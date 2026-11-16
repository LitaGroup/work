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
    projects.find.mockResolvedValue([{ id: 7, owner: '张三、李四' }]);

    const rows = await service.list({ projectId: 7 });

    expect(rows[0].owner).toBe('张三、李四');
    expect(projects.find).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, owner: true } }),
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
    save: jest.fn((row: unknown) => Promise.resolve(row)),
  };
  const iterations = {
    findOne: jest
      .fn()
      .mockResolvedValue({ id: 3, code: '2026W47', type: IterationType.T7 }),
  };
  const projects = {
    findOne: jest.fn().mockResolvedValue({ id: 7, name: '礼包改版' }),
  };
  const workers = { findOne: jest.fn() };
  const backlogEvents = {
    save: jest.fn(),
    create: jest.fn((row: unknown) => row),
  };
  const tasks = { create: jest.fn() };
  const chat = { ensureForBacklog: jest.fn().mockResolvedValue(undefined) };
  const service = new BacklogsService(
    backlogs as never,
    iterations as never,
    projects as never,
    workers as never,
    {} as never,
    {} as never,
    backlogEvents as never,
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
  return { service, backlogs, workers, tasks, backlogEvents, chat };
}

const memberActor = { userId: 21, userName: '李四', isAdmin: false };
const adminActor = { userId: 1, userName: '管理员', isAdmin: true };

describe('BacklogsService.createTask', () => {
  it('已有交付任务时作为其子任务创建（成员可操作）', async () => {
    const { service, backlogs, tasks } = buildTaskService();
    backlogs.findOne.mockResolvedValue({
      ...backlogRow,
      taskId: 500,
      members: [{ role: '产品', userId: 21, name: '李四' }],
    });
    tasks.create.mockResolvedValue({ id: 600, code: 'TK-0600' });

    const task = await service.createTask(
      12,
      { title: '拆分页面', description: '按模块拆分' },
      memberActor,
    );

    expect(task).toEqual({ id: 600, code: 'TK-0600' });
    expect(tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: 500,
        projectId: 7,
        title: '拆分页面',
        description: '按模块拆分',
        createdById: 21,
      }),
    );
    expect(backlogs.save).not.toHaveBeenCalled();
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
    const { service, backlogs, workers, tasks, backlogEvents, chat } =
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
    expect(backlogEvents.save).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'owner' }),
    );
    expect(chat.ensureForBacklog).toHaveBeenCalledWith(12);
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
