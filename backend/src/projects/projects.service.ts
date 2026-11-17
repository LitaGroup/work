import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as path from 'path';
import {
  FindOptionsWhere,
  ILike,
  In,
  IsNull,
  Not,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import {
  BacklogStatus,
  IterationType,
  ProjectStatus,
  ProjectType,
  ResourceStatus,
  TaskStatus,
  TaskSubStatus,
  TopicSubjectType,
} from '../common/enums';
import { ChecksService } from '../checks/checks.service';
import { Check } from '../checks/check.entity';
import { TestsService } from '../tests/tests.service';
import { Test } from '../tests/test.entity';
import { ExportsService } from '../exports/exports.service';
import { Export } from '../exports/export.entity';
import { SchedulesService } from '../schedules/schedules.service';
import { Schedule } from '../schedules/schedule.entity';
import {
  DOCUMENT_LIST_SELECT,
  DocumentsService,
} from '../documents/documents.service';
import { Document } from '../documents/document.entity';
import { Topic } from '../topics/topic.entity';
import { topicSectionFor } from '../topics/topic-markdown';
import { DEFECT_LIST_SELECT, DefectsService } from '../defects/defects.service';
import { Defect } from '../defects/defect.entity';
import {
  RESOURCE_LIST_SELECT,
  ResourcesService,
} from '../resources/resources.service';
import { Resource } from '../resources/resource.entity';
import { MilestonesService } from '../milestones/milestones.service';
import { AppVersionsService } from '../app-versions/app-versions.service';
import { CodeBranchesService } from '../github/code-branches.service';
import { ProjectBranch } from '../github/project-branch.entity';
import { mdFrontmatter, beijingTime } from '../common/frontmatter';
import { splitMemberNames } from '../common/names';
import { ReleasesService } from '../releases/releases.service';
import { ProjectRelease } from '../releases/project-release.entity';
import { SUMMARY_MAX_CHARS } from '../model-config/llm.service';
import { FeishuBotProjectChatService } from '../feishu-bot/feishu-bot-project-chat.service';
import {
  TasksService,
  type ProjectDeliveryTaskView,
} from '../tasks/tasks.service';
import { Task } from '../tasks/task.entity';
import { TaskEvent } from '../tasks/task-event.entity';
import { SYSTEM_PROJECT_DELIVERY_TASK_TEMPLATE_ID } from '../tasks/system-task-templates';
import { Ticket } from '../tickets/ticket.entity';
import { TicketWorkflowRun } from '../tickets/ticket-workflow-run.entity';
import { Worker } from '../workers/worker.entity';
import { Backlog } from '../iterations/backlog.entity';
import { Iteration } from '../iterations/iteration.entity';
import { Project } from './project.entity';
import { ProjectSummaryService } from './project-summary.service';
import { ProjectDescriptionService } from './project-description.service';
import {
  DAY_MS,
  UNSCHEDULED_FRESH_DAYS,
  deriveProjectStatus,
} from './project-status';

export interface CreateProjectInput {
  name: string;
  type?: ProjectType;
  expectedReleaseAt?: string;
  description?: string;
}

/** 项目表格分页查询参数（GET /projects/page） */
export interface ProjectPageQuery {
  page?: number;
  pageSize?: number;
  q?: string;
  iteration?: string;
  status?: ProjectStatus;
  type?: ProjectType;
  priority?: string;
  /**
   * 需求池快捷视图（与计划周无关，以「是否存在未取消迭代项」判定是否已排期）：
   * - unscheduled：未排期且创建不超过 30 天；
   * - scheduled：已排期（已进入迭代）；
   * - expired：未排期且创建超过 30 天。
   */
  view?: 'unscheduled' | 'scheduled' | 'expired';
}

/** 需求池「迭代」列：需求当前未取消迭代项所属迭代（应用层引用 backlogs.iterationId） */
export interface ProjectIterationRef {
  id: number;
  code: string;
  type: IterationType;
}

/** 需求池列表项：项目轻量列 + 所属迭代；未进入迭代时 iteration 为 null */
export interface ProjectListItem extends Project {
  iteration: ProjectIterationRef | null;
}

/** 项目表格分页响应（items 只含当前页，total/iterations/priorities 供分页与筛选用） */
export interface ProjectPage {
  items: ProjectListItem[];
  total: number;
  iterations: string[];
  priorities: string[];
}

/** 项目详情任务板块：任务/子任务与关联工单的统一展示项 */
export type ProjectWorkItemKind = 'task' | 'ticket';

export interface ProjectWorkItem {
  kind: ProjectWorkItemKind;
  id: number;
  code: string;
  title: string;
  status: string;
  /** 任务子状态；工单为空 */
  subStatus: string | null;
  /** 执行机器人或工单处理人，个人 AGENT 展示其主人 */
  agentName: string | null;
  /** 当前进度：任务取实时输出/最近事件，工单优先取当前节点 */
  progress: string;
  /** 工单当前节点 */
  currentNodeName: string | null;
  /** 子任务指向父任务；根任务与工单为空 */
  parentTaskId: number | null;
  updatedAt: Date;
}

const PROJECT_TASK_SELECT = {
  id: true,
  code: true,
  title: true,
  status: true,
  subStatus: true,
  parentId: true,
  rootId: true,
  agentId: true,
  updatedAt: true,
} as const;

const PROJECT_TICKET_SELECT = {
  id: true,
  code: true,
  title: true,
  taskId: true,
  assigneeId: true,
  assigneeName: true,
  workflowStatus: true,
  currentNodeName: true,
  updatedAt: true,
} as const;

/** 历史工单状态按关联任务推导；工作流工单直接使用工单状态 */
function deriveProjectTicketStatus(
  ticket: Ticket,
  task: Task | undefined,
): string {
  if (ticket.workflowStatus?.trim()) return ticket.workflowStatus;
  if (!task) return '已取消';
  if (task.status === TaskStatus.FINISHED) {
    if (task.subStatus === TaskSubStatus.COMPLETED) return '已完成';
    if (task.subStatus === TaskSubStatus.CANCELED) return '已取消';
    return '已失败';
  }
  if (task.status === TaskStatus.RUNNING) return '处理中';
  return task.subStatus;
}

/** 编号的自然排序（数字段按数值比较，如 check-2 < check-10） */
const codeCollator = new Intl.Collator('zh-Hans', { numeric: true });

/**
 * 项目列表列（GET /projects 及全局列表的"项目"下拉都用它）：
 * 排除 longtext description 与只在详情页用到的字段，缩少 3.6k 条记录的网络/序列化开销。
 */
const PROJECT_LIST_SELECT = {
  id: true,
  name: true,
  type: true,
  status: true,
  expectedReleaseAt: true,
  priority: true,
  iterationCycle: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** 迭代分组视图（GET /projects/iterations）单项，业务分区「迭代」栏目使用 */
export interface IterationGroup {
  /** 迭代周期原值；'-' 表示未排期 */
  cycle: string;
  /** 解析自 `w{n}: MM/DD-MM/DD` 的周编号；无法解析为 null */
  week: number | null;
  /** 日期区间展示（如 `08/19-08/25`）；无法解析为 null */
  dateRange: string | null;
  /** 今天（北京）是否落在该周期区间 */
  current: boolean;
  total: number;
  /** 各状态需求数（未排期组没有已发布进度含义，由前端自行呈现） */
  statusCounts: Partial<Record<ProjectStatus, number>>;
  items: Project[];
}

/** 未排期分组键：飞书同步无法识别的迭代统一为 '-'，本地清空为空串/NULL，一并归入 */
export const UNSCHEDULED_CYCLE = '-';

/** 解析迭代周期 `w{n}: MM/DD-MM/DD`（归一化格式，见 toIterationCycle）；'-' / 空 / 无法解析返回 null */
export function parseIterationCycle(cycle: string | null | undefined): {
  week: number;
  start: [number, number];
  end: [number, number];
} | null {
  if (!cycle || cycle === UNSCHEDULED_CYCLE) return null;
  const m = cycle.match(/^w(\d+):\s*(\d{2})\/(\d{2})-(\d{2})\/(\d{2})$/);
  if (!m) return null;
  return {
    week: Number(m[1]),
    start: [Number(m[2]), Number(m[3])],
    end: [Number(m[4]), Number(m[5])],
  };
}

/** 今天（北京时间）的 [月, 日] */
function beijingMonthDay(now: Date = new Date()): [number, number] {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPart['type']) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return [get('month'), get('day')];
}

/** 今天（北京）是否落在迭代区间；跨年区间（12/28-01/03）按 起点之后或终点之前 判定 */
export function isIterationCurrent(
  start: [number, number],
  end: [number, number],
  now: Date = new Date(),
): boolean {
  const today = beijingMonthDay(now);
  const cmp = (a: [number, number], b: [number, number]) =>
    a[0] * 100 + a[1] - (b[0] * 100 + b[1]);
  if (cmp(end, start) >= 0) {
    return cmp(today, start) >= 0 && cmp(today, end) <= 0;
  }
  return cmp(today, start) >= 0 || cmp(today, end) <= 0;
}

/**
 * 需求按迭代周期分组（纯函数，便于单测）：
 * - '-' / 空串 / NULL 归入未排期组，置于最后；
 * - 可解析的 `w{n}` 组按周编号倒序（新迭代在前）；
 * - 无法解析的其他取值按周编号 null 组紧随其后、按周期名排序。
 */
export function groupProjectsByIteration(
  projects: Project[],
  now: Date = new Date(),
): IterationGroup[] {
  const map = new Map<string, Project[]>();
  for (const p of projects) {
    const key =
      !p.iterationCycle || p.iterationCycle === ''
        ? UNSCHEDULED_CYCLE
        : p.iterationCycle;
    const bucket = map.get(key);
    if (bucket) bucket.push(p);
    else map.set(key, [p]);
  }

  const groups: IterationGroup[] = [];
  for (const [cycle, items] of map) {
    const parsed = parseIterationCycle(cycle);
    const statusCounts: Partial<Record<ProjectStatus, number>> = {};
    for (const p of items) {
      statusCounts[p.status] = (statusCounts[p.status] ?? 0) + 1;
    }
    groups.push({
      cycle,
      week: parsed?.week ?? null,
      dateRange: parsed
        ? `${String(parsed.start[0]).padStart(2, '0')}/${String(
            parsed.start[1],
          ).padStart(
            2,
            '0',
          )}-${String(parsed.end[0]).padStart(2, '0')}/${String(
            parsed.end[1],
          ).padStart(2, '0')}`
        : null,
      current: parsed
        ? isIterationCurrent(parsed.start, parsed.end, now)
        : false,
      total: items.length,
      statusCounts,
      items,
    });
  }

  const collator = new Intl.Collator('zh-Hans', { numeric: true });
  groups.sort((a, b) => {
    if (a.cycle === UNSCHEDULED_CYCLE) return 1;
    if (b.cycle === UNSCHEDULED_CYCLE) return -1;
    if (a.week !== null && b.week !== null) return b.week - a.week;
    if (a.week !== null) return -1;
    if (b.week !== null) return 1;
    return collator.compare(a.cycle, b.cycle);
  });
  return groups;
}

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    @InjectRepository(Project)
    private readonly projects: Repository<Project>,
    private readonly releasesService: ReleasesService,
    private readonly documentsService: DocumentsService,
    private readonly checksService: ChecksService,
    private readonly testsService: TestsService,
    private readonly exportsService: ExportsService,
    private readonly schedulesService: SchedulesService,
    private readonly defectsService: DefectsService,
    private readonly resourcesService: ResourcesService,
    private readonly milestonesService: MilestonesService,
    private readonly appVersionsService: AppVersionsService,
    private readonly codeBranchesService: CodeBranchesService,
    private readonly tasksService: TasksService,
    private readonly projectChats: FeishuBotProjectChatService,
    @InjectRepository(Backlog)
    private readonly backlogRows: Repository<Backlog>,
    @InjectRepository(Iteration)
    private readonly iterationRows: Repository<Iteration>,
    @InjectRepository(Topic)
    private readonly topicRows: Repository<Topic>,
    private readonly projectSummary: ProjectSummaryService,
    private readonly projectDescription: ProjectDescriptionService,
  ) {}

  findAll(): Promise<Project[]> {
    return this.projects
      .find({
        select: PROJECT_LIST_SELECT,
        order: { createdAt: 'DESC' },
      })
      .then((projects) => this.applyDerivedStatuses(projects));
  }

  /**
   * 项目表格分页（GET /projects/page）：只返回当前页 + total + 筛选项取值。
   * 避免一次把 3.6k 条项目全量拉回（远程 RDS 上全量扫描 ~1s+，分页 ~100ms）。
   */
  async findPage(query: ProjectPageQuery): Promise<ProjectPage> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));

    const qb = this.projects.createQueryBuilder('project');
    if (query.q) qb.andWhere('project.name ILIKE :q', { q: `%${query.q}%` });
    if (query.type) qb.andWhere('project.type = :type', { type: query.type });
    if (query.priority) {
      qb.andWhere('project.priority = :priority', { priority: query.priority });
    }
    if (query.iteration === '-') {
      // 需求池「未排期」约定：迭代筛选传 '-' 时把 空串/NULL 一并视为未排期
      qb.andWhere(
        "(project.iterationCycle IS NULL OR project.iterationCycle IN ('-', ''))",
      );
    } else if (query.iteration) {
      qb.andWhere('project.iterationCycle = :iteration', {
        iteration: query.iteration,
      });
    }
    if (query.view) this.applyViewFilter(qb, query.view);
    if (query.status) this.applyStatusFilter(qb, query.status);

    const [items, total] = await qb
      .select(Object.keys(PROJECT_LIST_SELECT).map((key) => `project.${key}`))
      .orderBy('project.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    const [iterations, priorities] = await Promise.all([
      this.distinctColumn('iterationCycle'),
      this.distinctColumn('priority'),
    ]);
    const activeBacklogs = await this.loadActiveBacklogs(
      items.map((project) => project.id),
    );
    const iterationById = await this.loadIterations([
      ...new Set([...activeBacklogs.values()].map((row) => row.iterationId)),
    ]);
    const now = new Date();
    return {
      items: items.map((project) => {
        const backlog = activeBacklogs.get(project.id);
        const iteration = backlog
          ? iterationById.get(backlog.iterationId)
          : undefined;
        return {
          ...project,
          status: deriveProjectStatus(
            backlog?.status ?? null,
            project.createdAt,
            now,
          ),
          iteration: iteration
            ? { id: iteration.id, code: iteration.code, type: iteration.type }
            : null,
        };
      }),
      total,
      iterations,
      priorities,
    };
  }

  /**
   * 快捷视图（与计划周无关，按是否存在未取消迭代项判定）：
   * - scheduled：已排期（不限创建时间）；
   * - unscheduled：未排期且创建不超过 30 天；
   * - expired：未排期且创建超过 30 天。
   */
  private applyViewFilter(
    qb: SelectQueryBuilder<Project>,
    view: NonNullable<ProjectPageQuery['view']>,
  ): void {
    if (view === 'scheduled') {
      qb.andWhere(
        `EXISTS (
           SELECT 1 FROM "backlogs" backlog
           WHERE backlog."projectId" = project.id
             AND backlog."status"::text <> :canceledBacklogStatus
         )`,
        { canceledBacklogStatus: BacklogStatus.CANCELED },
      );
      return;
    }
    // 已完成但未取消的迭代项仍算已排期，只有取消后才能重新回到未排期。
    qb.andWhere(
      `NOT EXISTS (
         SELECT 1 FROM "backlogs" backlog
         WHERE backlog."projectId" = project.id
           AND backlog."status"::text <> :canceledBacklogStatus
       )`,
      { canceledBacklogStatus: BacklogStatus.CANCELED },
    );
    const cutoff = new Date(Date.now() - UNSCHEDULED_FRESH_DAYS * DAY_MS);
    qb.andWhere(
      view === 'unscheduled'
        ? 'project.createdAt >= :cutoff'
        : 'project.createdAt < :cutoff',
      { cutoff },
    );
  }

  /**
   * 状态筛选：四态全部按推导规则翻译成 SQL（存量落库值不参与判定），
   * 与 deriveProjectStatus 口径保持一致。
   */
  private applyStatusFilter(
    qb: SelectQueryBuilder<Project>,
    status: ProjectStatus,
  ): void {
    const cutoff = new Date(Date.now() - UNSCHEDULED_FRESH_DAYS * DAY_MS);
    const activeBacklogExists = (extra = '') =>
      `EXISTS (
         SELECT 1 FROM "backlogs" backlog
         WHERE backlog."projectId" = project.id
           AND backlog."status"::text <> :canceledBacklogStatus${extra}
       )`;
    const noActiveBacklog = `NOT EXISTS (
       SELECT 1 FROM "backlogs" backlog
       WHERE backlog."projectId" = project.id
         AND backlog."status"::text <> :canceledBacklogStatus
     )`;
    const params = { canceledBacklogStatus: BacklogStatus.CANCELED };

    switch (status) {
      case ProjectStatus.PLANNED:
        qb.andWhere(noActiveBacklog, params).andWhere(
          'project.createdAt >= :cutoff',
          { cutoff },
        );
        return;
      case ProjectStatus.FINISHED:
        qb.andWhere(noActiveBacklog, params).andWhere(
          'project.createdAt < :cutoff',
          { cutoff },
        );
        return;
      case ProjectStatus.IN_PROGRESS:
        qb.andWhere(
          activeBacklogExists(
            ' AND backlog."status"::text <> :completedBacklogStatus',
          ),
          { ...params, completedBacklogStatus: BacklogStatus.COMPLETED },
        );
        return;
      case ProjectStatus.PUBLISHED:
        qb.andWhere(
          activeBacklogExists(
            ' AND backlog."status"::text = :completedBacklogStatus',
          ),
          { ...params, completedBacklogStatus: BacklogStatus.COMPLETED },
        );
        return;
      default:
        // 理论不可达（枚举已收敛为四态），兜底按落库值过滤
        qb.andWhere('project.status = :status', { status });
    }
  }

  /** 批量覆盖推导状态（列表/详情/Markdown 视图统一入口，落库值不作为展示依据） */
  private async applyDerivedStatuses<T extends Project>(
    items: T[],
  ): Promise<T[]> {
    const activeBacklogs = await this.loadActiveBacklogs(
      items.map((project) => project.id),
    );
    const now = new Date();
    for (const project of items) {
      project.status = deriveProjectStatus(
        activeBacklogs.get(project.id)?.status ?? null,
        project.createdAt,
        now,
      );
    }
    return items;
  }

  /**
   * 批量读取需求的未取消迭代项（projectId → 迭代项摘要）。
   * 一个需求同时只允许一个未取消迭代项（见 AGENTS.md 迭代与 Backlog），已取消的不计入。
   */
  private async loadActiveBacklogs(
    projectIds: number[],
  ): Promise<Map<number, { iterationId: number; status: BacklogStatus }>> {
    const map = new Map<
      number,
      { iterationId: number; status: BacklogStatus }
    >();
    if (projectIds.length === 0) return map;
    const backlogs = await this.backlogRows.find({
      where: {
        projectId: In(projectIds),
        status: Not(BacklogStatus.CANCELED),
      },
      select: { projectId: true, iterationId: true, status: true },
    });
    for (const backlog of backlogs) {
      map.set(backlog.projectId, {
        iterationId: backlog.iterationId,
        status: backlog.status,
      });
    }
    return map;
  }

  /** 批量读取迭代摘要（id → code/type），供需求池「迭代」列展示 */
  private async loadIterations(
    iterationIds: number[],
  ): Promise<Map<number, { id: number; code: string; type: IterationType }>> {
    if (iterationIds.length === 0) return new Map();
    const iterations = await this.iterationRows.find({
      where: { id: In(iterationIds) },
      select: { id: true, code: true, type: true },
    });
    return new Map(iterations.map((it) => [it.id, it]));
  }

  /**
   * 迭代分组视图（GET /projects/iterations）：把需求按迭代周期聚合，反映当前进度。
   * 全量走列表轻列（与 GET /projects 同一模式），分组与统计在内存完成；状态按推导值统计。
   */
  async groupIterations(): Promise<IterationGroup[]> {
    const projects = await this.projects.find({
      select: PROJECT_LIST_SELECT,
      order: { createdAt: 'DESC' },
    });
    return groupProjectsByIteration(await this.applyDerivedStatuses(projects));
  }

  /** 某列的去重取值（供筛选下拉），仅返回非空值 */
  private async distinctColumn(
    column: 'iterationCycle' | 'priority',
  ): Promise<string[]> {
    const rows = await this.projects
      .createQueryBuilder('p')
      .select(`DISTINCT p.${column}`, 'v')
      .where(`p.${column} IS NOT NULL`)
      .andWhere(`p.${column} <> ''`)
      .orderBy('v', 'ASC')
      .getRawMany<{ v: string }>();
    return rows.map((r) => r.v);
  }

  /**
   * 项目 + 关联（文档/检查/测试/导出/任务/缺陷/资源/节点）。
   * 不用 relations 巨型 LEFT JOIN：测试 RDS 上该 JOIN 要 ~2.5s，
   * 拆成并行小查询仅 ~250ms（见 AGENTS.md 工作约定）。
   */
  async findOne(id: number): Promise<Project> {
    const project = await this.projects.findOne({ where: { id } });
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    const { manager } = this.projects;
    const [
      documents,
      checks,
      tests,
      exportList,
      schedules,
      defects,
      resources,
      milestones,
      projectBranches,
      projectReleases,
      projectDeliveryTask,
      projectWorkItems,
    ] = await Promise.all([
      // 文档列表不取 longtext 正文（列表展示只需元信息）
      manager.find(Document, {
        where: { projectId: id },
        select: DOCUMENT_LIST_SELECT,
      }),
      manager.find(Check, { where: { projectId: id } }),
      manager.find(Test, { where: { projectId: id } }),
      manager.find(Export, { where: { projectId: id } }),
      manager.find(Schedule, { where: { projectId: id } }),
      // 缺陷列表不取 description 等大字段（详情经 GET /defects/:id 单独加载）
      manager.find(Defect, {
        where: { projectId: id },
        select: DEFECT_LIST_SELECT,
        order: { updatedAt: 'DESC' },
      }),
      // 资源不取多语言缓存正文，且隐藏软删除（详情经 GET /resources/:id 单独加载）
      manager.find(Resource, {
        where: { projectId: id, status: Not(ResourceStatus.DISCARDED) },
        select: RESOURCE_LIST_SELECT,
        order: { updatedAt: 'DESC' },
      }),
      // 节点按日期升序，状态由服务层推导
      this.milestonesService.findByProject(id),
      // 代码分支登记（仓库+分支+归类）
      manager.find(ProjectBranch, {
        where: { projectId: id },
        order: { repo: 'ASC', branch: 'ASC' },
      }),
      // 提测记录（倒序）
      manager.find(ProjectRelease, {
        where: { projectId: id },
        order: { createdAt: 'DESC', id: 'DESC' },
      }),
      this.tasksService.findProjectDeliveryTask(id),
      this.findProjectWorkItems(id),
    ]);
    project.documents = documents;
    project.checks = checks;
    project.tests = tests;
    project.exports = exportList;
    project.schedules = schedules;
    project.defects = defects;
    project.projectResources = resources;
    project.milestones = milestones;
    project.projectBranches = projectBranches;
    project.projectReleases = projectReleases;
    Object.assign(project, { projectDeliveryTask, projectWorkItems });
    // 状态为读时推导值（迭代项 + 创建时间），落库值不参与展示
    await this.applyDerivedStatuses([project]);
    // 检查/测试/导出按编号自然排序
    project.checks.sort((a, b) => codeCollator.compare(a.code, b.code));
    project.tests.sort((a, b) => codeCollator.compare(a.code, b.code));
    project.exports.sort((a, b) => codeCollator.compare(a.code, b.code));
    return project;
  }

  /**
   * 项目任务板块：项目交付任务主/子任务、缺陷处理任务及由这些任务关联的工单。
   * 不新增物理外键，按现有 projectId/rootId/followupTaskId/taskId 关系归集。
   */
  async findProjectWorkItems(projectId: number): Promise<ProjectWorkItem[]> {
    const { manager } = this.projects;
    const legacyDescription = `项目ID：${projectId} 的实施交付`;
    const [directRoots, defectRows] = await Promise.all([
      manager.find(Task, {
        where: [
          { projectId, parentId: IsNull() },
          {
            templateId: SYSTEM_PROJECT_DELIVERY_TASK_TEMPLATE_ID,
            parentId: IsNull(),
            description: legacyDescription,
          },
        ],
        select: PROJECT_TASK_SELECT,
        order: { updatedAt: 'DESC' },
      }),
      manager.find(Defect, {
        where: { projectId },
        select: { id: true, followupTaskId: true },
      }),
    ]);

    const rootsById = new Map<number, Task>(
      directRoots.map((task) => [task.id, task]),
    );
    const followupIds = [
      ...new Set(
        defectRows
          .map((defect) => defect.followupTaskId)
          .filter((id): id is number => Boolean(id)),
      ),
    ].filter((id) => !rootsById.has(id));
    if (followupIds.length > 0) {
      const followupTasks = await manager.find(Task, {
        where: { id: In(followupIds) },
        select: PROJECT_TASK_SELECT,
      });
      for (const task of followupTasks) rootsById.set(task.id, task);
    }
    const roots = [...rootsById.values()];
    const treeRootIds = [
      ...new Set(roots.map((task) => task.rootId || task.id)),
    ];
    const children =
      treeRootIds.length > 0
        ? await manager.find(Task, {
            where: {
              rootId: In(treeRootIds),
              parentId: Not(IsNull()),
            },
            select: PROJECT_TASK_SELECT,
          })
        : [];
    const tasksById = new Map<number, Task>();
    for (const task of [...roots, ...children]) tasksById.set(task.id, task);
    // rootId 缺失的历史数据再按主任务 id 补一次
    const knownIds = new Set(tasksById.keys());
    const missingRootIds = treeRootIds.filter((id) => !knownIds.has(id));
    if (missingRootIds.length > 0) {
      const missingRoots = await manager.find(Task, {
        where: { id: In(missingRootIds) },
        select: PROJECT_TASK_SELECT,
      });
      for (const task of missingRoots) tasksById.set(task.id, task);
    }
    const finalTasks = [...tasksById.values()];
    const taskIds = finalTasks.map((task) => task.id);

    const [latestEvents, workflowRuns] = await Promise.all([
      taskIds.length > 0
        ? manager.find(TaskEvent, {
            where: { taskId: In(taskIds) },
            select: {
              id: true,
              taskId: true,
              content: true,
              createdAt: true,
            },
            order: { id: 'DESC' },
          })
        : Promise.resolve([]),
      taskIds.length > 0
        ? manager.find(TicketWorkflowRun, {
            where: { taskId: In(taskIds) },
            select: { id: true, ticketId: true },
          })
        : Promise.resolve([]),
    ]);

    const latestEventByTask = new Map<number, TaskEvent>();
    for (const event of latestEvents) {
      if (!latestEventByTask.has(event.taskId)) {
        latestEventByTask.set(event.taskId, event);
      }
    }

    const ticketIds = [...new Set(workflowRuns.map((run) => run.ticketId))];
    const ticketWhere: FindOptionsWhere<Ticket>[] = [];
    if (taskIds.length > 0) ticketWhere.push({ taskId: In(taskIds) });
    if (ticketIds.length > 0) ticketWhere.push({ id: In(ticketIds) });
    const tickets =
      ticketWhere.length > 0
        ? await manager.find(Ticket, {
            where: ticketWhere,
            select: PROJECT_TICKET_SELECT,
            order: { updatedAt: 'DESC' },
          })
        : [];

    const workerIds = [
      ...new Set([
        ...finalTasks
          .map((task) => task.agentId)
          .filter((id): id is number => Boolean(id)),
        ...tickets.map((ticket) => ticket.assigneeId),
      ]),
    ];
    const workers =
      workerIds.length > 0
        ? await manager.find(Worker, {
            where: { id: In(workerIds) },
            select: {
              id: true,
              name: true,
              ownerName: true,
              personalAgentUserId: true,
            },
          })
        : [];
    const workerById = new Map(workers.map((worker) => [worker.id, worker]));
    const agentName = (id: number | null): string | null => {
      if (!id) return null;
      const worker = workerById.get(id);
      if (!worker) return null;
      return worker.personalAgentUserId && worker.ownerName
        ? worker.ownerName
        : worker.name;
    };

    const progressText = (value: string | null | undefined): string | null =>
      value?.replace(/\s+/g, ' ').trim() || null;

    const items: ProjectWorkItem[] = finalTasks.map((task) => {
      const latestEvent = latestEventByTask.get(task.id);
      return {
        kind: 'task',
        id: task.id,
        code: task.code,
        title: task.title,
        status: task.status,
        subStatus: task.subStatus,
        agentName: agentName(task.agentId),
        progress:
          this.tasksService.latestProjectProgressLine(task.id) ??
          progressText(latestEvent?.content) ??
          '等待任务开始',
        currentNodeName: null,
        parentTaskId: task.parentId,
        updatedAt: task.updatedAt,
      };
    });

    for (const ticket of tickets) {
      const task = ticket.taskId ? tasksById.get(ticket.taskId) : undefined;
      const latestEvent = ticket.taskId
        ? latestEventByTask.get(ticket.taskId)
        : undefined;
      const currentNodeName = ticket.currentNodeName?.trim() || null;
      items.push({
        kind: 'ticket',
        id: ticket.id,
        code: ticket.code,
        title: ticket.title,
        status: deriveProjectTicketStatus(ticket, task),
        subStatus: null,
        agentName: agentName(ticket.assigneeId) ?? ticket.assigneeName,
        progress:
          (currentNodeName ? `当前节点：${currentNodeName}` : null) ??
          progressText(latestEvent?.content) ??
          '等待处理',
        currentNodeName,
        parentTaskId: null,
        updatedAt: ticket.updatedAt,
      });
    }

    return items.sort(
      (a, b) =>
        b.updatedAt.getTime() - a.updatedAt.getTime() ||
        (a.kind === b.kind ? b.id - a.id : a.kind.localeCompare(b.kind)),
    );
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const project = await this.projects.save(this.projects.create(input));
    // 新建需求后触发摘要/描述生成（为空且无进行中生成时才会实际调用模型）
    this.projectSummary.maybeGenerateSummary(project.id);
    this.projectDescription.maybeGenerateDescription(project.id);
    return project;
  }

  /** 幂等创建项目开发交付任务；重复调用返回当前已有任务 */
  async ensureProjectDeliveryTask(
    projectId: number,
    creator?: { userId: number; userName?: string | null },
  ): Promise<ProjectDeliveryTaskView> {
    const project = await this.projects.findOne({
      where: { id: projectId },
      select: { id: true, name: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    const result = await this.tasksService.ensureProjectDeliveryTask(
      projectId,
      creator,
      project.name,
    );
    // 建群失败不能影响任务创建；绑定与重试由沟通群服务持久化处理。
    try {
      await this.projectChats.ensureForProjectTask(projectId, result.task.id);
    } catch (error) {
      this.logger.warn(
        `项目沟通群创建失败（project=${projectId}, task=${result.task.id}）: ${(error as Error).message}`,
      );
    }
    return result;
  }

  /**
   * 需求 Markdown 模糊搜索（GET /requirements/search.md）：
   * LIKE 捞候选后在应用层按匹配度分级排序（精确 > 前缀 > 包含），同级创建时间倒序，取前 5。
   */
  async searchMarkdown(query: string): Promise<string> {
    const q = query.trim();
    if (!q) {
      return [
        mdFrontmatter({}),
        '# 需求搜索',
        '',
        '缺少查询参数 `q`，用法：`GET /api/requirements/search.md?q={名称关键词}`',
        '',
      ].join('\n');
    }
    const candidates = await this.projects.find({
      select: PROJECT_LIST_SELECT,
      where: { name: ILike(`%${q}%`) },
      order: { createdAt: 'DESC' },
      take: 100,
    });
    await this.applyDerivedStatuses(candidates);
    const lower = q.toLowerCase();
    const rank = (name: string): number => {
      const n = name.toLowerCase();
      if (n === lower) return 0;
      if (n.startsWith(lower)) return 1;
      return 2;
    };
    const matched = candidates
      .map((p) => ({ p, r: rank(p.name) }))
      .sort(
        (a, b) =>
          a.r - b.r || b.p.createdAt.getTime() - a.p.createdAt.getTime(),
      )
      .slice(0, 5)
      .map(({ p }) => p);
    const items = matched.map(
      (p) =>
        `- **${p.name}**（${p.type} / ${p.status}）— id：${p.id}，更新：${p.updatedAt.toISOString()} — [详情](/api/requirements/${p.id}.md)`,
    );
    return [
      mdFrontmatter({ title: `需求搜索：${q}` }),
      `# 需求搜索：${q}`,
      '',
      `共 ${candidates.length} 个命中（按匹配度 + 创建时间倒序），返回前 ${items.length} 个：`,
      '',
      ...(items.length > 0 ? items : ['（无命中）']),
      '',
    ].join('\n');
  }

  /**
   * 需求 Markdown 视图（GET /requirements/:id.md）：基本信息 + 描述 + 对应迭代 + 文档资料。
   * 只加载需求本身的数据，不再附带检查/测试/提测/缺陷等研发关联（研发操作见任务定义说明）。
   */
  async findOneRequirementMarkdown(id: number): Promise<string> {
    const project = await this.projects.findOne({ where: { id } });
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    const { manager } = this.projects;
    const [documentRows, backlogRows] = await Promise.all([
      manager.find(Document, {
        where: { projectId: id },
        select: DOCUMENT_LIST_SELECT,
        order: { updatedAt: 'DESC', id: 'DESC' },
      }),
      // 对应迭代：含已取消的历史迭代项，按创建倒序
      manager.find(Backlog, {
        where: { projectId: id },
        order: { id: 'DESC' },
      }),
    ]);
    const iterationIds = [...new Set(backlogRows.map((b) => b.iterationId))];
    const iterationById = new Map(
      (iterationIds.length
        ? await manager.find(Iteration, { where: { id: In(iterationIds) } })
        : []
      ).map((it) => [it.id, it]),
    );
    // 状态为读时推导值（迭代项 + 创建时间），落库值不参与展示
    await this.applyDerivedStatuses([project]);

    const meta = [`- 类型：${project.type}`, `- 状态：${project.status}`];
    if (project.priority) meta.push(`- 优先级：${project.priority}`);
    if (project.expectedReleaseAt) {
      meta.push(`- 预期发布时间：${project.expectedReleaseAt}`);
    }
    if (project.iterationCycle) {
      meta.push(`- 计划周(w)：${project.iterationCycle}`);
    }
    if (project.owner) meta.push(`- 需求方：${project.owner}`);
    if (project.involvedParties?.length) {
      meta.push(`- 涉及方：${project.involvedParties.join('、')}`);
    }
    if (project.remark) meta.push(`- 备注：${project.remark}`);
    if (project.scriptsPath) meta.push(`- 脚本目录：${project.scriptsPath}`);
    meta.push(`- 更新时间：${project.updatedAt.toISOString()}`);

    const backlogLines = backlogRows.map((b) => {
      const iteration = iterationById.get(b.iterationId);
      const parts = [
        iteration
          ? `**${iteration.code}**（${iteration.type}，[迭代](/api/iterations/${iteration.id}.md)）`
          : `迭代 #${b.iterationId}`,
        `[${b.code} ${b.title}](/api/backlogs/${b.id}.md)`,
        `状态：${b.status}`,
      ];
      if (b.ownerName) parts.push(`负责人：${b.ownerName}`);
      if (b.expectedOnlineAt) {
        parts.push(`预期上线：${beijingTime(b.expectedOnlineAt)}`);
      }
      return `- ${parts.join(' — ')}`;
    });

    const documentLines = documentRows.map((d) => {
      const parts = [
        d.url
          ? `**${d.type}** [${d.title}](${d.url})`
          : `**${d.type}** [${d.title}](/api/documents/${d.id}.md)`,
      ];
      if (d.description) parts.push(d.description);
      if (d.remark) parts.push(`备注：${d.remark}`);
      return `- ${parts.join(' — ')}`;
    });

    const lines = [
      mdFrontmatter({ update: project.updatedAt, title: project.name }),
      `# ${project.name}`,
      '',
      ...meta,
      '',
      '## 摘要',
      '',
      project.summary?.trim() || '（暂无，需求或需求类文档更新后自动生成）',
      '',
      '## 描述',
      '',
      project.description ?? '（暂无）',
      '',
      `## 对应的迭代（${backlogRows.length}）`,
      '',
      `全部迭代项（需求转入后生成，含已取消的历史记录）：`,
      '',
      ...(backlogLines.length > 0 ? backlogLines : ['（暂未进入迭代）']),
      '',
      `迭代清单：\`GET /api/iterations.md\`｜迭代详情：\`GET /api/iterations/{iterationId}.md\``,
      '',
      `## 文档资料（${documentRows.length}）`,
      '',
      ...(documentLines.length > 0 ? documentLines : ['（暂无）']),
      '',
      '## AI 操作',
      '',
      '搜索需求：`GET /api/requirements/search.md?q={名称关键词}`（匹配度 + 创建时间倒序，前 5）',
      '',
      '修改需求配置（仅本地字段：脚本目录 / 描述 / 需求方 / 涉及方 / 备注，空串清除）：',
      '',
      '```bash',
      `curl -X POST /api/requirements/${project.id}/update.md -H 'Content-Type: application/json' -d '{"scriptsPath": "projects/xxx", "owner": "张三", "involvedParties": "Android、iOS、Backend", "remark": "排期优先级：P0；排期备注：xxx"}'`,
      '```',
      '',
      '写入/更新需求文档（按 projectId + fileName 判重 upsert；type 可选 需求/功能/测试/技术/接口/配置，缺省"技术"）：',
      '',
      '```bash',
      `curl -X POST /api/documents/upsert.md -H 'Content-Type: application/json' -d '{"projectId": ${project.id}, "fileName": "xxx.md", "title": "标题", "content": "# 正文 Markdown"}'`,
      '```',
      '',
      '把需求转入迭代（仅管理员；负责人为机器人时自动创建交付任务）：',
      '',
      '```bash',
      `curl -X POST /api/iterations/{iterationId}/backlogs -H 'Content-Type: application/json' -d '{"items": [{"projectId": ${project.id}, "ownerWorkerId": 1001}]}'`,
      '```',
      '',
      '研发操作（检查/测试/导出/提测/缺陷/节点/代码分支等）见所在任务的任务定义说明与 `lita-work` MCP 工具。',
      '',
    ];
    const topicsText = await topicSectionFor(
      this.topicRows,
      TopicSubjectType.REQUIREMENT,
      project.id,
    );
    if (topicsText) lines.push(topicsText);
    return lines.join('\n');
  }

  /** 更新项目可编辑字段：类型/优先级/迭代周期/预期发布时间/需求方/涉及方 + 脚本目录（scriptsPath）、描述（description）、摘要（summary），空串清除。状态为推导值不可手改。注意：飞书同步项目的同步字段（类型/优先级/迭代/预期发布/需求方/涉及方）会在下次同步时被飞书侧覆盖 */
  async update(
    id: number,
    input: {
      type?: ProjectType;
      priority?: string;
      iterationCycle?: string;
      expectedReleaseAt?: string;
      owner?: string | null;
      /** 涉及方（飞书「涉及方」多选同步；平台内可编辑，下次同步覆盖），空串清除 */
      involvedParties?: string | null;
      /** 备注（飞书「排期优先级」+「排期备注」同步合成；平台内可编辑，下次同步覆盖），空串清除 */
      remark?: string | null;
      scriptsPath?: string;
      description?: string;
      summary?: string;
    },
  ): Promise<Project> {
    const project = await this.findOne(id);
    if (input.type !== undefined) {
      if (!Object.values(ProjectType).includes(input.type)) {
        throw new BadRequestException(`非法的项目类型：${input.type}`);
      }
      project.type = input.type;
    }
    if (input.priority !== undefined) {
      project.priority = this.normalizeShortText(input.priority, 20, '优先级');
    }
    if (input.iterationCycle !== undefined) {
      project.iterationCycle = this.normalizeShortText(
        input.iterationCycle,
        50,
        '计划周(w)',
      );
    }
    if (input.expectedReleaseAt !== undefined) {
      const v = input.expectedReleaseAt.trim();
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new BadRequestException('预期发布时间须为 YYYY-MM-DD 格式');
      }
      project.expectedReleaseAt = v || null;
    }
    if (input.owner !== undefined) {
      const owner = this.normalizeShortText(input.owner ?? '', 200, '需求方');
      // 需求方同样不允许配置用户系统之外的用户
      if (owner) {
        await this.releasesService.assertNamesInUserSystem(
          splitMemberNames(owner),
          '需求方',
        );
      }
      project.owner = owner;
    }
    if (input.involvedParties !== undefined) {
      // 涉及方为多选值（端/侧），支持顿号/逗号/空格分隔，空串清除
      const parties = splitMemberNames(input.involvedParties ?? '');
      project.involvedParties = parties.length ? parties : null;
    }
    if (input.remark !== undefined) {
      project.remark = this.normalizeShortText(
        input.remark ?? '',
        2000,
        '备注',
      );
    }
    if (input.scriptsPath !== undefined) {
      project.scriptsPath = this.normalizeScriptsPath(input.scriptsPath);
    }
    if (input.description !== undefined) {
      project.description = input.description.trim() || null;
    }
    if (input.summary !== undefined) {
      const summary = input.summary.trim();
      if (summary.length > SUMMARY_MAX_CHARS) {
        throw new BadRequestException(
          `需求摘要不能超过 ${SUMMARY_MAX_CHARS} 字（当前 ${summary.length} 字）`,
        );
      }
      project.summary = summary || null;
    }
    return this.projects.save(project);
  }

  /**
   * AI 用：仅本地字段更新（脚本目录/描述/需求方/涉及方/备注），返回 Markdown 结果。
   * 刻意不含飞书同步字段（类型/优先级/迭代/预期发布），状态为推导值不可改。
   */
  async updateMarkdown(
    id: number,
    input: {
      scriptsPath?: string;
      description?: string;
      owner?: string | null;
      /** 涉及方（飞书「涉及方」多选同步；平台内可编辑，下次同步覆盖），空串清除 */
      involvedParties?: string | null;
      remark?: string | null;
    },
  ): Promise<string> {
    const project = await this.update(id, input);
    const lines: string[] = [];
    if (input.scriptsPath !== undefined) {
      lines.push(
        `- 脚本目录：${project.scriptsPath ? `\`${project.scriptsPath}\`` : '已清除'}`,
      );
    }
    if (input.description !== undefined) {
      lines.push(`- 描述：${project.description ? '已更新' : '已清除'}`);
    }
    if (input.owner !== undefined) {
      lines.push(`- 需求方：${project.owner ?? '已清除'}`);
    }
    if (input.involvedParties !== undefined) {
      lines.push(
        `- 涉及方：${project.involvedParties?.join('、') ?? '已清除'}`,
      );
    }
    if (input.remark !== undefined) {
      lines.push(`- 备注：${project.remark ?? '已清除'}`);
    }
    return [
      mdFrontmatter({
        update: project.updatedAt,
        title: `需求更新 - ${project.name}`,
      }),
      '# 需求已更新',
      '',
      `- 需求：${project.name}（#${project.id}）`,
      ...lines,
      `- 阅读地址：GET /api/requirements/${project.id}.md`,
      '',
    ].join('\n');
  }

  /** 短文本字段（优先级/迭代周期）：trim，空串清除，超长拒绝 */
  private normalizeShortText(
    value: string,
    max: number,
    label: string,
  ): string | null {
    const normalized = value.trim();
    if (!normalized) return null;
    if (normalized.length > max) {
      throw new BadRequestException(`${label}长度不能超过 ${max} 个字符`);
    }
    return normalized;
  }

  /** 脚本目录：相对 CHECK_SCRIPTS_DIR（空串清除）；登记检查时只在该子目录下扫描 */
  private normalizeScriptsPath(scriptsPath: string): string | null {
    const normalized = scriptsPath
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    if (
      normalized &&
      (path.isAbsolute(normalized) || normalized.split('/').includes('..'))
    ) {
      throw new BadRequestException(
        '脚本目录必须是相对脚本根目录的路径，如 projects/active/pk',
      );
    }
    return normalized || null;
  }

  /**
   * 删除项目。测试库无物理外键（见 AGENTS.md），文档/检查/测试/导出/任务需在应用层先清理。
   */
  async remove(id: number): Promise<void> {
    const project = await this.findOne(id);
    await this.documentsService.removeByProject(project.id);
    await this.defectsService.removeByProject(project.id);
    // 资源仅摘除登记，不级联删除绑定的文档（文档可独立存在）
    await this.resourcesService.removeByProject(project.id);
    await this.milestonesService.removeByProject(project.id);
    // 任务先于检查清理（任务依赖检查脚本；检查删除时也会再兜底清理）
    await this.schedulesService.removeByProject(project.id);
    await this.checksService.removeByProject(project.id);
    await this.testsService.removeByProject(project.id);
    await this.exportsService.removeByProject(project.id);
    await this.appVersionsService.removeByProject(project.id);
    await this.codeBranchesService.removeByProject(project.id);
    await this.releasesService.removeByProject(project.id);
    await this.projects.remove(project);
  }
}
