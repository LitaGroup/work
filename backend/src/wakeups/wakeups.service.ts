import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import {
  FindOptionsWhere,
  In,
  IsNull,
  LessThanOrEqual,
  Repository,
} from 'typeorm';
import { User } from '../auth/user.entity';
import { TaskStatus, TaskSubStatus } from '../common/enums';
import { beijingTime } from '../common/frontmatter';
import { Task } from '../tasks/task.entity';
import { TaskDispatchService } from '../tasks/task-dispatch.service';
import { nextInboxRetryDelay } from '../tasks/task-loop.rules';
import { TasksService } from '../tasks/tasks.service';
import {
  agentPageScope,
  normalizeAgentPageContext,
} from '../tasks/workbench.service';
import { PersonalAgentsService } from '../workers/personal-agents.service';
import type { Worker } from '../workers/worker.entity';
import { Wakeup } from './wakeup.entity';

/** 最短 30 秒、最长 30 天，避免过密唤醒打满执行容量 */
const MIN_DELAY_MS = 30_000;
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_NOTE_LENGTH = 2000;
/** 单次扫描最多投递的到期唤醒 */
const SCAN_LIMIT = 20;
/** 到期扫描间隔（唤醒以分钟为主，15 秒足够） */
const SCAN_MS = 15_000;
/** 最多尝试次数（按 2/10/30 分钟退避约 2 天后放弃，避免永久重试） */
const MAX_ATTEMPTS = 96;
/** 直投任务会话时的操作人/系统标签 */
const OPERATOR_LABEL = '定时唤醒';

export interface WakeupTimeInput {
  /** 相对当前时间的延迟（分钟，0.5 ~ 43200），与 wakeAt 二选一 */
  delayMinutes?: number;
  /** 绝对时间（ISO 8601；不带时区按北京时间），与 delayMinutes 二选一 */
  wakeAt?: string;
}

export interface TaskWakeupInput extends WakeupTimeInput {
  taskId: number;
  note?: string | null;
}

export interface AgentWakeupInput extends WakeupTimeInput {
  note?: string | null;
  /** 任务独立会话（agent:task:{id}）；不传 pageType/pageId 时生效 */
  taskId?: number | null;
  /** 详情页会话上下文类型（document/script/project/idea/backlog/topic） */
  pageType?: string | null;
  /** 详情页会话上下文 ID */
  pageId?: string | null;
}

export interface AgentWakeupTargetInput {
  taskId?: number | null;
  pageType?: string | null;
  pageId?: string | null;
}

export interface WakeupScheduleResult {
  wakeup: Wakeup;
  /** 是否覆盖了之前待触发的唤醒（每个目标只保留一条） */
  replaced: boolean;
  /** 距触发时间（分钟，四舍五入） */
  delayMinutes: number;
}

/** 解析并校验唤醒时间：相对时长与绝对时间二选一。 */
export function resolveWakeAt(input: WakeupTimeInput, now = new Date()): Date {
  const hasDelay =
    typeof input.delayMinutes === 'number' &&
    Number.isFinite(input.delayMinutes);
  const hasAt =
    typeof input.wakeAt === 'string' && input.wakeAt.trim().length > 0;
  if (hasDelay === hasAt) {
    throw new BadRequestException('delayMinutes 与 wakeAt 必须二选一');
  }
  let target: Date;
  if (hasDelay) {
    const delayMs = input.delayMinutes! * 60_000;
    if (delayMs < MIN_DELAY_MS || delayMs > MAX_DELAY_MS) {
      throw new BadRequestException(
        'delayMinutes 需在 0.5 ~ 43200 之间（30 秒 ~ 30 天）',
      );
    }
    target = new Date(now.getTime() + delayMs);
  } else {
    target = parseWakeAt(input.wakeAt!);
  }
  if (target.getTime() < now.getTime() + 5_000) {
    throw new BadRequestException('唤醒时间必须晚于当前时间');
  }
  if (target.getTime() > now.getTime() + MAX_DELAY_MS) {
    throw new BadRequestException('唤醒时间不能超过 30 天');
  }
  return target;
}

/** ISO 8601；不带时区的时间按北京时间（+08:00）解释。 */
export function parseWakeAt(raw: string): Date {
  const text = raw.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const parsed = new Date(hasZone ? text : `${normalized}+08:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(
      'wakeAt 无法解析，请使用 ISO 8601 时间（如 2026-11-18T09:00:00+08:00）',
    );
  }
  return parsed;
}

/**
 * 「我的 AI」会话范围：
 * - pageType + pageId → 详情页会话（服务端计算稳定 hash，与网页一致）；
 * - taskId → 任务独立会话；
 * - 都不传 → 通用会话。
 */
export function resolveAgentScope(input: AgentWakeupTargetInput): string {
  if (input.pageType || input.pageId) {
    const context = normalizeAgentPageContext({
      type: input.pageType ?? undefined,
      id: input.pageId ?? undefined,
    });
    if (!context) throw new BadRequestException('页面上下文参数不完整');
    return agentPageScope(context);
  }
  if (input.taskId !== undefined && input.taskId !== null) {
    const taskId = Number(input.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      throw new BadRequestException('taskId 必须为正整数');
    }
    return `agent:task:${taskId}`;
  }
  return 'agent:global';
}

function normalizeNote(note?: string | null): string | null {
  const text = note?.trim();
  if (!text) return null;
  if (text.length > MAX_NOTE_LENGTH) {
    throw new BadRequestException(`唤醒备注不能超过 ${MAX_NOTE_LENGTH} 个字符`);
  }
  return text;
}

function minutesUntil(at: Date, now = new Date()): number {
  return Math.max(0, Math.round((at.getTime() - now.getTime()) / 60_000));
}

/** 任务是否处于可接收唤醒的状态（待反馈等状态按退避等待变化）。 */
function canWakeTask(task: Task): boolean {
  if (task.status === TaskStatus.RUNNING) {
    return task.subStatus === TaskSubStatus.EXECUTING;
  }
  if (task.status !== TaskStatus.WAITING) return false;
  return [
    TaskSubStatus.PENDING_APPLY,
    TaskSubStatus.PENDING_ACCEPT,
    TaskSubStatus.PENDING_RESUME,
  ].includes(task.subStatus);
}

/**
 * 机器人定时唤醒：任务会话与「我的 AI」会话共用一套落库 + 扫描投递。
 * - 任务：与外部工单回调同规则——回合在跑直投会话，回合结束转「待继续」，
 *   LOOP 按并行容量恢复；待反馈等暂不可接收状态退避重试；任务结束只记录。
 * - 「我的 AI」：经个人 AGENT 会话发送消息，会话正忙时退避重试。
 */
@Injectable()
export class WakeupsService {
  private readonly logger = new Logger(WakeupsService.name);
  private scanning = false;

  constructor(
    @InjectRepository(Wakeup)
    private readonly wakeups: Repository<Wakeup>,
    @InjectRepository(Task)
    private readonly tasks: Repository<Task>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly dispatch: TaskDispatchService,
    private readonly tasksService: TasksService,
    private readonly personalAgents: PersonalAgentsService,
  ) {}

  /** 读取任务（工具展示与权限校验共用）。 */
  async findTask(taskId: number): Promise<Task> {
    const task = await this.tasks.findOne({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`任务 ${taskId} 不存在`);
    return task;
  }

  /** 为当前任务设置唤醒（仅任务当前执行机器人，新设置覆盖旧的）。 */
  async scheduleTask(
    worker: Worker,
    input: TaskWakeupInput,
  ): Promise<WakeupScheduleResult> {
    const task = await this.findTask(input.taskId);
    if (task.agentId !== worker.id) {
      throw new ForbiddenException('仅任务当前执行机器人可以设置定时唤醒');
    }
    if (task.status === TaskStatus.FINISHED) {
      throw new BadRequestException(
        `任务 ${task.code} 已结束，不能设置定时唤醒`,
      );
    }
    const wakeAt = resolveWakeAt(input);
    const note = normalizeNote(input.note);
    const replaced =
      (await this.cancelScheduled(
        { kind: 'task', taskId: task.id },
        'replaced',
      )) > 0;
    const wakeup = await this.wakeups.save(
      this.wakeups.create({
        kind: 'task',
        taskId: task.id,
        userId: null,
        scope: null,
        workerId: worker.id,
        note,
        wakeAt,
        status: 'scheduled',
      }),
    );
    await this.tasksService.addEvent(
      task.id,
      '系统',
      `机器人「${worker.name}」设置定时唤醒：${beijingTime(wakeAt)} 触发${
        note ? `，备注：${note}` : ''
      }`,
      null,
      {
        wakeupId: wakeup.id,
        wakeAt: wakeAt.toISOString(),
        source: 'schedule_task_wakeup',
      },
    );
    return { wakeup, replaced, delayMinutes: minutesUntil(wakeAt) };
  }

  /** 为「我的 AI」会话设置唤醒（个人 AGENT 身份，每个会话范围只保留一条）。 */
  async scheduleAgent(
    user: User | undefined,
    input: AgentWakeupInput,
  ): Promise<WakeupScheduleResult> {
    if (!user?.id) {
      throw new ForbiddenException(
        '设置「我的 AI」定时唤醒需要登录用户身份（机器人令牌需绑定真人）',
      );
    }
    const agent = await this.personalAgents.findForUser(user.id);
    if (!agent) {
      throw new BadRequestException(
        '当前用户未配置个人 AGENT，无法设置「我的 AI」会话唤醒',
      );
    }
    const scope = resolveAgentScope(input);
    const wakeAt = resolveWakeAt(input);
    const note = normalizeNote(input.note);
    const replaced =
      (await this.cancelScheduled(
        { kind: 'agent', userId: user.id, scope },
        'replaced',
      )) > 0;
    const wakeup = await this.wakeups.save(
      this.wakeups.create({
        kind: 'agent',
        taskId: scope.startsWith('agent:task:')
          ? Number(scope.slice('agent:task:'.length))
          : null,
        userId: user.id,
        scope,
        workerId: agent.id,
        note,
        wakeAt,
        status: 'scheduled',
      }),
    );
    return { wakeup, replaced, delayMinutes: minutesUntil(wakeAt) };
  }

  /** 取消当前任务的待触发唤醒（仅任务当前执行机器人）。 */
  async cancelTask(worker: Worker, taskId: number): Promise<number> {
    const task = await this.findTask(taskId);
    if (task.agentId !== worker.id) {
      throw new ForbiddenException('仅任务当前执行机器人可以取消定时唤醒');
    }
    return this.cancelScheduled({ kind: 'task', taskId }, 'manual');
  }

  /** 取消「我的 AI」会话的待触发唤醒（按同一会话范围）。 */
  async cancelAgent(
    user: User | undefined,
    input: AgentWakeupTargetInput,
  ): Promise<number> {
    if (!user?.id) {
      throw new ForbiddenException(
        '取消「我的 AI」定时唤醒需要登录用户身份（机器人令牌需绑定真人）',
      );
    }
    return this.cancelScheduled(
      { kind: 'agent', userId: user.id, scope: resolveAgentScope(input) },
      'manual',
    );
  }

  /** 到期扫描：投递所有到点且未被退避拦截的唤醒。 */
  @Interval(SCAN_MS)
  async processDue(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const now = new Date();
      const due = await this.wakeups.find({
        where: [
          {
            status: 'scheduled',
            wakeAt: LessThanOrEqual(now),
            nextRetryAt: IsNull(),
          },
          {
            status: 'scheduled',
            wakeAt: LessThanOrEqual(now),
            nextRetryAt: LessThanOrEqual(now),
          },
        ],
        order: { wakeAt: 'ASC' },
        take: SCAN_LIMIT,
      });
      for (const row of due) {
        await this.deliver(row.id);
      }
    } catch (error) {
      this.logger.warn(`定时唤醒扫描失败: ${(error as Error).message}`);
    } finally {
      this.scanning = false;
    }
  }

  /** 投递单条唤醒：领取后按目标类型唤醒会话，暂不可投递时退避重试。 */
  async deliver(id: number): Promise<void> {
    const wakeup = await this.wakeups.findOne({ where: { id } });
    if (!wakeup || wakeup.status !== 'scheduled') return;
    if (wakeup.kind === 'task') {
      await this.deliverTask(wakeup);
      return;
    }
    await this.deliverAgent(wakeup);
  }

  private async deliverTask(wakeup: Wakeup): Promise<void> {
    if (!wakeup.taskId) {
      await this.markDead(wakeup.id, '唤醒缺少任务关联');
      return;
    }
    const task = await this.tasks.findOne({ where: { id: wakeup.taskId } });
    if (!task) {
      await this.markDead(wakeup.id, '任务不存在');
      return;
    }
    if (task.status === TaskStatus.FINISHED) {
      await this.markRecorded(wakeup.id, '任务已结束');
      return;
    }
    if (!canWakeTask(task)) {
      await this.defer(
        wakeup.id,
        `任务当前状态「${task.status}-${task.subStatus}」暂不接收定时唤醒`,
      );
      return;
    }
    // 原子认领，避免扫描与并发投递重复唤醒。
    const claimed = await this.wakeups.update(
      { id: wakeup.id, status: 'scheduled' },
      {
        status: 'delivered',
        deliveredAt: new Date(),
        lastAttemptAt: new Date(),
      },
    );
    if (!claimed.affected) return;
    try {
      await this.wakeTask(task, wakeup, this.buildTaskPrompt(task, wakeup));
      await this.wakeups.update(wakeup.id, {
        processedAt: new Date(),
        lastError: null,
        nextRetryAt: null,
      });
      await this.tasksService.addEvent(
        task.id,
        '系统',
        `定时唤醒触发${wakeup.note ? `：${wakeup.note}` : '（未填写备注）'}`,
        null,
        { wakeupId: wakeup.id, source: 'wakeup' },
      );
    } catch (error) {
      await this.defer(wakeup.id, (error as Error).message);
    }
  }

  /**
   * 唤醒任务：
   * - 回合在跑 → 直投当前会话；
   * - 回合已结束/待继续/待申请验收/待验收 → 写入 resumePrompt 转「待继续」，
   *   由 LOOP 按执行容量恢复（不额外占用并行额度）。
   */
  private async wakeTask(
    task: Task,
    wakeup: Wakeup,
    prompt: string,
  ): Promise<void> {
    if (
      task.status === TaskStatus.RUNNING &&
      task.subStatus === TaskSubStatus.EXECUTING
    ) {
      if (this.dispatch.taskChatRunning(task.id)) {
        await this.dispatch.continueConversation(
          task.id,
          prompt,
          OPERATOR_LABEL,
        );
        return;
      }
      // 会话已结束但任务仍停在执行中的竞态兜底：转待继续交给 LOOP。
      const updated = await this.tasks.update(
        {
          id: task.id,
          status: TaskStatus.RUNNING,
          subStatus: TaskSubStatus.EXECUTING,
        },
        {
          status: TaskStatus.WAITING,
          subStatus: TaskSubStatus.PENDING_RESUME,
          resumePrompt: prompt,
          remindCount: 0,
          firstRemindedAt: null,
          lastRemindedAt: null,
        },
      );
      if (!updated.affected) throw new Error('任务状态已变化，稍后重试');
      return;
    }

    if (
      task.subStatus === TaskSubStatus.PENDING_APPLY ||
      task.subStatus === TaskSubStatus.PENDING_ACCEPT
    ) {
      const updated = await this.tasks.update(
        {
          id: task.id,
          status: TaskStatus.WAITING,
          subStatus: task.subStatus,
        },
        {
          subStatus: TaskSubStatus.PENDING_RESUME,
          resumePrompt: prompt,
          remindCount: 0,
          firstRemindedAt: null,
          lastRemindedAt: null,
        },
      );
      if (!updated.affected) throw new Error('任务状态已变化，稍后重试');
      return;
    }

    // 已在待继续：同一唤醒只追加一次，避免重试反复写入。
    if (task.resumePrompt?.includes(`唤醒记录 ID：${wakeup.id}`)) return;
    const merged = [task.resumePrompt?.trim(), prompt]
      .filter(Boolean)
      .join('\n\n---\n\n');
    const updated = await this.tasks.update(
      {
        id: task.id,
        status: TaskStatus.WAITING,
        subStatus: TaskSubStatus.PENDING_RESUME,
      },
      { resumePrompt: merged },
    );
    if (!updated.affected) throw new Error('任务状态已变化，请稍后重试');
  }

  private async deliverAgent(wakeup: Wakeup): Promise<void> {
    if (!wakeup.userId || !wakeup.scope) {
      await this.markDead(wakeup.id, '会话唤醒缺少用户或会话范围');
      return;
    }
    const user = await this.users.findOne({ where: { id: wakeup.userId } });
    if (!user) {
      await this.markDead(wakeup.id, '用户不存在');
      return;
    }
    const agent = await this.personalAgents.findForUser(user.id);
    if (!agent) {
      await this.markDead(wakeup.id, '个人 AGENT 不存在或已解绑');
      return;
    }
    const claimed = await this.wakeups.update(
      { id: wakeup.id, status: 'scheduled' },
      {
        status: 'delivered',
        deliveredAt: new Date(),
        lastAttemptAt: new Date(),
      },
    );
    if (!claimed.affected) return;
    try {
      await this.personalAgents.send(user, this.buildAgentPrompt(wakeup), {
        scope: wakeup.scope,
      });
      await this.wakeups.update(wakeup.id, {
        processedAt: new Date(),
        lastError: null,
        nextRetryAt: null,
      });
    } catch (error) {
      // 会话正在回复（Conflict）或执行器暂不可用：退避后重试投递。
      await this.defer(wakeup.id, (error as Error).message);
    }
  }

  /** 投递给任务机器人的唤醒说明。 */
  private buildTaskPrompt(task: Task, wakeup: Wakeup): string {
    const note = wakeup.note?.trim();
    return [
      '# 定时唤醒',
      '',
      `- 任务：${task.code}「${task.title}」（ID=${task.id}）`,
      `- 唤醒时间：${beijingTime(wakeup.wakeAt)}（北京时间）`,
      `- 设置时间：${beijingTime(wakeup.createdAt)}`,
      `- 当前状态：${task.status}-${task.subStatus}`,
      `- 唤醒备注：${note || '（未填写）'}`,
      '',
      '请按备注继续跟进当前任务：',
      '- 还需要等待时，再次调用 `schedule_task_wakeup` 设置下一次唤醒后结束本轮，不要空转轮询；',
      '- 无需继续等待时直接推进任务（继续执行、申请验收或向需求方提问）；',
      '- 任务已无跟进必要时不要再设置唤醒。',
      '',
      `> 唤醒记录 ID：${wakeup.id}`,
    ].join('\n');
  }

  /** 投递给「我的 AI」会话的唤醒说明（作为用户消息出现在面板中）。 */
  private buildAgentPrompt(wakeup: Wakeup): string {
    const note = wakeup.note?.trim();
    return [
      '【定时唤醒】',
      '',
      `- 唤醒时间：${beijingTime(wakeup.wakeAt)}（北京时间）`,
      `- 设置时间：${beijingTime(wakeup.createdAt)}`,
      `- 唤醒备注：${note || '（未填写）'}`,
      '',
      '请按备注继续跟进（可用 lita-work 工具查询任务、工单与脚本运行进展）。',
      '需要通知主人时可用 `feishu_send_message`；仍需等待时再次调用 `schedule_agent_wakeup` 设置下一次唤醒。',
    ].join('\n');
  }

  private async cancelScheduled(
    where: FindOptionsWhere<Wakeup>,
    reason: 'replaced' | 'manual',
  ): Promise<number> {
    const criteria: FindOptionsWhere<Wakeup> = {
      ...where,
      status: 'scheduled',
    };
    const result = await this.wakeups.update(criteria, {
      status: 'canceled',
      canceledAt: new Date(),
      canceledReason: reason,
      processedAt: new Date(),
    });
    return result.affected ?? 0;
  }

  /** 同一目标当前待触发的那条唤醒（用于覆盖/冲突判断）。 */
  private findActiveFor(wakeup: Wakeup): Promise<Wakeup | null> {
    if (wakeup.kind === 'task' && wakeup.taskId) {
      return this.wakeups.findOne({
        where: { kind: 'task', taskId: wakeup.taskId, status: 'scheduled' },
        select: { id: true },
      });
    }
    if (wakeup.kind === 'agent' && wakeup.userId && wakeup.scope) {
      return this.wakeups.findOne({
        where: {
          kind: 'agent',
          userId: wakeup.userId,
          scope: wakeup.scope,
          status: 'scheduled',
        },
        select: { id: true },
      });
    }
    return Promise.resolve(null);
  }

  /** 暂不投递：按 2/10/30 分钟退避重试，超过上限标记 dead。 */
  private async defer(id: number, reason: string): Promise<void> {
    const wakeup = await this.wakeups.findOne({ where: { id } });
    if (!wakeup) return;
    const attempts = (wakeup.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await this.markDead(id, reason, attempts);
      return;
    }
    // 机器人已重新设置唤醒时旧记录直接结束，避免回退到 scheduled 撞唯一索引。
    const current = await this.findActiveFor(wakeup);
    if (current && current.id !== id) {
      await this.markDead(
        id,
        `已被新的定时唤醒 #${current.id} 覆盖：${reason}`,
        attempts,
      );
      return;
    }
    await this.wakeups.update(
      { id, status: In(['scheduled', 'delivered']) },
      {
        status: 'scheduled',
        attempts,
        lastAttemptAt: new Date(),
        lastError: reason.slice(0, 500),
        nextRetryAt: new Date(Date.now() + nextInboxRetryDelay(attempts - 1)),
        deliveredAt: null,
      },
    );
  }

  private async markDead(
    id: number,
    reason: string,
    attempts?: number,
  ): Promise<void> {
    await this.wakeups.update(
      { id, status: In(['scheduled', 'delivered']) },
      {
        status: 'dead',
        lastError: reason.slice(0, 500),
        lastAttemptAt: new Date(),
        processedAt: new Date(),
        ...(attempts === undefined ? {} : { attempts }),
      },
    );
    this.logger.warn(`定时唤醒 #${id} 放弃投递：${reason}`);
  }

  /** 任务已结束：只记录，不唤醒、不复活。 */
  private async markRecorded(id: number, reason: string): Promise<void> {
    await this.wakeups.update(
      { id, status: In(['scheduled', 'delivered']) },
      {
        status: 'recorded',
        processedAt: new Date(),
        lastError: null,
        nextRetryAt: null,
      },
    );
    this.logger.debug(`定时唤醒 #${id} 仅记录：${reason}`);
  }
}
