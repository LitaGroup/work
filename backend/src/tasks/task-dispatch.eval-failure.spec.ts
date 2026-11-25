import { TaskStatus, TaskSubStatus } from '../common/enums';
import { Task } from './task.entity';
import { TaskDispatchService } from './task-dispatch.service';

/**
 * 派发侧的失败收尾（评估任务回调 + 终态事件新鲜度）：
 * 会话失败只结束本轮，续跑/判异常交给评估引擎。
 */
function buildService(task: Task) {
  const tasksRepo = {
    findOne: jest.fn().mockResolvedValue(task),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    save: jest.fn((value: Task) => Promise.resolve(value)),
  };
  const eventsRepo = {
    create: jest.fn((value: unknown) => value),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const taskChat = { failTask: jest.fn().mockResolvedValue(undefined) };
  const taskNotify = {
    notifyTaskAgentOwner: jest.fn().mockResolvedValue({ sent: true }),
    notifyTaskRequester: jest.fn().mockResolvedValue({ sent: true }),
  };
  const taskRealtime = { lineAppended: jest.fn(), taskChanged: jest.fn() };
  const workerInbox = {
    requeueDelivered: jest.fn().mockResolvedValue(undefined),
  };
  const service = new TaskDispatchService(
    tasksRepo as never,
    eventsRepo as never,
    { findOne: jest.fn() } as never,
    { findOne: jest.fn() } as never,
    { findOne: jest.fn() } as never,
    { workdirOf: jest.fn() } as never,
    { onEvent: jest.fn(), retain: jest.fn(), release: jest.fn() } as never,
    taskNotify as never,
    taskRealtime as never,
    taskChat as never,
    {} as never,
    { start: jest.fn() } as never,
    workerInbox as never,
    { buildServersConfig: jest.fn() } as never,
    { findOne: jest.fn() } as never,
    {
      recordTurnStart: jest.fn().mockResolvedValue(undefined),
      recordMessageIn: jest.fn().mockResolvedValue(undefined),
      recordTaskEvent: jest.fn().mockResolvedValue(undefined),
      finalize: jest.fn().mockResolvedValue(undefined),
    } as never,
    { transaction: jest.fn() } as never,
    { get: jest.fn() } as never,
  );
  return { service, taskChat, taskNotify };
}

const buildTask = (over: Partial<Task> = {}): Task =>
  ({
    id: 1,
    code: 'TK-0001',
    title: '评估用例',
    status: TaskStatus.RUNNING,
    subStatus: TaskSubStatus.EXECUTING,
    isEval: false,
    evalItemId: null,
    agentId: 1001,
    requesterType: 'worker',
    requesterId: 2,
    ...over,
  }) as Task;

type FinalizeInternals = {
  finalizeFailedTurn(
    taskId: number,
    content: string,
    eventContent: string,
  ): Promise<void>;
};

type FreshnessInternals = {
  turnStartedAt: Map<number, number>;
  isStaleTurnTerminal(taskId: number, data: Record<string, unknown>): boolean;
};

describe('TaskDispatchService 评估任务失败收尾', () => {
  it('评估任务会话失败：结束本轮并回调评估引擎（带失败原因）', async () => {
    const task = buildTask({ isEval: true, evalItemId: 7 });
    const { service, taskChat } = buildService(task);
    const hook = jest.fn().mockResolvedValue(undefined);
    service.evalTurnFailedHook = hook;

    await (service as unknown as FinalizeInternals).finalizeFailedTurn(
      1,
      '对账补偿：会话执行失败',
      '对账补偿：会话执行失败',
    );

    expect(taskChat.failTask).toHaveBeenCalledWith(1, '对账补偿：会话执行失败');
    expect(hook).toHaveBeenCalledWith(task, '对账补偿：会话执行失败');
  });

  it('普通任务不回调评估引擎', async () => {
    const task = buildTask();
    const { service } = buildService(task);
    const hook = jest.fn().mockResolvedValue(undefined);
    service.evalTurnFailedHook = hook;

    await (service as unknown as FinalizeInternals).finalizeFailedTurn(
      1,
      '执行失败：HTTP 429',
      '会话执行失败：HTTP 429',
    );

    expect(hook).not.toHaveBeenCalled();
  });

  it('回调异常不影响失败收尾本体', async () => {
    const task = buildTask({ isEval: true, evalItemId: 7 });
    const { service, taskChat } = buildService(task);
    service.evalTurnFailedHook = jest
      .fn()
      .mockRejectedValue(new Error('评估引擎异常'));

    await expect(
      (service as unknown as FinalizeInternals).finalizeFailedTurn(
        1,
        '对账补偿：会话执行失败',
        '对账补偿：会话执行失败',
      ),
    ).resolves.toBeUndefined();
    expect(taskChat.failTask).toHaveBeenCalled();
  });
});

describe('TaskDispatchService 终态事件新鲜度', () => {
  const internals = (service: TaskDispatchService): FreshnessInternals =>
    service as unknown as FreshnessInternals;

  it('更早一轮的终态事件被忽略（bridge 队列里还有后续 prompt）', () => {
    const { service } = buildService(buildTask());
    internals(service).turnStartedAt.set(1, 2_000);
    expect(
      internals(service).isStaleTurnTerminal(1, { time: { idle: 1_500 } }),
    ).toBe(true);
    expect(
      internals(service).isStaleTurnTerminal(1, { time: { idle: 2_000 } }),
    ).toBe(false);
  });

  it('没有执行器时间或没有本轮基准时按既有行为采信（兼容 opencode）', () => {
    const { service } = buildService(buildTask());
    expect(internals(service).isStaleTurnTerminal(1, {})).toBe(false);
    internals(service).turnStartedAt.set(1, 2_000);
    expect(internals(service).isStaleTurnTerminal(1, {})).toBe(false);
  });
});
