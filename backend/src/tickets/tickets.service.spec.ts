import { BadRequestException } from '@nestjs/common';
import { TaskStatus, TaskSubStatus, WorkerRole } from '../common/enums';
import { Task } from '../tasks/task.entity';
import { TicketConfig } from './ticket-config.entity';
import { Ticket } from './ticket.entity';
import { TicketsService } from './tickets.service';

describe('TicketsService', () => {
  const user = {
    id: 7,
    name: '张三',
    enabled: true,
  };
  const worker = (id: number, over: Partial<Record<string, unknown>> = {}) => ({
    id,
    name: `机器人${id}`,
    role: WorkerRole.WORKER,
    enabled: true,
    ...over,
  });
  const task = (over: Partial<Task> = {}): Task =>
    ({
      id: 101,
      code: 'TK-0101',
      title: '方案工单',
      templateId: 1001,
      templateName: '方案设计',
      status: TaskStatus.RUNNING,
      subStatus: TaskSubStatus.EXECUTING,
      agentId: 1001,
      ...over,
    }) as Task;

  let tickets: {
    save: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let backlogs: { find: jest.Mock };
  let workflowRuns: { find: jest.Mock };
  let configs: { findOne: jest.Mock };
  let tasks: {
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
  };
  let templates: { findOne: jest.Mock; find: jest.Mock };
  let workers: { find: jest.Mock; findOne: jest.Mock };
  let tasksService: {
    create: jest.Mock;
    remove: jest.Mock;
    addEvent: jest.Mock;
  };
  let dispatchService: { assign: jest.Mock };
  let ticketDocuments: {
    findTicketForTask: jest.Mock;
    renderTicketSection: jest.Mock;
  };
  let workflowRuntime: {
    create: jest.Mock;
    workflowView: jest.Mock;
    acceptNode: jest.Mock;
  };
  let service: TicketsService;

  const config = {
    category: '方案工单',
    defaultTemplateId: 10,
    allowedTemplateIds: [1001],
    enabled: true,
  } as TicketConfig;

  beforeEach(() => {
    tickets = {
      save: jest.fn((value: Ticket) => {
        if (!value.id) value.id = 1;
        return Promise.resolve(value);
      }),
      create: jest.fn((value: Partial<Ticket>) => value),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
    };
    backlogs = { find: jest.fn().mockResolvedValue([]) };
    workflowRuns = { find: jest.fn().mockResolvedValue([]) };
    configs = {
      findOne: jest.fn().mockResolvedValue(config),
    };
    tasks = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((value: Task) => Promise.resolve(value)),
    };
    templates = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    };
    workers = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    tasksService = {
      create: jest.fn().mockResolvedValue(task()),
      remove: jest.fn().mockResolvedValue(undefined),
      addEvent: jest.fn().mockResolvedValue(undefined),
    };
    dispatchService = {
      assign: jest.fn().mockResolvedValue(
        task({
          status: TaskStatus.WAITING,
          subStatus: TaskSubStatus.PENDING_ACCEPTANCE,
        }),
      ),
    };
    ticketDocuments = {
      findTicketForTask: jest.fn().mockResolvedValue(null),
      renderTicketSection: jest
        .fn()
        .mockResolvedValue('## 交付文档\n\n（暂无交付文档）\n'),
    };
    workflowRuntime = {
      create: jest.fn(),
      workflowView: jest.fn().mockResolvedValue(null),
      acceptNode: jest.fn(),
    };
    service = new TicketsService(
      tickets as never,
      workflowRuns as never,
      configs as never,
      tasks as never,
      {} as never,
      templates as never,
      workers as never,
      {} as never,
      backlogs as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      tasksService as never,
      dispatchService as never,
      {} as never,
      ticketDocuments as never,
      workflowRuntime as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
    );
  });

  it('旧版类别工单拒绝创建，必须通过工单配置（工作流）创建', async () => {
    await expect(
      service.create({ category: '技术工单' } as never, {
        user: user as never,
      }),
    ).rejects.toThrow('旧版工单类别创建已下线');
    expect(workflowRuntime.create).not.toHaveBeenCalled();
    expect(tasksService.create).not.toHaveBeenCalled();
  });

  it('工作流工单委托运行时创建并返回运行视图', async () => {
    const created = {
      id: 3,
      code: 'WO-0003',
      workflowStatus: '处理中',
    } as Ticket;
    const view = { nodes: [], runs: [] };
    workflowRuntime.create.mockResolvedValue(created);
    workflowRuntime.workflowView.mockResolvedValue(view);

    const actor = { user: user as never, worker: null };
    const saved = await service.create(
      {
        workflowDefinitionId: 5,
        title: '发布 v1.2.0',
        inputValues: { title: '发布 v1.2.0' },
      },
      actor,
    );

    expect(workflowRuntime.create).toHaveBeenCalledWith(
      {
        workflowDefinitionId: 5,
        title: '发布 v1.2.0',
        inputValues: { title: '发布 v1.2.0' },
      },
      actor,
    );
    expect(saved).toMatchObject({
      code: 'WO-0003',
      status: '处理中',
      workflow: view,
    });
  });

  it('转交工单更新任务定义并强制目标机器人重新接受', async () => {
    tasks.findOne.mockResolvedValue(task({ agentId: 1001 }));
    tickets.findOne.mockResolvedValue({
      id: 1,
      code: 'WO-0001',
      category: '方案工单',
      taskId: 101,
    });
    templates.findOne.mockResolvedValue({
      id: 1001,
      name: '方案设计',
      agentIds: [1002],
    });
    workers.find.mockResolvedValue([worker(1002)]);

    const routed = await service.routeFromTask(101, worker(1001) as never, {
      templateId: 1001,
      title: '活动方案设计',
      content: '明确后的需求',
      outputSpec: '输出方案文档',
      workPlan: '先分析再设计',
    });

    expect(tasks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 1001,
        templateName: '方案设计',
        content: '明确后的需求',
      }),
    );
    expect(dispatchService.assign).toHaveBeenCalledWith(
      101,
      1002,
      '机器人1001',
      { force: true },
    );
    expect(routed.subStatus).toBe(TaskSubStatus.PENDING_ACCEPTANCE);
  });

  it('转交定义不在配置清单时拒绝', async () => {
    tasks.findOne.mockResolvedValue(task({ agentId: 1001 }));
    tickets.findOne.mockResolvedValue({
      id: 1,
      code: 'WO-0001',
      category: '方案工单',
      taskId: 101,
    });

    await expect(
      service.routeFromTask(101, worker(1001) as never, {
        templateId: 2002,
        title: '标题',
        content: '内容',
        outputSpec: '交付',
        workPlan: '计划',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(dispatchService.assign).not.toHaveBeenCalled();
  });

  it('查询我的工单时按参与身份过滤', async () => {
    const query = {
      andWhere: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    tickets.createQueryBuilder.mockReturnValue(query);
    workers.find.mockResolvedValue([{ id: 51 }, { id: 52 }]);
    workflowRuns.find.mockResolvedValue([{ ticketId: 11 }, { ticketId: 12 }]);
    tasks.find.mockResolvedValue([{ id: 101 }]);

    await service.findAll({ participantUserId: 7 });

    expect(query.andWhere).toHaveBeenCalledWith(
      `(${[
        't.createdById = :participantUserId',
        "(t.assigneeType = 'user' AND t.assigneeId = :participantUserId)",
        't.initiatorWorkerId IN (:...participantWorkerIds)',
        't.id IN (:...runTicketIds)',
        't.taskId IN (:...joinedTaskIds)',
      ].join(' OR ')})`,
      {
        participantUserId: 7,
        participantWorkerIds: [51, 52],
        runTicketIds: [11, 12],
        joinedTaskIds: [101],
      },
    );
  });

  it('用户没有绑定机器人时仍按创建人和历史处理人过滤', async () => {
    const query = {
      andWhere: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    tickets.createQueryBuilder.mockReturnValue(query);

    await service.findAll({ participantUserId: 7 });

    expect(query.andWhere).toHaveBeenCalledWith(
      `(${[
        't.createdById = :participantUserId',
        "(t.assigneeType = 'user' AND t.assigneeId = :participantUserId)",
      ].join(' OR ')})`,
      { participantUserId: 7 },
    );
  });

  it('未知工单类别筛选直接返回空列表', async () => {
    const query = {
      andWhere: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    tickets.createQueryBuilder.mockReturnValue(query);

    const page = await service.findAll({ category: '不存在的工单' });

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(query.andWhere).not.toHaveBeenCalled();
  });

  it('列表按页返回并限制页大小', async () => {
    const query = {
      andWhere: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 987]),
    };
    tickets.createQueryBuilder.mockReturnValue(query);

    const page = await service.findAll({ page: 3, pageSize: 999 });

    expect(query.skip).toHaveBeenCalledWith(200);
    expect(query.take).toHaveBeenCalledWith(100);
    expect(page.total).toBe(987);
    expect(page.page).toBe(3);
    expect(page.pageSize).toBe(100);
  });

  it('按需求聚合相关工单：迭代项提测工单与交付任务树工单去重后按更新时间倒序', async () => {
    const older = {
      id: 1,
      code: 'WO-0001',
      title: '提测工单',
      category: '提测',
      workflowStatus: '处理中',
      currentNodeName: '验收',
      initiatorWorkerName: '张三',
      backlogId: 11,
      taskId: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    } as Ticket;
    const newer = {
      id: 2,
      code: 'WO-0002',
      title: '任务工单',
      category: '设计',
      workflowStatus: '已完成',
      currentNodeName: null,
      initiatorWorkerName: null,
      backlogId: null,
      taskId: 202,
      createdAt: new Date('2026-01-03T00:00:00Z'),
      updatedAt: new Date('2026-01-04T00:00:00Z'),
    } as Ticket;
    backlogs.find.mockResolvedValue([
      { id: 11, taskId: 201 },
      { id: 12, taskId: null },
    ]);
    tasks.find.mockResolvedValue([{ id: 201 }, { id: 202 }]);
    tickets.find
      .mockResolvedValueOnce([older])
      .mockResolvedValueOnce([newer])
      .mockResolvedValueOnce([newer]);
    workflowRuns.find.mockResolvedValue([{ ticketId: 2 }]);

    const rows = await service.listByProject(3);

    expect(backlogs.find).toHaveBeenCalledWith({
      where: { projectId: 3 },
      select: { id: true, taskId: true },
    });
    expect(rows.map((row) => row.id)).toEqual([2, 1]);
    expect(rows[0]).toMatchObject({
      code: 'WO-0002',
      workflowStatus: '已完成',
      currentNodeName: null,
    });
  });
});
