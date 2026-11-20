/**
 * 协议 DTO（protocol 1）：形态与平台 ExecutorClient 接口一一对应，
 * 见 docs/EXECUTOR_PROTOCOL.md。
 */

/** 执行器能力（与 backend/src/executors/executor-capabilities.ts 字段一致） */
export interface ExecutorCapabilities {
  questions: boolean;
  interrupt: boolean;
  switchModel: boolean;
  agents: boolean;
  exec: boolean;
  maxSessions: number | null;
  protocol: number;
}

/** 模型引用（id 即 modelID；variant 为思考等级） */
export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface ProviderInfo {
  id: string;
  name?: string;
}

export interface ModelInfo {
  id: string;
  modelID: string;
  providerID: string;
  name?: string;
  capabilities?: { tools?: boolean };
  variants?: Array<{ id: string }>;
}

export interface CreateSessionInput {
  title?: string;
  model?: ModelRef;
  agent?: string;
  location?: { directory: string };
  permissions?: unknown;
  metadata?: Record<string, unknown>;
}

export interface SessionInfo {
  id: string;
  title: string;
  location?: { directory: string } | null;
}

export interface PromptInput {
  text: string;
  skills?: unknown[];
  files?: Array<{ uri: string; name?: string; description?: string }>;
}

export interface PromptResult {
  id?: string;
  sessionID?: string;
  time?: { created?: number | null };
}

/** SSE 事件出口：sessionManager → http 广播 */
export type EventSink = (type: string, data: Record<string, unknown>) => void;
