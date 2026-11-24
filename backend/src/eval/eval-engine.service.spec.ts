import {
  EVAL_GLOBAL_CONCURRENCY,
  EvalEngineService,
  RULE_ANSWER_MORE,
} from './eval-engine.service';
import type { EvalRun } from './eval-run.entity';
import {
  EvalEventType,
  EvalItemResult,
  EvalItemStatus,
  EvalRunStatus,
} from '../common/enums';

/** 仅实现 slotAvailable 依赖的 items.count 桩（识别 TypeORM In 运算符） */
function engineWithItems(
  rows: Array<{ runId: number; status: EvalItemStatus; superseded: boolean }>,
): EvalEngineService {
  const service = Object.create(
    EvalEngineService.prototype,
  ) as EvalEngineService;
  const statusesOf = (status: unknown): EvalItemStatus[] => {
    const op = status as { value?: unknown[] };
    const list = Array.isArray(status)
      ? (status as unknown[])
      : (op?.value ?? []);
    return list.filter((s): s is EvalItemStatus => typeof s === 'string');
  };
  (
    service as unknown as { items: { count(query: unknown): Promise<number> } }
  ).items = {
    count: (query: unknown) => {
      const where = (
        query as {
          where: { runId?: number; status: unknown; superseded: boolean };
        }
      ).where;
      const statuses = statusesOf(where.status);
      return Promise.resolve(
        rows.filter(
          (r) =>
            r.superseded === where.superseded &&
            statuses.includes(r.status) &&
            (where.runId === undefined || r.runId === where.runId),
        ).length,
      );
    },
  };
  return service;
}

async function slotAvailable(
  service: EvalEngineService,
  run: Pick<EvalRun, 'id' | 'concurrency'>,
  currentActive: number,
): Promise<boolean> {
  return (
    service as unknown as {
      slotAvailable(
        run: Pick<EvalRun, 'id' | 'concurrency'>,
        currentActive: number,
      ): Promise<boolean>;
    }
  ).slotAvailable(run, currentActive);
}

describe('EvalEngineService 平台重启恢复（TECH_DESIGN 16）', () => {
  it('排队项重启后继续排队，有任务/沙箱在途的项才标异常', async () => {
    const service = Object.create(
      EvalEngineService.prototype,
    ) as EvalEngineService;
    const errors: Array<{ id: number; message: string }> = [];
    (
      service as unknown as {
        markItemError(id: number, message: string): Promise<void>;
      }
    ).markItemError = (id, message) => {
      errors.push({ id, message });
      return Promise.resolve();
    };
    (
      service as unknown as {
        items: { find(query: unknown): Promise<unknown[]> };
      }
    ).items = {
      find: () =>
        Promise.resolve([
          {
            id: 2,
            status: EvalItemStatus.PENDING,
            taskId: null,
            superseded: false,
          },
          {
            id: 3,
            status: EvalItemStatus.INVITED,
            taskId: null,
            superseded: false,
          },
          {
            id: 4,
            status: EvalItemStatus.RUNNING,
            taskId: 9,
            superseded: false,
          },
        ]),
    };
    (
      service as unknown as {
        tasks: { findOne(query: unknown): Promise<unknown> };
      }
    ).tasks = { findOne: () => Promise.resolve(null) };

    await service.onApplicationBootstrap();
    expect(errors).toEqual([
      { id: 3, message: '平台重启导致评估中断（任务未创建）' },
      { id: 4, message: '评估任务丢失' },
    ]);
  });
});

describe('EvalEngineService 并发槽位调度（TECH_DESIGN 15.3）', () => {
  const run = (id: number, concurrency: number) => ({
    id,
    concurrency,
    status: EvalRunStatus.RUNNING,
  });

  it('仅有排队项且项数 ≥ 批次并发时应有空槽（排队不占槽，回归：批次永久排队死锁）', async () => {
    // 本次事故场景：1 个 PENDING 项 + concurrency=1
    const one = engineWithItems([
      { runId: 1, status: EvalItemStatus.PENDING, superseded: false },
    ]);
    await expect(slotAvailable(one, run(1, 1), 1)).resolves.toBe(true);
    // 6 个 PENDING 项 + concurrency=3：全局占用态为 0（排队不计入全局槽位）
    const six = engineWithItems(
      Array.from({ length: 6 }, () => ({
        runId: 1,
        status: EvalItemStatus.PENDING,
        superseded: false,
      })),
    );
    await expect(slotAvailable(six, run(1, 3), 0)).resolves.toBe(true);
  });

  it('占用态项达到批次并发上限时无空槽', async () => {
    const service = engineWithItems([
      { runId: 1, status: EvalItemStatus.RUNNING, superseded: false },
      { runId: 1, status: EvalItemStatus.JUDGING, superseded: false },
      { runId: 1, status: EvalItemStatus.PENDING, superseded: false },
    ]);
    await expect(slotAvailable(service, run(1, 2), 3)).resolves.toBe(false);
  });

  it('全局占用达到上限时无空槽（即使批次内有空位）', async () => {
    const service = engineWithItems([
      { runId: 1, status: EvalItemStatus.PENDING, superseded: false },
    ]);
    await expect(
      slotAvailable(service, run(1, 3), EVAL_GLOBAL_CONCURRENCY),
    ).resolves.toBe(false);
  });

  it('占用态计数排除排队与被替代项', async () => {
    const service = engineWithItems([
      { runId: 1, status: EvalItemStatus.PENDING, superseded: false },
      { runId: 1, status: EvalItemStatus.PENDING, superseded: true },
      { runId: 1, status: EvalItemStatus.DONE, superseded: false },
      { runId: 2, status: EvalItemStatus.RUNNING, superseded: false },
    ]);
    // 本批次无占用态项 → 有空槽；其它批次的占用项不计入 runId 过滤
    await expect(slotAvailable(service, run(1, 1), 1)).resolves.toBe(true);
  });
});

/** answerQuestion 依赖的仓储与方法桩 */
interface AnswerEngineStub {
  runs: { findOne(query: unknown): Promise<unknown> };
  workers: { findOne(query: unknown): Promise<unknown> };
  messages: {
    createQueryBuilder(name: string): unknown;
    count(query: unknown): Promise<number>;
  };
  events: {
    find(query: unknown): Promise<unknown[]>;
    count(query: unknown): Promise<number>;
  };
  collaboration: { answer(...args: unknown[]): Promise<unknown> };
  tasksService: { cancel(...args: unknown[]): Promise<unknown> };
  logger: {
    warn(...args: unknown[]): void;
    log(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  addEvent(
    itemId: number,
    type: EvalEventType,
    payload?: Record<string, unknown>,
  ): Promise<void>;
  updateItem(itemId: number, patch: Record<string, unknown>): Promise<void>;
  finishItem(item: unknown, terminal: unknown): Promise<void>;
  destroyItemSandbox(item: unknown): Promise<void>;
  interruptTaskSession(task: unknown): Promise<void>;
  markItemError(itemId: number, message: string): Promise<void>;
  answerQuestion(
    item: unknown,
    task: unknown,
    previous: EvalItemStatus,
  ): Promise<void>;
}

type StubEvent = { type: EvalEventType; payload?: Record<string, unknown> };

function answerEngine(options: {
  questions: Array<{ question: string; custom?: boolean; options?: unknown[] }>;
  clarify?: string | null;
  maxQuestions?: number;
  questionCount?: number;
  priorEvents?: StubEvent[];
  answerError?: Error;
  itemStatus?: EvalItemStatus;
}) {
  const engine = Object.create(
    EvalEngineService.prototype,
  ) as unknown as AnswerEngineStub;
  const state = {
    itemStatus: options.itemStatus ?? EvalItemStatus.RUNNING,
    events: [...(options.priorEvents ?? [])] as StubEvent[],
    answers: [] as Array<{ questionId: unknown; input: unknown }>,
    cancelled: [] as unknown[][],
    finished: [] as unknown[],
    destroyed: 0,
    errors: [] as string[],
  };
  const rowsOf = (type: EvalEventType) =>
    state.events.filter((row) => row.type === type);

  engine.runs = {
    findOne: () =>
      Promise.resolve({
        id: 1,
        evaluatorWorkerId: 2,
        caseId: 5,
        suiteSnapshot: {
          maxQuestions: options.maxQuestions ?? 3,
          cases: [{ id: 5, clarify: options.clarify ?? null, points: [] }],
        },
      }),
  };
  engine.workers = {
    findOne: () => Promise.resolve({ id: 2, name: '评估机器人' }),
  };
  engine.messages = {
    createQueryBuilder: () => {
      const chain = {
        where: () => chain,
        orderBy: () => chain,
        getOne: () =>
          Promise.resolve({
            question: {
              id: 'project-q1',
              state: 'pending',
              questions: options.questions,
            },
          }),
      };
      return chain;
    },
    count: () => Promise.resolve(options.questionCount ?? 1),
  };
  engine.events = {
    find: (query: unknown) =>
      Promise.resolve(
        rowsOf((query as { where: { type: EvalEventType } }).where.type),
      ),
    count: (query: unknown) =>
      Promise.resolve(
        rowsOf((query as { where: { type: EvalEventType } }).where.type).length,
      ),
  };
  engine.addEvent = (_itemId, type, payload) => {
    state.events.push({ type, payload });
    return Promise.resolve();
  };
  engine.updateItem = (_itemId, patch) => {
    if (typeof patch.status === 'string') {
      state.itemStatus = patch.status as EvalItemStatus;
    }
    return Promise.resolve();
  };
  engine.finishItem = (_item, terminal) => {
    state.finished.push(terminal);
    return Promise.resolve();
  };
  engine.destroyItemSandbox = () => {
    state.destroyed += 1;
    return Promise.resolve();
  };
  engine.interruptTaskSession = () => {
    return Promise.resolve();
  };
  engine.markItemError = (_itemId, message) => {
    state.errors.push(message);
    return Promise.resolve();
  };
  engine.collaboration = {
    answer: (...args) => {
      if (options.answerError) return Promise.reject(options.answerError);
      const [, questionId, , input] = args;
      state.answers.push({ questionId, input });
      return Promise.resolve({});
    },
  };
  engine.tasksService = {
    cancel: (...args) => {
      state.cancelled.push(args);
      return Promise.resolve({});
    },
  };
  engine.logger = { warn() {}, log() {}, error() {} };
  return { engine, state };
}

describe('评估项提问处理（规则答复 / 跳过 / 超限）', () => {
  const item = { id: 7, runId: 1, caseId: 5 };
  const task = { id: 439, agentId: 3, opencodeSessionId: 'session-1' };

  it('一次提问包含多个问题时按问题数逐条答复（回归：答案数与问题数不一致）', async () => {
    const { engine, state } = answerEngine({
      questions: [
        { question: '范围？' },
        { question: '交付形式？' },
        { question: '验收标准？' },
      ],
    });
    await engine.answerQuestion(item, task, EvalItemStatus.RUNNING);
    expect(state.answers).toHaveLength(1);
    expect(state.answers[0].input).toEqual({
      answers: [[RULE_ANSWER_MORE], [RULE_ANSWER_MORE], [RULE_ANSWER_MORE]],
    });
    expect(state.events.map((row) => row.type)).toEqual([
      EvalEventType.QUESTION_ASKED,
      EvalEventType.QUESTION_ANSWERED,
    ]);
    expect(state.itemStatus).toBe(EvalItemStatus.RUNNING);
  });

  it('第一次提问使用用例 clarify 回答', async () => {
    const { engine, state } = answerEngine({
      questions: [{ question: '按哪个文档实现？' }],
      clarify: '按需求文档实现即可',
    });
    await engine.answerQuestion(item, task, EvalItemStatus.RUNNING);
    expect(state.answers[0].input).toEqual({
      answers: [['按需求文档实现即可']],
    });
  });

  it('只能从选项中选择的提问整轮跳过，不代答', async () => {
    const { engine, state } = answerEngine({
      questions: [
        {
          question: '用哪个框架？',
          custom: false,
          options: [{ label: 'React' }],
        },
        { question: '交付范围？' },
      ],
    });
    await engine.answerQuestion(item, task, EvalItemStatus.RUNNING);
    expect(state.answers[0].input).toEqual({ reject: true });
    expect(state.events.map((row) => row.type)).toEqual([
      EvalEventType.QUESTION_ASKED,
      EvalEventType.QUESTION_SKIPPED,
    ]);
    expect(state.itemStatus).toBe(EvalItemStatus.RUNNING);
  });

  it('跳过次数未超过提问上限时继续让机器人执行', async () => {
    const { engine, state } = answerEngine({
      questions: [{ question: '用哪个框架？', custom: false }],
      priorEvents: [
        { type: EvalEventType.QUESTION_SKIPPED, payload: { skipped: 1 } },
        { type: EvalEventType.QUESTION_SKIPPED, payload: { skipped: 2 } },
      ],
    });
    await engine.answerQuestion(item, task, EvalItemStatus.RUNNING);
    expect(state.answers[0].input).toEqual({ reject: true });
    expect(state.finished).toHaveLength(0);
  });

  it('跳过次数超过提问上限直接判失败并结束评估任务', async () => {
    const { engine, state } = answerEngine({
      questions: [{ question: '用哪个框架？', custom: false }],
      priorEvents: [
        { type: EvalEventType.QUESTION_SKIPPED },
        { type: EvalEventType.QUESTION_SKIPPED },
        { type: EvalEventType.QUESTION_SKIPPED },
      ],
    });
    await engine.answerQuestion(item, task, EvalItemStatus.RUNNING);
    expect(state.answers).toHaveLength(0);
    expect(
      state.events.some((row) => row.type === EvalEventType.QUESTION_LIMIT),
    ).toBe(true);
    expect(state.finished).toEqual([
      { status: EvalItemStatus.DONE, result: EvalItemResult.QUESTION_LIMIT },
    ]);
    expect(state.cancelled).toEqual([[439, '评估机器人']]);
    expect(state.destroyed).toBe(1);
  });

  it('答复失败时记异常事件、不重复写提问事件、不推进状态机', async () => {
    const { engine, state } = answerEngine({
      questions: [{ question: '范围？' }],
      priorEvents: [
        {
          type: EvalEventType.QUESTION_ASKED,
          payload: { questionId: 'project-q1', questionCount: 1 },
        },
      ],
      answerError: new Error('answers 数量必须与问题数量一致'),
      itemStatus: EvalItemStatus.WAITING_ANSWER,
    });
    await engine.answerQuestion(item, task, EvalItemStatus.RUNNING);
    expect(
      state.events.filter((row) => row.type === EvalEventType.QUESTION_ASKED),
    ).toHaveLength(1);
    const failure = state.events.find(
      (row) => row.type === EvalEventType.ERROR,
    );
    expect(failure?.payload).toEqual({
      stage: 'answer',
      questionId: 'project-q1',
      message: 'answers 数量必须与问题数量一致',
    });
    expect(state.itemStatus).toBe(EvalItemStatus.WAITING_ANSWER);
    expect(state.errors).toHaveLength(0);
  });

  it('同一提问连续答复失败达到上限转为异常项', async () => {
    const failure: StubEvent = {
      type: EvalEventType.ERROR,
      payload: {
        stage: 'answer',
        questionId: 'project-q1',
        message: '服务异常',
      },
    };
    const { engine, state } = answerEngine({
      questions: [{ question: '范围？' }],
      priorEvents: [
        {
          type: EvalEventType.QUESTION_ASKED,
          payload: { questionId: 'project-q1' },
        },
        failure,
        { ...failure },
      ],
      answerError: new Error('服务异常'),
      itemStatus: EvalItemStatus.WAITING_ANSWER,
    });
    await engine.answerQuestion(item, task, EvalItemStatus.RUNNING);
    expect(state.errors).toEqual(['提问答复失败（已重试 3 次）：服务异常']);
  });

  it('返工中提问答复后回到返工中', async () => {
    const { engine, state } = answerEngine({
      questions: [{ question: '返工范围？' }],
    });
    await engine.answerQuestion(item, task, EvalItemStatus.REWORKING);
    expect(state.itemStatus).toBe(EvalItemStatus.REWORKING);
  });
});

describe('评估项等待答复时长与汇总', () => {
  it('跳过的提问也算一次问答结束，配对不会错位', async () => {
    const service = Object.create(EvalEngineService.prototype) as unknown as {
      events: { find(query: unknown): Promise<unknown[]> };
      sumAnswerWaits(itemId: number, before: Date | null): Promise<number>;
    };
    const at = (offset: number) =>
      new Date(Date.UTC(2026, 10, 24, 10, 0, 0) + offset);
    service.events = {
      find: () =>
        Promise.resolve([
          { type: EvalEventType.QUESTION_ASKED, at: at(0) },
          { type: EvalEventType.QUESTION_SKIPPED, at: at(1_000) },
          { type: EvalEventType.QUESTION_ASKED, at: at(2_000) },
          { type: EvalEventType.QUESTION_ANSWERED, at: at(5_000) },
        ]),
    };
    await expect(service.sumAnswerWaits(7, null)).resolves.toBe(4_000);
    await expect(service.sumAnswerWaits(7, at(2_500))).resolves.toBe(1_000);
  });

  it('汇总统计区分提问超限与未通过', async () => {
    const service = Object.create(EvalEngineService.prototype) as unknown as {
      items: { find(query: unknown): Promise<unknown[]> };
      runs: {
        findOne(query: unknown): Promise<unknown>;
        update(
          query: unknown,
          patch: Record<string, unknown>,
        ): Promise<unknown>;
      };
      refreshRunSummary(runId: number): Promise<void>;
    };
    let summary: Record<string, unknown> | null = null;
    let nextStatus: unknown = null;
    const row = (status: EvalItemStatus, result: EvalItemResult | null) => ({
      runId: 1,
      status,
      result,
      superseded: false,
      firstScore: 90,
      finalScore: null,
      interventionCount: 0,
      waitAnswerMs: null,
    });
    service.items = {
      find: () =>
        Promise.resolve([
          row(EvalItemStatus.DONE, EvalItemResult.QUESTION_LIMIT),
          row(EvalItemStatus.DONE, EvalItemResult.FAILED),
          row(EvalItemStatus.DONE, EvalItemResult.FIRST_PASS),
          row(EvalItemStatus.ERROR, null),
        ]),
    };
    service.runs = {
      findOne: () =>
        Promise.resolve({
          id: 1,
          status: EvalRunStatus.RUNNING,
          finishedAt: null,
        }),
      update: (_query, patch) => {
        summary = patch.summary as Record<string, unknown>;
        nextStatus = patch.status;
        return Promise.resolve({});
      },
    };
    await service.refreshRunSummary(1);
    expect(summary?.questionLimit).toBe(1);
    expect(summary?.failed).toBe(1);
    expect(summary?.passRate).toBe(33);
    expect(nextStatus).toBe(EvalRunStatus.COMPLETED);
  });
});
