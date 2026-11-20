/**
 * 机器人运行时辅助：执行器驱动的 Agent 运行时判定与 executor.type → runtime 派生。
 * 真人机器人（human）与 PI 历史值不是 Agent 运行时；codex / claude-code / kiro 等
 * 随执行器接入扩展（运行时跟随绑定执行器的类型，写入时机见 workers.service）。
 */
import { ExecutorType, WorkerRuntime } from './enums';

/** 执行器驱动的 Agent 运行时集合（数据库查询可用 In(AGENT_RUNTIMES)） */
export const AGENT_RUNTIMES: readonly WorkerRuntime[] = [
  WorkerRuntime.OPENCODE,
  WorkerRuntime.CODEX,
  WorkerRuntime.CLAUDE_CODE,
  WorkerRuntime.KIRO,
];

/** 是否为执行器驱动的 AI Agent 机器人（真人 / PI 历史值除外） */
export function isAgentRuntime(
  runtime: WorkerRuntime | null | undefined,
): boolean {
  return !!runtime && AGENT_RUNTIMES.includes(runtime);
}

/** 按执行器类型派生运行时（字符串同名的枚举映射）；未知/缺省回退 opencode */
export function runtimeFromExecutorType(
  type?: ExecutorType | null,
): WorkerRuntime {
  switch (type) {
    case ExecutorType.CODEX:
      return WorkerRuntime.CODEX;
    case ExecutorType.CLAUDE_CODE:
      return WorkerRuntime.CLAUDE_CODE;
    case ExecutorType.KIRO:
      return WorkerRuntime.KIRO;
    default:
      return WorkerRuntime.OPENCODE;
  }
}
