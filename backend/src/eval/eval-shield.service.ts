import { Injectable } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  classifyEvalMdRequest,
  classifyEvalTool,
  EVAL_MODE_ERROR,
} from './eval-policy';
import type { EvalContext } from './eval-token.service';
import { EvalEngineService } from './eval-engine.service';

/**
 * 评估模式权限拦截（TECH_DESIGN 9.4）：
 * - MCP：在 lita-work 工具注册时用 Proxy 包裹 server.tool/registerTool，把回调包上策略检查；
 * - .md 端点：由 EvalMdInterceptor 按 方法与路径 分类拦截。
 * 被拦截的调用返回明确错误「评估模式下不允许此操作」，并写入评估项
 * WRITE_BLOCKED / SUBTASK_BLOCKED 事件。
 */
@Injectable()
export class EvalShieldService {
  constructor(private readonly engine: EvalEngineService) {}

  /** 包裹 McpServer：所有工具注册都经过策略检查 */
  shieldMcpServer(server: McpServer, ctx: EvalContext): McpServer {
    const checkTool = this.checkTool.bind(this);
    const wrapCallback = (name: string, cb: unknown): unknown => {
      if (typeof cb !== 'function') return cb;
      return (args: Record<string, unknown>, extra: unknown): unknown =>
        checkTool(name, args ?? {}, ctx, () =>
          (cb as (...a: unknown[]) => unknown)(args, extra),
        );
    };
    return new Proxy(server, {
      get(target, prop) {
        if (prop === 'registerTool') {
          return (name: string, config: unknown, cb: unknown): unknown =>
            (target.registerTool as (...a: unknown[]) => unknown)(
              name,
              config,
              wrapCallback(name, cb),
            );
        }
        if (prop === 'tool') {
          return (name: string, ...rest: unknown[]): unknown => {
            const cb = rest[rest.length - 1];
            const next = [...rest.slice(0, -1), wrapCallback(name, cb)];
            return (target.tool as (...a: unknown[]) => unknown)(name, ...next);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });
  }

  /** MCP 工具调用策略检查；通过才执行原回调 */
  private checkTool(
    name: string,
    args: Record<string, unknown>,
    ctx: EvalContext,
    invoke: () => unknown,
  ): unknown {
    const check = classifyEvalTool(name, args, ctx);
    if (check.decision === 'allow') return invoke();
    const kind: 'write' | 'subtask' =
      check.kind === 'subtask' ? 'subtask' : 'write';
    void this.engine.recordBlocked(ctx.evalItemId, kind, name).catch(() => {});
    const error = new Error(check.reason || EVAL_MODE_ERROR);
    (error as { evalBlocked?: boolean }).evalBlocked = true;
    throw error;
  }

  /** .md 端点拦截：blocked=false 表示放行 */
  checkMd(
    ctx: EvalContext,
    method: string,
    pathname: string,
  ): { blocked: boolean; kind?: 'write' | 'subtask'; reason: string } {
    const check = classifyEvalMdRequest(method, pathname, ctx);
    if (check.decision === 'allow') return { blocked: false, reason: '' };
    const kind = check.kind === 'subtask' ? 'subtask' : 'write';
    void this.engine
      .recordBlocked(ctx.evalItemId, kind, `${method} ${pathname}`)
      .catch(() => {});
    return { blocked: true, kind, reason: check.reason };
  }
}
