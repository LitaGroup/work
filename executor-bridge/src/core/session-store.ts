/**
 * bridge 会话快照存储：进程重启后恢复 bridge 会话 id 与内核原生会话 id 的绑定。
 * - 仅保存稳定状态；运行中的 child process / AbortController / 队列不落盘。
 * - 原子写入（临时文件 + rename），文件权限 600，避免半写快照覆盖有效状态。
 * - 写入串行合并：状态变化频繁时只保留最新快照，退出前可 flush。
 */
import { randomUUID } from 'crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { dirname } from 'path';
import type { ModelRef } from '../types.js';

export const SESSION_STATE_VERSION = 1;

export interface PersistedMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
}

export interface PersistedSession {
  id: string;
  title: string;
  directory: string;
  model: ModelRef | null;
  agent: string | null;
  /** 内核原生会话 id（kiro sess_* / devin / droid session_id） */
  externalId: string | null;
  outcome: 'succeeded' | 'failed' | null;
  lastError: string | null;
  idleAt: number;
  createdAt: number;
  /** 快照时仍有运行中回合或排队消息；重启后按失败收尾，不自动重放 */
  pending: boolean;
  messages: PersistedMessage[];
}

interface SessionSnapshot {
  version: number;
  updatedAt: string;
  sessions: PersistedSession[];
}

export class SessionStore {
  private readonly file: string;
  private pending: PersistedSession[] | null = null;
  private writing: Promise<void> | null = null;

  constructor(
    file: string,
    private readonly onError: (error: Error) => void = (error) => {
      process.stderr.write(
        `[executor-bridge] session state persist failed: ${error.message}\n`,
      );
    },
  ) {
    this.file = file;
  }

  path(): string {
    return this.file;
  }

  /** 读取快照；文件不存在返回空，损坏/版本不兼容时抛错（由启动方降级空状态） */
  async load(): Promise<PersistedSession[]> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const parsed = JSON.parse(text) as Partial<SessionSnapshot>;
    if (parsed?.version !== SESSION_STATE_VERSION) {
      throw new Error(
        `unsupported session state version: ${String(parsed?.version)}`,
      );
    }
    if (!Array.isArray(parsed.sessions)) {
      throw new Error('invalid session state: sessions must be an array');
    }
    const sessions = new Map<string, PersistedSession>();
    for (const value of parsed.sessions) {
      const session = parsePersistedSession(value);
      if (session && !sessions.has(session.id)) {
        sessions.set(session.id, session);
      }
    }
    return [...sessions.values()];
  }

  /** 排队写入最新快照；同一时刻最多一个写任务，后写覆盖先写 */
  schedule(sessions: PersistedSession[]): void {
    this.pending = sessions;
    this.kick();
  }

  /** 立即写入快照（测试/运维工具用） */
  async save(sessions: PersistedSession[]): Promise<void> {
    this.pending = sessions;
    this.kick();
    await this.flush();
  }

  /** 等待全部已排队快照落盘 */
  async flush(): Promise<void> {
    for (;;) {
      const writing = this.writing;
      if (!writing) {
        if (!this.pending) return;
        this.kick();
        continue;
      }
      await writing;
    }
  }

  private kick(): void {
    if (this.writing) return;
    this.writing = (async () => {
      try {
        while (this.pending) {
          const sessions = this.pending;
          this.pending = null;
          try {
            await this.writeSnapshot(sessions);
          } catch (error) {
            this.onError(error as Error);
          }
        }
      } finally {
        this.writing = null;
        if (this.pending) this.kick();
      }
    })();
  }

  private async writeSnapshot(sessions: PersistedSession[]): Promise<void> {
    const directory = dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    const snapshot: SessionSnapshot = {
      version: SESSION_STATE_VERSION,
      updatedAt: new Date().toISOString(),
      sessions,
    };
    const temp = `${this.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(snapshot), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temp, this.file);
      await chmod(this.file, 0o600).catch(() => undefined);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
}

function parsePersistedSession(value: unknown): PersistedSession | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const title = stringValue(value.title);
  const directory = stringValue(value.directory);
  if (!id?.startsWith('bs_') || !title || !directory) return null;
  const createdAt = finiteNumber(value.createdAt);
  if (createdAt === null) return null;

  const messages: PersistedMessage[] = [];
  if (Array.isArray(value.messages)) {
    for (const item of value.messages) {
      if (!isRecord(item)) continue;
      const messageId = stringValue(item.id);
      const text = typeof item.text === 'string' ? item.text : null;
      const created = finiteNumber(item.createdAt);
      const role = item.role;
      if (
        !messageId ||
        text === null ||
        created === null ||
        (role !== 'user' && role !== 'assistant')
      ) {
        continue;
      }
      messages.push({ id: messageId, role, text, createdAt: created });
    }
  }

  return {
    id,
    title,
    directory,
    model: parseModelRef(value.model),
    agent: stringValue(value.agent) ?? null,
    externalId: stringValue(value.externalId) ?? null,
    outcome:
      value.outcome === 'succeeded' || value.outcome === 'failed'
        ? value.outcome
        : null,
    lastError: stringValue(value.lastError) ?? null,
    idleAt: finiteNumber(value.idleAt) ?? 0,
    createdAt,
    pending: value.pending === true,
    messages,
  };
}

function parseModelRef(value: unknown): ModelRef | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const providerID = stringValue(value.providerID);
  if (!id || !providerID) return null;
  const variant = stringValue(value.variant);
  return { id, providerID, ...(variant ? { variant } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
