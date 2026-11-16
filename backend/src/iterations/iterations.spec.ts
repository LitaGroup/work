import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { BacklogStatus, IterationType } from '../common/enums';
import { backlogChatName } from '../feishu-bot/feishu-bot-backlog-chat.service';
import { Backlog } from './backlog.entity';
import { BacklogsService } from './backlogs.service';
import type { Iteration } from './iteration.entity';
import {
  iterationWeekCode,
  IterationsService,
  isIterationCurrent,
  summarizeBacklogs,
} from './iterations.service';
import type { IterationActor } from './iteration.types';

function actor(overrides?: Partial<IterationActor>): IterationActor {
  return { userId: 7, userName: '小明', isAdmin: false, ...overrides };
}

function backlogRow(overrides?: Partial<Backlog>): Backlog {
  return {
    id: 1,
    code: 'BL-0001',
    iterationId: 10,
    projectId: 100,
    title: '需求 A',
    status: BacklogStatus.WAITING,
    ownerWorkerId: 2,
    ownerName: '机器人 A',
    expectedOnlineAt: null,
    members: null,
    taskId: 500,
    statusBy: null,
    startedAt: null,
    testingAt: null,
    releasingAt: null,
    completedAt: null,
    canceledAt: null,
    createdAt: new Date('2026-11-01T02:00:00Z'),
    updatedAt: new Date('2026-11-01T02:00:00Z'),
    ...overrides,
  };
}

function makeService(row: Backlog) {
  const findOne = jest.fn().mockResolvedValue(row);
  const save = jest
    .fn()
    .mockImplementation((value: Backlog) => Promise.resolve(value));
  const repository = { findOne, save } as never;
  const events = {
    create: jest.fn().mockImplementation((value: unknown) => value),
    save: jest.fn().mockResolvedValue(undefined),
  } as never;
  const tasks = { cancel: jest.fn().mockResolvedValue(undefined) };
  const chat = {
    notifyBacklog: jest.fn().mockResolvedValue(undefined),
    ensureForBacklog: jest.fn().mockResolvedValue(undefined),
  };
  const service = new BacklogsService(
    repository,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    events,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    tasks as never,
    chat as never,
    {} as never,
  );
  return { service, save, tasks, chat, events };
}

describe('summarizeBacklogs', () => {
  it('统计总数、完成数与百分比', () => {
    const progress = summarizeBacklogs([
      { status: BacklogStatus.COMPLETED },
      { status: BacklogStatus.WAITING },
      { status: BacklogStatus.COMPLETED },
      { status: BacklogStatus.TESTING },
    ]);
    expect(progress.total).toBe(4);
    expect(progress.done).toBe(2);
    expect(progress.percent).toBe(50);
    expect(progress.statusCounts[BacklogStatus.WAITING]).toBe(1);
  });

  it('空列表完成率为 0', () => {
    expect(summarizeBacklogs([]).percent).toBe(0);
  });
});

describe('isIterationCurrent', () => {
  it('T0 恒为当前迭代', () => {
    expect(
      isIterationCurrent({
        type: IterationType.T0,
        startAt: null,
        endAt: null,
      }),
    ).toBe(true);
  });

  it('T7 今天落在起止区间内时为当前', () => {
    expect(
      isIterationCurrent({
        type: IterationType.T7,
        startAt: '2000-01-01',
        endAt: '2999-12-31',
      }),
    ).toBe(true);
    expect(
      isIterationCurrent({
        type: IterationType.T7,
        startAt: '2000-01-01',
        endAt: '2000-01-02',
      }),
    ).toBe(false);
  });
});

describe('iterationWeekCode（T7 自然周标识）', () => {
  it('按开始日期所在自然周生成标识并补零', () => {
    expect(iterationWeekCode('2026-11-17')).toBe('2026W47');
    expect(iterationWeekCode('2026-01-06')).toBe('2026W02');
  });

  it('含 1 月 1 日的那周为第 1 周', () => {
    expect(iterationWeekCode('2026-01-01')).toBe('2026W01');
    // 2026-01-01 为周四，第 1 周自 2025-12-29（周一）起算
    expect(iterationWeekCode('2026-01-04')).toBe('2026W01');
  });

  it('跨年按开始日期的日历年与自然周计数', () => {
    expect(iterationWeekCode('2026-12-29')).toBe('2026W53');
    expect(iterationWeekCode('2027-01-05')).toBe('2027W02');
  });
});

function makeIterationsService(options?: {
  taken?: Iteration | null;
  rows?: Array<Pick<Iteration, 'code'>>;
}) {
  const iterations = {
    findOne: jest.fn().mockResolvedValue(options?.taken ?? null),
    find: jest.fn().mockResolvedValue(options?.rows ?? []),
    create: jest.fn().mockImplementation((value: unknown) => value),
    save: jest
      .fn()
      .mockImplementation((value: unknown) => Promise.resolve(value)),
  };
  const backlogs = { find: jest.fn().mockResolvedValue([]) };
  const projects = { find: jest.fn().mockResolvedValue([]) };
  const service = new IterationsService(
    iterations as never,
    backlogs as never,
    projects as never,
  );
  return { service, iterations };
}

const adminActor: IterationActor = {
  userId: 1,
  userName: '管理员',
  isAdmin: true,
};

describe('IterationsService.create', () => {
  it('T7 按开始日期所在周自动生成标识', async () => {
    const { service, iterations } = makeIterationsService();
    await service.create(
      {
        type: IterationType.T7,
        startAt: '2026-11-17',
        endAt: '2026-11-23',
      },
      adminActor,
    );
    expect(iterations.save).toHaveBeenCalledWith(
      expect.objectContaining({
        code: '2026W47',
        type: IterationType.T7,
        startAt: '2026-11-17',
        endAt: '2026-11-23',
      }),
    );
  });

  it('同周已有 T7 时拒绝创建并提示改用 Tx', async () => {
    const { service } = makeIterationsService({
      taken: { id: 9, code: '2026W47' } as Iteration,
    });
    await expect(
      service.create(
        {
          type: IterationType.T7,
          startAt: '2026-11-17',
          endAt: '2026-11-23',
        },
        adminActor,
      ),
    ).rejects.toThrow(/已有 T7 迭代 2026W47.*Tx/);
  });

  it('Tx 按当年内递增序号生成标识', async () => {
    const { service, iterations } = makeIterationsService({
      rows: [{ code: '2026Tx01' }, { code: '2026Tx03' }, { code: '2025Tx09' }],
    });
    await service.create(
      {
        type: IterationType.Tx,
        startAt: '2026-11-17',
        endAt: '2026-11-23',
      },
      adminActor,
    );
    expect(iterations.save).toHaveBeenCalledWith(
      expect.objectContaining({ code: '2026Tx04', type: IterationType.Tx }),
    );
  });

  it('标识并发冲突时重新生成并重试', async () => {
    const { service, iterations } = makeIterationsService();
    iterations.save
      .mockRejectedValueOnce(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      )
      .mockImplementation((value: unknown) => Promise.resolve(value));
    await service.create(
      {
        type: IterationType.Tx,
        startAt: '2026-11-17',
        endAt: '2026-11-23',
      },
      adminActor,
    );
    expect(iterations.save).toHaveBeenCalledTimes(2);
  });

  it('T0 为常驻单例，不可创建', async () => {
    const { service } = makeIterationsService();
    await expect(
      service.create(
        {
          type: IterationType.T0,
          startAt: '2026-11-17',
          endAt: '2026-11-23',
        },
        adminActor,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('缺少起止日期时拒绝创建', async () => {
    const { service } = makeIterationsService();
    await expect(
      service.create({ type: IterationType.T7 }, adminActor),
    ).rejects.toThrow(BadRequestException);
  });

  it('非管理员不可创建', async () => {
    const { service } = makeIterationsService();
    await expect(
      service.create(
        {
          type: IterationType.T7,
          startAt: '2026-11-17',
          endAt: '2026-11-23',
        },
        { ...adminActor, isAdmin: false },
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('backlogChatName', () => {
  it('保留固定前后缀并截断超长标题', () => {
    const name = backlogChatName('很长的迭代项标题'.repeat(30));
    expect(name.startsWith('LitaWork-迭代-')).toBe(true);
    expect(name.endsWith(' 沟通群')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(80);
  });
});

describe('BacklogsService.updateStatus', () => {
  it('推进到执行记录开始时间与操作人', async () => {
    const { service, save } = makeService(backlogRow());
    const updated = await service.updateStatus(
      1,
      BacklogStatus.EXECUTING,
      actor({ isAdmin: true }),
    );
    expect(updated.status).toBe(BacklogStatus.EXECUTING);
    expect(updated.startedAt).toBeInstanceOf(Date);
    expect(updated.statusBy).toBe('小明');
    expect(save).toHaveBeenCalled();
  });

  it('回退到等待清空后续阶段时间', async () => {
    const { service } = makeService(
      backlogRow({
        status: BacklogStatus.TESTING,
        startedAt: new Date(),
        testingAt: new Date(),
      }),
    );
    const updated = await service.updateStatus(
      1,
      BacklogStatus.WAITING,
      actor({ isAdmin: true }),
    );
    expect(updated.startedAt).toBeNull();
    expect(updated.testingAt).toBeNull();
  });

  it('终态不可再变更', async () => {
    const { service } = makeService(
      backlogRow({ status: BacklogStatus.COMPLETED }),
    );
    await expect(
      service.updateStatus(
        1,
        BacklogStatus.EXECUTING,
        actor({ isAdmin: true }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('取消时联动取消交付任务并通知沟通群', async () => {
    const { service, tasks, chat } = makeService(
      backlogRow({ status: BacklogStatus.EXECUTING, startedAt: new Date() }),
    );
    const updated = await service.updateStatus(
      1,
      BacklogStatus.CANCELED,
      actor({ isAdmin: true }),
    );
    expect(updated.canceledAt).toBeInstanceOf(Date);
    expect(tasks.cancel).toHaveBeenCalledWith(500, '小明');
    expect(chat.notifyBacklog).toHaveBeenCalledWith(1);
  });

  it('非成员非管理员不可推进状态', async () => {
    const { service } = makeService(backlogRow());
    await expect(
      service.updateStatus(1, BacklogStatus.EXECUTING, actor()),
    ).rejects.toThrow(ForbiddenException);
  });

  it('成员可推进状态', async () => {
    const { service } = makeService(
      backlogRow({ members: [{ role: '产品', userId: 7, name: '小明' }] }),
    );
    const updated = await service.updateStatus(
      1,
      BacklogStatus.EXECUTING,
      actor(),
    );
    expect(updated.status).toBe(BacklogStatus.EXECUTING);
  });

  it('推进状态写入事件流（含备注）', async () => {
    const { service, events } = makeService(
      backlogRow({ status: BacklogStatus.WAITING }),
    );
    await service.updateStatus(
      1,
      BacklogStatus.EXECUTING,
      actor({ isAdmin: true }),
      '开始开发',
    );
    expect(events.save).toHaveBeenCalledWith(
      expect.objectContaining({
        backlogId: 1,
        type: 'status',
        payload: { from: '等待', to: '执行', remark: '开始开发' },
        operator: '小明',
      }),
    );
  });

  it('推进状态备注为空时事件 remark 落 null', async () => {
    const { service, events } = makeService(
      backlogRow({ status: BacklogStatus.WAITING }),
    );
    await service.updateStatus(
      1,
      BacklogStatus.EXECUTING,
      actor({ isAdmin: true }),
      '  ',
    );
    expect(events.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'status',
        payload: { from: '等待', to: '执行', remark: null },
      }),
    );
  });
});

describe('BacklogsService.updateBacklog', () => {
  it('成员可设置预期上线时间', async () => {
    const { service, save } = makeService(
      backlogRow({ members: [{ role: '产品', userId: 7, name: '小明' }] }),
    );
    const updated = await service.updateBacklog(
      1,
      { expectedOnlineAt: '2026-11-20T10:00:00+08:00' },
      actor(),
    );
    expect(updated.expectedOnlineAt).toBeInstanceOf(Date);
    expect(save).toHaveBeenCalled();
  });

  it('传 null 清空预期上线时间', async () => {
    const { service } = makeService(
      backlogRow({
        members: [{ role: '产品', userId: 7, name: '小明' }],
        expectedOnlineAt: new Date(),
      }),
    );
    const updated = await service.updateBacklog(
      1,
      { expectedOnlineAt: null },
      actor(),
    );
    expect(updated.expectedOnlineAt).toBeNull();
  });

  it('非法时间格式返回 400', async () => {
    const { service } = makeService(
      backlogRow({ members: [{ role: '产品', userId: 7, name: '小明' }] }),
    );
    await expect(
      service.updateBacklog(1, { expectedOnlineAt: 'not-a-date' }, actor()),
    ).rejects.toThrow(BadRequestException);
  });

  it('非成员非管理员不可编辑属性', async () => {
    const { service } = makeService(backlogRow());
    await expect(
      service.updateBacklog(
        1,
        { expectedOnlineAt: '2026-11-20T10:00:00+08:00' },
        actor(),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

/** 取 mock 首次调用的第一个参数（带类型，避免 any 访问） */
function callArg<T>(mock: jest.Mock, index = 0): T {
  const calls = mock.mock.calls as unknown[][];
  return calls[index]?.[0] as T;
}

/** 负责人相关流程：可空负责人、补指定与改派重建交付任务 */
function makeOwnerFixture(overrides?: {
  row?: Backlog;
  worker?: Record<string, unknown> | null;
  project?: { id: number; name: string } | null;
  iteration?: Record<string, unknown> | null;
  projectRows?: Array<{
    id: number;
    name: string;
  }>;
}) {
  let nextId = 501;
  const save = jest
    .fn()
    .mockImplementation((value: Partial<Backlog>) =>
      Promise.resolve({ ...value, id: value.id ?? nextId++ }),
    );
  const backlogs = {
    findOne: jest.fn().mockResolvedValue(overrides?.row ?? null),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((value: unknown) => value),
    save,
  };
  const iterations = {
    findOne: jest.fn().mockResolvedValue(overrides?.iteration ?? null),
  };
  const projects = {
    find: jest.fn().mockResolvedValue(overrides?.projectRows ?? []),
    findOne: jest.fn().mockResolvedValue(overrides?.project ?? null),
  };
  const workers = {
    find: jest
      .fn()
      .mockResolvedValue(overrides?.worker ? [overrides.worker] : []),
    findOne: jest.fn().mockResolvedValue(overrides?.worker ?? null),
  };
  const events = {
    create: jest.fn().mockImplementation((value: unknown) => value),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const tasks = {
    create: jest.fn().mockResolvedValue({ id: 777 }),
    cancel: jest.fn().mockResolvedValue(undefined),
  };
  const chat = {
    ensureForBacklog: jest.fn().mockResolvedValue(undefined),
    notifyBacklog: jest.fn().mockResolvedValue(undefined),
  };
  const service = new BacklogsService(
    backlogs as never,
    iterations as never,
    projects as never,
    workers as never,
    { find: jest.fn().mockResolvedValue([]) } as never,
    {} as never,
    events as never,
    { find: jest.fn().mockResolvedValue([]) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    tasks as never,
    chat as never,
    {} as never,
  );
  return { service, save, tasks, chat, events, backlogs };
}

const workerRow = {
  id: 9,
  name: '机器人 B',
  enabled: true,
  role: '工作者',
};

describe('BacklogsService 无负责人转入', () => {
  it('未指定负责人时不创建交付任务', async () => {
    const fixture = makeOwnerFixture({
      projectRows: [{ id: 100, name: '需求 A' }],
      iteration: { id: 10, code: '2026W47', type: 'T7', status: '进行中' },
    });
    const [created] = await fixture.service.createBatch(
      10,
      [{ projectId: 100 }],
      { userId: 1, userName: '管理员', isAdmin: true },
    );
    expect(created.ownerWorkerId).toBeNull();
    expect(created.ownerName).toBeNull();
    expect(created.taskId).toBeNull();
    expect(fixture.tasks.create).not.toHaveBeenCalled();
  });

  it('指定负责人时按负责人创建交付任务', async () => {
    const fixture = makeOwnerFixture({
      projectRows: [{ id: 100, name: '需求 A' }],
      iteration: { id: 10, code: '2026W47', type: 'T7', status: '进行中' },
      worker: workerRow,
    });
    const [created] = await fixture.service.createBatch(
      10,
      [{ projectId: 100, ownerWorkerId: 9 }],
      { userId: 1, userName: '管理员', isAdmin: true },
    );
    expect(fixture.tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 9 }),
    );
    expect(created.ownerName).toBe('机器人 B');
    expect(created.taskId).toBe(777);
  });
});

describe('BacklogsService 指定/改派负责人', () => {
  it('未指定时可补指定并补建交付任务', async () => {
    const fixture = makeOwnerFixture({
      row: backlogRow({ ownerWorkerId: null, ownerName: null, taskId: null }),
      worker: workerRow,
      project: { id: 100, name: '需求 A' },
      iteration: { id: 10, code: '2026W47', type: 'T7' },
    });
    const updated = await fixture.service.updateBacklog(
      1,
      { ownerWorkerId: 9 },
      { userId: 1, userName: '管理员', isAdmin: true },
    );
    expect(fixture.tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 9 }),
    );
    expect(fixture.tasks.cancel).not.toHaveBeenCalled();
    expect(updated.ownerWorkerId).toBe(9);
    expect(updated.ownerName).toBe('机器人 B');
    expect(updated.taskId).toBe(777);
    const event = callArg<{
      backlogId: number;
      type: string;
      payload: { to?: string; taskId?: number };
    }>(fixture.events.save);
    expect(event.backlogId).toBe(1);
    expect(event.type).toBe('owner');
    expect(event.payload.to).toBe('机器人 B');
    expect(event.payload.taskId).toBe(777);
    expect(fixture.chat.ensureForBacklog).toHaveBeenCalledWith(1);
  });

  it('改派时取消旧交付任务并按新负责人重建', async () => {
    const fixture = makeOwnerFixture({
      row: backlogRow({
        taskId: 500,
        ownerWorkerId: 2,
        ownerName: '机器人 A',
      }),
      worker: workerRow,
      project: { id: 100, name: '需求 A' },
      iteration: { id: 10, code: '2026W47', type: 'T7' },
    });
    const updated = await fixture.service.updateBacklog(
      1,
      { ownerWorkerId: 9 },
      { userId: 1, userName: '管理员', isAdmin: true },
    );
    expect(fixture.tasks.cancel).toHaveBeenCalledWith(500, '管理员');
    expect(fixture.tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 9 }),
    );
    expect(updated.taskId).toBe(777);
  });

  it('旧任务取消失败不阻断重建', async () => {
    const fixture = makeOwnerFixture({
      row: backlogRow({ taskId: 500 }),
      worker: workerRow,
      project: { id: 100, name: '需求 A' },
      iteration: { id: 10, code: '2026W47', type: 'T7' },
    });
    fixture.tasks.cancel.mockRejectedValueOnce(new Error('already finished'));
    const updated = await fixture.service.updateBacklog(
      1,
      { ownerWorkerId: 9 },
      { userId: 1, userName: '管理员', isAdmin: true },
    );
    expect(updated.taskId).toBe(777);
  });

  it('不支持清空负责人', async () => {
    const fixture = makeOwnerFixture({ row: backlogRow() });
    await expect(
      fixture.service.updateBacklog(
        1,
        { ownerWorkerId: null },
        { userId: 1, userName: '管理员', isAdmin: true },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('非管理员不可指定负责人', async () => {
    const fixture = makeOwnerFixture({
      row: backlogRow({
        members: [{ role: '产品', userId: 7, name: '小明' }],
      }),
    });
    await expect(
      fixture.service.updateBacklog(1, { ownerWorkerId: 9 }, actor()),
    ).rejects.toThrow(ForbiddenException);
  });

  it('已结束的迭代项不可改派', async () => {
    const fixture = makeOwnerFixture({
      row: backlogRow({ status: BacklogStatus.COMPLETED }),
    });
    await expect(
      fixture.service.updateBacklog(
        1,
        { ownerWorkerId: 9 },
        { userId: 1, userName: '管理员', isAdmin: true },
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('BacklogsService 成员更新（MCP / 网页）', () => {
  function makeMembersFixture(options?: {
    row?: Backlog;
    users?: Array<{ id: number; name: string; enabled?: boolean }>;
    humanWorker?: { id: number; humanUserId: number } | null;
  }) {
    const row = options?.row ?? backlogRow();
    const users = options?.users ?? [
      { id: 7, name: '小明' },
      { id: 8, name: '小红' },
      { id: 9, name: '小刚' },
    ];
    const save = jest
      .fn()
      .mockImplementation((value: Backlog) => Promise.resolve(value));
    const repository = {
      findOne: jest.fn().mockResolvedValue(row),
      save,
    };
    const events = {
      create: jest.fn().mockImplementation((value: unknown) => value),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const usersRepo = {
      find: jest.fn(
        (args?: {
          where?: {
            id?: { value: number[] };
            name?: { value: string[] };
          };
        }) => {
          const where = args?.where ?? {};
          if (where.name) {
            const names = where.name.value;
            return Promise.resolve(
              users.filter(
                (user) => names.includes(user.name) && user.enabled !== false,
              ),
            );
          }
          if (where.id) {
            const ids = where.id.value;
            return Promise.resolve(
              users.filter((user) => ids.includes(user.id)),
            );
          }
          return Promise.resolve([]);
        },
      ),
    };
    const workersRepo = {
      findOne: jest.fn().mockResolvedValue(options?.humanWorker ?? null),
    };
    const service = new BacklogsService(
      repository as never,
      {} as never,
      {} as never,
      workersRepo as never,
      usersRepo as never,
      {} as never,
      events as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, save, events, usersRepo, workersRepo };
  }

  it('管理员按 userId 整体替换成员并记录 members 事件', async () => {
    const fixture = makeMembersFixture({
      row: backlogRow({
        members: [{ role: '产品', userId: 7, name: '小明' }],
      }),
    });
    const updated = await fixture.service.updateMembers(
      1,
      [{ role: '前端', userId: 8 }],
      { userId: 1, userName: '管理员', isAdmin: true },
    );
    expect(updated.members).toEqual([
      { role: '前端', userId: 8, name: '小红' },
    ]);
    expect(fixture.events.save).toHaveBeenCalledWith(
      expect.objectContaining({
        backlogId: 1,
        type: 'members',
        operator: '管理员',
        payload: {
          from: [{ role: '产品', userId: 7, name: '小明' }],
          to: [{ role: '前端', userId: 8, name: '小红' }],
        },
      }),
    );
  });

  it('姓名入参支持顿号连接多人', async () => {
    const fixture = makeMembersFixture();
    const updated = await fixture.service.updateMembers(
      1,
      [{ role: '测试', name: '小明、小红' }],
      { userId: 1, userName: '管理员', isAdmin: true },
    );
    expect(updated.members).toEqual([
      { role: '测试', userId: 7, name: '小明' },
      { role: '测试', userId: 8, name: '小红' },
    ]);
  });

  it('姓名不存在或已停用时报错并列出姓名', async () => {
    const fixture = makeMembersFixture();
    await expect(
      fixture.service.updateMembers(
        1,
        [{ role: '测试', name: '小明、不存在的人' }],
        { userId: 1, userName: '管理员', isAdmin: true },
      ),
    ).rejects.toThrow(/不存在的人/);
  });

  it('空数组清空成员', async () => {
    const fixture = makeMembersFixture({
      row: backlogRow({
        members: [{ role: '产品', userId: 7, name: '小明' }],
      }),
    });
    const updated = await fixture.service.updateMembers(1, [], {
      userId: 1,
      userName: '管理员',
      isAdmin: true,
    });
    expect(updated.members).toBeNull();
  });

  it('迭代项负责人机器人可更新成员', async () => {
    const fixture = makeMembersFixture({
      row: backlogRow({ ownerWorkerId: 2 }),
    });
    const updated = await fixture.service.updateMembers(
      1,
      [{ role: '后端', userId: 9 }],
      { userId: null, userName: '机器人 A', isAdmin: false, workerId: 2 },
    );
    expect(updated.members).toEqual([
      { role: '后端', userId: 9, name: '小刚' },
    ]);
  });

  it('网页负责人真人登录（经其真人机器人）可更新成员', async () => {
    const fixture = makeMembersFixture({
      row: backlogRow({ ownerWorkerId: 9 }),
      humanWorker: { id: 9, humanUserId: 7 },
    });
    const updated = await fixture.service.updateMembers(
      1,
      [{ role: '后端', userId: 8 }],
      { userId: 7, userName: '小明', isAdmin: false },
    );
    expect(updated.members).toEqual([
      { role: '后端', userId: 8, name: '小红' },
    ]);
  });

  it('非管理员且非负责人不可更新成员', async () => {
    const fixture = makeMembersFixture({
      row: backlogRow({ ownerWorkerId: 2 }),
      humanWorker: null,
    });
    await expect(
      fixture.service.updateMembers(1, [{ role: '前端', userId: 8 }], {
        userId: 7,
        userName: '小明',
        isAdmin: false,
      }),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('BacklogsService.list', () => {
  it('默认排除取消项并限制条数', async () => {
    const fixture = makeOwnerFixture();
    await fixture.service.list({});
    const args = callArg<{
      where: { status?: unknown };
      take: number;
    }>(fixture.backlogs.find);
    expect(args.where.status).toBeDefined();
    expect(args.take).toBe(1000);
  });
});
