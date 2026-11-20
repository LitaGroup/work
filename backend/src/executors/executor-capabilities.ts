/**
 * 执行器能力上报：平台按能力降级（提问回路/切模型/主 Agent 等），
 * opencode 为固定值；bridge 执行器经 /health 上报并协商 protocol 版本。
 * 缓存于 executors.capabilitiesCache（健康检查时刷新）。
 */

export interface ExecutorCapabilities {
  /** 执行中向需求方提问并等待答复（false 时提问回路整体降级，飞书审批卡片不渲染按钮） */
  questions: boolean;
  /** 中断正在执行的会话 */
  interrupt: boolean;
  /** 运行中切换模型/思考等级（false 时调试页提示「重置会话后生效」） */
  switchModel: boolean;
  /** 主 Agent 切换（build / plan） */
  agents: boolean;
  /** shell 命令（仅 opencode 保留；bridge 为可选白名单能力，令牌写入走结构化文件端点） */
  exec: boolean;
  /** 最大并发会话数；null = 未提供上限（按执行器自身容量兜底） */
  maxSessions: number | null;
  /** 执行器协议版本（能力协商用，当前为 1） */
  protocol: number;
}

/** opencode server 固定能力（协议原生支持提问/中断/切模型/主 Agent/shell） */
export const OPENCODE_CAPABILITIES: ExecutorCapabilities = {
  questions: true,
  interrupt: true,
  switchModel: true,
  agents: true,
  exec: true,
  maxSessions: null,
  protocol: 1,
};
