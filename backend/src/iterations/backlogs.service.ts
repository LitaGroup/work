import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { FindOptionsWhere, In, Not, Repository } from 'typeorm';
import {
  AUTO_BACKLOG_MEMBER_ROLES,
  BacklogMemberRole,
  BacklogStatus,
  IterationStatus,
  MANUAL_BACKLOG_MEMBER_ROLES,
  TopicSubjectType,
  WorkerRole,
} from '../common/enums';
import { beijingTime, mdFrontmatter } from '../common/frontmatter';
import { splitMemberNames } from '../common/names';
import { Document } from '../documents/document.entity';
import { Project } from '../projects/project.entity';
import { User } from '../auth/user.entity';
import { Task } from '../tasks/task.entity';
import { TaskContextService } from '../tasks/task-context.service';
import { TasksService } from '../tasks/tasks.service';
import { SYSTEM_BACKLOG_DELIVERY_TASK_TEMPLATE_ID } from '../tasks/system-task-templates';
import { Ticket } from '../tickets/ticket.entity';
import { TicketWorkflowRun } from '../tickets/ticket-workflow-run.entity';
import { TicketsService } from '../tickets/tickets.service';
import { Worker } from '../workers/worker.entity';
import { WorkflowDefinition } from '../workflows/workflow-definition.entity';
import { WorkflowDefinitionVersion } from '../workflows/workflow-definition-version.entity';
import { RELEASE_TICKET_WORKFLOW } from '../workflows/system-workflows';
import { LlmService } from '../model-config/llm.service';
import {
  ReleasesService,
  SubmitReleaseBatchInput,
} from '../releases/releases.service';
import { FeishuBotBacklogChatService } from '../feishu-bot/feishu-bot-backlog-chat.service';
import type { BacklogChatInfo } from '../feishu-bot/feishu-bot-backlog-chat.service';
import { Backlog, BacklogMember } from './backlog.entity';
import { BacklogDocument } from './backlog-document.entity';
import { BacklogEvent } from './backlog-event.entity';
import { Iteration } from './iteration.entity';
import { Topic } from '../topics/topic.entity';
import { topicSectionFor } from '../topics/topic-markdown';
import {
  BacklogMemberInput,
  BacklogReleaseItemResult,
  BacklogReleaseResult,
  BacklogReleaseWorkflow,
  BacklogTaskSummary,
  BacklogTicketSummary,
  CreateBacklogItemInput,
  CreateBacklogTaskInput,
  IterationActor,
} from './iteration.types';

/** 迭代项轻量列表查询 */
export interface BacklogListQuery {
  iterationId?: number;
  projectId?: number;
  status?: BacklogStatus;
  /** true：包含已取消的迭代项（需求详情「对应的迭代」展示全部历史） */
  includeCanceled?: boolean;
}

/** 轻量列表项：附带所属迭代引用，供需求详情展示对应的迭代 */
export type BacklogListItem = Pick<
  Backlog,
  | 'id'
  | 'code'
  | 'projectId'
  | 'iterationId'
  | 'title'
  | 'status'
  | 'ownerWorkerId'
  | 'ownerName'
  | 'expectedOnlineAt'
  | 'members'
  | 'updatedAt'
> & {
  /** 需求方：实时取自原始需求 projects.owner（不落库） */
  owner: string | null;
  /** 原始需求类型（projects.type，如 活动/功能；供工单输入展示） */
  requirementType: string;
  iteration: {
    id: number;
    code: string;
    type: Iteration['type'];
  } | null;
};

/** 轻量列表上限（选择器只关心未取消项） */
const BACKLOG_LIST_LIMIT = 1000;

/**
 * 提测工单保留字段：由提测弹窗专用控件承载并映射进工单 inputValues，
 * 不从动态字段区透传（配置驱动渲染时跳过这些 key，避免重复输入）。
 * 提测端选项、补充描述与迭代项完全以工单配置为准；代码分支/访问地址等
 * 作为普通字段由工单配置定义并按类型动态渲染。
 */
const RELEASE_RESERVED_INPUT_KEYS = new Set([
  'title',
  'description',
  'backlogs',
  'testEnds',
]);

/**
 * 迭代项（Backlog）：从需求转入，负责人可暂不指定（指定后自动创建交付任务）；
 * 飞书沟通群由成员/管理员在详情页手动创建；状态由成员/管理员手动流转。
 */
@Injectable()
export class BacklogsService implements OnModuleInit {
  private readonly logger = new Logger(BacklogsService.name);

  /** 进行中的标题生成（防重复调度） */
  private readonly titleNaming = new Set<number>();

  constructor(
    @InjectRepository(Backlog)
    private readonly backlogs: Repository<Backlog>,
    @InjectRepository(Iteration)
    private readonly iterations: Repository<Iteration>,
    @InjectRepository(Project)
    private readonly projects: Repository<Project>,
    @InjectRepository(Worker)
    private readonly workers: Repository<Worker>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(BacklogDocument)
    private readonly backlogDocuments: Repository<BacklogDocument>,
    @InjectRepository(BacklogEvent)
    private readonly backlogEvents: Repository<BacklogEvent>,
    @InjectRepository(Document)
    private readonly documents: Repository<Document>,
    @InjectRepository(Task)
    private readonly taskRows: Repository<Task>,
    @InjectRepository(Ticket)
    private readonly ticketRows: Repository<Ticket>,
    @InjectRepository(TicketWorkflowRun)
    private readonly ticketRunRows: Repository<TicketWorkflowRun>,
    @InjectRepository(WorkflowDefinition)
    private readonly workflowDefs: Repository<WorkflowDefinition>,
    @InjectRepository(WorkflowDefinitionVersion)
    private readonly workflowVersions: Repository<WorkflowDefinitionVersion>,
    @InjectRepository(Topic)
    private readonly topicRows: Repository<Topic>,
    private readonly ticketsService: TicketsService,
    private readonly tasks: TasksService,
    private readonly taskContext: TaskContextService,
    private readonly chat: FeishuBotBacklogChatService,
    private readonly llm: LlmService,
    private readonly releases: ReleasesService,
  ) {}

  /** 启动时补齐存量迭代项的自动成员行（负责人/需求方），只改成员不动飞书群 */
  onModuleInit(): void {
    void this.backfillAutoMembers();
  }

  private async backfillAutoMembers(): Promise<void> {
    try {
      const rows = await this.backlogs.find({
        where: { status: Not(BacklogStatus.CANCELED) },
      });
      let changed = 0;
      for (const backlog of rows) {
        if (await this.refreshAutoMembers(backlog)) {
          await this.backlogs.save(backlog);
          changed += 1;
        }
      }
      if (changed > 0) {
        this.logger.log(`已补齐 ${changed} 个迭代项的自动成员行`);
      }
    } catch (error) {
      this.logger.warn(`迭代项自动成员行补齐失败：${(error as Error).message}`);
    }
  }

  /**
   * 迭代项轻量列表（默认仅未取消，含各迭代），供选择器过滤已进入迭代的需求。
   * 传 includeCanceled=true 时返回全部历史（需求详情查看该需求的全部迭代项）。
   * 上限 1000 条：判重仍由转入接口兜底。
   */
  async list(query: BacklogListQuery): Promise<BacklogListItem[]> {
    const where: FindOptionsWhere<Backlog> = {};
    if (query.iterationId) where.iterationId = query.iterationId;
    if (query.projectId) where.projectId = query.projectId;
    if (query.status) where.status = query.status;
    else if (!query.includeCanceled) where.status = Not(BacklogStatus.CANCELED);
    const rows = await this.backlogs.find({
      where,
      select: {
        id: true,
        code: true,
        projectId: true,
        iterationId: true,
        title: true,
        status: true,
        ownerWorkerId: true,
        ownerName: true,
        expectedOnlineAt: true,
        members: true,
        updatedAt: true,
      },
      order: { id: 'DESC' },
      take: BACKLOG_LIST_LIMIT,
    });
    const iterationIds = [...new Set(rows.map((row) => row.iterationId))];
    const iterations = iterationIds.length
      ? await this.iterations.find({ where: { id: In(iterationIds) } })
      : [];
    const iterationById = new Map(iterations.map((it) => [it.id, it]));
    // 需求方实时取原始需求（projects.owner），不落库
    const projectIds = [...new Set(rows.map((row) => row.projectId))];
    const projects = projectIds.length
      ? await this.projects.find({
          where: { id: In(projectIds) },
          select: { id: true, owner: true, type: true },
        })
      : [];
    const projectById = new Map(
      projects.map((project) => [project.id, project]),
    );
    return rows.map((row) => {
      const iteration = iterationById.get(row.iterationId);
      const project = projectById.get(row.projectId);
      return {
        ...row,
        owner: project?.owner ?? null,
        requirementType: project?.type ?? '需求',
        iteration: iteration
          ? { id: iteration.id, code: iteration.code, type: iteration.type }
          : null,
      };
    });
  }

  /**
   * 批量转入：把选中的需求转为指定迭代的 backlog。
   * 负责人可暂不指定（不建交付任务，后续指定时补建）；创建后自动建飞书群（失败不阻断）。
   */
  async createBatch(
    iterationId: number,
    items: CreateBacklogItemInput[],
    actor: IterationActor,
  ): Promise<Backlog[]> {
    this.assertAdmin(actor, '仅管理员可将需求转入迭代');
    const iteration = await this.iterations.findOne({
      where: { id: iterationId },
    });
    if (!iteration) {
      throw new NotFoundException(`Iteration ${iterationId} not found`);
    }
    if (iteration.status === IterationStatus.CLOSED) {
      throw new BadRequestException('迭代已结束，不能再追加迭代项');
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('请至少选择一个需求');
    }

    const projectIds = items.map((item) => item.projectId);
    const ownerIds = [
      ...new Set(
        items
          .map((item) => item.ownerWorkerId)
          .filter((id): id is number => id !== null && id !== undefined),
      ),
    ];
    if (new Set(projectIds).size !== projectIds.length) {
      throw new BadRequestException('同一需求不能重复转入');
    }
    for (const id of projectIds) {
      if (!Number.isInteger(id) || id <= 0) {
        throw new BadRequestException('需求 ID 非法');
      }
    }
    for (const id of ownerIds) {
      if (!Number.isInteger(id) || id <= 0) {
        throw new BadRequestException('负责人机器人 ID 非法');
      }
    }

    const projects = await this.projects.find({
      where: { id: In(projectIds) },
      select: { id: true, name: true },
    });
    const projectMap = new Map(
      projects.map((project) => [project.id, project]),
    );
    for (const id of projectIds) {
      if (!projectMap.has(id)) {
        throw new NotFoundException(`需求 #${id} 不存在`);
      }
    }

    const existing = await this.backlogs.find({
      where: { projectId: In(projectIds) },
    });
    const activeDupes = existing.filter(
      (backlog) => backlog.status !== BacklogStatus.CANCELED,
    );
    if (activeDupes.length > 0) {
      throw new BadRequestException(
        `以下需求已存在未取消的迭代项：${activeDupes
          .map((backlog) => `#${backlog.projectId} ${backlog.title}`)
          .join('、')}`,
      );
    }

    const workers = ownerIds.length
      ? await this.workers.find({ where: { id: In(ownerIds) } })
      : [];
    const workerMap = new Map(workers.map((worker) => [worker.id, worker]));
    for (const id of ownerIds) {
      this.assertAssignableWorker(workerMap.get(id), id);
    }

    const created: Backlog[] = [];
    for (const item of items) {
      const project = projectMap.get(item.projectId)!;
      const owner =
        item.ownerWorkerId !== null && item.ownerWorkerId !== undefined
          ? (workerMap.get(item.ownerWorkerId) ?? null)
          : null;
      const members = await this.normalizeMembers(item.members);

      let backlog = await this.backlogs.save(
        this.backlogs.create({
          code: `TMP-${randomBytes(8).toString('hex')}`,
          iterationId,
          projectId: project.id,
          title: project.name.slice(0, 200),
          status: BacklogStatus.WAITING,
          ownerWorkerId: owner?.id ?? null,
          ownerName: owner?.name ?? null,
          members: members.length ? members : null,
          taskId: null,
          statusBy: actor.userName,
          startedAt: null,
          testingAt: null,
          releasingAt: null,
          completedAt: null,
          canceledAt: null,
        }),
      );
      backlog.code = `BL-${String(backlog.id).padStart(4, '0')}`;
      backlog = await this.backlogs.save(backlog);

      // 追加系统维护的自动成员（负责人 / 需求方），供展示与建群使用
      if (await this.refreshAutoMembers(backlog)) {
        backlog = await this.backlogs.save(backlog);
      }

      // 负责人存在真人登录身份时创建交付任务并直接指派给该机器人；未指定负责人则暂不建任务。
      if (owner && actor.userId !== null) {
        try {
          const task = await this.tasks.create({
            title: `迭代任务-${project.name}`.slice(0, 200),
            description: [
              `迭代：${iteration.code}（${iteration.type}）`,
              `原始需求：${project.name}（#${project.id}）`,
              '',
              `需求详情：GET /api/requirements/${project.id}.md`,
            ].join('\n'),
            input: `原始需求：${project.name}`,
            projectId: project.id,
            templateId: SYSTEM_BACKLOG_DELIVERY_TASK_TEMPLATE_ID,
            agentId: owner.id,
            createdById: actor.userId,
            operatorName: actor.userName,
            titleNaming: true,
          });
          backlog.taskId = task.id;
          backlog = await this.backlogs.save(backlog);
        } catch (error) {
          this.logger.warn(
            `迭代项 ${backlog.code} 交付任务创建失败：${(error as Error).message}`,
          );
        }
      }

      // 需求文档一并迁移到迭代项（backlog_documents 关联，迁移失败不阻断）
      let migratedDocuments = 0;
      try {
        migratedDocuments = await this.migrateProjectDocuments(
          backlog.id,
          project.id,
        );
      } catch (error) {
        this.logger.warn(
          `迭代项 ${backlog.code} 文档迁移失败：${(error as Error).message}`,
        );
      }

      await this.recordEvent(
        backlog.id,
        'created',
        {
          iteration: `${iteration.code}（${iteration.type}）`,
          migratedDocuments,
          taskId: backlog.taskId ?? null,
        },
        actor.userName,
      );

      // 异步生成迭代项自己的标题（title-naming 场景；失败保留需求名兜底）
      this.scheduleTitleNaming(backlog.id, backlog.title, {
        requirement: project.name,
        iteration: `${iteration.code}（${iteration.type}）`,
        owner: owner?.name ?? '未指定',
        description: `迭代交付任务：${project.name}`,
      });

      created.push(backlog);
    }
    return created;
  }

  /** 单条转入（T0 快速通道或指定 T7/Tx 迭代） */
  async createOne(
    iterationId: number,
    item: CreateBacklogItemInput,
    actor: IterationActor,
  ): Promise<Backlog> {
    const [created] = await this.createBatch(iterationId, [item], actor);
    return created;
  }

  async findOne(id: number): Promise<Backlog> {
    const backlog = await this.backlogs.findOne({ where: { id } });
    if (!backlog) throw new NotFoundException(`Backlog ${id} not found`);
    return backlog;
  }

  /** 手动流转状态：成员或管理员；终态不可再变更；备注可空，记入事件流 */
  async updateStatus(
    id: number,
    status: BacklogStatus,
    actor: IterationActor,
    remark?: string,
  ): Promise<Backlog> {
    const backlog = await this.findOne(id);
    if (!Object.values(BacklogStatus).includes(status)) {
      throw new BadRequestException(
        '迭代项状态仅允许：等待/执行/测试/发布/完成/取消',
      );
    }
    if (this.isTerminal(backlog.status)) {
      throw new BadRequestException('已结束的迭代项不可再变更状态');
    }
    if (backlog.status === status) return backlog;
    if (!actor.isAdmin && !(await this.isMember(backlog, actor))) {
      throw new ForbiddenException('仅迭代项成员或管理员可推进状态');
    }

    const from = backlog.status;
    const updated = this.applyStatus(
      backlog,
      status,
      actor.userName,
      new Date(),
    );
    const saved = await this.backlogs.save(updated);

    await this.recordEvent(
      saved.id,
      'status',
      {
        from,
        to: status,
        remark: remark?.trim() || null,
      },
      actor.userName,
    );

    if (status === BacklogStatus.CANCELED && saved.taskId) {
      try {
        await this.tasks.cancel(saved.taskId, actor.userName);
      } catch (error) {
        this.logger.warn(
          `迭代项 ${saved.code} 取消联动交付任务失败：${(error as Error).message}`,
        );
      }
    }

    try {
      await this.chat.notifyBacklog(saved.id);
    } catch (error) {
      this.logger.warn(
        `迭代项 ${saved.code} 沟通群状态推送失败：${(error as Error).message}`,
      );
    }
    return saved;
  }

  /** 移动迭代项到另一个迭代（不重建交付任务与沟通群） */
  async move(
    id: number,
    iterationId: number,
    actor: IterationActor,
  ): Promise<Backlog> {
    this.assertAdmin(actor, '仅管理员可移动迭代项');
    const backlog = await this.findOne(id);
    if (this.isTerminal(backlog.status)) {
      throw new BadRequestException('已结束的迭代项不可移动');
    }
    if (!Number.isInteger(iterationId) || iterationId <= 0) {
      throw new BadRequestException('目标迭代 ID 非法');
    }
    const target = await this.iterations.findOne({
      where: { id: iterationId },
    });
    if (!target)
      throw new NotFoundException(`Iteration ${iterationId} not found`);
    if (target.status === IterationStatus.CLOSED) {
      throw new BadRequestException('目标迭代已结束');
    }
    if (backlog.iterationId === iterationId) return backlog;
    const fromIterationId = backlog.iterationId;
    backlog.iterationId = iterationId;
    const saved = await this.backlogs.save(backlog);
    await this.recordEvent(
      saved.id,
      'moved',
      {
        fromIterationId,
        toIterationId: iterationId,
        toIterationCode: target.code,
      },
      actor.userName,
    );
    return saved;
  }

  /**
   * 更新迭代项属性：预期上线时间（成员或管理员）、负责人（仅管理员，改派重建交付任务）。
   */
  async updateBacklog(
    id: number,
    dto: {
      expectedOnlineAt?: string | Date | null;
      ownerWorkerId?: number | null;
    },
    actor: IterationActor,
  ): Promise<Backlog> {
    const backlog = await this.findOne(id);
    if (!actor.isAdmin && !(await this.isMember(backlog, actor))) {
      throw new ForbiddenException('仅迭代项成员或管理员可编辑迭代项属性');
    }
    const ownerChange =
      dto.ownerWorkerId !== undefined
        ? await this.assignOwner(backlog, dto.ownerWorkerId, actor)
        : null;
    if (dto.expectedOnlineAt !== undefined) {
      if (dto.expectedOnlineAt === null || dto.expectedOnlineAt === '') {
        backlog.expectedOnlineAt = null;
      } else {
        const parsed =
          dto.expectedOnlineAt instanceof Date
            ? dto.expectedOnlineAt
            : new Date(String(dto.expectedOnlineAt));
        if (Number.isNaN(parsed.getTime())) {
          throw new BadRequestException('预期上线时间格式不正确');
        }
        backlog.expectedOnlineAt = parsed;
      }
    }
    const saved = await this.backlogs.save(backlog);
    if (ownerChange) {
      // 负责人变化 → 刷新「负责人」成员行并同步飞书群
      let current = saved;
      if (await this.refreshAutoMembers(current)) {
        current = await this.backlogs.save(current);
      }
      await this.recordEvent(
        current.id,
        'owner',
        {
          from: ownerChange.from,
          to: ownerChange.to,
          taskId: current.taskId,
          previousTaskId: ownerChange.previousTaskId,
        },
        actor.userName,
      );
      await this.syncChatMembers(current);
      return current;
    }
    return saved;
  }

  /**
   * 指定/改派负责人（仅管理员）：先按新负责人重建交付任务，成功后再取消旧任务。
   * 变更写入 backlog 字段但不在本方法内保存，由调用方统一保存。
   */
  private async assignOwner(
    backlog: Backlog,
    ownerWorkerId: number | null,
    actor: IterationActor,
  ): Promise<{
    from: string | null;
    to: string;
    previousTaskId: number | null;
  } | null> {
    this.assertAdmin(actor, '仅管理员可指定/改派负责人');
    if (ownerWorkerId === null) {
      throw new BadRequestException('不支持清空负责人；请指定新的负责人机器人');
    }
    if (!Number.isInteger(ownerWorkerId) || ownerWorkerId <= 0) {
      throw new BadRequestException('负责人机器人 ID 非法');
    }
    if (backlog.ownerWorkerId === ownerWorkerId) return null;
    if (
      backlog.status === BacklogStatus.COMPLETED ||
      backlog.status === BacklogStatus.CANCELED
    ) {
      throw new BadRequestException('迭代项已结束，不可改派负责人');
    }
    const worker = await this.workers.findOne({
      where: { id: ownerWorkerId },
    });
    if (!worker) {
      throw new BadRequestException(`负责人机器人 #${ownerWorkerId} 不存在`);
    }
    this.assertAssignableWorker(worker, ownerWorkerId);
    const [project, iteration] = await Promise.all([
      this.projects.findOne({
        where: { id: backlog.projectId },
        select: { id: true, name: true },
      }),
      this.iterations.findOne({ where: { id: backlog.iterationId } }),
    ]);
    const projectName = project?.name ?? backlog.title;
    const task = await this.tasks.create({
      title: `迭代任务-${projectName}`.slice(0, 200),
      description: [
        `迭代：${
          iteration
            ? `${iteration.code}（${iteration.type}）`
            : `#${backlog.iterationId}`
        }`,
        `原始需求：${projectName}（#${backlog.projectId}）`,
        '',
        `需求详情：GET /api/requirements/${backlog.projectId}.md`,
      ].join('\n'),
      input: `原始需求：${projectName}`,
      projectId: backlog.projectId,
      templateId: SYSTEM_BACKLOG_DELIVERY_TASK_TEMPLATE_ID,
      agentId: worker.id,
      createdById: actor.userId,
      operatorName: actor.userName,
      titleNaming: true,
    });
    const previousTaskId = backlog.taskId;
    if (previousTaskId) {
      try {
        await this.tasks.cancel(previousTaskId, actor.userName);
      } catch (error) {
        this.logger.warn(
          `迭代项 ${backlog.code} 旧交付任务 #${previousTaskId} 取消失败：${(error as Error).message}`,
        );
      }
    }
    const from = backlog.ownerName;
    backlog.ownerWorkerId = worker.id;
    backlog.ownerName = worker.name;
    backlog.taskId = task.id;
    return { from, to: worker.name, previousTaskId };
  }

  /** 详情视图：迭代项 + 需求方/涉及方（实时取自原始需求）+ 所属迭代标识 + 提测工单工作流配置（供前端动态提测表单）+ 飞书沟通群状态（供建群/打开群按钮）+ 当前查看者操作权限 */
  async getDetail(
    id: number,
    actor?: IterationActor,
  ): Promise<
    Backlog & {
      owner: string | null;
      /** 涉及方：实时取自原始需求 projects.involvedParties（不落库） */
      involvedParties: string[] | null;
      iteration: {
        id: number;
        code: string;
        type: Iteration['type'];
      } | null;
      releaseWorkflow: BacklogReleaseWorkflow | null;
      /** 飞书沟通群：未建群/已解散为 null */
      feishuChat: BacklogChatInfo | null;
      /** 当前查看者是否可操作（管理员或手动成员；自动列入的负责人/需求方不计） */
      canOperate: boolean;
      /** 当前查看者是否可维护成员（管理员或迭代项负责人） */
      canManageMembers: boolean;
    }
  > {
    const backlog = await this.findOne(id);
    const [project, iteration, feishuChat] = await Promise.all([
      this.projects.findOne({
        where: { id: backlog.projectId },
        select: {
          id: true,
          name: true,
          owner: true,
          involvedParties: true,
        },
      }),
      this.iterations.findOne({
        where: { id: backlog.iterationId },
        select: { id: true, code: true, type: true },
      }),
      this.chat.describe(backlog.id),
    ]);
    const canOperate =
      !!actor && (actor.isAdmin || (await this.isMember(backlog, actor)));
    const canManageMembers =
      !!actor && (await this.canUpdateMembers(backlog, actor));
    return {
      ...backlog,
      owner: project?.owner ?? null,
      involvedParties: project?.involvedParties ?? null,
      iteration: iteration
        ? { id: iteration.id, code: iteration.code, type: iteration.type }
        : null,
      releaseWorkflow: await this.releaseWorkflowInfo(),
      feishuChat,
      canOperate,
      canManageMembers,
    };
  }

  /** 提测工单工作流信息（code 固定 release-ticket；含发布版本起始字段供动态表单） */
  async releaseWorkflowInfo(): Promise<BacklogReleaseWorkflow | null> {
    const definition = await this.workflowDefs.findOne({
      where: { code: RELEASE_TICKET_WORKFLOW.code },
    });
    if (!definition) return null;
    const version = definition.latestPublishedVersion
      ? await this.workflowVersions.findOne({
          where: {
            definitionId: definition.id,
            version: definition.latestPublishedVersion,
          },
        })
      : null;
    const start =
      version?.definition.nodes.find((node) => node.kind === 'start') ?? null;
    return {
      id: definition.id,
      name: definition.name,
      enabled:
        definition.enabled && (definition.latestPublishedVersion ?? 0) > 0,
      inputFields: start?.inputFields ?? [],
    };
  }

  /** 迭代项关联的文档（不含正文大字段） */
  async listDocuments(
    id: number,
  ): Promise<
    Array<
      Pick<
        Document,
        | 'id'
        | 'title'
        | 'type'
        | 'source'
        | 'description'
        | 'remark'
        | 'feishuUrl'
        | 'projectId'
        | 'url'
        | 'createdAt'
        | 'updatedAt'
      >
    >
  > {
    const backlog = await this.findOne(id);
    const links = await this.backlogDocuments.find({
      where: { backlogId: backlog.id },
    });
    const docIds = [...new Set(links.map((link) => link.documentId))];
    if (docIds.length === 0) return [];
    const docs = await this.documents.find({
      where: { id: In(docIds) },
      select: {
        id: true,
        title: true,
        type: true,
        source: true,
        description: true,
        remark: true,
        feishuUrl: true,
        projectId: true,
        url: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return docs.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  /** 事件流（append-only，倒序，最近 100 条） */
  async listEvents(id: number): Promise<BacklogEvent[]> {
    const backlog = await this.findOne(id);
    return this.backlogEvents.find({
      where: { backlogId: backlog.id },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  /**
   * 任务与工单面板数据：
   * - tasks：交付任务为根的全部任务树（含所有子任务）；
   * - tickets：直接关联（backlogId）+ 任务树关联（tickets.taskId / ticket_workflow_runs.taskId）。
   */
  async relatedRecords(
    id: number,
  ): Promise<{ tasks: BacklogTaskSummary[]; tickets: BacklogTicketSummary[] }> {
    const backlog = await this.findOne(id);
    const taskRows = backlog.taskId
      ? await this.taskRows.find({
          where: [{ id: backlog.taskId }, { rootId: backlog.taskId }],
          select: {
            id: true,
            code: true,
            title: true,
            type: true,
            status: true,
            subStatus: true,
            parentId: true,
            rootId: true,
            projectId: true,
            agentId: true,
            templateName: true,
            sortOrder: true,
            createdAt: true,
            updatedAt: true,
          },
          order: { id: 'ASC' },
        })
      : [];
    const taskIds = taskRows.map((task) => task.id);
    const agentIds = [
      ...new Set(
        taskRows
          .map((task) => task.agentId)
          .filter((id): id is number => id !== null),
      ),
    ];
    const agentNameById = new Map<number, string>();
    if (agentIds.length > 0) {
      const workers = await this.workers.find({
        where: { id: In(agentIds) },
        select: { id: true, name: true },
      });
      for (const worker of workers) agentNameById.set(worker.id, worker.name);
    }

    const directTickets = await this.ticketRows.find({
      where: { backlogId: backlog.id },
    });
    const taskTickets = taskIds.length
      ? await this.ticketRows.find({ where: { taskId: In(taskIds) } })
      : [];
    const runs = taskIds.length
      ? await this.ticketRunRows.find({ where: { taskId: In(taskIds) } })
      : [];
    const runTicketIds = [...new Set(runs.map((run) => run.ticketId))];
    const runTickets = runTicketIds.length
      ? await this.ticketRows.find({ where: { id: In(runTicketIds) } })
      : [];

    const ticketMap = new Map<number, Ticket>();
    for (const ticket of [...directTickets, ...taskTickets, ...runTickets]) {
      ticketMap.set(ticket.id, ticket);
    }
    const tickets = [...ticketMap.values()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((ticket) => ({
        id: ticket.id,
        code: ticket.code,
        title: ticket.title,
        category: ticket.category,
        workflowStatus: ticket.workflowStatus,
        currentNodeName: ticket.currentNodeName,
        initiatorWorkerName: ticket.initiatorWorkerName,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
      }));

    return {
      tasks: taskRows.map((task) => ({
        id: task.id,
        code: task.code,
        title: task.title,
        type: task.type,
        status: task.status,
        subStatus: task.subStatus,
        parentId: task.parentId,
        rootId: task.rootId,
        projectId: task.projectId,
        agentId: task.agentId,
        agentName:
          task.agentId !== null
            ? (agentNameById.get(task.agentId) ?? null)
            : null,
        templateName: task.templateName,
        sortOrder: task.sortOrder,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      })),
      tickets,
    };
  }

  /**
   * 迭代项新建任务：
   * - 已有交付任务（backlog.taskId）：作为该交付任务的子任务创建，出现在任务树，
   *   描述自动附带迭代上下文（ID/标识/描述）与任务上下文（父任务、兄弟任务）；
   * - 无交付任务：按所选执行机器人创建交付任务并登记为迭代项负责人（仅管理员）。
   */
  async createTask(
    id: number,
    input: CreateBacklogTaskInput,
    actor: IterationActor,
  ): Promise<Task> {
    const backlog = await this.findOne(id);
    const project = await this.projects.findOne({
      where: { id: backlog.projectId },
      select: { id: true, name: true },
    });
    const projectName = project?.name ?? backlog.title;
    const description = input.description?.trim()
      ? input.description.trim()
      : null;
    const iteration = await this.iterations.findOne({
      where: { id: backlog.iterationId },
    });

    if (backlog.taskId) {
      if (!actor.isAdmin && !(await this.isMember(backlog, actor))) {
        throw new ForbiddenException('仅迭代项成员或管理员可新建任务');
      }
      const context = await this.taskContext.buildSubtaskContext(
        backlog.taskId,
      );
      return this.tasks.create({
        title: input.title,
        description: description
          ? `${description}\n\n---\n\n${context}`
          : context,
        projectId: backlog.projectId,
        templateId: input.templateId ?? null,
        agentId: input.agentId ?? null,
        parentId: backlog.taskId,
        createdById: actor.userId,
        operatorName: actor.userName,
      });
    }

    // 无交付任务：按执行机器人创建交付任务（等价于指定负责人）
    this.assertAdmin(actor, '仅管理员可创建迭代项交付任务');
    if (
      backlog.status === BacklogStatus.COMPLETED ||
      backlog.status === BacklogStatus.CANCELED
    ) {
      throw new BadRequestException('迭代项已结束，不可创建交付任务');
    }
    const workerId = input.agentId ?? backlog.ownerWorkerId;
    if (!workerId) {
      throw new BadRequestException('请选择负责人机器人');
    }
    if (!Number.isInteger(workerId) || workerId <= 0) {
      throw new BadRequestException('负责人机器人 ID 非法');
    }
    const worker = await this.workers.findOne({ where: { id: workerId } });
    if (!worker) {
      throw new BadRequestException(`负责人机器人 #${workerId} 不存在`);
    }
    this.assertAssignableWorker(worker, workerId);
    const task = await this.tasks.create({
      title: input.title?.trim() || `迭代任务-${projectName}`.slice(0, 200),
      description:
        description ??
        [
          `迭代：${this.iterationLabel(iteration, backlog.iterationId)}`,
          `原始需求：${projectName}（#${backlog.projectId}）`,
          '',
          `需求详情：GET /api/requirements/${backlog.projectId}.md`,
        ].join('\n'),
      input: `原始需求：${projectName}`,
      projectId: backlog.projectId,
      templateId: input.templateId ?? SYSTEM_BACKLOG_DELIVERY_TASK_TEMPLATE_ID,
      agentId: worker.id,
      createdById: actor.userId,
      operatorName: actor.userName,
      titleNaming: true,
    });
    const from = backlog.ownerName;
    backlog.ownerWorkerId = worker.id;
    backlog.ownerName = worker.name;
    backlog.taskId = task.id;
    await this.refreshAutoMembers(backlog);
    await this.backlogs.save(backlog);
    await this.recordEvent(
      backlog.id,
      'owner',
      { from, to: worker.name, taskId: task.id, previousTaskId: null },
      actor.userName,
    );
    await this.syncChatMembers(backlog);
    return task;
  }

  /**
   * 迭代标签：`#id 标识（类型）`，描述非空时以「——」拼接，供任务描述引用。
   * 迭代不存在时降级为 `#id`。
   */
  private iterationLabel(
    iteration: Iteration | null,
    iterationId: number,
  ): string {
    const label = iteration
      ? `#${iteration.id} ${iteration.code}（${iteration.type}）`
      : `#${iterationId}`;
    const description = iteration?.description?.trim();
    return description ? `${label}——${description}` : label;
  }

  /**
   * 批量提测：所选迭代项各创建一张提测工单 + 一条提测记录（互相绑定），
   * 提测群通知由工单「提测群通知」节点发送。
   * 提测不与迭代项/迭代状态绑定，同一迭代项可多次发起。
   */
  async submitRelease(
    input: SubmitReleaseBatchInput,
    actor: IterationActor,
    creator: { user?: User | null; worker?: Worker | null },
  ): Promise<BacklogReleaseResult> {
    const ids = [
      ...new Set(
        (Array.isArray(input.items) ? input.items : [])
          .map((item) => Number(item?.backlogId))
          .filter((id) => Number.isInteger(id) && id > 0),
      ),
    ];
    if (ids.length === 0) {
      throw new BadRequestException('至少选择一个迭代项');
    }
    if (ids.length > 50) {
      throw new BadRequestException('单次最多提测 50 个迭代项');
    }

    const rows = await this.backlogs.find({ where: { id: In(ids) } });
    if (rows.length !== ids.length) {
      const found = new Set(rows.map((row) => row.id));
      throw new BadRequestException(
        `迭代项不存在：${ids.filter((id) => !found.has(id)).join('、')}`,
      );
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = ids.map((id) => byId.get(id)!);
    const canceled = ordered.filter(
      (row) => row.status === BacklogStatus.CANCELED,
    );
    if (canceled.length > 0) {
      throw new BadRequestException(
        `已取消的迭代项不可提测：${canceled.map((row) => row.code).join('、')}`,
      );
    }

    // 权限：管理员或所选迭代项中任意一个的成员（批量跨迭代时放宽）
    if (!actor.isAdmin) {
      let allowed = false;
      for (const row of ordered) {
        if (await this.isMember(row, actor)) {
          allowed = true;
          break;
        }
      }
      if (!allowed) {
        throw new ForbiddenException('仅所选迭代项成员或管理员可发起提测');
      }
    }

    const workflow = await this.releaseWorkflowInfo();
    if (!workflow || !workflow.enabled) {
      throw new BadRequestException(
        '「提测工单」工作流未配置或未发布版本，暂不能提测',
      );
    }

    // 提测端选项完全以工单 testEnds 字段配置为准；工单未配置该字段时不采集提测端
    const endsField = workflow.inputFields.find(
      (field) => field.key === 'testEnds',
    );
    const shared = await this.releases.prepareBatch(
      input,
      {
        operator: actor.userName,
        workerId: actor.workerId ?? null,
      },
      endsField?.options ?? [],
    );

    const iterationIds = [...new Set(ordered.map((row) => row.iterationId))];
    const projectIds = [...new Set(ordered.map((row) => row.projectId))];
    const [iterations, projects] = await Promise.all([
      this.iterations.find({ where: { id: In(iterationIds) } }),
      this.projects.find({ where: { id: In(projectIds) } }),
    ]);
    const iterationById = new Map(iterations.map((row) => [row.id, row]));
    const projectById = new Map(projects.map((row) => [row.id, row]));

    const count = ordered.length;
    const baseTitle = input.title?.trim();
    const title = (
      count === 1
        ? baseTitle || `提测-${ordered[0].code} ${ordered[0].title}`
        : `${baseTitle || ordered[0].title} 等${count}个迭代`
    ).slice(0, 200);

    const results: BacklogReleaseItemResult[] = [];
    // 动态字段值：除保留 key 外的配置字段原样透传到每张工单 inputValues
    const dynamicValues = this.pickReleaseDynamicValues(input.inputValues);
    const manualDescription = this.releaseManualDescription(input.inputValues);
    for (const backlog of ordered) {
      const iteration = iterationById.get(backlog.iterationId) ?? null;
      const project = projectById.get(backlog.projectId) ?? null;
      const ticketTitle = (
        count === 1 && baseTitle
          ? baseTitle
          : `提测-${backlog.code} ${backlog.title}`
      ).slice(0, 200);
      const description = this.buildReleaseDescription(
        backlog,
        iteration,
        project,
        shared,
        manualDescription,
      );
      const ticket = await this.ticketsService.create(
        {
          workflowDefinitionId: workflow.id,
          title: ticketTitle,
          inputValues: {
            ...dynamicValues,
            title: ticketTitle,
            description,
            // 迭代项字段直接带入选中的迭代项，保证必填校验与模板循环一致；
            // 提测端仅在工单配置了 testEnds 字段时带入（须为其配置的选项）
            backlogs: [backlog.id],
            ...(endsField && shared.ends.length > 0
              ? { testEnds: shared.ends }
              : {}),
          },
          backlogId: backlog.id,
        },
        creator,
      );
      const release = await this.releases.createRecord({
        projectId: backlog.projectId,
        ends: shared.ends,
        operator: shared.operator,
        workerId: shared.workerId,
        sourceTaskId: shared.sourceTaskId,
        ticketId: ticket.id,
        ticketCode: ticket.code,
      });
      await this.recordEvent(
        backlog.id,
        'release-ticket',
        {
          ticketId: ticket.id,
          ticketCode: ticket.code,
          title: ticket.title,
          releaseId: release.id,
          ends: shared.ends,
        },
        actor.userName,
      );
      results.push({
        backlogId: backlog.id,
        code: backlog.code,
        title: backlog.title,
        projectId: backlog.projectId,
        ticketId: ticket.id,
        ticketCode: ticket.code,
        releaseId: release.id,
      });
    }

    return { title, items: results };
  }

  /** AI 用：批量提测并返回 Markdown 结果 */
  async submitReleaseMarkdown(
    input: SubmitReleaseBatchInput,
    actor: IterationActor,
    creator: { user?: User | null; worker?: Worker | null },
  ): Promise<string> {
    const result = await this.submitRelease(input, actor, creator);
    return [
      mdFrontmatter({ update: new Date(), title: `提测 - ${result.title}` }),
      '# 已发起提测',
      '',
      `- 提测标题：${result.title}`,
      `- 迭代项：${result.items.length} 个`,
      ...result.items.map(
        (item) =>
          `- ${item.code} ${item.title} → 工单 ${item.ticketCode}（#${item.ticketId}），提测记录 #${item.releaseId}`,
      ),
      '- 提测群：由提测工单「提测群通知」节点以平台官方机器人发送（未配置目标群或发送失败只记录，不阻断工单）',
      '- 提测记录清单：`GET /api/releases.md?projectId={projectId}`',
      '- 推进提测状态：`POST /api/releases/{id}/status.md`',
      '',
    ].join('\n');
  }

  /** 提测工单描述：人工补充描述（置前）+ 迭代项上下文 + 提测端 */
  private buildReleaseDescription(
    backlog: Backlog,
    iteration: Iteration | null,
    project: Project | null,
    shared: Awaited<ReturnType<ReleasesService['prepareBatch']>>,
    manualDescription?: string | null,
  ): string {
    const context = this.buildReleaseContext(backlog, iteration, project);
    const manual = manualDescription?.trim();
    const extra = shared.ends.length
      ? [`- 提测端：${shared.ends.join(' / ')}`]
      : [];
    return [...(manual ? [manual, ''] : []), context, ...extra, ''].join('\n');
  }

  /** 迭代项上下文（提测描述静态段，不含提测端等表单字段） */
  private buildReleaseContext(
    backlog: Backlog,
    iteration: Iteration | null,
    project: { id: number; name?: string | null } | null,
  ): string {
    return [
      '## 迭代项提测信息',
      '',
      `- 迭代项：${backlog.code} ${backlog.title}（状态：${backlog.status}）`,
      `- 所属迭代：${
        iteration
          ? `${iteration.code}（${iteration.type}）`
          : `#${backlog.iterationId}`
      }`,
      `- 原始需求：${project?.name ?? '—'}（#${backlog.projectId}）｜ \`GET /api/requirements/${backlog.projectId}.md\``,
      `- 负责人：${backlog.ownerName ?? '未指定'}`,
      `- 预期上线：${
        backlog.expectedOnlineAt
          ? `${beijingTime(backlog.expectedOnlineAt)}（北京时间）`
          : '未设置'
      }`,
      `- 交付任务：${
        backlog.taskId
          ? `#${backlog.taskId}｜\`GET /api/tasks/${backlog.taskId}.md\``
          : '（未创建）'
      }`,
      `- 迭代项详情：\`GET /api/backlogs/${backlog.id}.md\``,
    ].join('\n');
  }

  /** 提测弹窗「补充描述」人工填写值（空白视为未填写，仅保留平台自动上下文） */
  private releaseManualDescription(
    inputValues?: Record<string, unknown>,
  ): string | null {
    const raw = inputValues?.description;
    const text = typeof raw === 'string' ? raw.trim() : '';
    return text || null;
  }

  /** 动态字段值：过滤保留 key（由平台按提测表单映射），其余原样透传 */
  private pickReleaseDynamicValues(
    inputValues?: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!inputValues) return {};
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(inputValues)) {
      if (RELEASE_RESERVED_INPUT_KEYS.has(key)) continue;
      values[key] = value;
    }
    return values;
  }

  /**
   * 手动创建/重试迭代项飞书沟通群（成员或管理员）。
   * 已建成的群直接返回现有状态；终态迭代项不再建群。
   */
  async createFeishuChat(
    id: number,
    actor: IterationActor,
  ): Promise<BacklogChatInfo | null> {
    const backlog = await this.findOne(id);
    if (!actor.isAdmin && !(await this.isMember(backlog, actor))) {
      throw new ForbiddenException('仅迭代项成员或管理员可创建飞书群');
    }
    const info = await this.chat.createForBacklog(id);
    await this.recordEvent(
      id,
      'feishu-chat',
      { state: info?.state ?? null, chatId: info?.chatId ?? null },
      actor.userName,
    );
    return info;
  }

  /** 更新成员（管理员或迭代项负责人机器人；网页负责人真人登录同样可改） */
  async updateMembers(
    id: number,
    members: BacklogMemberInput[],
    actor: IterationActor,
  ): Promise<Backlog> {
    const backlog = await this.findOne(id);
    await this.assertCanUpdateMembers(backlog, actor);
    const normalized = await this.normalizeMembers(members);
    const previous = backlog.members ?? [];
    backlog.members = normalized.length ? normalized : null;
    // 追加系统维护的自动成员（负责人 / 需求方）
    await this.refreshAutoMembers(backlog);
    const saved = await this.backlogs.save(backlog);
    await this.recordEvent(
      saved.id,
      'members',
      {
        from: previous,
        to: saved.members ?? [],
      },
      actor.userName,
    );
    // 新增成员自动拉进已有飞书沟通群（只加不减）
    await this.syncChatMembers(saved);
    return saved;
  }

  async findOneMarkdown(id: number): Promise<string> {
    const backlog = await this.findOne(id);
    const [iteration, project] = await Promise.all([
      this.iterations.findOne({ where: { id: backlog.iterationId } }),
      // 需求方/涉及方/备注实时取原始需求（projects），不落库
      this.projects.findOne({
        where: { id: backlog.projectId },
        select: {
          id: true,
          owner: true,
          involvedParties: true,
          remark: true,
        },
      }),
    ]);
    const head = mdFrontmatter({
      update: backlog.updatedAt,
      title: backlog.title,
      code: backlog.code,
      status: backlog.status,
    });
    const meta = [
      `- 迭代项 ID：${backlog.id}`,
      `- 编号：${backlog.code}`,
      `- 原始需求：\`GET /api/requirements/${backlog.projectId}.md\`（#${backlog.projectId}）`,
      `- 所属迭代：${
        iteration
          ? `${iteration.code}（${iteration.type}）`
          : `#${backlog.iterationId}`
      }`,
      `- 状态：${backlog.status}`,
      `- 需求方：${project?.owner ?? '-'}`,
      `- 涉及方：${project?.involvedParties?.join('、') || '-'}`,
      `- 备注：${project?.remark ?? '-'}`,
      `- 负责人：${backlog.ownerName ?? '-'}`,
      `- 预期上线：${
        backlog.expectedOnlineAt
          ? `${beijingTime(backlog.expectedOnlineAt)}（北京时间）`
          : '-'
      }`,
      `- 交付任务：${
        backlog.taskId
          ? `\`GET /api/tasks/${backlog.taskId}.md\``
          : '（未创建）'
      }`,
      `- 平台链接：/backlogs/${backlog.id}`,
    ];
    if (backlog.startedAt)
      meta.push(`- 开始执行：${beijingTime(backlog.startedAt)}`);
    if (backlog.testingAt)
      meta.push(`- 进入测试：${beijingTime(backlog.testingAt)}`);
    if (backlog.releasingAt)
      meta.push(`- 进入发布：${beijingTime(backlog.releasingAt)}`);
    if (backlog.completedAt)
      meta.push(`- 完成时间：${beijingTime(backlog.completedAt)}`);
    if (backlog.canceledAt)
      meta.push(`- 取消时间：${beijingTime(backlog.canceledAt)}`);

    const membersText = backlog.members?.length
      ? backlog.members
          .map((member) => `${member.role}：${member.name}`)
          .join('；')
      : '（暂无）';

    const [docs, events] = await Promise.all([
      this.listDocuments(backlog.id),
      this.listEvents(backlog.id),
    ]);
    const docsText = docs.length
      ? docs
          .map((doc) =>
            doc.url
              ? `- ${doc.title}（${doc.type}｜${doc.url}）`
              : `- ${doc.title}（${doc.type}｜\`GET /api/documents/${doc.id}.md\`）`,
          )
          .join('\n')
      : '（暂无）';
    const eventsText = events.length
      ? events
          .map((event) => {
            const payload = event.payload as {
              from?: string;
              to?: string;
              remark?: string;
            } | null;
            const detail =
              event.type === 'status'
                ? `（${payload?.from ?? '?'} → ${payload?.to ?? '?'}）`
                : '';
            const remark = payload?.remark ? `：${payload.remark}` : '';
            return `- ${beijingTime(event.createdAt)} ${event.operator ?? '系统'} ${event.type}${detail}${remark}`;
          })
          .join('\n')
      : '（暂无）';

    const sections = [
      '# 迭代项',
      '',
      ...meta,
      '',
      '## 成员',
      '',
      membersText,
      '',
      '## 文档',
      '',
      docsText,
      '',
      '## 最近事件',
      '',
      eventsText,
      '',
    ];
    const topicsText = await topicSectionFor(
      this.topicRows,
      TopicSubjectType.BACKLOG,
      backlog.id,
    );
    if (topicsText) sections.push(topicsText);
    return `${head}${sections.join('\n')}\n`;
  }

  /** 迁移需求的全部文档关联到迭代项，返回迁移数量 */
  private async migrateProjectDocuments(
    backlogId: number,
    projectId: number,
  ): Promise<number> {
    const docs = await this.documents.find({
      where: { projectId },
      select: { id: true },
    });
    if (docs.length === 0) return 0;
    await this.backlogDocuments
      .createQueryBuilder()
      .insert()
      .into(BacklogDocument)
      .values(docs.map((doc) => ({ backlogId, documentId: doc.id })))
      .orIgnore()
      .execute();
    return docs.length;
  }

  /** 追加事件（append-only）；失败只告警不阻断主流程 */
  private async recordEvent(
    backlogId: number,
    type: string,
    payload: Record<string, unknown> | null,
    operator?: string | null,
  ): Promise<void> {
    try {
      await this.backlogEvents.save(
        this.backlogEvents.create({
          backlogId,
          type,
          payload: payload ?? null,
          operator: operator ?? null,
        }),
      );
    } catch (error) {
      this.logger.warn(
        `迭代项 #${backlogId} 事件 ${type} 记录失败：${(error as Error).message}`,
      );
    }
  }

  /**
   * 后台生成迭代项标题：「BL-{id}」+ 模型生成的简洁标题。
   * 未配置模型场景时直接跳过；期间标题被人工修改（乐观条件不命中）则不覆盖。
   */
  private scheduleTitleNaming(
    backlogId: number,
    originalTitle: string,
    material: {
      requirement: string;
      iteration: string;
      owner: string;
      description?: string;
    },
  ): void {
    if (!backlogId || this.titleNaming.has(backlogId)) return;
    this.titleNaming.add(backlogId);
    void this.generateBacklogTitle(backlogId, originalTitle, material)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`迭代项 #${backlogId} 标题生成失败：${message}`);
      })
      .finally(() => this.titleNaming.delete(backlogId));
  }

  private async generateBacklogTitle(
    backlogId: number,
    originalTitle: string,
    material: {
      requirement: string;
      iteration: string;
      owner: string;
      description?: string;
    },
  ): Promise<void> {
    const generated = await this.llm.generateTitle(
      [
        `需求：${material.requirement}`,
        `迭代：${material.iteration}`,
        `负责人：${material.owner}`,
        ...(material.description ? [`说明：${material.description}`] : []),
      ]
        .join('\n')
        .slice(0, 4000),
    );
    if (!generated) return;
    const title = `「BL-${backlogId}」${generated}`.slice(0, 200);
    const result = await this.backlogs
      .createQueryBuilder()
      .update(Backlog)
      .set({ title })
      .where('id = :id AND title = :original', {
        id: backlogId,
        original: originalTitle,
      })
      .execute();
    if (result.affected) {
      this.logger.log(`迭代项 #${backlogId} 标题已生成：${title}`);
    }
  }

  private applyStatus(
    backlog: Backlog,
    status: BacklogStatus,
    by: string,
    now: Date,
  ): Backlog {
    backlog.status = status;
    backlog.statusBy = by;
    switch (status) {
      case BacklogStatus.WAITING:
        backlog.startedAt = null;
        backlog.testingAt = null;
        backlog.releasingAt = null;
        backlog.completedAt = null;
        backlog.canceledAt = null;
        break;
      case BacklogStatus.EXECUTING:
        backlog.startedAt = backlog.startedAt ?? now;
        backlog.testingAt = null;
        backlog.releasingAt = null;
        backlog.completedAt = null;
        backlog.canceledAt = null;
        break;
      case BacklogStatus.TESTING:
        backlog.startedAt = backlog.startedAt ?? now;
        backlog.testingAt = now;
        backlog.releasingAt = null;
        backlog.completedAt = null;
        backlog.canceledAt = null;
        break;
      case BacklogStatus.RELEASING:
        backlog.startedAt = backlog.startedAt ?? now;
        backlog.testingAt = backlog.testingAt ?? now;
        backlog.releasingAt = now;
        backlog.completedAt = null;
        backlog.canceledAt = null;
        break;
      case BacklogStatus.COMPLETED:
        backlog.startedAt = backlog.startedAt ?? now;
        backlog.testingAt = backlog.testingAt ?? now;
        backlog.releasingAt = backlog.releasingAt ?? now;
        backlog.completedAt = now;
        backlog.canceledAt = null;
        break;
      case BacklogStatus.CANCELED:
        backlog.canceledAt = now;
        break;
      default:
        break;
    }
    return backlog;
  }

  private isTerminal(status: BacklogStatus): boolean {
    return (
      status === BacklogStatus.COMPLETED || status === BacklogStatus.CANCELED
    );
  }

  private isManualRole(role: BacklogMemberRole): boolean {
    return MANUAL_BACKLOG_MEMBER_ROLES.includes(role);
  }

  private isAutoRole(role: BacklogMemberRole): boolean {
    return AUTO_BACKLOG_MEMBER_ROLES.includes(role);
  }

  /** 操作人对应的机器人：机器人令牌用自身；真人登录映射其真人机器人 */
  private async resolveActorWorkerId(
    actor: IterationActor,
  ): Promise<number | null> {
    if (actor.workerId !== null && actor.workerId !== undefined) {
      return actor.workerId;
    }
    if (actor.userId === null || actor.userId === undefined) return null;
    const human = await this.workers.findOne({
      where: { humanUserId: actor.userId },
      select: { id: true },
    });
    return human?.id ?? null;
  }

  /** 是否手动成员（以机器人身份判定；自动列入的负责人/需求方不授予成员操作权限） */
  private async isMember(
    backlog: Backlog,
    actor: IterationActor,
  ): Promise<boolean> {
    const workerId = await this.resolveActorWorkerId(actor);
    if (workerId === null) return false;
    return (backlog.members ?? []).some(
      (member) =>
        member.workerId === workerId && this.isManualRole(member.role),
    );
  }

  /**
   * 重新计算并写入自动成员行（负责人 / 需求方）。
   * 手动成员原样保留；自动行由负责人字段、需求方字段派生，按「角色 + 机器人」去重
   * （同一人不同角色各占一行）。仅改动内存对象，由调用方保存。返回是否变化。
   */
  private async refreshAutoMembers(backlog: Backlog): Promise<boolean> {
    const manual = (backlog.members ?? []).filter((member) =>
      this.isManualRole(member.role),
    );
    const auto: BacklogMember[] = [];

    // 负责人：ownerWorkerId 对应的机器人（真人或 AI 机器人）
    if (backlog.ownerWorkerId) {
      let name = backlog.ownerName;
      if (!name) {
        const worker = await this.workers.findOne({
          where: { id: backlog.ownerWorkerId },
          select: { name: true },
        });
        name = worker?.name ?? `#${backlog.ownerWorkerId}`;
      }
      auto.push({
        role: BacklogMemberRole.OWNER,
        workerId: backlog.ownerWorkerId,
        name: name.slice(0, 100),
      });
    }

    // 需求方：projects.owner 姓名 → 真人机器人
    const project = await this.projects.findOne({
      where: { id: backlog.projectId },
      select: { owner: true },
    });
    const demandNames = splitMemberNames(project?.owner ?? null);
    if (demandNames.length) {
      const users = await this.users.find({
        where: { name: In(demandNames), enabled: true },
        select: { id: true, name: true },
      });
      const userByName = new Map<string, { id: number; name: string }>();
      for (const user of users) {
        if (!userByName.has(user.name)) userByName.set(user.name, user);
      }
      const demandUserIds = [
        ...new Set([...userByName.values()].map((user) => user.id)),
      ];
      const humans = demandUserIds.length
        ? await this.workers.find({
            where: { humanUserId: In(demandUserIds) },
            select: { id: true, name: true, humanUserId: true },
          })
        : [];
      const humanByUser = new Map(
        humans.map((worker) => [worker.humanUserId as number, worker]),
      );
      for (const name of demandNames) {
        const user = userByName.get(name);
        if (!user) continue;
        const human = humanByUser.get(user.id);
        if (!human) continue;
        auto.push({
          role: BacklogMemberRole.DEMAND,
          workerId: human.id,
          name: (human.name || user.name).slice(0, 100),
        });
      }
    }

    const seen = new Set<string>();
    const merged: BacklogMember[] = [];
    for (const member of [...manual, ...auto]) {
      const key = `${member.role}:${member.workerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(member);
    }

    const before = JSON.stringify(backlog.members ?? []);
    const after = JSON.stringify(merged);
    if (before === after) return false;
    backlog.members = merged.length ? merged : null;
    return true;
  }

  /** 成员变化后同步进已有飞书沟通群（只加不减）；失败只告警 */
  private async syncChatMembers(backlog: Backlog): Promise<void> {
    try {
      await this.chat.syncMembers(backlog.id);
    } catch (error) {
      this.logger.warn(
        `迭代项 ${backlog.code} 沟通群成员同步失败：${(error as Error).message}`,
      );
    }
  }

  /**
   * 需求方（projects.owner）变化后联动刷新：该需求全部未取消迭代项的「需求方」成员行
   * 重新派生，并把新增成员拉进已有飞书群。失败只告警不阻断主流程。
   */
  async refreshDemandMembers(projectId: number): Promise<void> {
    const backlogs = await this.backlogs.find({
      where: { projectId, status: Not(BacklogStatus.CANCELED) },
    });
    for (const backlog of backlogs) {
      try {
        if (await this.refreshAutoMembers(backlog)) {
          await this.backlogs.save(backlog);
        }
        await this.syncChatMembers(backlog);
      } catch (error) {
        this.logger.warn(
          `需求 #${projectId} 迭代项 ${backlog.code} 需求方成员刷新失败：${(error as Error).message}`,
        );
      }
    }
  }

  private assertAssignableWorker(worker: Worker | undefined, id: number): void {
    if (!worker) throw new BadRequestException(`负责人机器人 #${id} 不存在`);
    if (!worker.enabled) {
      throw new BadRequestException(`负责人机器人「${worker.name}」已停用`);
    }
    if (worker.role === WorkerRole.SCHEDULER) {
      throw new BadRequestException(
        `「${worker.name}」为调度机器人，不承接交付任务`,
      );
    }
    if (worker.personalAgentUserId) {
      throw new BadRequestException(
        `「${worker.name}」为个人 AGENT，不承接迭代交付任务`,
      );
    }
  }

  /**
   * 合并前校验角色与机器人存在性（按「角色 + 机器人」去重）。
   * 成员统一存为机器人：workerId 直接选机器人；userId/name 选真人时映射为其真人机器人。
   * 自动角色（负责人/需求方）由系统维护，手动提交会被忽略。
   */
  private async normalizeMembers(
    input?: BacklogMemberInput[],
  ): Promise<BacklogMember[]> {
    if (!input || input.length === 0) return [];
    const allRoles = new Set<string>(Object.values(BacklogMemberRole));
    const manualRoles = new Set<string>(MANUAL_BACKLOG_MEMBER_ROLES);
    type Pick = {
      role: BacklogMemberRole;
      workerId?: number;
      userId?: number;
      name?: string;
    };
    const picks: Pick[] = [];
    const names = new Set<string>();
    for (const member of input) {
      if (!member || !allRoles.has(member.role)) {
        throw new BadRequestException(`成员角色非法：${String(member?.role)}`);
      }
      // 自动角色由系统按负责人/需求方维护，忽略手动提交
      if (!manualRoles.has(member.role)) continue;
      if (member.workerId !== undefined && member.workerId !== null) {
        if (!Number.isInteger(member.workerId) || member.workerId <= 0) {
          throw new BadRequestException('成员机器人 ID 非法');
        }
        picks.push({ role: member.role, workerId: member.workerId });
        continue;
      }
      if (member.userId !== undefined && member.userId !== null) {
        if (!Number.isInteger(member.userId) || member.userId <= 0) {
          throw new BadRequestException('成员用户 ID 非法');
        }
        picks.push({ role: member.role, userId: member.userId });
        continue;
      }
      const memberNames = splitMemberNames(member.name);
      if (memberNames.length === 0) {
        throw new BadRequestException(
          `成员「${member.role}」须提供 workerId、userId 或 name`,
        );
      }
      for (const name of memberNames) {
        names.add(name);
        picks.push({ role: member.role, name });
      }
    }

    // 直接选择的机器人（AI 或真人机器人）
    const directWorkerIds = [
      ...new Set(
        picks
          .map((pick) => pick.workerId)
          .filter((id): id is number => id !== undefined),
      ),
    ];
    const directWorkers = directWorkerIds.length
      ? await this.workers.find({ where: { id: In(directWorkerIds) } })
      : [];
    const directMap = new Map(
      directWorkers.map((worker) => [worker.id, worker]),
    );

    // 真人姓名 → 用户（启用）
    const resolvedNames = names.size
      ? await this.resolveUserNames([...names])
      : new Map<string, { id: number; name: string }>();
    // 直接选择的用户 ID
    const directUserIds = [
      ...new Set(
        picks
          .map((pick) => pick.userId)
          .filter((id): id is number => id !== undefined),
      ),
    ];
    const directUsers = directUserIds.length
      ? await this.users.find({
          where: { id: In(directUserIds) },
          select: { id: true, name: true },
        })
      : [];
    const directUserMap = new Map(directUsers.map((user) => [user.id, user]));

    // 用户 → 真人机器人
    const userIds = [
      ...new Set([
        ...directUserIds,
        ...[...resolvedNames.values()].map((user) => user.id),
      ]),
    ];
    const humans = userIds.length
      ? await this.workers.find({
          where: { humanUserId: In(userIds) },
          select: { id: true, name: true, humanUserId: true },
        })
      : [];
    const humanByUser = new Map(
      humans.map((worker) => [worker.humanUserId as number, worker]),
    );

    const seen = new Set<string>();
    const result: BacklogMember[] = [];
    for (const pick of picks) {
      let workerId: number;
      let name: string;
      if (pick.workerId !== undefined) {
        const worker = directMap.get(pick.workerId);
        if (!worker) {
          throw new BadRequestException(`成员机器人 #${pick.workerId} 不存在`);
        }
        this.assertAssignableWorker(worker, pick.workerId);
        workerId = worker.id;
        name = worker.name;
      } else {
        let userId: number;
        if (pick.userId !== undefined) {
          const user = directUserMap.get(pick.userId);
          if (!user) {
            throw new BadRequestException(`成员用户 #${pick.userId} 不存在`);
          }
          userId = user.id;
        } else {
          const user = resolvedNames.get(pick.name!);
          if (!user) {
            throw new BadRequestException(
              `成员用户「${pick.name}」不存在或已停用`,
            );
          }
          userId = user.id;
        }
        const human = humanByUser.get(userId);
        if (!human) {
          throw new BadRequestException(
            `用户 #${userId} 缺少真人机器人，无法加入成员`,
          );
        }
        workerId = human.id;
        name = human.name;
      }
      const key = `${pick.role}:${workerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ role: pick.role, workerId, name: name.slice(0, 100) });
    }
    return result;
  }

  /** 姓名 → 用户系统内用户（启用）；不存在/停用的姓名直接报错 */
  private async resolveUserNames(
    names: string[],
  ): Promise<Map<string, { id: number; name: string }>> {
    if (names.length === 0) return new Map();
    const users = await this.users.find({
      where: { name: In(names), enabled: true },
      select: { id: true, name: true },
    });
    const byName = new Map<string, { id: number; name: string }>();
    for (const user of users) {
      if (!byName.has(user.name)) byName.set(user.name, user);
    }
    const missing = names.filter((name) => !byName.has(name));
    if (missing.length > 0) {
      throw new BadRequestException(
        `以下成员用户不存在或已停用：${missing.join('、')}`,
      );
    }
    return byName;
  }

  private assertAdmin(actor: IterationActor, message: string): void {
    if (!actor.isAdmin) throw new ForbiddenException(message);
  }

  /** 成员维护权限：管理员，或该迭代项的负责人机器人（网页负责人真人登录经其真人机器人判定） */
  private async canUpdateMembers(
    backlog: Backlog,
    actor: IterationActor,
  ): Promise<boolean> {
    if (actor.isAdmin) return true;
    if (
      actor.workerId !== null &&
      actor.workerId !== undefined &&
      backlog.ownerWorkerId === actor.workerId
    ) {
      return true;
    }
    if (actor.userId !== null && backlog.ownerWorkerId !== null) {
      const humanWorker = await this.workers.findOne({
        where: { humanUserId: actor.userId },
        select: { id: true },
      });
      if (humanWorker && backlog.ownerWorkerId === humanWorker.id) return true;
    }
    return false;
  }

  private async assertCanUpdateMembers(
    backlog: Backlog,
    actor: IterationActor,
  ): Promise<void> {
    if (await this.canUpdateMembers(backlog, actor)) return;
    throw new ForbiddenException('仅管理员或迭代项负责人可修改成员');
  }
}
