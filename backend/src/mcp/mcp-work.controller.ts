import { Controller, Post, Req, Res, Body } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { Public } from '../auth/public.decorator';
import { WorkersService } from '../workers/workers.service';
import { EvalTokenService } from '../eval/eval-token.service';
import type { McpWorkPrincipal } from './work-tools/work-tools.types';
import { authenticateMcpRequest } from './mcp-auth';
import { beginMcpTrace } from './mcp-request-trace';
import { McpWorkService } from './mcp-work.service';
import { TraceService } from '../trace/trace.service';
import { assertMcpAccess } from '../auth/worker-access';

/**
 * lita-work MCP 开放端点（MCP Streamable HTTP，stateless）：
 * POST /api/mcp/work —— 外部 AI Agent 调用平台项目/知识/运行/缺陷等工具。
 * 鉴权（与 `.md` 端点一致）：
 * - X-Worker-Token：机器人令牌 → worker 身份（任务协同等需要机器人身份的接口）；
 * - Authorization: Bearer / X-Agent-Token / ?token=：机器人令牌（真人机器人 / AI 机器人）
 *   或公共 Agent 令牌；真人机器人令牌同时解析出其绑定用户，保持真人身份语义。
 * 真人用户没有独立令牌，个人 AGENT 使用其主人真人机器人的令牌。
 * 管理类工具（机器人/任务定义/测试集评估等）在 lita-work-admin（/api/mcp/work-admin）。
 */
@Controller('mcp/work')
export class McpWorkController {
  constructor(
    private readonly mcp: McpWorkService,
    private readonly auth: AuthService,
    private readonly workers: WorkersService,
    private readonly evalToken: EvalTokenService,
    private readonly trace: TraceService,
  ) {}

  @Post()
  @Public()
  async handlePost(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    const principal = await this.authenticate(req);
    // 「无权限」机器人禁止调用全部 MCP；评估令牌代表平台内部评估会话，豁免该限制（仍受 EvalShield 约束）
    if (!principal.evalContext) assertMcpAccess(principal);
    const traceCtx = beginMcpTrace(this.trace, principal, res, body);
    try {
      await this.mcp.handleRequest(principal, req, res, body);
    } finally {
      traceCtx?.();
    }
  }

  private authenticate(req: Request): Promise<McpWorkPrincipal> {
    return authenticateMcpRequest(req, {
      auth: this.auth,
      workers: this.workers,
      evalToken: this.evalToken,
    });
  }
}
