/**
 * 会话快照持久化用例（node --test，针对 dist 产物）。
 * 覆盖：bridge id/原生会话 id/消息恢复、重启中回合按失败收尾、
 * 退出时不重放排队消息、删除与会话状态清理。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '../dist/core/sessions.js';
import { SessionStore } from '../dist/core/session-store.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error('等待超时');
}

function fakeKernel(nativeId = 'native-1') {
  const rec = { turns: [] };
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
        rec.turns.push({
          prompt: input.prompt,
          externalId: input.externalId,
        });
        const finish = (result) => resolve(result);
        const timer = setTimeout(() => {
          if (!input.externalId) input.events.onExternalSession(nativeId);
          input.events.onChunk(`reply:${input.prompt}`);
          finish({
            outcome: 'succeeded',
            finalText: `reply:${input.prompt}`,
            externalId: input.externalId ?? nativeId,
          });
        }, input.prompt.includes('[long]') ? 5000 : 5);
        input.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            finish({
              outcome: 'failed',
              finalText: null,
              externalId: input.externalId,
              error: 'interrupted',
            });
          },
          { once: true },
        );
      }),
  };
}

function manager(kernel, store, root) {
  return new SessionManager(kernel, () => undefined, root, 10, store);
}

test('重启后恢复 bridge 会话、原生 externalId、消息与模型续聊', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-state-'));
  try {
    const file = join(root, 'state.json');
    const firstStore = new SessionStore(file);
    const firstKernel = fakeKernel('native-restore');
    const first = manager(firstKernel, firstStore, root);
    const id = first.create({
      title: '持久化会话',
      model: { id: 'model-a', providerID: 'provider-a', variant: 'high' },
    }).id;
    first.prompt(id, 'first');
    await until(() => first.state(id).outcome === 'succeeded');
    await firstStore.flush();

    const secondStore = new SessionStore(file);
    const secondKernel = fakeKernel('native-restore');
    const second = manager(secondKernel, secondStore, root);
    const restored = await second.restore();
    assert.equal(restored.restored, 1);
    assert.equal(restored.interrupted, 0);
    assert.equal(second.state(id).outcome, 'succeeded');
    assert.equal(await second.lastAssistantText(id), 'reply:first');
    assert.equal(
      second.messageDetail(id, first.messages(id)[0].id).content[0].text,
      'first',
    );

    second.prompt(id, 'second');
    await until(() => secondKernel.rec.turns.length === 1);
    assert.equal(secondKernel.rec.turns[0].externalId, 'native-restore');
    await until(() => second.messages(id).length === 4);
    assert.equal(await second.lastAssistantText(id), 'reply:second');
    await secondStore.flush();

    const raw = JSON.parse(await readFile(file, 'utf8'));
    const persisted = raw.sessions.find((item) => item.id === id);
    assert.equal(persisted.externalId, 'native-restore');
    assert.deepEqual(persisted.model, {
      id: 'model-a',
      providerID: 'provider-a',
      variant: 'high',
    });
    assert.equal(persisted.messages.at(-1).text, 'reply:second');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('快照中运行中的回合重启后标记失败且不自动重放', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-pending-'));
  try {
    const file = join(root, 'state.json');
    const store = new SessionStore(file);
    const createdAt = Date.now() - 1000;
    await store.save([
      {
        id: 'bs_pending',
        title: 'pending',
        directory: root,
        model: null,
        agent: null,
        externalId: 'native-pending',
        outcome: null,
        lastError: null,
        idleAt: 0,
        createdAt,
        pending: true,
        messages: [
          {
            id: 'km_user',
            role: 'user',
            text: 'in-flight',
            createdAt,
          },
        ],
      },
    ]);

    const kernel = fakeKernel('native-other');
    const restoreStore = new SessionStore(file);
    const restoredManager = manager(kernel, restoreStore, root);
    const restored = await restoredManager.restore();
    assert.deepEqual(restored, { restored: 1, interrupted: 1 });
    assert.equal(restoredManager.state('bs_pending').outcome, 'failed');
    assert.equal(restoredManager.state('bs_pending').error, 'bridge restarted');
    assert.equal(
      await restoredManager.lastAssistantText('bs_pending'),
      '执行失败：bridge restarted',
    );
    assert.equal(kernel.rec.turns.length, 0);

    restoredManager.prompt('bs_pending', 'again');
    await until(() => kernel.rec.turns.length === 1);
    assert.equal(kernel.rec.turns[0].externalId, 'native-pending');
    await until(() => restoredManager.messages('bs_pending').length === 3);
    await restoreStore.flush();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('退出时中断当前回合、丢弃排队消息并保存失败终态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-shutdown-'));
  try {
    const file = join(root, 'state.json');
    const store = new SessionStore(file);
    const kernel = fakeKernel('native-shutdown');
    const sessions = manager(kernel, store, root);
    const id = sessions.create({ title: 'shutdown' }).id;
    sessions.prompt(id, '[long] first');
    sessions.prompt(id, 'queued');
    await until(
      () => sessions.state(id).outcome === null && kernel.rec.turns.length === 1,
    );

    await sessions.shutdown(1000);
    assert.equal(kernel.rec.turns.length, 1, '排队消息不应在退出时执行');
    assert.equal(sessions.state(id).outcome, 'failed');
    assert.equal(sessions.state(id).error, 'bridge restarted');

    const restoreStore = new SessionStore(file);
    const restoredManager = manager(
      fakeKernel('native-shutdown'),
      restoreStore,
      root,
    );
    await restoredManager.restore();
    assert.equal(restoredManager.state(id).outcome, 'failed');
    assert.equal(restoredManager.state(id).error, 'bridge restarted');
    await restoreStore.flush();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('删除会话后快照不再恢复该会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-delete-'));
  try {
    const file = join(root, 'state.json');
    const store = new SessionStore(file);
    const sessions = manager(fakeKernel(), store, root);
    const id = sessions.create({ title: 'deleted' }).id;
    sessions.delete(id);
    await store.flush();

    const restoreStore = new SessionStore(file);
    const restoredManager = manager(fakeKernel(), restoreStore, root);
    const restored = await restoredManager.restore();
    assert.equal(restored.restored, 0);
    assert.throws(() => restoredManager.state(id), /not found/);
    await restoreStore.flush();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('损坏或版本不兼容的快照明确报错，由启动方降级空状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-invalid-'));
  try {
    const file = join(root, 'state.json');
    await writeFile(file, '{"version":999,"sessions":[]}', 'utf8');
    const store = new SessionStore(file);
    await assert.rejects(
      () => store.load(),
      /unsupported session state version/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
