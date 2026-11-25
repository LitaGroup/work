import {
  Controller,
  ForbiddenException,
  Post,
  Req,
  Res,
  Body,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { UserRole } from '../common/enums';
import { AuthService } from '../auth/auth.service';
import { Public } from '../auth/public.decorator';
import { WorkersService } from '../workers/workers.service';
import { EvalTokenService } from '../eval/eval-token.service';
import type { McpWorkPrincipal } from './work-tools/work-tools.types';
import { authenticateMcpRequest } from './mcp-auth';
import { beginMcpTrace } from './mcp-request-trace';
import { McpAdminService } from './mcp-admin.service';
import { TraceService } from '../trace/trace.service';

/**
 * lita-work-admin MCP 开放端点（MCP Streamable HTTP，stateless）：
 * POST /api/mcp/work-admin —— 管理面工具：机器人 / 任务定义 / 测试集与评估 /
 * 执行记录 / 平台设置。
 *
 * 鉴权：令牌解析规则与 lita-work 一致，但额外要求管理员身份
 * （公共 Agent 虚拟用户、绑定真人且 role=管理员 的真人机器人令牌，
 * 或 MCP_ADMIN_WORKER_IDS 显式授权的机器人）；
 * 评估令牌（含判定令牌）一律拒绝。
 */

/** 显式授权使用 lita-work-admin 的机器人 id（逗号/空格分隔，便于临时放开 AI 机器人） */
export const ADMIN_WORKER_IDS_ENV = 'MCP_ADMIN_WORKER_IDS';

function adminGrantedWorkerIds(): Set<number> {
  const raw = process.env[ADMIN_WORKER_IDS_ENV] ?? '';
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((item) => Number(item.trim()))
      .filter((id) => Number.isInteger(id) && id > 0),
  );
}

@Controller('mcp/work-admin')
export class McpAdminController {
  constructor(
    private readonly mcp: McpAdminService,
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
    const principal = await this.authenticateAdmin(req);
    const traceCtx = beginMcpTrace(this.trace, principal, res, body);
    try {
      await this.mcp.handleRequest(principal, req, res, body);
    } finally {
      traceCtx?.();
    }
  }

  private async authenticateAdmin(req: Request): Promise<McpWorkPrincipal> {
    const principal = await authenticateMcpRequest(req, {
      auth: this.auth,
      workers: this.workers,
      evalToken: this.evalToken,
    });
    if (principal.evalContext) {
      throw new ForbiddenException('评估令牌不可访问 lita-work-admin');
    }
    const adminUser = principal.user?.role === UserRole.ADMIN;
    const grantedWorker =
      !!principal.worker && adminGrantedWorkerIds().has(principal.worker.id);
    if (!adminUser && !grantedWorker) {
      throw new ForbiddenException(
        'lita-work-admin 仅管理员可用（公共 Agent、管理员绑定的真人机器人令牌，或在 MCP_ADMIN_WORKER_IDS 中授权的机器人）',
      );
    }
    return principal;
  }
}
