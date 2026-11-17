import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Like, Repository } from 'typeorm';
import { BacklogStatus, IterationStatus, IterationType } from '../common/enums';
import { beijingTime, mdFrontmatter } from '../common/frontmatter';
import { Project } from '../projects/project.entity';
import { Backlog } from './backlog.entity';
import { Iteration } from './iteration.entity';
import {
  CreateIterationInput,
  IterationActor,
  IterationProgress,
  IterationSummaryView,
  UpdateIterationInput,
} from './iteration.types';

/** T0 常驻快速通道固定标识 */
export const T0_ITERATION_CODE = 'T0';

/** 列表查询上限（迭代数量有限） */
const LIST_LIMIT = 500;

/** 迭代描述最大长度（与前端输入上限一致） */
export const ITERATION_DESCRIPTION_MAX = 200;

/** 一天的毫秒数（自然周计算使用 UTC 日差，避免时区与夏令时干扰） */
const DAY_MS = 24 * 60 * 60 * 1000;

export interface IterationListQuery {
  type?: IterationType;
  status?: IterationStatus;
}

export interface IterationDetailView extends IterationSummaryView {
  backlogs: Backlog[];
}

/** Markdown 表格单元格转义 */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

/** 今天的北京时间日期串 YYYY-MM-DD */
function todayBeijing(): string {
  return beijingTime(new Date()).slice(0, 10);
}

/** 解析 YYYY-MM-DD 为 UTC 时间戳（仅用于日差计算） */
function parseDateUtc(value: string): number {
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * T7 每周通道标识：`{yyyy}W{ww}`。
 * 自然周计数：含 1 月 1 日的那一周为第 1 周（周一起始），按顺序数周；
 * yyyy 固定取开始日期的日历年，ww 补足两位。
 */
export function iterationWeekCode(startAt: string): string {
  const year = Number(startAt.slice(0, 4));
  const jan1 = Date.UTC(year, 0, 1);
  const jan1Weekday = new Date(jan1).getUTCDay(); // 0=周日
  const week1Monday = jan1 - ((jan1Weekday + 6) % 7) * DAY_MS;
  const week =
    Math.floor((parseDateUtc(startAt) - week1Monday) / DAY_MS / 7) + 1;
  return `${year}W${String(week).padStart(2, '0')}`;
}

/** 汇总 backlog 进度 */
export function summarizeBacklogs(
  backlogs: Array<{ status: BacklogStatus }>,
): IterationProgress {
  const statusCounts: Partial<Record<BacklogStatus, number>> = {};
  for (const backlog of backlogs) {
    statusCounts[backlog.status] = (statusCounts[backlog.status] ?? 0) + 1;
  }
  const total = backlogs.length;
  const done = statusCounts[BacklogStatus.COMPLETED] ?? 0;
  return {
    total,
    done,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    statusCounts,
  };
}

/** 是否当前迭代（今天在起止区间内）；T0 恒为当前 */
export function isIterationCurrent(iteration: {
  type: IterationType;
  startAt: string | null;
  endAt: string | null;
}): boolean {
  if (iteration.type === IterationType.T0) return true;
  if (!iteration.startAt || !iteration.endAt) return false;
  const today = todayBeijing();
  return iteration.startAt <= today && today <= iteration.endAt;
}

/**
 * 迭代：T0 常驻快速通道 + T7 每周通道 + Tx 特殊通道。
 * 迭代只是 backlog 的分组容器；需求转入、状态流转、交付任务与飞书群见 BacklogsService。
 */
@Injectable()
export class IterationsService implements OnModuleInit {
  private readonly logger = new Logger(IterationsService.name);

  constructor(
    @InjectRepository(Iteration)
    private readonly iterations: Repository<Iteration>,
    @InjectRepository(Backlog)
    private readonly backlogs: Repository<Backlog>,
    @InjectRepository(Project)
    private readonly projects: Repository<Project>,
  ) {}

  /** 启动时保证 T0 常驻快速通道存在 */
  async onModuleInit(): Promise<void> {
    const existing = await this.iterations.findOne({
      where: { type: IterationType.T0 },
    });
    if (existing) return;
    const codeTaken = await this.iterations.findOne({
      where: { code: T0_ITERATION_CODE },
    });
    if (codeTaken) {
      this.logger.warn(
        `迭代标识 ${T0_ITERATION_CODE} 已被其他迭代占用，未能创建 T0 快速通道`,
      );
      return;
    }
    await this.iterations.save(
      this.iterations.create({
        code: T0_ITERATION_CODE,
        type: IterationType.T0,
        startAt: null,
        endAt: null,
        status: IterationStatus.ACTIVE,
      }),
    );
    this.logger.log('T0 快速通道已创建');
  }

  async list(query: IterationListQuery): Promise<IterationSummaryView[]> {
    const where: FindOptionsWhere<Iteration> = {};
    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;
    const rows = await this.iterations.find({
      where,
      order: { id: 'DESC' },
      take: LIST_LIMIT,
    });
    if (rows.length === 0) return [];
    const allBacklogs = await this.backlogs.find({
      where: rows.map((row) => ({ iterationId: row.id })),
      select: { id: true, iterationId: true, status: true },
    });
    const byIteration = new Map<number, Backlog[]>();
    for (const backlog of allBacklogs) {
      const list = byIteration.get(backlog.iterationId) ?? [];
      list.push(backlog);
      byIteration.set(backlog.iterationId, list);
    }
    const views = rows.map((row) =>
      this.toSummary(row, byIteration.get(row.id) ?? []),
    );
    // T0 常驻置顶；T7/Tx 按开始日期倒序（新迭代在前），无日期按 id 倒序
    return views.sort((a, b) => {
      if (a.type === IterationType.T0) return -1;
      if (b.type === IterationType.T0) return 1;
      if (a.startAt && b.startAt) return b.startAt.localeCompare(a.startAt);
      if (a.startAt) return -1;
      if (b.startAt) return 1;
      return b.id - a.id;
    });
  }

  async findOne(id: number): Promise<IterationDetailView> {
    const iteration = await this.iterations.findOne({ where: { id } });
    if (!iteration) throw new NotFoundException(`Iteration ${id} not found`);
    const backlogs = await this.backlogs.find({
      where: { iterationId: id },
      order: { id: 'DESC' },
    });
    return { ...this.toSummary(iteration, backlogs), backlogs };
  }

  async mustFind(id: number): Promise<Iteration> {
    const iteration = await this.iterations.findOne({ where: { id } });
    if (!iteration) throw new NotFoundException(`Iteration ${id} not found`);
    return iteration;
  }

  /** 创建 T7 每周通道 / Tx 特殊通道（仅管理员）；标识由后端自动生成 */
  async create(
    input: CreateIterationInput,
    actor: IterationActor,
  ): Promise<Iteration> {
    this.assertAdmin(actor, '仅管理员可创建迭代');
    const type = this.normalizeType(input.type);
    const startAt = this.normalizeDate(input.startAt, '开始日期');
    const endAt = this.normalizeDate(input.endAt, '结束日期');
    if (!startAt || !endAt) {
      throw new BadRequestException('迭代须填写开始日期与结束日期');
    }
    this.assertDateOrder(startAt, endAt);
    // 标识生成与保存存在并发竞争（唯一约束兜底），冲突时重新生成序号重试
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code =
        type === IterationType.T7
          ? await this.nextT7Code(startAt)
          : await this.nextTxCode(startAt);
      try {
        return await this.iterations.save(
          this.iterations.create({
            code,
            type,
            startAt,
            endAt,
            status: IterationStatus.ACTIVE,
          }),
        );
      } catch (error) {
        if (!this.isUniqueViolation(error) || attempt === 2) throw error;
      }
    }
    throw new BadRequestException('迭代标识生成冲突，请稍后重试');
  }

  /** 更新迭代（仅管理员）：起止日期 / 结束或重开；T7 改开始日期时重算周标识 */
  async update(
    id: number,
    input: UpdateIterationInput,
    actor: IterationActor,
  ): Promise<Iteration> {
    this.assertAdmin(actor, '仅管理员可修改迭代');
    const iteration = await this.mustFind(id);
    const nextStart =
      input.startAt !== undefined
        ? this.normalizeDate(input.startAt, '开始日期')
        : iteration.startAt;
    const nextEnd =
      input.endAt !== undefined
        ? this.normalizeDate(input.endAt, '结束日期')
        : iteration.endAt;
    if (iteration.type !== IterationType.T0) {
      if (!nextStart || !nextEnd) {
        throw new BadRequestException('迭代须填写开始日期与结束日期');
      }
      this.assertDateOrder(nextStart, nextEnd);
    }
    if (
      iteration.type === IterationType.T7 &&
      nextStart &&
      nextStart !== iteration.startAt
    ) {
      iteration.code = await this.nextT7Code(nextStart, iteration.id);
    }
    iteration.startAt = nextStart;
    iteration.endAt = nextEnd;
    if (input.description !== undefined) {
      iteration.description = this.normalizeDescription(input.description);
    }
    if (input.status !== undefined) {
      if (!Object.values(IterationStatus).includes(input.status)) {
        throw new BadRequestException('迭代状态仅允许：进行中/已结束');
      }
      if (
        iteration.type === IterationType.T0 &&
        input.status !== IterationStatus.ACTIVE
      ) {
        throw new ForbiddenException('T0 快速通道常驻，不可结束');
      }
      iteration.status = input.status;
    }
    return this.iterations.save(iteration);
  }

  async listMarkdown(query: IterationListQuery): Promise<string> {
    const rows = await this.list(query);
    const head = mdFrontmatter({
      title: '迭代列表',
      description: `共 ${rows.length} 个迭代`,
    });
    const lines: string[] = [
      '# 迭代',
      '',
      `共 ${rows.length} 个迭代。详情：GET /api/iterations/{id}.md；迭代项详情：GET /api/backlogs/{id}.md。`,
      '',
    ];
    if (rows.length === 0) {
      lines.push('（暂无迭代）');
    } else {
      lines.push(
        '| ID | 标识 | 类型 | 起止 | 状态 | 迭代项 | 完成 | 详情 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
      );
      for (const row of rows) {
        lines.push(
          `| ${row.id} | ${escapeCell(row.code)} | ${row.type} | ${this.dateRangeText(
            row.startAt,
            row.endAt,
          )} | ${row.status} | ${row.total} | ${row.done} | /api/iterations/${
            row.id
          }.md |`,
        );
      }
    }
    return `${head}${lines.join('\n')}\n`;
  }

  async findOneMarkdown(id: number): Promise<string> {
    const detail = await this.findOne(id);
    const head = mdFrontmatter({
      update: detail.updatedAt,
      title: detail.code,
      code: detail.code,
      type: detail.type,
      status: detail.status,
      startAt: detail.startAt ?? undefined,
      endAt: detail.endAt ?? undefined,
    });
    const meta = [
      `- 迭代 ID：${detail.id}`,
      `- 唯一标识：${detail.code}`,
      `- 类型：${detail.type}`,
      `- 状态：${detail.status}`,
      ...(detail.description ? [`- 描述：${detail.description}`] : []),
      `- 起止：${this.dateRangeText(detail.startAt, detail.endAt)}`,
      `- 迭代项：${detail.total} 个，已完成 ${detail.done} 个（${detail.percent}%）`,
      `- 平台链接：/iterations/${detail.id}`,
    ];
    const sections = ['# 迭代', '', ...meta, '', '## 迭代项', ''];
    if (detail.backlogs.length === 0) {
      sections.push('（暂无迭代项）');
    } else {
      sections.push(
        '| ID | 编号 | 原始需求 | 需求方 | 状态 | 负责人 | 交付任务 | 详情 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
      );
      // 需求方实时取原始需求（projects.owner），不落库
      const projectIds = [...new Set(detail.backlogs.map((b) => b.projectId))];
      const projects = await this.projects.find({
        where: { id: In(projectIds) },
        select: { id: true, owner: true },
      });
      const ownerByProject = new Map(
        projects.map((project) => [project.id, project.owner]),
      );
      for (const backlog of detail.backlogs) {
        sections.push(
          `| ${backlog.id} | ${backlog.code} | #${backlog.projectId} ${escapeCell(
            backlog.title,
          )} | ${escapeCell(ownerByProject.get(backlog.projectId) ?? '-')} | ${backlog.status} | ${escapeCell(backlog.ownerName ?? '-')} | ${
            backlog.taskId ? `#${backlog.taskId}` : '-'
          } | /api/backlogs/${backlog.id}.md |`,
        );
      }
    }
    return `${head}${sections.join('\n')}\n`;
  }

  /** T7 周标识：同周已有其它 T7 时拒绝，提示改用 Tx */
  private async nextT7Code(startAt: string, selfId?: number): Promise<string> {
    const code = iterationWeekCode(startAt);
    const taken = await this.iterations.findOne({
      where: { type: IterationType.T7, code },
    });
    if (taken && taken.id !== selfId) {
      throw new BadRequestException(
        `该周已有 T7 迭代 ${code}，同周追加请使用 Tx 特殊通道`,
      );
    }
    return code;
  }

  /** Tx 特殊通道标识：`{yyyy}Tx{nn}`，nn 为开始日期当年内的递增序号 */
  private async nextTxCode(startAt: string): Promise<string> {
    const year = startAt.slice(0, 4);
    const rows = await this.iterations.find({
      where: { type: IterationType.Tx, code: Like(`${year}Tx%`) },
      select: { code: true },
    });
    let max = 0;
    for (const row of rows) {
      const match = /^(\d{4})Tx(\d+)$/.exec(row.code);
      if (match && match[1] === year) max = Math.max(max, Number(match[2]));
    }
    return `${year}Tx${String(max + 1).padStart(2, '0')}`;
  }

  private toSummary(
    iteration: Iteration,
    backlogs: Pick<Backlog, 'id' | 'status'>[],
  ): IterationSummaryView {
    const progress = summarizeBacklogs(backlogs);
    return {
      id: iteration.id,
      code: iteration.code,
      type: iteration.type,
      description: iteration.description ?? null,
      startAt: iteration.startAt,
      endAt: iteration.endAt,
      status: iteration.status,
      current: isIterationCurrent(iteration),
      createdAt: iteration.createdAt,
      updatedAt: iteration.updatedAt,
      ...progress,
    };
  }

  private dateRangeText(startAt: string | null, endAt: string | null): string {
    if (!startAt && !endAt) return '长期';
    return `${startAt ?? '?'} ~ ${endAt ?? '?'}`;
  }

  private assertAdmin(actor: IterationActor, message: string): void {
    if (!actor.isAdmin) throw new ForbiddenException(message);
  }

  /** PostgreSQL 唯一约束冲突（23505） */
  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    );
  }

  private normalizeType(type: IterationType | undefined): IterationType {
    if (type === IterationType.T7) return IterationType.T7;
    if (type === IterationType.Tx) return IterationType.Tx;
    throw new BadRequestException(
      'T0 为平台常驻快速通道，不可创建；迭代类型仅支持 T7 / Tx',
    );
  }

  private normalizeDate(
    value: string | null | undefined,
    label: string,
  ): string | null {
    if (value === undefined || value === null || value === '') return null;
    const trimmed = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      throw new BadRequestException(`${label}格式须为 YYYY-MM-DD`);
    }
    return trimmed;
  }

  /** 迭代描述：去首尾空白，空串落 null，最长 200 字 */
  private normalizeDescription(
    value: string | null | undefined,
  ): string | null {
    const trimmed = String(value ?? '').trim();
    if (trimmed.length > ITERATION_DESCRIPTION_MAX) {
      throw new BadRequestException(
        `迭代描述不能超过 ${ITERATION_DESCRIPTION_MAX} 个字符`,
      );
    }
    return trimmed || null;
  }

  private assertDateOrder(startAt: string, endAt: string): void {
    if (startAt > endAt) {
      throw new BadRequestException('开始日期不能晚于结束日期');
    }
  }
}
