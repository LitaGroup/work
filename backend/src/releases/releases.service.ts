import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ReleaseStatus, TaskStatus, TaskSubStatus } from '../common/enums';
import { beijingTime, mdFrontmatter } from '../common/frontmatter';
import { Project } from '../projects/project.entity';
import { User } from '../auth/user.entity';
import { Task } from '../tasks/task.entity';
import { TaskWorkerInboxService } from '../tasks/task-worker-inbox.service';
import { ProjectRelease } from './project-release.entity';

/** 提测状态可选值（待冒烟 / 进行中 / 已通过 / 未通过） */
export const RELEASE_STATUS_VALUES: string[] = Object.values(ReleaseStatus);

/** 读库状态归一：历史行或异常值为空时按「待冒烟」处理 */
function releaseStatusOf(status?: string | null): ReleaseStatus {
  return RELEASE_STATUS_VALUES.includes(status ?? '')
    ? (status as ReleaseStatus)
    : ReleaseStatus.PENDING;
}

/** 批量提测入参（迭代项维度；每个迭代项生成一张提测工单 + 一条提测记录） */
export interface SubmitReleaseBatchInput {
  /** 参与提测的迭代项 */
  items: Array<{ backlogId: number }>;
  /** 提测标题（多迭代项缺省「{首个迭代项标题} 等x个迭代」） */
  title?: string;
  /** 提测端（取值须为提测工单 testEnds 字段配置的选项） */
  ends?: string[];
  /**
   * 提测工单配置（release-ticket）动态字段值：除保留 key（title/description/
   * backlogs/testEnds）外的起始节点字段原样透传进工单 inputValues。
   */
  inputValues?: Record<string, unknown>;
  /** 来源任务（机器人可选；缺省自动取当前执行中的任务） */
  taskId?: number;
}

/** 提测操作人：网页用户或机器人。兼容历史调用中的纯操作人姓名。 */
export interface ReleaseActor {
  operator?: string | null;
  workerId?: number | null;
  sourceTaskId?: number | null;
}

export type ReleaseActorInput = ReleaseActor | string | null | undefined;

/** 一次批量提测的整单共用字段（校验并归一后） */
export interface ReleaseBatchShared {
  ends: string[];
  operator: string | null;
  workerId: number | null;
  sourceTaskId: number | null;
}

/** 单条提测记录落库入参 */
export interface ReleaseRecordInput {
  projectId: number;
  ends: string[];
  operator: string | null;
  workerId: number | null;
  sourceTaskId: number | null;
  /** 关联提测工单（可空） */
  ticketId?: number | null;
  ticketCode?: string | null;
}

@Injectable()
export class ReleasesService {
  private readonly logger = new Logger(ReleasesService.name);

  constructor(
    @InjectRepository(ProjectRelease)
    private readonly releases: Repository<ProjectRelease>,
    @InjectRepository(Project)
    private readonly projects: Repository<Project>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Task)
    private readonly tasks: Repository<Task>,
    private readonly workerInbox: TaskWorkerInboxService,
  ) {}

  /**
   * 批量提测的公共字段校验：
   * - 提测端取值须为提测工单 testEnds 字段配置的选项（未配置该字段时不校验、不落库）；
   * - 解析机器人来源任务（网页人工提测不自动关联任务）。
   */
  async prepareBatch(
    input: SubmitReleaseBatchInput,
    actorInput?: ReleaseActorInput,
    endOptions: string[] = [],
  ): Promise<ReleaseBatchShared> {
    const actor = this.normalizeActor(actorInput);
    const ends = this.normalizeEnds(input.ends, endOptions);
    const sourceTask = await this.resolveSourceTask(
      actor.workerId ?? null,
      input.taskId ?? actor.sourceTaskId ?? null,
    );
    return {
      ends,
      operator: actor.operator?.trim() || null,
      workerId: actor.workerId ?? null,
      sourceTaskId: sourceTask?.id ?? null,
    };
  }

  /** 保存一条提测记录（每个迭代项一条，绑定其提测工单） */
  async createRecord(input: ReleaseRecordInput): Promise<ProjectRelease> {
    const release = this.releases.create({
      projectId: input.projectId,
      // 提测内容 / 分支 / 地址 / 测试人员已由简化后的提测工单字段与迭代项成员承载，
      // 记录侧不再采集（历史行保留原值）
      content: null,
      urls: null,
      branches: null,
      testers: [],
      ends: input.ends.length > 0 ? input.ends : null,
      operator: input.operator,
      workerId: input.workerId,
      sourceTaskId: input.sourceTaskId,
      ticketId: input.ticketId ?? null,
      ticketCode: input.ticketCode ?? null,
      // 新提测一律「待冒烟」，由测试同学判定通过与否
      status: ReleaseStatus.PENDING,
      verifier: null,
      verifiedAt: null,
    });
    return this.releases.save(release);
  }

  /** 提测记录列表（倒序）；不传 projectId 返回全部 */
  findByProject(projectId?: number): Promise<ProjectRelease[]> {
    return this.releases.find({
      where: projectId === undefined ? {} : { projectId },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
  }

  /**
   * 测试同学推进提测状态：待冒烟 → 进行中 → 已通过 / 未通过。
   * 已通过表示测试完成且缺陷全部修复并通过测试，未通过表示未达到验收要求；
   * 仅这两个终态记录判定人与判定时间，切回待冒烟/进行中时清空。
   * 状态未变化幂等返回（不刷新判定时间）。
   */
  async updateStatus(
    id: number,
    status: ReleaseStatus,
    operator?: string | null,
  ): Promise<ProjectRelease> {
    if (!RELEASE_STATUS_VALUES.includes(status)) {
      throw new BadRequestException(
        `提测状态非法：${status ?? '（空）'}，可选值：${RELEASE_STATUS_VALUES.join('、')}`,
      );
    }
    const release = await this.releases.findOne({ where: { id } });
    if (!release) throw new NotFoundException(`Release ${id} not found`);

    if (releaseStatusOf(release.status) === status) return release;

    const previousStatus = releaseStatusOf(release.status);
    const now = new Date();
    release.status = status;
    if (
      status === ReleaseStatus.PENDING ||
      status === ReleaseStatus.IN_PROGRESS
    ) {
      release.verifier = null;
      release.verifiedAt = null;
    } else {
      release.verifier = operator?.trim() || null;
      release.verifiedAt = now;
    }
    const saved = await this.releases.save(release);

    // 状态变化写入提测机器人收件箱；项目读取或入队失败均不影响状态变更结果。
    try {
      const project = await this.projects.findOne({
        where: { id: saved.projectId },
        select: { id: true, name: true },
      });
      await this.workerInbox.enqueueReleaseStatus(
        saved,
        previousStatus,
        project?.name ?? null,
      );
    } catch (e) {
      this.logger.warn(
        `提测状态通知入队失败（release ${saved.id}）：${(e as Error).message}`,
      );
    }
    return saved;
  }

  /** AI 用：判定提测结果并返回 Markdown 结果 */
  async updateStatusMarkdown(
    id: number,
    status: ReleaseStatus,
    operator?: string | null,
  ): Promise<string> {
    const release = await this.updateStatus(id, status, operator);
    const project = await this.projects.findOne({
      where: { id: release.projectId },
    });
    return [
      mdFrontmatter({
        update: release.verifiedAt ?? release.createdAt,
        title: `提测记录 #${release.id} - ${releaseStatusOf(release.status)}`,
      }),
      '# 提测状态已更新',
      '',
      `- 项目：${project?.name ?? `#${release.projectId}`}（#${release.projectId}）`,
      `- 提测记录：id ${release.id}（提测时间 ${beijingTime(release.createdAt)}）`,
      `- 提测人：${release.operator ?? '—'}`,
      `- 提测端：${release.ends?.length ? release.ends.join(' / ') : '—'}`,
      release.testers.length
        ? `- 测试人员：${release.testers.join('、')}`
        : null,
      release.ticketCode ? `- 提测工单：${release.ticketCode}` : null,
      `- 当前状态：**${releaseStatusOf(release.status)}**`,
      release.verifier ? `- 判定人：${release.verifier}` : null,
      release.verifiedAt
        ? `- 判定时间：${beijingTime(release.verifiedAt)}`
        : null,
      `- 提测记录清单：GET /api/releases.md?projectId=${release.projectId}`,
      '',
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  }

  /** 提测记录清单 Markdown（GET /api/releases.md?projectId=） */
  async listMarkdown(projectId?: number): Promise<string> {
    const items = await this.findByProject(projectId);
    const title =
      projectId === undefined ? '提测记录' : `提测记录（项目 #${projectId}）`;
    const lines = items.map((r) => {
      const status = releaseStatusOf(r.status);
      const head = `- **${beijingTime(r.createdAt)}**（id：${r.id}）提测人 ${r.operator ?? '—'} — 状态：**${status}**`;
      const detail = [
        `提测端：${r.ends?.length ? r.ends.join(' / ') : '—'}`,
        r.testers.length ? `测试人员：${r.testers.join('、')}` : null,
        r.ticketCode
          ? `提测工单：${r.ticketCode}${r.ticketId ? `（#${r.ticketId}）` : ''}`
          : null,
        r.workerId ? `提测机器人：#${r.workerId}` : null,
        r.sourceTaskId ? `来源任务：#${r.sourceTaskId}` : null,
        r.verifier ? `判定人：${r.verifier}` : null,
        r.verifiedAt ? `判定时间：${beijingTime(r.verifiedAt)}` : null,
        r.urls?.length ? `访问地址：${r.urls.join('、')}` : null,
        r.branches?.length
          ? `代码分支：${r.branches.map((b) => `\`${b.repo}\` @ \`${b.branch}\``).join('、')}`
          : null,
        r.content ? `提测内容：${oneLine(r.content, 120)}` : null,
      ].filter(Boolean);
      return [head, ...detail.map((d) => `  - ${d}`)].join('\n');
    });
    return [
      mdFrontmatter({ title }),
      `# ${title}`,
      '',
      `共 ${items.length} 条（按提测时间倒序）。提测：\`POST /api/backlogs/release.md\`，body \`{"items": [{"backlogId": 123}], "ends": ["APP"], "inputValues": {"自定义字段key": "值"}, "title": "可选", "taskId": 123}\`（每个迭代项生成提测工单与提测记录；提测端取值须为提测工单 testEnds 字段配置的选项；测试人员/代码分支/访问地址/补充描述等由提测工单字段与迭代项成员承载，inputValues 透传提测工单配置中除保留 key 外的起始字段；提测群通知由工单「提测群通知」节点发送；taskId 可省略，缺省自动关联当前执行中的任务）`,
      `推进提测状态（由测试同学操作）：\`POST /api/releases/{id}/status.md\`，body \`{"status": "待冒烟" | "进行中" | "已通过" | "未通过"}\`——新提测默认「待冒烟」，开始测试后改为「进行中」；仅「已通过 / 未通过」记录判定人/判定时间，切回「待冒烟 / 进行中」会清空`,
      '',
      ...(lines.length > 0 ? lines : ['（暂无提测记录）']),
      '',
    ].join('\n');
  }

  /**
   * 校验姓名均存在于用户系统（users 表，飞书登录落库），不存在则 400 并列出无效姓名。
   * 供提测测试人员与需求方配置共用——项目中不允许配置用户系统之外的人。
   */
  async assertNamesInUserSystem(names: string[], label: string): Promise<void> {
    const found = await this.users.find({
      where: { name: In(names) },
      select: { name: true },
    });
    const known = new Set(found.map((u) => u.name));
    const missing = names.filter((n) => !known.has(n));
    if (missing.length > 0) {
      throw new BadRequestException(
        `${label}不存在于用户系统中（须为飞书登录过的用户）：${missing.join('、')}`,
      );
    }
  }

  /** 删除项目时应用层级联删提测记录（测试库无物理外键） */
  async removeByProject(projectId: number): Promise<void> {
    await this.releases.delete({ projectId });
  }

  // ---- 内部 ----

  /** 兼容旧的纯姓名字符串入参，统一成带机器人/来源任务的 actor。 */
  private normalizeActor(actor?: ReleaseActorInput): ReleaseActor {
    if (typeof actor === 'string') return { operator: actor };
    return actor ?? {};
  }

  /**
   * 解析提测来源任务。
   * 显式传入时校验任务属于当前机器人；未传时取该机器人当前执行中的任务。
   * 网页人工提测没有机器人身份，不自动关联任务。
   */
  private async resolveSourceTask(
    workerId: number | null,
    taskId: number | null,
  ): Promise<Task | null> {
    if (taskId !== null) {
      if (!Number.isInteger(taskId) || taskId < 1) {
        throw new BadRequestException('来源任务 ID 必须为正整数');
      }
      const task = await this.tasks.findOne({ where: { id: taskId } });
      if (!task) throw new BadRequestException('来源任务不存在');
      if (workerId !== null && task.agentId !== workerId) {
        throw new BadRequestException('来源任务不是当前机器人执行的任务');
      }
      return task;
    }
    if (workerId === null) return null;
    return this.tasks.findOne({
      where: {
        agentId: workerId,
        status: TaskStatus.RUNNING,
        subStatus: TaskSubStatus.EXECUTING,
      },
      order: { assignedAt: 'DESC', id: 'DESC' },
    });
  }

  /**
   * 提测端：取值须来自提测工单 testEnds 字段配置的选项（去重）。
   * 工单未配置该字段时不校验也不落库；配置了字段则至少选择 1 个。
   */
  private normalizeEnds(
    ends: string[] | undefined,
    options: string[],
  ): string[] {
    const allowed = [
      ...new Set(options.map((item) => item.trim()).filter(Boolean)),
    ];
    if (allowed.length === 0) return [];
    const unique = [
      ...new Set(
        (Array.isArray(ends) ? ends : [])
          .map((end) => (typeof end === 'string' ? end.trim() : ''))
          .filter(Boolean),
      ),
    ];
    if (unique.length === 0) {
      throw new BadRequestException('提测端至少选择 1 个');
    }
    const invalid = unique.filter((end) => !allowed.includes(end));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `提测端包含无效值「${invalid.join('、')}」，可选值：${allowed.join(' / ')}`,
      );
    }
    return unique;
  }
}

/** 单行摘要：折叠换行 + 截断 */
function oneLine(text: string, max: number): string {
  const line = text.replace(/\s*\n\s*/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
