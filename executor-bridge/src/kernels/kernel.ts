/**
 * 内核接口：bridge 骨架与具体执行内核（kiro / codex / claude-code）之间的契约。
 * 骨架负责会话状态机、排队与事件广播；内核只执行「一个回合」。
 */
import type {
  ExecutorCapabilities,
  ModelInfo,
  ModelRef,
  ProviderInfo,
} from '../types.js';

export interface KernelTurnEvents {
  /** assistant 增量文本（delta） */
  onChunk(text: string): void;
  /** assistant 思考增量（delta；如 kiro 的 agent_thought_chunk） */
  onThoughtChunk(text: string): void;
  /** 内核侧会话标识确定时回调（如 kiro 的 sess_*，用于 --resume-id 续聊） */
  onExternalSession(externalId: string): void;
}

export interface KernelRunTurnInput {
  /** 内核会话标识；null 表示新建 */
  externalId: string | null;
  /** 回合工作目录（工位目录） */
  directory: string;
  prompt: string;
  /** 平台指定的模型/思考等级；null 用内核默认 */
  model: ModelRef | null;
  /** 中断信号：abort 后内核必须终止子进程并 resolve（outcome=failed） */
  signal: AbortSignal;
  events: KernelTurnEvents;
}

export interface KernelTurnResult {
  outcome: 'succeeded' | 'failed';
  finalText: string | null;
  externalId: string | null;
  error?: string;
}

export interface Kernel {
  readonly name: string;
  capabilities(): ExecutorCapabilities;
  /** 内核（Agent CLI）自身版本号；探测失败返回 'unknown'。与 bridge 版本区分展示 */
  version(): Promise<string>;
  location(): Promise<{ directory: string }>;
  providers(): Promise<ProviderInfo[]>;
  models(): Promise<ModelInfo[]>;
  runTurn(input: KernelRunTurnInput): Promise<KernelTurnResult>;
}
