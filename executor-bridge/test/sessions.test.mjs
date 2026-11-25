/**
 * bridge 会话状态机并发用例（node --test，针对 dist 产物）。
 * 覆盖：多会话并行、per-session 排队顺序、跨会话事件隔离、并发回合上限、
 * 中断语义、回合终态事件与失败原因。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '../dist/core/sessions.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error('等待超时');
}

/** 假内核：记录同时在跑的回合数、完成顺序，并按 prompt 里的标记决定是否长跑 */
function fakeKernel() {
  const rec = { inFlight: 0, peak: 0, finished: [], aborted: 0 };
  return {
    rec,
    name: 'fake',
    capabilities: () => ({
      questions: false,
      interrupt: true,
      switchModel: true,
      agents: false,
      exec: false,
      maxSessions: null,
      protocol: 1,
    }),
    version: async () => 'fake',
    location: async () => ({ directory: '/' }),
    providers: async () => [],
    models: async () => [],
    runTurn: (input) =>
      new Promise((resolve) => {
        rec.inFlight += 1;
        rec.peak = Math.max(rec.peak, rec.inFlight);
        const delay = input.prompt.includes('[long]')
          ? 5000
          : 5 + Math.floor(Math.random() * 15);
        let settled = false;
        const done = (result) => {
          if (settled) return;
          settled = true;
          rec.inFlight -= 1;
          if (result.outcome === 'succeeded') rec.finished.push(input.prompt);
          resolve(result);
        };
        const timer = setTimeout(() => {
          input.events.onChunk(`done:${input.prompt}`);
          done({
            outcome: 'succeeded',
            finalText: `done:${input.prompt}`,
            externalId: null,
          });
        }, delay);
        input.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            rec.aborted += 1;
            done({
              outcome: 'failed',
              finalText: null,
              externalId: null,
              error: 'interrupted',
            });
          },
          { once: true },
        );
      }),
  };
}

function manager(kernel, maxTurns) {
  const events = [];
  const sessions = new SessionManager(
    kernel,
    (type, data) => events.push({ type, data }),
    '/tmp',
    ...(maxTurns === undefined ? [] : [maxTurns]),
  );
  return { sessions, events };
}

test('并发会话互不串扰：30 个会话各连发 3 条，顺序正确且受回合上限约束', async () => {
  const kernel = fakeKernel();
  const { sessions, events } = manager(kernel);
  assert.equal(sessions.maxTurns, 10);
  const ids = Array.from(
    { length: 30 },
    (_, index) => sessions.create({ title: `s${index}` }).id,
  );
  ids.forEach((id, index) => {
    sessions.prompt(id, `s${index}-t1`);
    sessions.prompt(id, `s${index}-t2`);
    sessions.prompt(id, `s${index}-t3`);
  });
  await until(() => kernel.rec.finished.length === 90);

  assert.ok(kernel.rec.peak <= 10, `峰值回合数 ${kernel.rec.peak} 不应超过上限 10`);
  assert.ok(kernel.rec.peak >= 5, '多会话应当真正并行执行');

  for (let index = 0; index < 30; index += 1) {
    const order = kernel.rec.finished.filter((prompt) =>
      prompt.startsWith(`s${index}-`),
    );
    assert.deepEqual(order, [`s${index}-t1`, `s${index}-t2`, `s${index}-t3`]);
    const deltas = events
      .filter(
        (event) =>
          event.type === 'session.text.delta' &&
          event.data.sessionID === ids[index],
      )
      .map((event) => event.data.delta);
    assert.deepEqual(deltas, [
      `done:s${index}-t1`,
      `done:s${index}-t2`,
      `done:s${index}-t3`,
    ]);
  }

  const terminals = events.filter((event) =>
    event.type.startsWith('session.execution.'),
  );
  assert.equal(terminals.length, 90);
  assert.ok(terminals.every((event) => event.type === 'session.execution.succeeded'));
  assert.ok(
    terminals.every((event) => typeof event.data.time.idle === 'number'),
    '终态事件必须带执行器时间，供平台判断是否属于最新一轮',
  );
});

test('并发回合上限：超出上限的回合排队，按序补位', async () => {
  const kernel = fakeKernel();
  const { sessions } = manager(kernel, 2);
  const ids = Array.from(
    { length: 5 },
    (_, index) => sessions.create({ title: `q${index}` }).id,
  );
  ids.forEach((id, index) => sessions.prompt(id, `q${index}`));
  await until(() => kernel.rec.finished.length === 5);
  assert.equal(kernel.rec.peak, 2);
  assert.deepEqual(
    kernel.rec.finished.slice().sort(),
    ['q0', 'q1', 'q2', 'q3', 'q4'],
  );
});

test('中断：当前回合失败，队列保留且后续回合照常执行', async () => {
  const kernel = fakeKernel();
  const { sessions, events } = manager(kernel);
  const id = sessions.create({ title: 'x' }).id;
  sessions.prompt(id, '[long] x1');
  sessions.prompt(id, 'x2');
  await sleep(30);
  sessions.interrupt(id);
  await until(() => kernel.rec.finished.includes('x2'));
  const state = sessions.state(id);
  assert.equal(state.outcome, 'succeeded');
  assert.equal(kernel.rec.aborted, 1);
  const failed = events.find((event) => event.type === 'session.execution.failed');
  assert.equal(failed.data.error.message, 'interrupted');
  assert.equal(await sessions.lastAssistantText(id), 'done:x2');
});

test('失败回合：会话 error 字段带真实原因（平台对账与限额识别用）', async () => {
  const kernel = fakeKernel();
  const { sessions } = manager(kernel);
  const id = sessions.create({ title: 'f' }).id;
  sessions.prompt(id, '[long] f1');
  await sleep(20);
  sessions.interrupt(id);
  await until(() => sessions.state(id).outcome === 'failed');
  assert.equal(sessions.state(id).error, 'interrupted');
});

test('删除会话会丢弃排队中的回合（评估项取消时清空工位内存）', async () => {
  const kernel = fakeKernel();
  const { sessions } = manager(kernel, 1);
  const first = sessions.create({ title: 'a' }).id;
  const second = sessions.create({ title: 'b' }).id;
  sessions.prompt(first, '[long] a1');
  sessions.prompt(second, 'b1');
  await sleep(20);
  sessions.delete(second);
  sessions.interrupt(first);
  await until(() => kernel.rec.inFlight === 0);
  assert.equal(kernel.rec.finished.includes('b1'), false);
});