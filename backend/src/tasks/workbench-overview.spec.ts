import { TaskStatus, TaskSubStatus, TaskType } from '../common/enums';
import type { User } from '../auth/user.entity';
import { Task } from './task.entity';
import { WorkbenchService } from './workbench.service';

describe('WorkbenchService 工作台概览', () => {
  const baseTask = (over: Partial<Task> = {}): Task =>
    ({
      id: 1,
      code: 'TK-0001',
      title: '任务标题',
      type: TaskType.NORMAL,
      status: TaskStatus.WAITING,
      subStatus: TaskSubStatus.PENDING_ACCEPTANCE,
      requesterType: 'worker',
      requesterId: 1000,
      agentId: 1000,
      createdAt: new Date('2026-11-01T09:00:00+08:00'),
      updatedAt: new Date('2026-11-02T09:00:00+08:00'),
      ...over,
    }) as Task;

  const user = { id: 1, name: '张三' } as User;
  const humanWorker = { id: 1000, name: '张三' };

  let tasksRepo: { findAndCount: jest.Mock };
  let workersRepo: { find: jest.Mock };
  let workersService: { mustHumanWorker: jest.Mock };
  let personalAgents: { findForUser: jest.Mock };
  let service: WorkbenchService;

  beforeEach(() => {
    tasksRepo = {
      findAndCount: jest.fn().mockResolvedValue([[baseTask()], 1]),
    };
    workersRepo = { find: jest.fn().mockResolvedValue([{ id: 1001 }]) };
    workersService = {
      mustHumanWorker: jest.fn().mockResolvedValue(humanWorker),
    };
    personalAgents = { findForUser: jest.fn().mockResolvedValue(null) };
    service = new WorkbenchService(
      tasksRepo as never,
      workersRepo as never,
      workersService as never,
      personalAgents as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  /** 取首次 findAndCount 的 where 条件（避开 mock.calls 的 any） */
  function whereOfFirstCall(): Array<Record<string, unknown>> {
    const calls = tasksRepo.findAndCount.mock.calls as Array<
      [{ where: Array<Record<string, unknown>> }]
    >;
    return calls[0][0].where;
  }

  it('默认按创建时间倒序、每页 50 条', async () => {
    const result = await service.overview(user);

    expect(tasksRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: 0,
        take: 50,
      }),
    );
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 50 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].workbenchRoles).toEqual(['agent', 'requester']);
    expect(result.items[0].workbenchAction).toBe('接受任务');
  });

  it('分页参数生效且单页上限 200 条', async () => {
    const result = await service.overview(user, { page: 3, pageSize: 500 });

    expect(tasksRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 400, take: 200 }),
    );
    expect(result).toMatchObject({ page: 3, pageSize: 200 });
  });

  it('可见范围包含我执行、需求方、我负责的机器人与历史接管', async () => {
    await service.overview(user);

    const where = whereOfFirstCall();
    expect(where).toContainEqual(expect.objectContaining({ agentId: 1000 }));
    expect(where).toContainEqual(
      expect.objectContaining({ requesterType: 'worker', requesterId: 1000 }),
    );
    expect(where).toContainEqual(
      expect.objectContaining({ requesterType: 'user', requesterId: user.id }),
    );
    expect(where).toContainEqual(
      expect.objectContaining({ ownerTakeoverUserId: user.id }),
    );
    // 基础 4 条 + 我负责的机器人（1001）1 条
    expect(where).toHaveLength(5);
  });

  it('个人 AGENT 历史任务作为需求方仍然可见', async () => {
    personalAgents.findForUser.mockResolvedValue({ id: 2001 });

    await service.overview(user);

    const where = whereOfFirstCall();
    expect(where).toContainEqual(
      expect.objectContaining({ requesterType: 'worker', requesterId: 2001 }),
    );
  });
});
