/**
 * executor-bridge 客户端：经 docs/EXECUTOR_PROTOCOL.md（HTTP + SSE，protocol 1）
 * 连接工位侧 bridge，服务 codex / claude-code / kiro / devin / droid 执行器。
 * DTO 形态与 OpencodeClient 一致（协议对齐平台 ExecutorClient 接口）；
 * 错误统一抛 OpencodeClientError（保留状态码，调用方 404 降级逻辑不变）。
 */
import type { ExecutorCapabilities } from './executor-capabilities';
import type { ExecutorClient } from './executor-client';
import {
  OpencodeClientError,
  type OpencodeEndpoint,
  type OpencodeModelInfo,
  type OpencodeModelRef,
  type OpencodeProviderInfo,
  type OpencodePromptResult,
  type OpencodeQuestionRequest,
  type OpencodeServerInfo,
  type OpencodeSessionInfo,
  type OpencodeCreateSessionInput,
  type OpencodePromptInput,
} from './opencode-client';
import type { ModelErrorLike } from './model-availability';
import type { OpencodeTodo } from './opencode-todos';

interface BridgeHealth {
  /** 内核（Agent CLI）自身版本，如 kiro-cli 3.5.0 / devin 3000.14.30821 / droid 1.16.0 */
  version: string;
  /** bridge 自身版本（内部诊断用，不覆盖执行器版本展示） */
  bridgeVersion?: string;
  protocol: number;
  kernel: string;
  pid: number;
  urls: string[];
  capabilities: ExecutorCapabilities;
}

export class BridgeClient implements ExecutorClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(endpoint: OpencodeEndpoint) {
    this.baseUrl = `http://${endpoint.ip}:${endpoint.port}`;
    this.headers = { 'Content-Type': 'application/json' };
    if (endpoint.token) {
      this.headers.Authorization = `Bearer ${endpoint.token}`;
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers, ...(init?.headers ?? {}) },
        signal: init?.signal,
      });
    } catch (e) {
      throw new OpencodeClientError(
        `执行器连接失败: ${(e as Error).message}`,
        0,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let message = `HTTP ${res.status}`;
      try {
        const json = JSON.parse(body) as { message?: string };
        if (json.message) message = json.message;
      } catch {
        if (body) message = `${message}: ${body.slice(0, 200)}`;
      }
      throw new OpencodeClientError(message, res.status);
    }
    return (await res.json().catch(() => null)) as T;
  }

  private async health(signal?: AbortSignal): Promise<BridgeHealth> {
    return this.request<BridgeHealth>('/health', { signal });
  }

  async info(signal?: AbortSignal): Promise<OpencodeServerInfo> {
    const health = await this.health(signal);
    return {
      version: health.version,
      pid: health.pid,
      urls: health.urls,
    };
  }

  async capabilities(): Promise<ExecutorCapabilities> {
    const health = await this.health();
    return health.capabilities;
  }

  async location(signal?: AbortSignal): Promise<{ directory: string }> {
    return this.request<{ directory: string }>('/location', { signal });
  }

  async providers(signal?: AbortSignal): Promise<OpencodeProviderInfo[]> {
    return this.request<OpencodeProviderInfo[]>('/providers', { signal });
  }

  async models(signal?: AbortSignal): Promise<OpencodeModelInfo[]> {
    return this.request<OpencodeModelInfo[]>('/models', { signal });
  }

  async deleteSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      signal,
    });
  }

  async switchAgent(
    sessionId: string,
    agent: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/agent`, {
      method: 'POST',
      body: JSON.stringify({ agent }),
      signal,
    });
  }

  async switchModel(
    sessionId: string,
    model: OpencodeModelRef,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/model`, {
      method: 'POST',
      body: JSON.stringify({ model }),
      signal,
    });
  }

  async writeFile(
    directory: string,
    path: string,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{ path: string }> {
    return this.request<{ path: string }>('/fs/write-file', {
      method: 'POST',
      body: JSON.stringify({
        directory,
        path,
        contentBase64: Buffer.from(data).toString('base64'),
      }),
      signal,
    });
  }

  async ensureDir(directory: string): Promise<void> {
    await this.request('/fs/ensure-dir', {
      method: 'POST',
      body: JSON.stringify({ directory }),
    });
  }

  async writeSecretFile(
    directory: string,
    path: string,
    content: string,
    mode = 0o600,
  ): Promise<void> {
    await this.request('/fs/write-file', {
      method: 'POST',
      body: JSON.stringify({
        directory,
        path,
        contentBase64: Buffer.from(content, 'utf8').toString('base64'),
        mode,
      }),
    });
  }

  async upsertEnvFile(
    directory: string,
    path: string,
    entries: Record<string, string>,
  ): Promise<void> {
    await this.request('/fs/upsert-env', {
      method: 'POST',
      body: JSON.stringify({ directory, path, entries }),
    });
  }

  /** 递归复制目录（bridge 无 shell，走 /fs/copy-dir；exclude 在复制时剔除） */
  async copyDir(input: {
    source: string;
    target: string;
    exclude?: string[];
  }): Promise<void> {
    await this.request('/fs/copy-dir', {
      method: 'POST',
      body: JSON.stringify({
        source: input.source,
        target: input.target,
        exclude: input.exclude,
      }),
    });
  }

  /** 递归删除目录（bridge 无 shell，走 /fs/rm-dir） */
  async removeDir(directory: string): Promise<void> {
    await this.request('/fs/rm-dir', {
      method: 'POST',
      body: JSON.stringify({ directory }),
    });
  }

  async createSession(
    input: OpencodeCreateSessionInput,
    signal?: AbortSignal,
  ): Promise<OpencodeSessionInfo> {
    return this.request<OpencodeSessionInfo>('/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    });
  }

  async prompt(
    sessionId: string,
    input: OpencodePromptInput,
    signal?: AbortSignal,
  ): Promise<OpencodePromptResult | null> {
    return this.request<OpencodePromptResult | null>(
      `/sessions/${encodeURIComponent(sessionId)}/prompt`,
      { method: 'POST', body: JSON.stringify({ text: input.text }), signal },
    );
  }

  async messages(sessionId: string): Promise<unknown> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/messages`);
  }

  async message(sessionId: string, messageId: string): Promise<unknown> {
    return this.request(
      `/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
    );
  }

  async lastAssistantText(
    sessionId: string,
    afterCreatedMs = 0,
  ): Promise<string | null> {
    interface ListMessage {
      id?: string;
      type?: string;
      role?: string;
      time?: { created?: number | null };
    }
    const list = (await this.messages(sessionId)) as ListMessage[];
    const assistants = (Array.isArray(list) ? list : [])
      .filter(
        (message) =>
          (message?.type === 'assistant' || message?.role === 'assistant') &&
          (message.time?.created ?? 0) >= afterCreatedMs,
      )
      .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
    for (const message of assistants) {
      if (!message.id) continue;
      const detail = (await this.message(sessionId, message.id)) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const text = (detail.content ?? [])
        .filter((part) => part.type === 'text' && part.text?.trim())
        .map((part) => part.text!.trim())
        .join('\n\n');
      if (text) return text;
    }
    return null;
  }

  lastAssistantError(): Promise<ModelErrorLike | null> {
    // bridge v1 不上报结构化模型错误（内核失败原因在 outcome/error 文案中）
    return Promise.resolve(null);
  }

  async lastUserMessageCreatedAt(sessionId: string): Promise<number> {
    interface ListMessage {
      type?: string;
      role?: string;
      time?: { created?: number | null };
    }
    const list = (await this.messages(sessionId)) as ListMessage[];
    const created = (Array.isArray(list) ? list : [])
      .filter((message) => message?.type === 'user' || message?.role === 'user')
      .map((message) => message.time?.created ?? 0)
      .sort((left, right) => right - left);
    return created[0] ?? 0;
  }

  async session(sessionId: string): Promise<{
    id: string;
    outcome?: string | null;
    time?: { idle?: number | null };
    location?: { directory: string } | null;
  }> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}`);
  }

  latestTodos(): Promise<OpencodeTodo[] | null> {
    // bridge v1 无待办事件；待办面板降级为空
    return Promise.resolve(null);
  }

  async interrupt(sessionId: string): Promise<unknown> {
    return this.request(
      `/sessions/${encodeURIComponent(sessionId)}/interrupt`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  }

  async waitForIdle(sessionId: string, timeoutMs: number): Promise<void> {
    await this.request(
      `/sessions/${encodeURIComponent(sessionId)}/wait?timeoutMs=${timeoutMs}`,
      {
        method: 'POST',
        body: JSON.stringify({}),
        // 客户端兜底超时略晚于服务端，优先拿到 bridge 的明确错误
        signal: AbortSignal.timeout(timeoutMs + 5000),
      },
    );
  }

  async activeSessions(): Promise<Record<string, { type?: string }>> {
    return this.request<Record<string, { type?: string }>>('/sessions/active');
  }

  async replyPermission(
    sessionId: string,
    requestId: string,
    decision: 'once' | 'always' | 'reject',
    message?: string,
  ): Promise<unknown> {
    return this.request(
      `/sessions/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { method: 'POST', body: JSON.stringify({ decision, message }) },
    );
  }

  async listQuestions(sessionId: string): Promise<OpencodeQuestionRequest[]> {
    return this.request<OpencodeQuestionRequest[]>(
      `/sessions/${encodeURIComponent(sessionId)}/questions`,
    );
  }

  async replyQuestion(
    sessionId: string,
    requestId: string,
    answers: string[][],
  ): Promise<void> {
    await this.request(
      `/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(requestId)}/reply`,
      { method: 'POST', body: JSON.stringify({ answers }) },
    );
  }

  async rejectQuestion(sessionId: string, requestId: string): Promise<void> {
    await this.request(
      `/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(requestId)}/reject`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  }

  shell(): Promise<unknown> {
    // bridge 不提供 shell（capabilities.exec=false）；令牌/MCP 写入走 writeFile
    throw new OpencodeClientError(
      'bridge 执行器不提供 shell（capabilities.exec=false）',
      400,
    );
  }

  async eventStream(signal: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}/events`, {
      headers: { ...this.headers, Accept: 'text/event-stream' },
      signal,
    });
  }
}
