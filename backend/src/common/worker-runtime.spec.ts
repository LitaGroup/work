import { ExecutorType, WorkerRuntime } from './enums';
import {
  AGENT_RUNTIMES,
  isAgentRuntime,
  runtimeFromExecutorType,
} from './worker-runtime';

describe('worker-runtime', () => {
  it('isAgentRuntime：执行器运行时为 true，human / PI / 空值为 false', () => {
    expect(isAgentRuntime(WorkerRuntime.OPENCODE)).toBe(true);
    expect(isAgentRuntime(WorkerRuntime.CODEX)).toBe(true);
    expect(isAgentRuntime(WorkerRuntime.CLAUDE_CODE)).toBe(true);
    expect(isAgentRuntime(WorkerRuntime.KIRO)).toBe(true);
    expect(isAgentRuntime(WorkerRuntime.HUMAN)).toBe(false);
    expect(isAgentRuntime(WorkerRuntime.PI)).toBe(false);
    expect(isAgentRuntime(null)).toBe(false);
    expect(isAgentRuntime(undefined)).toBe(false);
  });

  it('AGENT_RUNTIMES 覆盖全部执行器运行时且不含 human/pi', () => {
    expect(AGENT_RUNTIMES).toEqual([
      WorkerRuntime.OPENCODE,
      WorkerRuntime.CODEX,
      WorkerRuntime.CLAUDE_CODE,
      WorkerRuntime.KIRO,
    ]);
  });

  it('runtimeFromExecutorType：按执行器类型映射；未知/缺省回退 opencode', () => {
    expect(runtimeFromExecutorType(ExecutorType.OPENCODE)).toBe(
      WorkerRuntime.OPENCODE,
    );
    expect(runtimeFromExecutorType(ExecutorType.CODEX)).toBe(
      WorkerRuntime.CODEX,
    );
    expect(runtimeFromExecutorType(ExecutorType.CLAUDE_CODE)).toBe(
      WorkerRuntime.CLAUDE_CODE,
    );
    expect(runtimeFromExecutorType(ExecutorType.KIRO)).toBe(WorkerRuntime.KIRO);
    expect(runtimeFromExecutorType(null)).toBe(WorkerRuntime.OPENCODE);
    expect(runtimeFromExecutorType(undefined)).toBe(WorkerRuntime.OPENCODE);
  });
});
