import {
  EVAL_GLOBAL_CONCURRENCY,
  EVAL_JUDGE_CONCURRENCY,
  EvalEngineService,
  RULE_ANSWER_MORE,
} from './eval-engine.service';
import type { EvalRunItem } from './eval-run-item.entity';
import {
  EvalEventType,
  EvalItemResult,
  EvalItemStatus,
  EvalRunStatus,
  TaskStatus,
  TaskSubStatus,
} from '../common/enums';

/**
 * 并发占位测试桩：内存里的评估批次与评估项，
 * dataSource.transaction 直接执行回调，用同一份内存数据实现 manager 的计数与条件更新。
 */
interface ItemRow {
  id: number;
  runId: number;
  caseId: number;
  status: EvalItemStatus;
  superseded: boolean;
  taskId?: number | null;
  reworkCount?: number;
}

interface RunRow {
  id: number;
  concurrency: number;
  status: EvalRunStatus;
}

function statusesOf(status: unknown): EvalItemStatus[] {
  const value = Array.isArray(status)
    ? (status as unknown[])
    : ((status as { value?: unknown[] } | null)?.value ?? []);
  return value.filter((s): s is EvalItemStatus => typeof s === 'string');
}

function admissionEngine(rows: ItemRow[], runs: RunRow[]) {
  const service = Object.create(
    EvalEngineService.prototype,
  ) as EvalEngineService;
  const internals = service as unknown as {
    dataSource: unknown;
    progress: { emitRun(runId: number): void };
    launching: Set<number>;
    busy: Set<number>;
    admitting: boolean;
    launch(item: EvalRunItem): void;
    admitPending(pending: EvalRunItem[]): Promise<void>;
  };
  const launched: number[] = [];
  internals.launching = new Set();
  internals.busy = new Set();
  internals.admitting = false;
  internals.progress = { emitRun: () => undefined };
  internals.launch = (item) => {
    launched.push(item.id);
  };
  const manager = {
    query: () => Promise.resolve([{}]),
    findOne: (_entity: unknown, query: { where: { id: number } }) =>
      Promise.resolve(runs.find((run) => run.id === query.where.id) ?? null),
    count: (_entity: unknown, query: { where: Record<string, unknown> }) => {
      const where = query.where as {
        runId?: number;
        status: unknown;
        superseded: boolean;
      };
      const list = statusesOf(where.status);
      return Promise.resolve(
        rows.filter(
          (row) =>
            row.superseded === where.superseded &&
            list.includes(row.status) &&
            (where.runId === undefined || row.runId === where.runId),
        ).length,
      );
    },
    update: (
      _entity: unknown,
      criteria: { id: number; status: EvalItemStatus },
      patch: { status: EvalItemStatus },
    ) => {
      const row = rows.find(
        (item) => item.id === criteria.id && item.status === criteria.status,
      );
      if (!row) return Promise.resolve({ affected: 0 });
      row.status = patch.status;
      return Promise.resolve({ affected: 1 });
    },
  };
  internals.dataSource = {
    transaction: (fn: (entityManager: unknown) => Promise<boolean>) =>
      fn(manager),
  };
  return { service, internals, launched, rows };
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
      find: (query: unknown) => {
        const where = (query as { where: { status: unknown } }).where;
        const statuses = statusesOf(where.status);
        return Promise.resolve(
          [
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
          ].filter((row) => statuses.includes(row.status)),
        );
      },
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

describe('EvalEngineService 并发占位（TECH_DESIGN 15.3）', () => {
  const run = (id: number, concurrency: number): RunRow => ({
    id,
    concurrency,
    status: EvalRunStatus.RUNNING,
  });
  const item = (
    id: number,
    runId: number,
    status: EvalItemStatus,
  ): ItemRow => ({
    id,
    runId,
    caseId: 1,
    status,
    superseded: false,
  });

  it('concurrency=1 的批次一次只启动 1 个排队项（回归：同轮全部放行）', async () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      item(index + 1, 1, EvalItemStatus.PENDING),
    );
    const { internals, launched } = admissionEngine(rows, [run(1, 1)]);
    await internals.admitPending(rows as unknown as EvalRunItem[]);
    expect(launched).toEqual([1]);
    expect(rows[0]?.status).toBe(EvalItemStatus.PREPARING);
  });

  it('批次并发上限只放行剩余空位（执行中 1 个 + concurrency=3 → 再放 2 个）', async () => {
    const rows = [
      item(1, 1, EvalItemStatus.RUNNING),
      ...Array.from({ length: 5 }, (_, index) =>
        item(index + 2, 1, EvalItemStatus.PENDING),
      ),
    ];
    const { internals, launched } = admissionEngine(rows, [run(1, 3)]);
    await internals.admitPending(rows.slice(1) as unknown as EvalRunItem[]);
    expect(launched).toEqual([2, 3]);
  });

  it('全局上限跨批次生效（两个批次各 4 个排队项 → 总共只放 5 个）', async () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, index) =>
        item(index + 1, 1, EvalItemStatus.PENDING),
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        item(index + 5, 2, EvalItemStatus.PENDING),
      ),
    ];
    const { internals, launched } = admissionEngine(rows, [
      run(1, 4),
      run(2, 4),
    ]);
    await internals.admitPending(rows as unknown as EvalRunItem[]);
    expect(launched).toHaveLength(EVAL_GLOBAL_CONCURRENCY);
    expect(launched).toEqual([1, 2, 3, 4, 5]);
  });

  it('判定中占用槽位：69 个判定中 + 12 个排队项不再启动任何项', async () => {
    const rows = [
      ...Array.from({ length: 69 }, (_, index) =>
        item(index + 1, 5, EvalItemStatus.JUDGING),
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        item(index + 100, 6, EvalItemStatus.PENDING),
      ),
      ...Array.from({ length: 2 }, (_, index) =>
        item(index + 200, 7, EvalItemStatus.PENDING),
      ),
    ];
    const { internals, launched } = admissionEngine(rows, [
      run(5, 5),
      run(6, 3),
      run(7, 3),
    ]);
    const pending = rows.filter((row) => row.status === EvalItemStatus.PENDING);
    await internals.admitPending(pending as unknown as EvalRunItem[]);
    expect(launched).toEqual([]);
  });

  it('同一轮 tick 只有一个启动流程（重入直接返回）', async () => {
    const rows = [
      item(1, 1, EvalItemStatus.PENDING),
      item(2, 1, EvalItemStatus.PENDING),
    ];
    const { internals, launched } = admissionEngine(rows, [run(1, 5)]);
    internals.admitting = true;
    await internals.admitPending(rows as unknown as EvalRunItem[]);
    expect(launched).toEqual([]);
  });
});

/** 判定对账测试桩：只实现 reconcileJudging 依赖的仓储与方法 */
interface JudgingStub {
  items: { findOne(query: unknown): Promise<unknown> };
  judgements: { findOne(query: unknown): Promise<unknown> };
  tasks: { findOne(query: unknown): Promise<unknown> };
  events: { find(query: unknown): Promise<unknown[]> };
  logger: { log(): void; warn(): void; error(): void };
  judging: Set<number>;
  judgeStartedAt: Map<number, number>;
  startJudge(...args: unknown[]): Promise<void>;
  applyJudgement(...args: unknown[]): Promise<void>;
  markItemError(id: number, message: string): Promise<void>;
  addEvent(...args: unknown[]): Promise<void>;
  reconcileJudging(item: unknown): Promise<void>;
}

function judgingStub(options: {
  item: Record<string, unknown>;
  task: Record<string, unknown> | null;
  effective?: Record<string, unknown> | null;
  judgeStarts?: number[];
  live?: boolean;
  startedAgoMs?: number;
}) {
  const engine = Object.create(
    EvalEngineService.prototype,
  ) as unknown as JudgingStub;
  const state = {
    started: [] as unknown[][],
    applied: [] as unknown[][],
    errors: [] as string[],
    events: [] as unknown[][],
  };
  engine.items = { findOne: () => Promise.resolve({ ...options.item }) };
  engine.logger = {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  engine.judgements = {
    findOne: () => Promise.resolve(options.effective ?? null),
  };
  engine.tasks = { findOne: () => Promise.resolve(options.task) };
  engine.events = {
    find: () =>
      Promise.resolve(
        (options.judgeStarts ?? []).map((round) => ({ payload: { round } })),
      ),
  };
  engine.judging = new Set(options.live ? [Number(options.item.id)] : []);
  engine.judgeStartedAt = new Map(
    options.live
      ? [
          [
            Number(options.item.id),
            Date.now() - (options.startedAgoMs ?? 0),
          ] as [number, number],
        ]
      : [],
  );
  engine.startJudge = (...args) => {
    state.started.push(args);
    return Promise.resolve();
  };
  engine.applyJudgement = (...args) => {
    state.applied.push(args);
    return Promise.resolve();
  };
  engine.markItemError = (id, message) => {
    state.errors.push(message);
    return Promise.resolve();
  };
  engine.addEvent = (...args) => {
    state.events.push(args);
    return Promise.resolve();
  };
  return { engine, state };
}

describe('评估项判定对账（判定中兜底）', () => {
  const judgingItem = {
    id: 7,
    runId: 1,
    caseId: 5,
    taskId: 9,
    status: EvalItemStatus.JUDGING,
    reworkCount: 0,
  };
  const waitingAccept = {
    id: 9,
    status: TaskStatus.WAITING,
    subStatus: TaskSubStatus.PENDING_ACCEPT,
  };

  it('没有在跑的判定会话且任务仍在待验收：重开判定', async () => {
    const { engine, state } = judgingStub({
      item: judgingItem,
      task: waitingAccept,
    });
    await engine.reconcileJudging(judgingItem);
    expect(state.started).toHaveLength(1);
    expect(state.errors).toEqual([]);
  });

  it('本轮判定会话已达上限：判异常，不再无限重开', async () => {
    const { engine, state } = judgingStub({
      item: judgingItem,
      task: waitingAccept,
      judgeStarts: [1, 1, 1],
    });
    await engine.reconcileJudging(judgingItem);
    expect(state.started).toEqual([]);
    expect(state.errors).toEqual(['判定失败：判定重试耗尽']);
  });

  it('已有生效判定（提交后进程异常）：补推进状态机', async () => {
    const { engine, state } = judgingStub({
      item: judgingItem,
      task: waitingAccept,
      effective: { id: 3, score: 90, pass: true },
    });
    await engine.reconcileJudging(judgingItem);
    expect(state.applied).toHaveLength(1);
    expect(state.started).toEqual([]);
  });

  it('任务已不在待验收：判异常，避免永久占槽', async () => {
    const { engine, state } = judgingStub({
      item: judgingItem,
      task: {
        id: 9,
        status: TaskStatus.FINISHED,
        subStatus: TaskSubStatus.COMPLETED,
      },
    });
    await engine.reconcileJudging(judgingItem);
    expect(state.errors).toEqual(['评估任务已不在待验收，判定无法继续']);
  });

  it('判定会话长时间没结束：按超时判异常', async () => {
    const { engine, state } = judgingStub({
      item: judgingItem,
      task: waitingAccept,
      live: true,
      startedAgoMs: 7 * 60_000,
    });
    await engine.reconcileJudging(judgingItem);
    expect(state.errors).toEqual(['判定会话超时未结束（执行器无响应）']);
    expect(engine.judging.has(7)).toBe(false);
  });

  it('判定并发达到上限时 startJudge 直接返回（不查批次、不建会话）', async () => {
    const engine = Object.create(EvalEngineService.prototype) as unknown as {
      judging: Set<number>;
      logger: { log(): void; warn(): void; error(): void };
      runs: { findOne(query: unknown): Promise<unknown> };
      startJudge(item: unknown, task: unknown, round: number): Promise<void>;
    };
    engine.judging = new Set(
      Array.from({ length: EVAL_JUDGE_CONCURRENCY }, (_, index) => index + 100),
    );
    engine.logger = {
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    let touched = false;
    engine.runs = {
      findOne: () => {
        touched = true;
        return Promise.resolve(null);
      },
    };
    await engine.startJudge({ id: 7, runId: 1 }, { id: 9 }, 1);
    expect(touched).toBe(false);
  });
});

/** 会话失败续跑测试桩 */
interface TurnFailureStub {
  items: { findOne(query: unknown): Promise<unknown> };
  runs: { findOne(query: unknown): Promise<unknown> };
  workers: { findOne(query: unknown): Promise<unknown> };
  tasks: { findOne(query: unknown): Promise<unknown> };
  tasksService: { cancel(...args: unknown[]): Promise<unknown> };
  turnFailures: Map<number, number>;
  resumeTimers: Map<number, NodeJS.Timeout>;
  addEvent(...args: unknown[]): Promise<void>;
  markItemError(id: number, message: string): Promise<void>;
  scheduleResume(...args: unknown[]): void;
  failEvalItem(...args: unknown[]): Promise<void>;
  onEvalTurnFailed(task: unknown, reason: string): Promise<void>;
}

function turnFailureStub(options: {
  itemStatus?: EvalItemStatus;
  runStatus?: EvalRunStatus;
}) {
  const engine = Object.create(
    EvalEngineService.prototype,
  ) as unknown as TurnFailureStub;
  const state = {
    scheduled: [] as unknown[][],
    errors: [] as string[],
    cancelled: [] as unknown[][],
    events: [] as unknown[][],
  };
  engine.items = {
    findOne: () =>
      Promise.resolve({
        id: 7,
        runId: 1,
        caseId: 5,
        taskId: 9,
        superseded: false,
        status: options.itemStatus ?? EvalItemStatus.RUNNING,
      }),
  };
  engine.runs = {
    findOne: () =>
      Promise.resolve({
        id: 1,
        evaluatorWorkerId: 2,
        status: options.runStatus ?? EvalRunStatus.RUNNING,
      }),
  };
  engine.workers = {
    findOne: () => Promise.resolve({ id: 2, name: '评估机器人' }),
  };
  engine.tasks = {
    findOne: () =>
      Promise.resolve({
        id: 9,
        status: TaskStatus.RUNNING,
        subStatus: TaskSubStatus.EXECUTING,
      }),
  };
  engine.tasksService = {
    cancel: (...args) => {
      state.cancelled.push(args);
      return Promise.resolve({});
    },
  };
  engine.turnFailures = new Map();
  engine.resumeTimers = new Map();
  engine.addEvent = (...args) => {
    state.events.push(args);
    return Promise.resolve();
  };
  engine.markItemError = (id, message) => {
    state.errors.push(message);
    return Promise.resolve();
  };
  engine.scheduleResume = (...args) => {
    state.scheduled.push(args);
  };
  return { engine, state };
}

describe('评估任务会话失败续跑（自动续跑 → 判异常）', () => {
  const task = { id: 9, evalItemId: 7, isEval: true };

  it('第一次失败先安排自动续跑，不判异常', async () => {
    const { engine, state } = turnFailureStub({});
    await engine.onEvalTurnFailed(task, '对账补偿：会话执行失败');
    expect(state.scheduled).toEqual([[7, 9, 1, 30_000]]);
    expect(state.errors).toEqual([]);
    expect(engine.turnFailures.get(7)).toBe(1);
  });

  it('连续失败超过续跑上限（2 次）后判异常并结束评估任务', async () => {
    const { engine, state } = turnFailureStub({});
    engine.turnFailures.set(7, 2);
    await engine.onEvalTurnFailed(task, '执行失败：HTTP 429');
    expect(state.errors).toEqual([
      '会话执行失败（已续跑 2 次）：执行失败：HTTP 429',
    ]);
    expect(state.cancelled).toEqual([[9, '评估机器人']]);
  });

  it('评估项已终态或批次已取消：不再续跑也不再判异常', async () => {
    const terminal = turnFailureStub({ itemStatus: EvalItemStatus.DONE });
    await terminal.engine.onEvalTurnFailed(task, '失败');
    expect(terminal.state.scheduled).toEqual([]);
    expect(terminal.state.errors).toEqual([]);

    const canceled = turnFailureStub({ runStatus: EvalRunStatus.CANCELED });
    await canceled.engine.onEvalTurnFailed(task, '失败');
    expect(canceled.state.scheduled).toEqual([]);
    expect(canceled.state.errors).toEqual([]);
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
