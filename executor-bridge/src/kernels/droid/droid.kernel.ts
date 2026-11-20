/**
 * droid 内核（v1）：每回合 spawn `droid exec --cwd <工位目录> -o stream-json`，
 * stdout 为 JSONL 事件流（system/init、message、tool_call、tool_result、error、终态 result）。
 * - 会话标识取 system/init 的 session_id，续聊用 `-s <sessionId>`（droid 本地 store 持久化）；
 * - 模型走 `-m`、思考等级走 `-r/--reasoning-effort`，逐回合传参（下一回合生效）；
 * - 终态 result（type=result 或 completion）带 result 文本与 usage，
 *   其余情况取进程退出码与错误事件判定；
 * - 模型清单无独立命令，解析 `droid exec --help` 的
 *   「Available Models / Model details」段（模型 + 每模型 reasoning 等级 → variants）。
 * 自治等级默认 --skip-permissions-unsafe（等价 kiro --trust-all-tools，无人值守工位），
 * DROID_PERMISSION_MODE=low|medium|high 时改走 --auto <level>。
 */
import { execFile, spawn } from 'child_process';
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

const DROID_PROVIDER_ID = 'droid';
const MODEL_CACHE_MS = 10 * 60 * 1000;

interface DroidEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  role?: string;
  text?: string;
  /** completion 终态事件的最终文本（实测 stream-json 字段） */
  finalText?: string;
  result?: string;
  response?: string;
  completion?: string;
  message?: string;
  source?: string;
  session_id?: string;
  model?: string;
  reasoning_effort?: string;
  reasoning?: string;
}

export class DroidKernel implements Kernel {
  readonly name = 'droid';
  private readonly cli: string;
  private readonly root: string;
  private readonly permissionMode: string;
  private modelsCache: { at: number; models: ModelInfo[] } | null = null;

  constructor(root: string) {
    this.cli = process.env.DROID_CLI_PATH || 'droid';
    this.root = root;
    this.permissionMode = (
      process.env.DROID_PERMISSION_MODE || 'unsafe'
    ).toLowerCase();
  }

  capabilities(): ExecutorCapabilities {
    return {
      questions: false,
      interrupt: true,
      switchModel: true, // 下一回合生效（-m / -r 逐回合传参）
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
    return [{ id: DROID_PROVIDER_ID, name: 'Droid' }];
  }

  async models(): Promise<ModelInfo[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < MODEL_CACHE_MS) {
      return this.modelsCache.models;
    }
    const help = await new Promise<string>((resolve, reject) => {
      execFile(
        this.cli,
        ['exec', '--help'],
        { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: process.env },
        (error, stdout) => {
          if (error) {
            reject(new Error(`droid 模型清单获取失败: ${error.message}`));
          } else {
            resolve(stdout);
          }
        },
      );
    });
    const models = this.parseModelCatalog(help);
    if (models.length === 0) {
      throw new Error('droid 模型清单解析失败（--help 中未找到 Available Models）');
    }
    this.modelsCache = { at: Date.now(), models };
    return models;
  }

  /**
   * 解析 `droid exec --help`：
   * 「Available Models:」段 `  <id>   <名称>`；「Model details:」段
   * `- <名称>: supports reasoning: Yes; supported: [off, low, ...]; default: high`。
   */
  private parseModelCatalog(help: string): ModelInfo[] {
    const entries: Array<{ id: string; name: string }> = [];
    const levels = new Map<string, string[]>();
    let section: 'none' | 'models' | 'details' = 'none';

    for (const raw of help.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (/^Available Models:\s*$/.test(line)) {
        section = 'models';
        continue;
      }
      if (/^Model details:\s*$/.test(line)) {
        section = 'details';
        continue;
      }
      if (/^Pinning the Latest Model:\s*$/.test(line)) {
        section = 'none';
        continue;
      }
      if (section === 'models') {
        const match = line.match(/^\s{2}(\S+)\s{2,}(.+)$/);
        if (!match) continue;
        entries.push({
          id: match[1] ?? '',
          name: (match[2] ?? '').replace(/\s*\(default\)\s*$/, '').trim(),
        });
        continue;
      }
      if (section === 'details') {
        const match = line.match(
          /^\s*-\s*(.+?):\s*supports reasoning:.*?supported:\s*\[([^\]]*)\]/,
        );
        if (!match) continue;
        const values = (match[2] ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        levels.set((match[1] ?? '').trim(), values);
      }
    }

    return entries.map((entry) => {
      const variants =
        levels.get(entry.name) ??
        levels.get(entry.name.replace(/\s*\[Deprecated\]\s*$/, '').trim()) ??
        [];
      return {
        id: entry.id,
        modelID: entry.id,
        providerID: DROID_PROVIDER_ID,
        name: entry.name,
        capabilities: { tools: true },
        ...(variants.length
          ? { variants: variants.map((id) => ({ id })) }
          : {}),
      };
    });
  }

  /** 自治等级参数：默认跳过全部权限检查；低档位改走 --auto <level> */
  private permissionArgs(): string[] {
    if (
      this.permissionMode === 'low' ||
      this.permissionMode === 'medium' ||
      this.permissionMode === 'high'
    ) {
      return ['--auto', this.permissionMode];
    }
    return ['--skip-permissions-unsafe'];
  }

  async runTurn(input: KernelRunTurnInput): Promise<KernelTurnResult> {
    const args = [
      'exec',
      '--cwd',
      input.directory,
      '-o',
      'stream-json',
      ...this.permissionArgs(),
    ];
    if (input.externalId) args.push('-s', input.externalId);
    if (input.model?.id) args.push('-m', input.model.id);
    if (input.model?.variant) args.push('-r', input.model.variant);
    args.push(input.prompt);

    const child = spawn(this.cli, args, {
      cwd: input.directory,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    return await new Promise<KernelTurnResult>((resolve) => {
      let buffer = '';
      let stderrTail = '';
      let externalId = input.externalId;
      let settled = false;
      let errorText: string | null = null;

      const finish = (result: KernelTurnResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
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

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf('\n');
          if (!line.startsWith('{')) continue;
          let event: DroidEvent;
          try {
            event = JSON.parse(line) as DroidEvent;
          } catch {
            continue;
          }
          if (event.type === 'system') {
            // system/init：会话标识（每行也带 session_id，init 时回调一次即可）
            if (event.session_id && event.session_id !== externalId) {
              externalId = event.session_id;
              input.events.onExternalSession(externalId);
            }
            continue;
          }
          if (event.type === 'message') {
            if (
              event.role === 'assistant' &&
              typeof event.reasoning === 'string' &&
              event.reasoning
            ) {
              input.events.onThoughtChunk(event.reasoning);
            }
            if (
              event.role === 'assistant' &&
              typeof event.text === 'string' &&
              event.text
            ) {
              input.events.onChunk(event.text);
            }
            continue;
          }
          if (event.type === 'error') {
            errorText = event.message ?? errorText;
            continue;
          }
          if (event.type === 'result' || event.type === 'completion') {
            const finalText =
              typeof event.finalText === 'string'
                ? event.finalText
                : typeof event.result === 'string'
                  ? event.result
                  : typeof event.response === 'string'
                    ? event.response
                    : typeof event.completion === 'string'
                      ? event.completion
                      : null;
            // 期间出现 error 事件（如鉴权/额度错误）时，即使收到终态也判失败
            const ok =
              !errorText &&
              !event.is_error &&
              (event.subtype === undefined ||
                event.subtype === 'success' ||
                event.subtype === 'completed');
            finish({
              outcome: ok ? 'succeeded' : 'failed',
              finalText,
              externalId,
              ...(ok
                ? {}
                : {
                    error: `droid ${event.subtype ?? event.type}${
                      errorText ? `: ${errorText}` : ''
                    }`,
                  }),
            });
          }
        }
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
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
          error: input.signal.aborted
            ? 'interrupted'
            : `${errorText ? `${errorText}; ` : ''}droid exec 退出（code=${code}）${
                stderrTail ? `: ${stderrTail.trim()}` : ''
              }`,
        });
      });
    });
  }
}