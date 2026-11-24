import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID, createHash } from 'crypto';
import { appendFile, mkdir, readFile, rm, stat } from 'fs/promises';
import { dirname, resolve } from 'path';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { traceWebroot } from '../common/paths';
import { TraceRole, TraceStatus } from '../common/enums';
import { Worker } from '../workers/worker.entity';
import { Task } from '../tasks/task.entity';
import { TaskTrace, TaskTraceAccess } from './task-trace.entity';

/** 步骤流中的一步（JSONL 单行） */
export interface TraceStep {
  seq: number;
  at: string;
  type: string;
  [key: string]: unknown;
}

/** 一次平台调用的记录入参 */
export interface PlatformCallInput {
  workerId: number;
  channel: 'mcp' | 'md';
  tool: string;
  args: unknown;
  status: 'ok' | 'error' | 'blocked';
  content: string;
  durationMs: number;
  /** 评估令牌上下文（评估任务归属确定） */
  evalItemId?: number | null;
  evalTaskId?: number | null;
  /** 参数中携带的任务 ID（归属判定用） */
  taskId?: number | null;
}

/** 真实任务保留天数 / 评估任务保留天数（D11） */
const RETENTION_DAYS_REAL = 180;
const RETENTION_DAYS_EVAL = 90;
/** 参数/返回截断阈值（8KB，前 6KB + 后 2KB，D10） */
const TRUNCATE_BYTES = 8 * 1024;
const TRUNCATE_HEAD = 6 * 1024;
const TRUNCATE_TAIL = 2 * 1024;
/** message_in 单条截断（64KB） */
const MESSAGE_MAX_BYTES = 64 * 1024;

/** 单个 trace 的内存写缓冲 */
interface TraceBuffer {
  steps: TraceStep[];
  lastSeq: number;
  flushing: boolean;
}

/**
 * 执行记录（Trace）服务（TECH_DESIGN 12）：
 * - 平台侧采集：平台消息（turn_start/message_in）、平台调用（platform_call）、
 *   任务事件（task_event）、轮结束（turn_end）；
 * - 归属（12.4）：评估令牌 explicit；参数 taskId 且窗口内 explicit；单窗口 window；否则不记录计数；
 * - 异步队列批量写 JSONL（traces/{yyyyMM}/{traceId}/steps.jsonl，重试 3 次）；
 * - 写入前截断（8KB/64KB）与脱敏（令牌精确替换 + 规则识别）；
 * - 到期清理（真实 180 天 / 评估 90 天，正文删除、索引保留统计）。
 */
@Injectable()
export class TraceService {
  private readonly logger = new Logger(TraceService.name);

  private readonly buffers = new Map<string, TraceBuffer>();
  /** traceId → 当前轮次 */
  private readonly turns = new Map<string, number>();
  /** workerId → 打开中的任务窗口 */
  private readonly windows = new Map<
    number,
    Array<{ taskId: number; turn: number; startedAt: number }>
  >();
  /** workerId → 未归属调用计数 */
  private readonly unattributed = new Map<number, number>();

  constructor(
    @InjectRepository(TaskTrace)
    private readonly traces: Repository<TaskTrace>,
    @InjectRepository(TaskTraceAccess)
    private readonly accesses: Repository<TaskTraceAccess>,
    @InjectRepository(Worker)
    private readonly workers: Repository<Worker>,
    @InjectRepository(Task)
    private readonly tasks: Repository<Task>,
  ) {}

  // ===== 采集：轮与消息 =====

  /** 平台派发一轮会话（dispatch 调用） */
  async recordTurnStart(
    task: Task,
    reason: string,
    worker: Worker,
  ): Promise<void> {
    if (!task.isEval && worker.traceEnabled === false) return;
    const trace = await this.ensureTraceByTask(
      task.id,
      worker.id,
      task.isEval,
      task.evalItemId ?? null,
    );
    if (!trace) return;
    const turn = this.nextTurn(trace.id);
    this.pushWindow(worker.id, task.id, turn);
    this.enqueue(trace.id, {
      type: 'turn_start',
      turn,
      reason,
      configDigest: workerConfigDigest(worker),
    });
    await this.traces
      .update(
        { id: trace.id },
        {
          turnCount: turn,
          kernel: worker.runtime,
          model: worker.modelId ?? null,
        },
      )
      .catch(() => {});
  }

  /** 平台发给机器人的消息正文（任务指令/答复/返工/邀约） */
  async recordMessageIn(task: Task, text: string): Promise<void> {
    const trace = await this.findTraceByTask(task.id);
    if (!trace) return;
    this.enqueue(trace.id, {
      type: 'message_in',
      turn: this.currentTurn(trace.id),
      source: 'platform',
      text: truncateText(text, MESSAGE_MAX_BYTES),
    });
  }

  /** 任务事件（状态变更/提问/HANDOFF/验收等） */
  async recordTaskEvent(
    taskId: number,
    event: string,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    if (!taskId) return;
    const trace = await this.findTraceByTask(taskId);
    if (!trace) return;
    this.enqueue(trace.id, {
      type: 'task_event',
      turn: this.currentTurn(trace.id),
      event,
      detail: detail ?? null,
    });
  }

  // ===== 采集：平台调用 =====

  /** 记录一次平台调用（MCP 或 .md），内部完成归属/截断/脱敏 */
  async recordPlatformCall(input: PlatformCallInput): Promise<void> {
    const worker = await this.workers.findOne({
      where: { id: input.workerId },
      select: { id: true, traceEnabled: true, runtime: true, modelId: true },
    });
    if (!worker) return;
    // 评估任务不受 traceEnabled 开关约束（D9）
    if (!input.evalItemId && worker.traceEnabled === false) return;

    const attribution = await this.resolveAttribution(input);
    if (!attribution.trace) {
      if (!input.evalItemId) {
        this.unattributed.set(
          input.workerId,
          (this.unattributed.get(input.workerId) ?? 0) + 1,
        );
      }
      return;
    }
    const { trace, kind } = attribution;
    const redactedContent = redact(input.content ?? '');
    const redactedArgs = redact(stringifyArgs(input.args));
    const content = truncateText(redactedContent.text, TRUNCATE_BYTES);
    const args = truncateText(redactedArgs.text, TRUNCATE_BYTES);
    this.enqueue(trace.id, {
      type: 'platform_call',
      turn: this.currentTurn(trace.id),
      channel: input.channel,
      tool: input.tool,
      args,
      status: input.status,
      content,
      originalBytes: Buffer.byteLength(input.content ?? ''),
      truncated: content !== redactedContent.text || args !== redactedArgs.text,
      durationMs: input.durationMs,
      attribution: kind,
    });
    const redactions = redactedContent.count + redactedArgs.count;
    await this.traces
      .createQueryBuilder()
      .update(TaskTrace)
      .set({
        callCount: () => '"callCount" + 1',
        ...(input.status === 'error'
          ? { callErrorCount: () => '"callErrorCount" + 1' }
          : {}),
        ...(input.status === 'blocked'
          ? { blockedCount: () => '"blockedCount" + 1' }
          : {}),
        ...(kind === 'window'
          ? { windowAttributedCount: () => '"windowAttributedCount" + 1' }
          : {}),
        ...(redactions > 0
          ? { redactionCount: () => `"redactionCount" + ${redactions}` }
          : {}),
      })
      .where('id = :id', { id: trace.id })
      .execute()
      .catch(() => {});
  }

  private async resolveAttribution(input: PlatformCallInput): Promise<{
    trace: TaskTrace | null;
    kind: 'explicit' | 'window';
  }> {
    // 1. 评估令牌：taskId 明确
    if (input.evalItemId && input.evalTaskId) {
      const trace = await this.ensureTraceByTask(
        input.evalTaskId,
        input.workerId,
        true,
        input.evalItemId,
      );
      return { trace, kind: 'explicit' };
    }
    const windows = this.windows.get(input.workerId) ?? [];
    // 2. 参数任务 ID 且窗口内
    if (
      input.taskId != null &&
      windows.some((w) => w.taskId === input.taskId)
    ) {
      const trace = await this.findTraceByTask(input.taskId);
      if (trace) return { trace, kind: 'explicit' };
    }
    // 3. 仅一个窗口打开（「我的 AI」不登记窗口，不会误归属）
    if (windows.length === 1) {
      const trace = await this.findTraceByTask(windows[0].taskId);
      if (trace) return { trace, kind: 'window' };
    }
    // 4. 其他情况不记录
    return { trace: null, kind: 'window' };
  }

  // ===== 生命周期 =====

  /** 任务终态：写 turn_end、回填统计、设置到期时间 */
  async finalize(task: Task): Promise<void> {
    const trace = await this.findTraceByTask(task.id);
    if (!trace) return;
    if (task.agentId) {
      const windows = this.windows.get(task.agentId) ?? [];
      const open = windows.find((w) => w.taskId === task.id);
      if (open) {
        this.enqueue(trace.id, {
          type: 'turn_end',
          turn: open.turn,
          durationMs: Date.now() - open.startedAt,
        });
        this.closeWindow(task.agentId, task.id);
      }
    }
    await this.flush(trace.id);
    const days = task.isEval ? RETENTION_DAYS_EVAL : RETENTION_DAYS_REAL;
    await this.traces
      .update(
        { id: trace.id },
        {
          status: TraceStatus.COMPLETED,
          endedAt: new Date(),
          outcome: `${task.status}-${task.subStatus}`,
          expireAt: new Date(Date.now() + days * 24 * 3600_000),
        },
      )
      .catch(() => {});
  }

  // ===== 查询（12.7） =====

  async list(query: {
    workerId?: number;
    isEval?: boolean;
    taskId?: number;
    outcome?: string[];
    from?: Date;
    to?: Date;
    page?: number;
    pageSize?: number;
  }): Promise<{ rows: TaskTrace[]; total: number }> {
    const qb = this.traces.createQueryBuilder('t');
    if (query.workerId)
      qb.andWhere('t.workerId = :workerId', { workerId: query.workerId });
    if (query.isEval !== undefined)
      qb.andWhere('t.isEval = :isEval', { isEval: query.isEval });
    if (query.taskId)
      qb.andWhere('t.taskId = :taskId', { taskId: query.taskId });
    if (query.outcome?.length)
      qb.andWhere('t.outcome IN (:...outcome)', { outcome: query.outcome });
    if (query.from) qb.andWhere('t.startedAt >= :from', { from: query.from });
    if (query.to) qb.andWhere('t.startedAt <= :to', { to: query.to });
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const page = Math.max(1, query.page ?? 1);
    const [rows, total] = await qb
      .orderBy('t.startedAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    return { rows, total };
  }

  async findByTask(taskId: number): Promise<TaskTrace | null> {
    return this.findTraceByTask(taskId);
  }

  async findById(traceId: string): Promise<TaskTrace | null> {
    return this.traces.findOne({ where: { id: traceId } });
  }

  /** 分页读取步骤（fromSeq + types/turn 过滤；单页上限 200 条） */
  async readSteps(
    traceId: string,
    query: {
      fromSeq?: number;
      limit?: number;
      types?: string[];
      turn?: number;
    },
  ): Promise<{ steps: TraceStep[]; nextSeq: number | null }> {
    const trace = await this.findById(traceId);
    if (!trace || trace.status === TraceStatus.EXPIRED) {
      return { steps: [], nextSeq: null };
    }
    const file = resolve(traceWebroot(), trace.storageUri);
    const raw = await readFile(file, 'utf8').catch(() => '');
    const limit = Math.min(200, Math.max(1, query.limit ?? 100));
    const steps: TraceStep[] = [];
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (!text) continue;
      try {
        const step = JSON.parse(text) as TraceStep;
        if (query.fromSeq != null && step.seq < query.fromSeq) continue;
        if (query.types?.length && !query.types.includes(step.type)) continue;
        if (query.turn != null && step.turn !== query.turn) continue;
        steps.push(step);
        if (steps.length >= limit) break;
      } catch {
        /* 忽略坏行 */
      }
    }
    const nextSeq =
      steps.length >= limit ? (steps[steps.length - 1]?.seq ?? 0) + 1 : null;
    return { steps, nextSeq };
  }

  /** 记录读取访问日志（12.8） */
  async logAccess(input: {
    traceId: string;
    readerName: string;
    readerKind: string | null;
    readerId: number | null;
    action: string;
  }): Promise<void> {
    await this.accesses.save(this.accesses.create(input)).catch(() => {});
  }

  /** 机器人维度聚合统计（12.7 get_trace_stats 子集） */
  async stats(query: {
    workerId: number;
    from?: Date;
    to?: Date;
    isEval?: boolean;
  }): Promise<Record<string, unknown>> {
    const qb = this.traces
      .createQueryBuilder('t')
      .where('t.workerId = :workerId', { workerId: query.workerId });
    if (query.from) qb.andWhere('t.startedAt >= :from', { from: query.from });
    if (query.to) qb.andWhere('t.startedAt <= :to', { to: query.to });
    if (query.isEval !== undefined)
      qb.andWhere('t.isEval = :isEval', { isEval: query.isEval });
    const rows = await qb.getMany();
    const total = rows.length;
    const avgs = (pick: (row: TaskTrace) => number) =>
      total
        ? Math.round((rows.reduce((a, r) => a + pick(r), 0) / total) * 10) / 10
        : 0;
    return {
      total,
      avgTurns: avgs((r) => r.turnCount),
      avgCalls: avgs((r) => r.callCount),
      avgErrors: avgs((r) => r.callErrorCount),
      blocked: rows.reduce((a, r) => a + r.blockedCount, 0),
      windowAttributed: rows.reduce((a, r) => a + r.windowAttributedCount, 0),
      unattributed: this.unattributed.get(query.workerId) ?? 0,
      redactions: rows.reduce((a, r) => a + r.redactionCount, 0),
      samples: rows.slice(0, 50).map((r) => ({
        traceId: r.id,
        taskId: r.taskId,
        outcome: r.outcome,
        startedAt: r.startedAt,
        turns: r.turnCount,
        calls: r.callCount,
        errors: r.callErrorCount,
      })),
    };
  }

  // ===== 到期清理（D11） =====

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupExpired(): Promise<void> {
    const rows = await this.traces
      .createQueryBuilder('t')
      .where('t."expireAt" < :now', { now: new Date() })
      .andWhere('t.status <> :expired', { expired: TraceStatus.EXPIRED })
      .take(200)
      .getMany();
    for (const row of rows) {
      await rm(resolve(traceWebroot(), row.storageUri), { force: true }).catch(
        () => {},
      );
      await this.traces.update(
        { id: row.id },
        { status: TraceStatus.EXPIRED, sizeBytes: '0' },
      );
    }
    if (rows.length > 0) {
      this.logger.log(`执行记录到期清理：${rows.length} 条正文已删除`);
    }
  }

  // ===== 内部实现 =====

  private async findTraceByTask(taskId: number): Promise<TaskTrace | null> {
    return this.traces.findOne({ where: { taskId } });
  }

  private async ensureTraceByTask(
    taskId: number,
    workerId: number,
    isEval: boolean,
    evalItemId: number | null,
  ): Promise<TaskTrace | null> {
    const existing = await this.traces.findOne({ where: { taskId } });
    if (existing) return existing;
    const worker = await this.workers.findOne({
      where: { id: workerId },
      select: {
        id: true,
        traceEnabled: true,
        runtime: true,
        modelId: true,
      },
    });
    if (!worker) return null;
    if (!isEval && worker.traceEnabled === false) return null;
    const now = new Date();
    const traceId = randomUUID();
    const month = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    return this.traces.save(
      this.traces.create({
        id: traceId,
        taskId,
        workerId: worker.id,
        kernel: worker.runtime,
        model: worker.modelId ?? null,
        configDigests: null,
        isEval,
        evalItemId,
        role: TraceRole.EXECUTOR,
        status: TraceStatus.COLLECTING,
        storageUri: `${month}/${traceId}/steps.jsonl`,
        startedAt: now,
        expireAt: new Date(now.getTime() + RETENTION_DAYS_REAL * 24 * 3600_000),
      }),
    );
  }

  /** 追加一步到内存缓冲并触发异步写盘 */
  private enqueue(
    traceId: string,
    step: Record<string, unknown> & { type: string },
  ): void {
    const buffer = this.buffers.get(traceId) ?? {
      steps: [],
      lastSeq: 0,
      flushing: false,
    };
    buffer.lastSeq += 1;
    buffer.steps.push({
      ...step,
      seq: buffer.lastSeq,
      at: new Date().toISOString(),
    });
    this.buffers.set(traceId, buffer);
    void this.flush(traceId).catch(() => {});
  }

  /** 批量追加 JSONL（重试 3 次，失败丢弃并标记不完整） */
  private async flush(traceId: string): Promise<void> {
    const buffer = this.buffers.get(traceId);
    if (!buffer || buffer.flushing || buffer.steps.length === 0) return;
    buffer.flushing = true;
    const steps = buffer.steps.splice(0, buffer.steps.length);
    const trace = await this.traces.findOne({ where: { id: traceId } });
    if (!trace) {
      buffer.flushing = false;
      return;
    }
    const file = resolve(traceWebroot(), trace.storageUri);
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        await mkdir(dirname(file), { recursive: true });
        await appendFile(
          file,
          steps.map((s) => JSON.stringify(s)).join('\n') + '\n',
          'utf8',
        );
        ok = true;
      } catch (error) {
        this.logger.warn(
          `执行记录写入失败（第 ${attempt + 1} 次）#${traceId}: ${(error as Error).message}`,
        );
      }
    }
    if (ok) {
      const size = await stat(file)
        .then((s) => s.size)
        .catch(() => 0);
      await this.traces
        .update(
          { id: traceId },
          {
            stepCount: trace.stepCount + steps.length,
            sizeBytes: String(size),
          },
        )
        .catch(() => {});
    } else {
      await this.traces
        .update({ id: traceId }, { status: TraceStatus.INCOMPLETE })
        .catch(() => {});
    }
    buffer.flushing = false;
    if (buffer.steps.length > 0) void this.flush(traceId).catch(() => {});
  }

  private nextTurn(traceId: string): number {
    const next = (this.turns.get(traceId) ?? 0) + 1;
    this.turns.set(traceId, next);
    return next;
  }

  private currentTurn(traceId: string): number {
    return this.turns.get(traceId) ?? 1;
  }

  private pushWindow(workerId: number, taskId: number, turn: number): void {
    const list = this.windows.get(workerId) ?? [];
    list.push({ taskId, turn, startedAt: Date.now() });
    this.windows.set(workerId, list);
  }

  private closeWindow(workerId: number, taskId: number): void {
    const list = this.windows.get(workerId) ?? [];
    this.windows.set(
      workerId,
      list.filter((w) => w.taskId !== taskId),
    );
  }
}

/** 字符串化工具参数（防循环引用） */
function stringifyArgs(args: unknown): string {
  try {
    return typeof args === 'string' ? args : JSON.stringify(args ?? null);
  } catch {
    return String(args);
  }
}

/** 截断文本（按字节，前 6KB + 后 2KB） */
export function truncateText(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text ?? '', 'utf8');
  if (buffer.length <= maxBytes) return text ?? '';
  const head = buffer
    .subarray(0, Math.min(TRUNCATE_HEAD, maxBytes))
    .toString('utf8');
  const tail = buffer
    .subarray(Math.max(0, buffer.length - TRUNCATE_TAIL))
    .toString('utf8');
  return `${head}…[已截断 ${
    buffer.length - TRUNCATE_HEAD - TRUNCATE_TAIL
  } 字节]…${tail}`;
}

/** 脱敏（D10）：请求头、password/secret/token、连接串、私钥、JWT */
export function redact(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  const patterns: Array<[RegExp, string]> = [
    [/(Authorization\s*[:=]\s*Bearer\s+)[^\s"'\\]+/gi, '$1***'],
    [/(X-(?:Worker|Agent)-Token\s*[:=]\s*)[^\s"'\\]+/gi, '$1***'],
    [/\b(password|secret|token)\s*=\s*[^\s&"']+/gi, '$1=***'],
    [/(mysql|postgres|jdbc):\/\/[^\s"']+:[^\s"']+@/gi, '$1://***@'],
    [
      /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/g,
      '***',
    ],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '***'],
  ];
  for (const [pattern, replacement] of patterns) {
    out = out.replace(pattern, () => {
      count += 1;
      return replacement;
    });
  }
  return { text: out, count };
}

/** 配置摘要（与评估快照算法一致：AGENTS.md + 技能 + 规则 + MCP + 模型） */
export function workerConfigDigest(worker: {
  prompt?: string | null;
  skills?: unknown;
  standards?: unknown;
  mcps?: unknown;
  runtime?: string;
  providerId?: string | null;
  modelId?: string | null;
  variant?: string | null;
}): string {
  const material = JSON.stringify({
    prompt: worker.prompt ?? '',
    skills: worker.skills ?? [],
    standards: worker.standards ?? [],
    mcps: worker.mcps ?? [],
    runtime: worker.runtime ?? '',
    model: [worker.providerId, worker.modelId, worker.variant].join('/'),
  });
  // 与评估快照同一算法（sha256 十六进制）
  return createHash('sha256').update(material).digest('hex');
}
