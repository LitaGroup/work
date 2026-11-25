/**
 * 执行器客户端抽象：平台与执行器实例（opencode server / executor-bridge）之间的统一接口。
 *
 * - opencode 是第一个实现（OpencodeClient）；codex / claude-code / kiro / devin / droid 等经工位侧
 *   executor-bridge 接入（协议见 docs/EXECUTOR_PROTOCOL.md，DTO 形态对齐本接口）。
 * - 本阶段为零行为变更抽象：接口成员与 OpencodeClient 公开方法一一对应，DTO 暂沿用
 *   opencode 命名，随 bridge 协议落地再逐步中立化。
 * - 会话忙时的 prompt 排队是执行器侧职责（平台不维护发送队列）：所有实现都必须保证
 *   「会话执行中新 prompt 入队、本轮结束后按序处理」的语义。
 */
import { ExecutorType } from '../common/enums';
import type { ModelErrorLike } from './model-availability';
import { OpencodeClient } from './opencode-client';
import { BridgeClient } from './bridge-client';
import type {
  OpencodeCreateSessionInput,
  OpencodeEndpoint,
  OpencodeModelInfo,
  OpencodeModelRef,
  OpencodePromptInput,
  OpencodePromptResult,
  OpencodeProviderInfo,
  OpencodeQuestionInfo,
  OpencodeQuestionRequest,
  OpencodeServerInfo,
  OpencodeSessionInfo,
} from './opencode-client';
import type { OpencodeTodo } from './opencode-todos';
import type { ExecutorCapabilities } from './executor-capabilities';

export type { ExecutorCapabilities } from './executor-capabilities';

export interface ExecutorClient {
  /** 服务器信息（健康检查用） */
  info(signal?: AbortSignal): Promise<OpencodeServerInfo>;

  /** 执行器能力上报（opencode 固定值；bridge 经 /health 上报并协商协议版本） */
  capabilities(): Promise<ExecutorCapabilities>;

  /** 默认工作目录 */
  location(signal?: AbortSignal): Promise<{ directory: string }>;

  /** 供应商清单 */
  providers(signal?: AbortSignal): Promise<OpencodeProviderInfo[]>;

  /** 模型清单（含 providerID/modelID/name） */
  models(signal?: AbortSignal): Promise<OpencodeModelInfo[]>;

  /** 删除会话及其全部数据（任务验收后释放执行器资源） */
  deleteSession(sessionId: string, signal?: AbortSignal): Promise<void>;

  /** 切换会话后续轮次使用的主 Agent（build / plan） */
  switchAgent(
    sessionId: string,
    agent: string,
    signal?: AbortSignal,
  ): Promise<void>;

  /** 切换会话后续轮次使用的模型/思考等级 */
  switchModel(
    sessionId: string,
    model: OpencodeModelRef,
    signal?: AbortSignal,
  ): Promise<void>;

  /**
   * 写入执行器工作目录（聊天附件落盘）。
   * 返回执行器上的绝对路径，供 prompt files 使用 file:// URI。
   */
  writeFile(
    directory: string,
    path: string,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{ path: string }>;

  /**
   * 幂等建立目录（工位骨架 / .opencode 子目录）。
   * opencode 经 shell 实现；bridge 为原生结构化端点。
   */
  ensureDir(directory: string): Promise<void>;

  /**
   * 读取工位内的文本/二进制文件；不存在返回 null。
   * 用于工位同步 manifest 对账，不读取令牌与 MCP 凭据。
   */
  readFile(
    directory: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array | null>;

  /** 删除工位内的受管文件（不存在时忽略），用于规范 manifest 差量清理 */
  removeFiles(directory: string, paths: string[]): Promise<void>;

  /**
   * 写入敏感文件（令牌 / MCP 配置），权限 600。
   * 内容不得进入 Prompt、SSE 进度或日志（各实现自行保证）。
   */
  writeSecretFile(
    directory: string,
    path: string,
    content: string,
    mode?: number,
  ): Promise<void>;

  /**
   * 按 key 更新 env 文件（保留其他键，权限 600；文件不存在时创建）。
   * 工位 .env 令牌注入统一入口（LITA_WORK_TOKEN / LITA_USER_TOKEN 等）。
   */
  upsertEnvFile(
    directory: string,
    path: string,
    entries: Record<string, string>,
  ): Promise<void>;

  /**
   * 递归复制目录（评估沙箱构建：真实工位 → 沙箱；源/目标须位于执行器工作区内）。
   * exclude 为相对 source 的路径（文件或目录），命中的内容不进入 target（凭据不复制）。
   * opencode 经 shell 实现；bridge 走 /fs/copy-dir 结构化端点（bridge 无 shell）。
   */
  copyDir(input: {
    source: string;
    target: string;
    exclude?: string[];
  }): Promise<void>;

  /** 递归删除目录（评估沙箱销毁）；opencode 经 shell，bridge 走 /fs/rm-dir */
  removeDir(directory: string): Promise<void>;

  /** 建会话（title/model/location/permissions），返回会话信息 */
  createSession(
    input: OpencodeCreateSessionInput,
    signal?: AbortSignal,
  ): Promise<OpencodeSessionInfo>;

  /**
   * 发送消息（任务派发或执行中续聊的 prompt）。异步投递：立即返回本轮创建的用户消息。
   * 会话仍在执行时由执行器内部排队，平台不另行维护发送队列。
   * 执行结果须轮询会话终态，且 outcome 具有粘性（保留上一轮结果），
   * 判定时使用 isFreshOutcome 以本轮用户消息时间作为基准。
   */
  prompt(
    sessionId: string,
    input: OpencodePromptInput,
    signal?: AbortSignal,
  ): Promise<OpencodePromptResult | null>;

  /** 会话消息历史（列表，assistant 项 text 可能为空，需取详情） */
  messages(sessionId: string): Promise<unknown>;

  /** 单条消息详情（含 content 分段，assistant 文本在此） */
  message(sessionId: string, messageId: string): Promise<unknown>;

  /**
   * 会话最后一条 assistant 消息的文本。
   * afterCreatedMs：只取该时间之后创建的 assistant 消息（本轮基准），
   * 避免终态先于消息落库的瞬间取到上一轮回复。
   */
  lastAssistantText(
    sessionId: string,
    afterCreatedMs?: number,
  ): Promise<string | null>;

  /**
   * 会话最后一条 assistant 消息携带的错误（供应商限流/配额等失败原因）。
   * 无错误返回 null。
   */
  lastAssistantError(
    sessionId: string,
    afterCreatedMs?: number,
  ): Promise<ModelErrorLike | null>;

  /** 会话最后一条用户消息的创建时间（毫秒，无用户消息返回 0）；作为本轮运行的新鲜度基准 */
  lastUserMessageCreatedAt(sessionId: string): Promise<number>;

  /** 会话信息（outcome=运行结果，time.idle=空闲时间；重启后对账用） */
  session(sessionId: string): Promise<{
    id: string;
    outcome?: string | null;
    /** 最近一回合失败的真实原因（bridge 提供；其它执行器可能不返回） */
    error?: string | null;
    time?: { idle?: number | null };
    location?: { directory: string } | null;
  }>;

  /** 最近一次 todowrite 工具输入中的 todos（无则 null）；调试待办面板断线对账兜底 */
  latestTodos(sessionId: string): Promise<OpencodeTodo[] | null>;

  /** 中断会话执行 */
  interrupt(sessionId: string): Promise<unknown>;

  /** 等待会话空闲（用于回答提问后接管既有执行） */
  waitForIdle(sessionId: string, timeoutMs: number): Promise<void>;

  /** 当前正在运行的会话清单（sessionId → { type: 'running' }） */
  activeSessions(): Promise<Record<string, { type?: string }>>;

  /** 批复权限请求（decision：once=本次允许 / always=总是 / reject=拒绝） */
  replyPermission(
    sessionId: string,
    requestId: string,
    decision: 'once' | 'always' | 'reject',
    message?: string,
  ): Promise<unknown>;

  /** 待回答的提问清单 */
  listQuestions(sessionId: string): Promise<OpencodeQuestionRequest[]>;

  /** 回答提问（answers 与问题顺序一致，每项为所选 label 与自定义文本） */
  replyQuestion(
    sessionId: string,
    requestId: string,
    answers: string[][],
    questions?: OpencodeQuestionInfo[],
  ): Promise<void>;

  /** 跳过提问 */
  rejectQuestion(sessionId: string, requestId: string): Promise<void>;

  /** 执行 shell 命令（建工位目录等；仅 opencode 保留，后续收窄为结构化文件端点） */
  shell(command: string, timeoutMs?: number): Promise<unknown>;

  /** 订阅事件流（全执行器单连接 SSE，含心跳注释行）。返回原始 Response，由调用方读流解析 */
  eventStream(signal: AbortSignal): Promise<Response>;
}

/** 工厂入参：执行器连接信息（Executor 实体的连接子集；type 缺省视为 opencode） */
export type ExecutorClientEndpoint = OpencodeEndpoint & {
  type?: ExecutorType | null;
};

type ExecutorClientCtor = (endpoint: ExecutorClientEndpoint) => ExecutorClient;

/** 已接入的执行器类型 → 客户端构造：opencode 直连；codex / claude-code / kiro / devin / droid 经 executor-bridge（协议见 docs/EXECUTOR_PROTOCOL.md） */
const CLIENT_FACTORIES: Partial<Record<ExecutorType, ExecutorClientCtor>> = {
  [ExecutorType.OPENCODE]: (endpoint) => new OpencodeClient(endpoint),
  [ExecutorType.CODEX]: (endpoint) => new BridgeClient(endpoint),
  [ExecutorType.CLAUDE_CODE]: (endpoint) => new BridgeClient(endpoint),
  [ExecutorType.KIRO]: (endpoint) => new BridgeClient(endpoint),
  [ExecutorType.DEVIN]: (endpoint) => new BridgeClient(endpoint),
  [ExecutorType.DROID]: (endpoint) => new BridgeClient(endpoint),
};

/** 按执行器类型创建客户端；未接入的类型直接抛错，避免误用 opencode 协议 */
export function createExecutorClient(
  endpoint: ExecutorClientEndpoint,
): ExecutorClient {
  const type = endpoint.type ?? ExecutorType.OPENCODE;
  const factory = CLIENT_FACTORIES[type];
  if (!factory) {
    throw new Error(`执行器类型「${type}」尚未接入平台（当前仅支持 opencode）`);
  }
  return factory(endpoint);
}
