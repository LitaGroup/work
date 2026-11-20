/**
 * kiro 内核（v1）：每回合 spawn `kiro-cli chat --no-interactive
 * --output-format stream-json`（ACP 事件流，stdout JSONL），续聊用 --resume-id。
 * 会话由 kiro 本地 session store 持久化，bridge 重启后 externalId 仍可 resume。
 */
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import type {
  ExecutorCapabilities,
  ModelInfo,
  ProviderInfo,
} from '../../types.js';
import type {
  Kernel,
  KernelRunTurnInput,
  KernelTurnResult,
} from '../kernel.js';

const KIRO_PROVIDER_ID = 'kiro';
const MODEL_CACHE_MS = 10 * 60 * 1000;

/**
 * effort 等级静态兜底（来自 config_option_update 实测，2026-11 kiro-cli 3.5.0）。
 * 真实数据优先：会话开场的 config_option_update 会持续刷新 effortLevels。
 */
const STATIC_EFFORT: Array<{ prefix: RegExp; levels: string[] }> = [
  { prefix: /^gpt-5/, levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { prefix: /^grok/, levels: ['low', 'medium', 'high', 'xhigh'] },
];

interface KiroListModel {
  model_name?: string;
  model_id: string;
  context_window_tokens?: number;
}

interface AcpEvent {
  type?: string;
  data?: {
    sessionId?: string;
    status?: string;
    stopReason?: string;
    finalText?: string;
  };
  update?: {
    sessionUpdate?: string;
    content?: { type?: string; text?: string };
    configOptions?: Array<{
      id?: string;
      options?: Array<{
        value?: string;
        _meta?: { kiro?: { hasEffort?: boolean; effortLevels?: string[] } };
      }>;
    }>;
  };
}

export class KiroKernel implements Kernel {
  readonly name = 'kiro';
  private readonly cli: string;
  private readonly root: string;
  private modelsCache: { at: number; models: ModelInfo[] } | null = null;
  /** modelId → effort 等级（真实会话刷新；空数组 = 明确不支持） */
  private readonly effortLevels = new Map<string, string[]>();
  private effortProbed = false;

  constructor(root: string) {
    this.cli = process.env.KIRO_CLI_PATH || 'kiro-cli';
    this.root = root;
  }

  capabilities(): ExecutorCapabilities {
    return {
      questions: false,
      interrupt: true,
      switchModel: true, // 下一回合生效（--model/--effort 逐回合传入）
      agents: false,
      exec: false,
      maxSessions: null,
      protocol: 1,
    };
  }

  async location(): Promise<{ directory: string }> {
    return { directory: this.root };
  }

  async providers(): Promise<ProviderInfo[]> {
    return [{ id: KIRO_PROVIDER_ID, name: 'Kiro' }];
  }

  async models(): Promise<ModelInfo[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < MODEL_CACHE_MS) {
      return this.modelsCache.models;
    }
    const raw = await new Promise<string>((resolve, reject) => {
      execFile(
        this.cli,
        ['chat', '--list-models', '-f', 'json'],
        { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          if (error) reject(new Error(`kiro 模型清单获取失败: ${error.message}`));
          else resolve(stdout);
        },
      );
    });
    const parsed = JSON.parse(raw) as { models?: KiroListModel[] };
    // effort 等级不在 list-models 输出里：先探测一次，真实会话会持续刷新
    await this.probeEffortLevels();
    const models: ModelInfo[] = (parsed.models ?? []).map((model) => ({
      id: model.model_id,
      modelID: model.model_id,
      providerID: KIRO_PROVIDER_ID,
      name: model.model_name ?? model.model_id,
      capabilities: { tools: true },
      ...(this.variantsFor(model.model_id)
        ? { variants: this.variantsFor(model.model_id) }
        : {}),
    }));
    this.modelsCache = { at: Date.now(), models };
    return models;
  }

  /** modelId → 思考等级变体；明确不支持或未知返回 undefined */
  private variantsFor(modelId: string): Array<{ id: string }> | undefined {
    const known = this.effortLevels.get(modelId);
    if (known) {
      return known.length > 0 ? known.map((id) => ({ id })) : undefined;
    }
    const fallback = STATIC_EFFORT.find((entry) =>
      entry.prefix.test(modelId),
    )?.levels;
    return fallback?.length ? fallback.map((id) => ({ id })) : undefined;
  }

  /**
   * 探测 effort 等级：spawn 一个以 `-`（stdin）为 prompt 的会话，stdin 立即 EOF，
   * 会话开场的 config_option_update 携带全部模型的 effortLevels；拿到即杀进程。
   * 每进程只探测一次；失败走静态兜底。
   */
  private async probeEffortLevels(): Promise<void> {
    if (this.effortProbed) return;
    this.effortProbed = true;
    const { spawn } = await import('child_process');
    await new Promise<void>((resolve) => {
      let child;
      try {
        child = spawn(
          this.cli,
          ['chat', '--no-interactive', '--output-format', 'stream-json', '-'],
          { cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'], env: process.env },
        );
      } catch {
        resolve();
        return;
      }
      child.stdin.end();
      let buffer = '';
      const finish = () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
        resolve();
      };
      const timer = setTimeout(finish, 20_000);
      timer.unref();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf('\n');
          if (!line.startsWith('{')) continue;
          try {
            const event = JSON.parse(line) as AcpEvent;
            if (
              this.captureEffortLevels(event) &&
              this.effortLevels.size >= 3
            ) {
              clearTimeout(timer);
              finish();
              return;
            }
          } catch {
            /* 忽略非 JSON 行 */
          }
        }
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** 从 config_option_update 抓取各模型 effort 等级；抓到返回 true */
  private captureEffortLevels(event: AcpEvent): boolean {
    if (event.update?.sessionUpdate !== 'config_option_update') return false;
    const options = event.update.configOptions ?? [];
    const modelOptions = options.find((option) => option.id === 'model');
    if (!modelOptions?.options?.length) return false;
    for (const option of modelOptions.options) {
      if (!option.value) continue;
      const kiro = option._meta?.kiro;
      this.effortLevels.set(
        option.value,
        kiro?.hasEffort ? (kiro.effortLevels ?? []) : [],
      );
    }
    return true;
  }

  async runTurn(input: KernelRunTurnInput): Promise<KernelTurnResult> {
    const args = [
      'chat',
      '--no-interactive',
      '--trust-all-tools',
      '--output-format',
      'stream-json',
    ];
    if (input.externalId) args.push('--resume-id', input.externalId);
    if (input.model?.id) args.push('--model', input.model.id);
    if (input.model?.variant) args.push('--effort', input.model.variant);
    args.push(input.prompt);

    const { spawn } = await import('child_process');
    const child = spawn(this.cli, args, {
      cwd: input.directory,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    return await new Promise<KernelTurnResult>((resolve) => {
      let buffer = '';
      let stderrTail = '';
      let finalText: string | null = null;
      let externalId = input.externalId;
      let settled = false;

      const finish = (result: KernelTurnResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      input.signal.addEventListener(
        'abort',
        () => {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        },
        { once: true },
      );

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf('\n');
          if (!line.startsWith('{')) continue;
          let event: AcpEvent;
          try {
            event = JSON.parse(line) as AcpEvent;
          } catch {
            continue;
          }
          if (event.type === 'runStarted' && event.data?.sessionId) {
            externalId = event.data.sessionId;
            input.events.onExternalSession(externalId);
          } else if (
            event.type === 'sessionUpdate' &&
            event.update?.sessionUpdate === 'config_option_update'
          ) {
            // 会话开场携带全部模型 effort 等级，持续刷新思考等级清单
            this.captureEffortLevels(event);
          } else if (
            event.type === 'sessionUpdate' &&
            event.update?.sessionUpdate === 'agent_message_chunk' &&
            event.update.content?.type === 'text' &&
            event.update.content.text
          ) {
            input.events.onChunk(event.update.content.text);
          } else if (event.type === 'runFinished') {
            finalText = event.data?.finalText ?? null;
            const ok = event.data?.status === 'success';
            finish({
              outcome: ok ? 'succeeded' : 'failed',
              finalText,
              externalId,
              ...(ok ? {} : { error: `runFinished status=${event.data?.status}` }),
            });
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-500);
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
          error:
            input.signal.aborted
              ? 'interrupted'
              : `kiro-cli 退出（code=${code}）${stderrTail ? `: ${stderrTail.trim()}` : ''}`,
        });
      });
    });
  }

  /** 会话级助手：生成 bridge 侧消息 id */
  static messageId(): string {
    return `km_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }
}
