/**
 * 会话状态机：per-session prompt 排队（协议强制语义）、回合终态、消息日志。
 * - 事件出口：内核增量翻译为 opencode 事件方言（session.text.* / session.reasoning.*），
 *   与平台任务会话、机器人调试对话的消费侧一致；思考/正文交错时按块开闭。
 * - prompt 忙时入队，回合终态后按序投递下一条（平台不维护发送队列）。
 * - outcome 具有粘性；每回合终态刷新 idleAt（bridge 时钟，毫秒）。
 * - 消息日志在内存（user/assistant 文本），支撑 lastAssistantText / 对账查询。
 */
import { randomUUID } from 'crypto';
import type {
  CreateSessionInput,
  EventSink,
  ModelRef,
  PromptResult,
  SessionInfo,
} from '../types.js';
import type { Kernel } from '../kernels/kernel.js';
import { KiroKernel } from '../kernels/kiro/kiro.kernel.js';
import type { PersistedSession, SessionStore } from './session-store.js';

interface QueueItem {
  text: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
}

interface Session {
  id: string;
  title: string;
  directory: string;
  model: ModelRef | null;
  agent: string | null;
  externalId: string | null;
  queue: QueueItem[];
  running: boolean;
  abort: AbortController | null;
  outcome: 'succeeded' | 'failed' | null;
  /** 最近一回合失败的真实原因（内核 result.error；成功回合清空） */
  lastError: string | null;
  idleAt: number;
  /** 创建时间（空闲会话淘汰用） */
  createdAt: number;
  messages: Message[];
  turnBuffer: string;
  deleted: boolean;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  /** 等待并发上限的会话 id（FIFO）：执行器不能被一次涌入的回合压垮 */
  private readonly waiting: string[] = [];
  /** 正在运行的回合数 */
  private activeTurns = 0;
  /** 退出中：不再接受新 prompt，也不再启动排队回合 */
  private closing = false;

  constructor(
    private readonly kernel: Kernel,
    private readonly emit: EventSink,
    private readonly defaultDirectory: string,
    /** 同时运行的回合上限（BRIDGE_MAX_TURNS，缺省 10） */
    readonly maxTurns = 10,
    /** 本地快照存储；null 表示不持久化（测试/临时实例） */
    private readonly store: SessionStore | null = null,
  ) {}

  /**
   * 从本地快照恢复会话：
   * - 恢复 bridge session id 与内核原生 externalId 的绑定；
   * - 重启前仍在运行的回合/排队消息不重放，统一按失败收尾，避免重复产生副作用；
   * - 恢复后立即按 TTL 清理过期空闲会话。
   */
  async restore(ttlMs?: number): Promise<{
    restored: number;
    interrupted: number;
  }> {
    if (!this.store || this.closing) return { restored: 0, interrupted: 0 };
    const persisted = await this.store.load();
    const now = Date.now();
    let restored = 0;
    let interrupted = 0;
    for (const item of persisted) {
      if (this.sessions.has(item.id) || !item.id.startsWith('bs_')) continue;
      const session: Session = {
        id: item.id,
        title: item.title,
        directory: item.directory,
        model: item.model,
        agent: item.agent,
        externalId: item.externalId,
        queue: [],
        running: false,
        abort: null,
        outcome: item.outcome,
        lastError: item.lastError,
        idleAt: item.idleAt,
        createdAt: item.createdAt,
        messages: [...item.messages],
        turnBuffer: '',
        deleted: false,
      };
      if (item.pending) {
        this.failInterrupted(session, now);
        interrupted += 1;
      }
      this.sessions.set(session.id, session);
      restored += 1;
    }
    if (ttlMs && ttlMs > 0) this.evictIdle(ttlMs);
    this.persist();
    return { restored, interrupted };
  }

  /** 退出前中断活动回合并保存最终快照（排队消息不重放） */
  async shutdown(timeoutMs = 8000): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const session of this.sessions.values()) {
      if (session.running) session.abort?.abort();
    }
    const deadline = Date.now() + timeoutMs;
    while (this.activeTurns > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (!session.running && session.queue.length === 0) continue;
      session.queue = [];
      session.running = false;
      session.abort = null;
      session.turnBuffer = '';
      this.failInterrupted(session, now);
    }
    this.persist();
    await this.store?.flush();
  }

  create(input: CreateSessionInput): SessionInfo {
    const id = `bs_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const directory = input.location?.directory ?? this.defaultDirectory;
    const session: Session = {
      id,
      title: input.title ?? id,
      directory,
      model: input.model ?? null,
      agent: input.agent ?? null,
      externalId: null,
      queue: [],
      running: false,
      abort: null,
      outcome: null,
      lastError: null,
      idleAt: 0,
      createdAt: Date.now(),
      messages: [],
      turnBuffer: '',
      deleted: false,
    };
    this.sessions.set(id, session);
    this.persist();
    return { id, title: session.title, location: { directory } };
  }

  /** 投递消息：立即入队并返回本轮用户消息（忙时由队列保证按序执行） */
  prompt(sessionId: string, text: string): PromptResult {
    if (this.closing) throw new HttpError(503, 'bridge shutting down');
    const session = this.getOrFail(sessionId);
    const message: Message = {
      id: KiroKernel.messageId(),
      role: 'user',
      text,
      createdAt: Date.now(),
    };
    session.messages.push(message);
    session.queue.push({ text });
    void this.drain(session);
    // 运行中/排队标记随用户消息立即落盘：崩溃后恢复时据此按失败收尾
    this.persist();
    return {
      id: message.id,
      sessionID: session.id,
      time: { created: message.createdAt },
    };
  }

  /** 中断当前回合（outcome=failed，队列保留） */
  interrupt(sessionId: string): void {
    this.getOrFail(sessionId).abort?.abort();
  }

  /** 等待会话空闲（队列清空且无运行中回合） */
  async waitForIdle(sessionId: string, timeoutMs: number): Promise<void> {
    const session = this.getOrFail(sessionId);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!session.running && session.queue.length === 0) return;
      if (Date.now() >= deadline) throw new Error('wait timeout');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  activeSessions(): Record<string, { type?: string }> {
    const result: Record<string, { type?: string }> = {};
    for (const session of this.sessions.values()) {
      if (session.running) result[session.id] = { type: 'running' };
    }
    return result;
  }

  state(sessionId: string): {
    id: string;
    outcome?: string | null;
    /** 最近一回合失败的真实原因（成功或未运行时为 null，兼容旧平台忽略） */
    error?: string | null;
    time?: { idle?: number | null };
    location?: { directory: string } | null;
  } {
    const session = this.getOrFail(sessionId);
    return {
      id: session.id,
      outcome: session.outcome,
      error: session.lastError,
      time: { idle: session.idleAt },
      location: { directory: session.directory },
    };
  }

  messages(sessionId: string): unknown {
    const session = this.getOrFail(sessionId);
    return session.messages.map((message) => ({
      id: message.id,
      role: message.role,
      type: message.role,
      time: { created: message.createdAt },
    }));
  }

  messageDetail(sessionId: string, messageId: string): unknown {
    const session = this.getOrFail(sessionId);
    const message = session.messages.find((item) => item.id === messageId);
    if (!message) throw new HttpError(404, `message ${messageId} not found`);
    return {
      id: message.id,
      role: message.role,
      type: message.role,
      time: { created: message.createdAt },
      content: [{ type: 'text', text: message.text }],
    };
  }

  /** 会话最后一条 assistant 文本（afterCreatedMs 之后；无则 null） */
  lastAssistantText(sessionId: string, afterCreatedMs = 0): string | null {
    const session = this.getOrFail(sessionId);
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const message = session.messages[i];
      if (!message || message.role !== 'assistant') continue;
      if (message.createdAt < afterCreatedMs) continue;
      if (message.text.trim()) return message.text;
    }
    return null;
  }

  lastUserMessageCreatedAt(sessionId: string): number {
    const session = this.getOrFail(sessionId);
    let latest = 0;
    for (const message of session.messages) {
      if (message.role === 'user' && message.createdAt > latest) {
        latest = message.createdAt;
      }
    }
    return latest;
  }

  setModel(sessionId: string, model: ModelRef): void {
    this.getOrFail(sessionId).model = model;
    this.persist();
  }

  setAgent(sessionId: string, agent: string): void {
    this.getOrFail(sessionId).agent = agent;
    this.persist();
  }

  /** 删除会话：终止当前回合并移除（事件由 http 层广播） */
  delete(sessionId: string): void {
    const session = this.getOrFail(sessionId);
    session.deleted = true;
    session.abort?.abort();
    this.sessions.delete(sessionId);
    this.dropWaiting(sessionId);
    this.persist();
  }

  /** 空闲会话淘汰：长时间没有回合的会话回收内存（平台按 404 对账重建） */
  startEviction(ttlMs = 24 * 3600_000, intervalMs = 10 * 60_000): void {
    const timer = setInterval(() => this.evictIdle(ttlMs), intervalMs);
    timer.unref();
  }

  private evictIdle(ttlMs: number): void {
    const deadline = Date.now() - ttlMs;
    let changed = false;
    for (const [id, session] of this.sessions) {
      if (session.running || session.queue.length > 0) continue;
      if (Math.max(session.idleAt, session.createdAt) > deadline) continue;
      this.sessions.delete(id);
      this.dropWaiting(id);
      changed = true;
    }
    if (changed) this.persist();
  }

  private dropWaiting(sessionId: string): void {
    const index = this.waiting.indexOf(sessionId);
    if (index >= 0) this.waiting.splice(index, 1);
  }

  /** 回合结束后按下发顺序补位（drain 同步占住并发名额后才返回） */
  private pumpWaiting(): void {
    while (this.activeTurns < this.maxTurns && this.waiting.length > 0) {
      const sessionId = this.waiting.shift();
      if (!sessionId) return;
      const session = this.sessions.get(sessionId);
      if (!session || session.deleted) continue;
      void this.drain(session);
    }
  }

  private getOrFail(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new HttpError(404, `session ${sessionId} not found`);
    return session;
  }

  private async drain(session: Session): Promise<void> {
    if (this.closing || session.running || session.deleted) return;
    if (session.queue.length === 0) return;
    // 并发上限：超出的回合保持排队，回合结束后由 pumpWaiting 按序补上
    if (this.activeTurns >= this.maxTurns) {
      if (!this.waiting.includes(session.id)) this.waiting.push(session.id);
      return;
    }
    const item = session.queue.shift();
    if (!item) return;
    session.running = true;
    session.abort = new AbortController();
    this.activeTurns += 1;
    session.turnBuffer = '';
    const turnModel = session.model;
    const assistantId = KiroKernel.messageId();

    let result: import('../kernels/kernel.js').KernelTurnResult;
    /** 当前流式块：思考/正文交错时先关旧块再开新块 */
    let block: 'reasoning' | 'text' | null = null;
    const endBlock = () => {
      if (block === 'reasoning') {
        this.emit('session.reasoning.ended', {
          sessionID: session.id,
          assistantMessageID: assistantId,
        });
      } else if (block === 'text') {
        this.emit('session.text.ended', {
          sessionID: session.id,
          assistantMessageID: assistantId,
        });
      }
      block = null;
    };
    const emitChunk = (kind: 'reasoning' | 'text', delta: string) => {
      if (!delta) return;
      if (block !== kind) {
        endBlock();
        block = kind;
        this.emit(
          kind === 'reasoning'
            ? 'session.reasoning.started'
            : 'session.text.started',
          { sessionID: session.id, assistantMessageID: assistantId },
        );
      }
      this.emit(
        kind === 'reasoning' ? 'session.reasoning.delta' : 'session.text.delta',
        {
          sessionID: session.id,
          assistantMessageID: assistantId,
          delta,
        },
      );
    };
    try {
      result = await this.kernel.runTurn({
        externalId: session.externalId,
        directory: session.directory,
        prompt: item.text,
        model: turnModel,
        signal: session.abort.signal,
        events: {
          onChunk: (text) => {
            session.turnBuffer += text;
            emitChunk('text', text);
          },
          onThoughtChunk: (text) => {
            emitChunk('reasoning', text);
          },
          onExternalSession: (externalId) => {
            session.externalId = externalId;
            // 原生会话 id 一旦获取立即落盘，重启后仍可续聊该会话
            this.persist();
          },
        },
      });
    } catch (error) {
      result = {
        outcome: 'failed',
        finalText: null,
        externalId: session.externalId,
        error: (error as Error).message,
      };
    } finally {
      // 无论内核怎么失败，并发名额必须归还，否则后续回合永久排队
      this.activeTurns -= 1;
    }
    // 回合终态：关闭未闭合的思考/正文块（消费侧据此收尾气泡与实时行）
    endBlock();

    const text = result.finalText ?? session.turnBuffer;
    session.messages.push({
      id: assistantId,
      role: 'assistant',
      // 失败回合没有正文时把真实原因落成消息，便于会话日志定位
      text:
        text ||
        (result.outcome === 'failed' && result.error
          ? `执行失败：${result.error}`
          : ''),
      createdAt: Date.now(),
    });
    session.outcome = result.outcome;
    // 失败原因随会话返回（GET /sessions/:id 的 error 字段），成功回合清空
    session.lastError =
      result.outcome === 'failed' ? (result.error ?? null) : null;
    session.idleAt = Date.now();
    session.running = false;
    session.abort = null;
    session.turnBuffer = '';
    this.persist();
    // 回合终态事件：平台据此立即收尾本轮（不用等两分钟对账）；time.idle 供平台判断是否属于最新一轮
    this.emit(
      result.outcome === 'succeeded'
        ? 'session.execution.succeeded'
        : 'session.execution.failed',
      {
        sessionID: session.id,
        ...(result.outcome === 'failed'
          ? {
              error: {
                type: 'turn-failed',
                message: session.lastError ?? '执行失败',
              },
            }
          : {}),
        time: { idle: session.idleAt },
      },
    );
    if (!this.closing) {
      this.pumpWaiting();
      void this.drain(session);
    }
  }

  /** 把重启/退出时未完成的会话标记失败（不重放已发 prompt，避免重复副作用） */
  private failInterrupted(session: Session, idleAt: number): void {
    const lastUser = [...session.messages]
      .reverse()
      .find((message) => message.role === 'user');
    const lastAssistant = [...session.messages]
      .reverse()
      .find((message) => message.role === 'assistant');
    if (
      lastUser &&
      (!lastAssistant || lastAssistant.createdAt < lastUser.createdAt)
    ) {
      session.messages.push({
        id: KiroKernel.messageId(),
        role: 'assistant',
        text: '执行失败：bridge restarted',
        createdAt: idleAt,
      });
    }
    session.outcome = 'failed';
    session.lastError = 'bridge restarted';
    session.idleAt = idleAt;
  }

  /** 生成不含运行态对象的稳定快照并异步落盘 */
  private persist(): void {
    this.store?.schedule(this.snapshot());
  }

  private snapshot(): PersistedSession[] {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      title: session.title,
      directory: session.directory,
      model: session.model,
      agent: session.agent,
      externalId: session.externalId,
      outcome: session.outcome,
      lastError: session.lastError,
      idleAt: session.idleAt,
      createdAt: session.createdAt,
      pending: session.running || session.queue.length > 0,
      messages: session.messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
      })),
    }));
  }
}

/** 协议错误：http 层按状态码序列化为 {message} */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
