import { BacklogStatus, IterationType, WorkerRole } from '../common/enums';
import { SYSTEM_BACKLOG_DELIVERY_TASK_TEMPLATE_ID } from '../tasks/system-task-templates';
import { BacklogsService } from './backlogs.service';

/** 只覆盖 list 的三个仓库：其余依赖在本用例中不会被调用 */
function buildService() {
  const backlogs = { find: jest.fn() };
  const iterations = { find: jest.fn() };
  const projects = { find: jest.fn().mockResolvedValue([]) };
  const service = new BacklogsService(
    backlogs as never,
    iterations as never,
    projects as never,
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
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, backlogs, iterations, projects };
}

const backlogRow = {
  id: 12,
  code: 'BL-12',
  projectId: 7,
  iterationId: 3,
  title: '礼包改版',
  status: BacklogStatus.EXECUTING,
  ownerWorkerId: 1001,
  ownerName: '张三',
  expectedOnlineAt: null,
  members: null,
  updatedAt: new Date('2026-11-16T10:00:00Z'),
};

describe('BacklogsService.list', () => {
  it('默认排除已取消，并附带迭代引用', async () => {
    const { service, backlogs, iterations } = buildService();
    backlogs.find.mockResolvedValue([backlogRow]);
    iterations.find.mockResolvedValue([
      { id: 3, code: '2026W47', type: IterationType.T7 },
    ]);

    const rows = await service.list({ projectId: 7 });

    // 未指定 status / includeCanceled 时必须带取消过滤
    const [findCall] = backlogs.find.mock.calls as [
      { where: Record<string, unknown> },
    ][];
    expect(findCall[0].where.projectId).toBe(7);
    expect(findCall[0].where.status).toBeDefined();
    expect(rows).toEqual([
      {
        ...backlogRow,
        owner: null,
        requirementType: '需求',
        iteration: { id: 3, code: '2026W47', type: IterationType.T7 },
      },
    ]);
  });

  it('需求方实时取自原始需求（projects.owner）', async () => {
    const { service, backlogs, iterations, projects } = buildService();
    backlogs.find.mockResolvedValue([backlogRow]);
    iterations.find.mockResolvedValue([
      { id: 3, code: '2026W47', type: IterationType.T7 },
    ]);
    projects.find.mockResolvedValue([
      { id: 7, owner: '张三、李四', type: '活动' },
    ]);

    const rows = await service.list({ projectId: 7 });

    expect(rows[0].owner).toBe('张三、李四');
    expect(rows[0].requirementType).toBe('活动');
    expect(projects.find).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { id: true, owner: true, type: true },
      }),
    );
  });

  it('includeCanceled 时不按状态过滤（含全部历史）', async () => {
    const { service, backlogs, iterations } = buildService();
    backlogs.find.mockResolvedValue([]);
    iterations.find.mockResolvedValue([]);

    await service.list({ projectId: 7, includeCanceled: true });

    expect(backlogs.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: 7 } }),
    );
    expect(iterations.find).not.toHaveBeenCalled();
  });

  it('迭代缺失时引用为 null', async () => {
    const { service, backlogs, iterations } = buildService();
    backlogs.find.mockResolvedValue([backlogRow]);
    iterations.find.mockResolvedValue([]);

    const rows = await service.list({ projectId: 7 });

    expect(rows[0].iteration).toBeNull();
  });
});

/** 新建任务只用到 backlogs/projects/workers/tasks/events/chat 等少量依赖 */
function buildTaskService() {
  const backlogs = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn((row: unknown) => Promise.resolve(row)),
  };
  const iterations = {
    findOne: jest
      .fn()
      .mockResolvedValue({ id: 3, code: '2026W47', type: IterationType.T7 }),
    find: jest
      .fn()
      .mockResolvedValue([{ id: 3, code: '2026W47', type: IterationType.T7 }]),
  };
  const projects = {
    findOne: jest.fn().mockResolvedValue({ id: 7, name: '礼包改版' }),
    find: jest
      .fn()
      .mockResolvedValue([{ id: 7, name: '礼包改版', owner: '王五' }]),
  };
  const workers = {
    findOne: jest.fn((args?: { where?: { humanUserId?: number } }) =>
      Promise.resolve(
        args?.where?.humanUserId ? { id: args.where.humanUserId } : undefined,
      ),
    ),
    find: jest.fn().mockResolvedValue([]),
  };
  const backlogEvents = {
    save: jest.fn(),
    create: jest.fn((row: unknown) => row),
  };
  const tasks = { create: jest.fn() };
  const taskContext = {
    buildSubtaskContext: jest
      .fn()
      .mockResolvedValue(
        '## 上下文（系统附加）\n- 任务树：#500 TK-0500 交付礼包改版',
      ),
  };
  const taskRows = {
    findOne: jest.fn().mockResolvedValue({ id: 500, title: '交付礼包改版' }),
    find: jest.fn().mockResolvedValue([]),
  };
  const chat = {
    describe: jest.fn().mockResolvedValue(null),
    createForBacklog: jest
      .fn()
      .mockResolvedValue({ state: 'active', chatId: 'oc_1', lastError: null }),
  };
  const releases = {
    prepareBatch: jest.fn().mockResolvedValue({
      ends: ['APP'],
      testers: ['赵六'],
      branches: [],
      urls: [],
      operator: '李四',
      workerId: null,
      sourceTaskId: null,
    }),
    createRecord: jest.fn().mockResolvedValue({ id: 21 }),
    notifyBatch: jest.fn().mockResolvedValue(true),
  };
  const tickets = { create: jest.fn() };
  const workflowDefs = { findOne: jest.fn() };
  const service = new BacklogsService(
    backlogs as never,
    iterations as never,
    projects as never,
    workers as never,
    {} as never,
    {} as never,
    backlogEvents as never,
    {} as never,
    taskRows as never,
    {} as never,
    {} as never,
    workflowDefs as never,
    {} as never,
    tickets as never,
    tasks as never,
    taskContext as never,
    chat as never,
    {} as never,
    releases as never,
  );
  return {
    service,
    backlogs,
    workers,
    tasks,
    taskContext,
    taskRows,
    iterations,
    projects,
    backlogEvents,
    chat,
    releases,
    tickets,
    workflowDefs,
  };
}

const memberActor = { userId: 21, userName: '李四', isAdmin: false };
const adminActor = { userId: 1, userName: '管理员', isAdmin: true };

describe('BacklogsService.createTask', () => {
  it('已有交付任务时作为其子任务创建，描述附带系统上下文（成员可操作）', async () => {
    const { service, backlogs, tasks, taskContext } = buildTaskService();
    backlogs.findOne.mockResolvedValue({
      ...backlogRow,
      taskId: 500,
      members: [{ role: '产品', workerId: 21, name: '李四' }],
    });
    tasks.create.mockResolvedValue({ id: 600, code: 'TK-0600' });

    const task = await service.createTask(
      12,
      { title: '拆分页面', description: '按模块拆分' },
      memberActor,
    );

    expect(task).toEqual({ id: 600, code: 'TK-0600' });
    expect(taskContext.buildSubtaskContext).toHaveBeenCalledWith(500);
    expect(tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: 500,
        projectId: 7,
        title: '拆分页面',
        createdById: 21,
      }),
    );
    const [[input]] = tasks.create.mock.calls as [[{ description: string }]];
    expect(input.description.startsWith('按模块拆分\n\n---\n\n')).toBe(true);
    expect(input.description).toContain('## 上下文（系统附加）');
    expect(backlogs.save).not.toHaveBeenCalled();
  });

  it('子任务描述缺省时直接使用系统上下文', async () => {
    const { service, backlogs, tasks } = buildTaskService();
    backlogs.findOne.mockResolvedValue({
      ...backlogRow,
      taskId: 500,
      members: [{ role: '产品', workerId: 21, name: '李四' }],
    });
    tasks.create.mockResolvedValue({ id: 600, code: 'TK-0600' });

    await service.createTask(12, { title: '拆分页面' }, memberActor);

    const [[input]] = tasks.create.mock.calls as [[{ description: string }]];
    expect(input.description).toBe(
      '## 上下文（系统附加）\n- 任务树：#500 TK-0500 交付礼包改版',
    );
  });

  it('已有交付任务但非成员非管理员时拒绝', async () => {
    const { service, backlogs, tasks } = buildTaskService();
    backlogs.findOne.mockResolvedValue({
      ...backlogRow,
      taskId: 500,
      members: null,
    });

    await expect(
      service.createTask(12, { description: '越权任务' }, memberActor),
    ).rejects.toThrow('仅迭代项成员或管理员可新建任务');
    expect(tasks.create).not.toHaveBeenCalled();
  });

  it('无交付任务时按负责人创建交付任务并登记负责人（管理员）', async () => {
    const { service, backlogs, workers, tasks, backlogEvents } =
      buildTaskService();
    backlogs.findOne.mockResolvedValue({
      ...backlogRow,
      taskId: null,
      ownerWorkerId: 1001,
      ownerName: '张三',
    });
    workers.findOne.mockResolvedValue({
      id: 1001,
      name: '张三',
      enabled: true,
      role: WorkerRole.WORKER,
      personalAgentUserId: null,
    });
    tasks.create.mockResolvedValue({ id: 600, code: 'TK-0600' });

    await service.createTask(12, {}, adminActor);

    expect(tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '迭代任务-礼包改版',
        templateId: SYSTEM_BACKLOG_DELIVERY_TASK_TEMPLATE_ID,
        agentId: 1001,
        projectId: 7,
      }),
    );
    expect(backlogs.save).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 600, ownerWorkerId: 1001 }),
    );
    const [[input]] = tasks.create.mock.calls as [[{ description: string }]];
    expect(input.description).toContain('迭代：#3 2026W47（T7）');
    expect(input.description).toContain('原始需求：礼包改版（#7）');
    expect(backlogEvents.save).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'owner' }),
    );
  });

  it('无交付任务时非管理员不可创建交付任务', async () => {
    const { service, backlogs, tasks } = buildTaskService();
    backlogs.findOne.mockResolvedValue({ ...backlogRow, taskId: null });

    await expect(service.createTask(12, {}, memberActor)).rejects.toThrow(
      '仅管理员可创建迭代项交付任务',
    );
    expect(tasks.create).not.toHaveBeenCalled();
  });
});

describe('BacklogsService.submitRelease', () => {
  it('单个迭代项：建工单 + 提测记录（绑定），汇总一条提测群消息', async () => {
    const {
      service,
      backlogs,
      workflowDefs,
      tickets,
      releases,
      backlogEvents,
    } = buildTaskService();
    backlogs.find.mockResolvedValue([
      {
        ...backlogRow,
        members: [
          { role: '前端', workerId: 21, name: '李四' },
          { role: '产品', workerId: 22, name: '产品A' },
        ],
      },
    ]);
    workflowDefs.findOne.mockResolvedValue({
      id: 9,
      enabled: true,
      latestPublishedVersion: 1,
    });
    tickets.create.mockResolvedValue({
      id: 11,
      code: 'WO-0011',
      title: '提测-BL-12 礼包改版',
      createdAt: new Date('2026-11-17T10:56:35Z'),
    });
    releases.createRecord.mockResolvedValue({ id: 21 });

    const result = await service.submitRelease(
      {
        items: [{ backlogId: 12, content: '回归登录' }],
        ends: ['APP', 'H5'],
        testers: ['赵六'],
        branches: [{ repo: 'LitaGroup/lita-h5', branch: 'test' }],
        urls: ['https://staging.example.com'],
      },
      memberActor,
      { user: { id: 21, name: '李四' } as never, worker: null },
    );

    expect(result).toEqual({
      title: '提测-BL-12 礼包改版',
      items: [
        {
          backlogId: 12,
          code: 'BL-12',
          title: '礼包改版',
          projectId: 7,
          ticketId: 11,
          ticketCode: 'WO-0011',
          releaseId: 21,
        },
      ],
    });
    expect(tickets.create).toHaveBeenCalledWith(
      expect.objectContaining({ backlogId: 12, workflowDefinitionId: 9 }),
      expect.anything(),
    );
    expect(releases.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 7,
        content: '回归登录',
        ends: ['APP'],
        testers: ['赵六'],
        ticketId: 11,
        ticketCode: 'WO-0011',
      }),
    );
    const [[ticketInput]] = tickets.create.mock.calls as [
      [
        {
          inputValues: {
            description: string;
            content: string;
            testEnds: string[];
            branch: string;
            url: string;
            backlogs: number[];
          };
        },
      ],
    ];
    expect(ticketInput.inputValues.description).toContain(
      '原始需求：礼包改版（#7）',
    );
    expect(ticketInput.inputValues.description).toContain('提测端：APP');
    expect(ticketInput.inputValues.description).toContain('回归登录');
    // 提测群消息模板直接引用的字段随工单带入
    expect(ticketInput.inputValues.content).toBe('回归登录');
    expect(ticketInput.inputValues.testEnds).toEqual(['APP']);
    expect(ticketInput.inputValues.branch).toBe('');
    expect(ticketInput.inputValues.url).toBe('');
    expect(ticketInput.inputValues.backlogs).toEqual([12]);
    expect(backlogEvents.save).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'release-ticket' }),
    );

    await new Promise((r) => setTimeout(r, 0)); // 放行 fire-and-forget 通知
    expect(releases.notifyBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '提测-BL-12 礼包改版',
        ends: ['APP'],
        operator: '李四',
        testers: ['赵六'],
        demanders: ['王五'],
        developers: ['李四'],
        items: [{ code: 'BL-12', title: '礼包改版', content: '回归登录' }],
      }),
    );
  });

  it('多个迭代项：标题自动「等x个迭代」，每个迭代项各建工单与提测记录', async () => {
    const {
      service,
      backlogs,
      projects,
      iterations,
      tickets,
      releases,
      workflowDefs,
    } = buildTaskService();
    workflowDefs.findOne.mockResolvedValue({
      id: 9,
      enabled: true,
      latestPublishedVersion: 1,
    });
    backlogs.find.mockResolvedValue([
      { ...backlogRow, members: [] },
      {
        ...backlogRow,
        id: 13,
        code: 'BL-13',
        projectId: 8,
        iterationId: 4,
        title: '签到优化',
        members: [],
      },
    ]);
    projects.find.mockResolvedValue([
      { id: 7, name: '礼包改版', owner: '王五' },
      { id: 8, name: '签到优化', owner: '赵六' },
    ]);
    iterations.find.mockResolvedValue([
      { id: 3, code: '2026W47', type: IterationType.T7 },
      { id: 4, code: '2026W48', type: IterationType.T7 },
    ]);
    tickets.create
      .mockResolvedValueOnce({ id: 11, code: 'WO-0011', title: 't1' })
      .mockResolvedValueOnce({ id: 12, code: 'WO-0012', title: 't2' });
    releases.createRecord
      .mockResolvedValueOnce({ id: 21 })
      .mockResolvedValueOnce({ id: 22 });

    const result = await service.submitRelease(
      {
        items: [
          { backlogId: 12, content: '回归登录' },
          { backlogId: 13, content: '回归签到' },
        ],
        ends: ['APP'],
        testers: ['钱七'],
      },
      adminActor,
      { user: { id: 1, name: '管理员' } as never, worker: null },
    );

    expect(result.title).toBe('礼包改版 等2个迭代');
    expect(result.items.map((item) => item.ticketCode)).toEqual([
      'WO-0011',
      'WO-0012',
    ]);
    expect(tickets.create).toHaveBeenCalledTimes(2);
    expect(releases.createRecord).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(releases.notifyBatch).toHaveBeenCalledTimes(1);
    expect(releases.notifyBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '礼包改版 等2个迭代',
        demanders: ['王五', '赵六'],
        items: [
          { code: 'BL-12', title: '礼包改版', content: '回归登录' },
          { code: 'BL-13', title: '签到优化', content: '回归签到' },
        ],
      }),
    );
  });

  it('非成员非管理员不可发起提测', async () => {
    const { service, backlogs, tickets } = buildTaskService();
    backlogs.find.mockResolvedValue([{ ...backlogRow, members: [] }]);

    await expect(
      service.submitRelease(
        { items: [{ backlogId: 12 }], ends: ['APP'], testers: ['赵六'] },
        memberActor,
        { user: { id: 21, name: '李四' } as never, worker: null },
      ),
    ).rejects.toThrow('仅所选迭代项成员或管理员可发起提测');
    expect(tickets.create).not.toHaveBeenCalled();
  });

  it('未选择迭代项 → 400', async () => {
    const { service } = buildTaskService();
    await expect(
      service.submitRelease(
        { items: [], ends: ['APP'], testers: ['赵六'] },
        adminActor,
        { user: { id: 1, name: '管理员' } as never, worker: null },
      ),
    ).rejects.toThrow('至少选择一个迭代项');
  });

  it('已取消的迭代项不可提测', async () => {
    const { service, backlogs } = buildTaskService();
    backlogs.find.mockResolvedValue([
      { ...backlogRow, status: BacklogStatus.CANCELED },
    ]);
    await expect(
      service.submitRelease(
        { items: [{ backlogId: 12 }], ends: ['APP'], testers: ['赵六'] },
        adminActor,
        { user: { id: 1, name: '管理员' } as never, worker: null },
      ),
    ).rejects.toThrow('已取消的迭代项不可提测');
  });
});

describe('BacklogsService.createFeishuChat', () => {
  it('成员触发手动建群并记录事件', async () => {
    const { service, backlogs, backlogEvents, chat } = buildTaskService();
    backlogs.findOne.mockResolvedValue({
      ...backlogRow,
      members: [{ role: '产品', workerId: 21, name: '李四' }],
    });
    const info = await service.createFeishuChat(12, memberActor);
    expect(chat.createForBacklog).toHaveBeenCalledWith(12);
    expect(info).toEqual({ state: 'active', chatId: 'oc_1', lastError: null });
    expect(backlogEvents.save).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'feishu-chat' }),
    );
  });

  it('非成员非管理员不可建群', async () => {
    const { service, backlogs, chat } = buildTaskService();
    backlogs.findOne.mockResolvedValue({ ...backlogRow, members: [] });
    await expect(service.createFeishuChat(12, memberActor)).rejects.toThrow(
      '仅迭代项成员或管理员可创建飞书群',
    );
    expect(chat.createForBacklog).not.toHaveBeenCalled();
  });
});
