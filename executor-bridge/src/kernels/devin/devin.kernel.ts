/**
 * devin 内核（v1）：每回合 spawn `devin acp --process-model in-process`，
 * 以 ACP（Agent Client Protocol，JSON-RPC over stdio）驱动一回合：
 * initialize → session/load（有 externalId 时续聊）或 session/new →
 * session/set_config_option（mode / model / thought_level）→ session/prompt。
 * 正文（agent_message_chunk）与思考（agent_thought_chunk）分别回调，
 * 由 sessionManager 翻译为 opencode 事件方言（session.text.* / session.reasoning.*）。
 * devin 的 session/prompt 响应不带 finalText，正文由 bridge 侧 turnBuffer 拼接兜底。
 * 会话由 devin 本地 session store 持久化（loadSession=true），
 * bridge 重启后 externalId 仍可 session/load。
 * 中断：devin acp 无 session/cancel 方法，杀进程（--process-model in-process
 * 保证回合随进程终止，不残留在后台 daemon）。
 */
import { spawn, type ChildProcess } from 'child_process';
import type {
  ExecutorCapabilities,
  ModelInfo,
  ModelRef,
  ProviderInfo,
} from '../../types.js';
import type {
  Kernel,
  KernelRunTurnInput,
  KernelTurnResult,
} from '../kernel.js';
import { probeCliVersion } from '../cli-version.js';

const DEVIN_PROVIDER_ID = 'devin';
const MODEL_CACHE_MS = 10 * 60 * 1000;
/** 无人值守工位默认全自治（等价 kiro 的 --trust-all-tools），可用 DEVIN_SESSION_MODE 覆盖 */
const DEFAULT_SESSION_MODE = 'bypass';
const PROBE_TIMEOUT_MS = 30_000;

interface JsonRpcError {
  code?: number;
  message?: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: JsonRpcError;
}

interface AcpConfigOption {
  id?: string;
  currentValue?: string;
  options?: Array<{ value?: string; name?: string }>;
}

interface AcpSessionUpdate {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  configOptions?: AcpConfigOption[];
}

/**
 * devin acp 子进程 + 行缓冲 JSON-RPC 客户端。
 * 同时处理服务端发来的权限请求（bypass 模式下通常不出现，
 * 其余模式按「允许一次/始终允许」自动作答，避免回合挂起）。
 */
class AcpProcess {
  private buffer = '';
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners: Array<(msg: JsonRpcMessage) => void> = [];
  stderrTail = '';

  constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.consume(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-500);
    });
    child.on('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(
          new Error(
            `devin acp 进程退出${this.stderrTail ? `: ${this.stderrTail.trim()}` : ''}`,
          ),
        );
      }
      this.pending.clear();
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      idx = this.buffer.indexOf('\n');
      if (!line.startsWith('{')) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      if (msg.id !== undefined && !msg.method) {
        const pending = this.pending.get(Number(msg.id));
        if (!pending) continue;
        this.pending.delete(Number(msg.id));
        if (msg.error) {
          pending.reject(new Error(msg.error.message ?? 'jsonrpc error'));
        } else {
          pending.resolve(msg.result);
        }
        continue;
      }
      if (msg.method === 'session/request_permission') {
        this.answerPermission(msg);
        continue;
      }
      for (const listener of this.listeners) listener(msg);
    }
  }

  private answerPermission(msg: JsonRpcMessage): void {
    const options = (msg.params?.options ?? []) as Array<{
      optionId?: string;
      kind?: string;
    }>;
    const allow =
      options.find((option) => option.kind === 'allow_always') ??
      options.find((option) => option.kind === 'allow_once') ??
      options[0];
    this.write({
      jsonrpc: '2.0',
      id: msg.id,
      result: allow?.optionId
        ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
        : { outcome: { outcome: 'cancelled' } },
    });
  }

  write(payload: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin?.write(JSON.stringify(payload) + '\n');
    } catch {
      /* 进程已退出 */
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  onMessage(listener: (msg: JsonRpcMessage) => void): void {
    this.listeners.push(listener);
  }

  dispose(): void {
    try {
      this.child.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
    const timer = setTimeout(() => {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, 2000);
    timer.unref();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`devin acp 探测超时（${ms}ms）`)),
      ms,
    );
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class DevinKernel implements Kernel {
  readonly name = 'devin';
  private readonly cli: string;
  private readonly root: string;
  private readonly sessionMode: string;
  private modelsCache: { at: number; models: ModelInfo[] } | null = null;

  constructor(root: string) {
    this.cli = process.env.DEVIN_CLI_PATH || 'devin';
    this.root = root;
    this.sessionMode =
      (process.env.DEVIN_SESSION_MODE || DEFAULT_SESSION_MODE).trim() ||
      DEFAULT_SESSION_MODE;
  }

  capabilities(): ExecutorCapabilities {
    return {
      questions: false,
      interrupt: true,
      switchModel: true, // 下一回合生效（set_config_option 逐回合应用）
      agents: false,
      exec: false,
      maxSessions: null,
      protocol: 1,
    };
  }

  async location(): Promise<{ directory: string }> {
    return { directory: this.root };
  }

  /** devin CLI 自身版本（平台执行器「版本」列展示） */
  async version(): Promise<string> {
    return probeCliVersion(this.cli);
  }

  async providers(): Promise<ProviderInfo[]> {
    return [{ id: DEVIN_PROVIDER_ID, name: 'Devin' }];
  }

  async models(): Promise<ModelInfo[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < MODEL_CACHE_MS) {
      return this.modelsCache.models;
    }
    const options = await this.probeConfig();
    const modelOption = options.find((option) => option.id === 'model');
    const thoughtOption = options.find((option) => option.id === 'thought_level');
    if (!modelOption?.options?.length) {
      throw new Error('devin 模型清单为空（session/new 未返回 model 配置项）');
    }
    // 思考等级为会话级配置：同一组变体应用到全部模型
    const variants = (thoughtOption?.options ?? [])
      .map((option) => option.value)
      .filter((value): value is string => Boolean(value))
      .map((id) => ({ id }));
    const models: ModelInfo[] = modelOption.options
      .filter((option) => Boolean(option.value))
      .map((option) => ({
        id: option.value as string,
        modelID: option.value as string,
        providerID: DEVIN_PROVIDER_ID,
        name: option.name ?? (option.value as string),
        capabilities: { tools: true },
        ...(variants.length ? { variants } : {}),
      }));
    this.modelsCache = { at: Date.now(), models };
    return models;
  }

  /** 短会话探测：initialize + session/new，取 configOptions 后立即销毁 */
  private async probeConfig(): Promise<AcpConfigOption[]> {
    const child = spawn(this.cli, ['acp', '--process-model', 'in-process'], {
      cwd: this.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const acp = new AcpProcess(child);
    try {
      const result = await withTimeout(
        (async () => {
          await acp.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
            },
          });
          return (await acp.request('session/new', {
            cwd: this.root,
            mcpServers: [],
          })) as { configOptions?: AcpConfigOption[] };
        })(),
        PROBE_TIMEOUT_MS,
      );
      return result?.configOptions ?? [];
    } catch (error) {
      throw new Error(`devin 模型清单获取失败: ${(error as Error).message}`);
    } finally {
      acp.dispose();
    }
  }

  async runTurn(input: KernelRunTurnInput): Promise<KernelTurnResult> {
    const child = spawn(this.cli, ['acp', '--process-model', 'in-process'], {
      cwd: input.directory,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const acp = new AcpProcess(child);
    let externalId = input.externalId;
    /** session/load 会重放历史消息（agent_message_chunk），只在 prompt 发出后转增量 */
    let promptSent = false;

    const result = await new Promise<KernelTurnResult>((resolve) => {
      let settled = false;
      const finish = (turn: KernelTurnResult) => {
        if (settled) return;
        settled = true;
        resolve(turn);
      };

      input.signal.addEventListener(
        'abort',
        () => {
          try {
            child.kill('SIGTERM');
          } catch {
            /* 已退出 */
          }
          setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* 已退出 */
            }
          }, 5000).unref();
        },
        { once: true },
      );

      acp.onMessage((msg) => {
        if (msg.method !== 'session/update') return;
        const update = (msg.params as { update?: AcpSessionUpdate } | undefined)
          ?.update;
        if (!update) return;
        // session/load 的历史重放不是本回合产物：prompt 发出前一律不转发
        if (!promptSent) return;
        if (
          update.sessionUpdate === 'agent_thought_chunk' &&
          update.content?.type === 'text' &&
          update.content.text
        ) {
          input.events.onThoughtChunk(update.content.text);
        } else if (
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content?.type === 'text' &&
          update.content.text
        ) {
          input.events.onChunk(update.content.text);
        }
      });

      child.on('error', (error) => {
        finish({
          outcome: 'failed',
          finalText: null,
          externalId,
          error: `spawn ${this.cli} 失败: ${error.message}`,
        });
      });

      child.on('close', (code) => {
        finish({
          outcome: 'failed',
          finalText: null,
          externalId,
          error: input.signal.aborted
            ? 'interrupted'
            : `devin acp 退出（code=${code}）${
                acp.stderrTail ? `: ${acp.stderrTail.trim()}` : ''
              }`,
        });
      });

      void (async () => {
        try {
          await acp.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
            },
          });

          if (externalId) {
            try {
              await acp.request('session/load', {
                sessionId: externalId,
                cwd: input.directory,
                mcpServers: [],
              });
            } catch {
              // 会话已被外部清理：降级新建，保证回合可继续
              externalId = null;
            }
          }
          if (!externalId) {
            const created = (await acp.request('session/new', {
              cwd: input.directory,
              mcpServers: [],
            })) as { sessionId?: string };
            if (typeof created?.sessionId === 'string' && created.sessionId) {
              externalId = created.sessionId;
              input.events.onExternalSession(externalId);
            }
          }
          if (!externalId) throw new Error('devin acp 未返回会话标识');

          await this.applyConfig(acp, externalId, input.model);

          promptSent = true;
          const promptResult = (await acp.request('session/prompt', {
            sessionId: externalId,
            prompt: [{ type: 'text', text: input.prompt }],
          })) as { stopReason?: string };
          const stopReason = promptResult?.stopReason;
          const ok = stopReason === 'end_turn' || stopReason === 'max_tokens';
          finish({
            outcome: ok ? 'succeeded' : 'failed',
            finalText: null,
            externalId,
            ...(ok ? {} : { error: `session/prompt stopReason=${stopReason}` }),
          });
        } catch (error) {
          finish({
            outcome: 'failed',
            finalText: null,
            externalId,
            error: (error as Error).message,
          });
        }
      })();
    });

    acp.dispose();
    return result;
  }

  /** 逐回合应用配置：mode（自治）/ model / thought_level；单项失败不阻断回合 */
  private async applyConfig(
    acp: AcpProcess,
    sessionId: string,
    model: ModelRef | null,
  ): Promise<void> {
    if (this.sessionMode) {
      await this.setConfig(acp, sessionId, 'mode', this.sessionMode);
    }
    if (model?.id) {
      await this.setConfig(acp, sessionId, 'model', model.id);
    }
    if (model?.variant) {
      await this.setConfig(acp, sessionId, 'thought_level', model.variant);
    }
  }

  private async setConfig(
    acp: AcpProcess,
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    try {
      await acp.request('session/set_config_option', {
        sessionId,
        configId,
        value,
      });
    } catch {
      // 旧版 devin 或该会话不支持此配置项：保留默认，不阻断回合
    }
  }
}