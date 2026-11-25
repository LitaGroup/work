import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthService } from '../auth/auth.service';
import type { EvalTokenService } from '../eval/eval-token.service';
import type { Worker } from '../workers/worker.entity';
import type { WorkersService } from '../workers/workers.service';
import type { McpWorkPrincipal } from './work-tools/work-tools.types';

/**
 * MCP 令牌认证依赖：lita-work（/api/mcp/work）与
 * lita-work-admin（/api/mcp/work-admin）共用同一套令牌解析规则。
 */
export interface McpAuthDeps {
  auth: AuthService;
  workers: WorkersService;
  evalToken: EvalTokenService;
}

/**
 * 解析 MCP 请求令牌（与 `.md` 端点一致）：
 * - X-Worker-Token：机器人令牌 → worker 身份（评估令牌优先）；
 * - Authorization: Bearer / X-Agent-Token / ?token=：评估令牌、公共 Agent 令牌或机器人令牌。
 * 真人机器人令牌同时解析出其绑定用户，保持真人身份语义。
 */
export async function authenticateMcpRequest(
  req: Request,
  deps: McpAuthDeps,
): Promise<McpWorkPrincipal> {
  const workerHeader = req.headers['x-worker-token'];
  const workerToken = (
    Array.isArray(workerHeader) ? workerHeader[0] : workerHeader
  )?.trim();
  if (workerToken) {
    // 评估令牌优先（评估沙箱 .env 的 LITA_WORK_TOKEN 即评估令牌）
    const evalClaims = deps.evalToken.verify(workerToken);
    if (evalClaims) return evalPrincipalOf(evalClaims, deps);
    const worker = await deps.workers.findByAgentToken(workerToken);
    if (!worker) {
      throw new UnauthorizedException(
        '无效的机器人访问令牌（由平台在初始化或首次派发时生成到工位 .agents/.env 的 LITA_WORK_TOKEN）',
      );
    }
    return principalOf(worker, deps);
  }

  const header = req.headers['authorization'];
  const bearer =
    typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
      ? header.slice(7).trim()
      : '';
  const agentHeader = req.headers['x-agent-token'];
  const agentToken = Array.isArray(agentHeader) ? agentHeader[0] : agentHeader;
  const queryToken = new URL(
    req.originalUrl ?? req.url ?? '',
    'http://localhost',
  ).searchParams.get('token');
  const token = bearer || agentToken?.trim() || queryToken?.trim() || '';
  if (!token) {
    throw new UnauthorizedException(
      '缺少鉴权：请在 Authorization: Bearer 或 X-Agent-Token 头（或 ?token= 参数）携带机器人令牌，或使用 X-Worker-Token 携带机器人令牌（工位环境变量 LITA_WORK_TOKEN）',
    );
  }
  // 评估令牌也接受 Bearer / X-Agent-Token / ?token= 携带（沙箱内核适配场景）
  const evalClaims = deps.evalToken.verify(token);
  if (evalClaims) return evalPrincipalOf(evalClaims, deps);
  const publicAgent = deps.auth.getPublicAgentByToken(token);
  if (publicAgent) return { user: publicAgent };
  // 工位 .agents/.env 的 LITA_WORK_TOKEN 是机器人令牌：
  // 统一按 Bearer / X-Agent-Token 传入时同样识别为机器人身份
  const worker = await deps.workers.findByAgentToken(token);
  if (worker) return principalOf(worker, deps);
  throw new UnauthorizedException(
    '无效的机器人访问令牌（可在平台个人中心重置后更新 MCP 配置）',
  );
}

/** 评估令牌 → 机器人身份 + 评估上下文（9.3；评估令牌下授予受限权限） */
export async function evalPrincipalOf(
  claims: Awaited<ReturnType<EvalTokenService['verify']>>,
  deps: McpAuthDeps,
): Promise<McpWorkPrincipal> {
  if (!claims) throw new UnauthorizedException('无效的评估令牌');
  const worker = await deps.workers.findOne(claims.workerId).catch(() => null);
  if (!worker || !worker.enabled) {
    throw new UnauthorizedException('评估令牌对应的机器人不可用');
  }
  const principal: McpWorkPrincipal = {
    worker,
    evalContext: {
      workerId: claims.workerId,
      evalItemId: claims.evalItemId,
      taskId: claims.taskId,
      judge: claims.judge,
    },
  };
  if (worker.humanUserId) {
    const user = await deps.auth.getUserById(worker.humanUserId);
    if (user) principal.user = user;
  }
  return principal;
}

/** 机器人身份；绑定真人时同时挂载用户，保持真人操作语义 */
export async function principalOf(
  worker: Worker,
  deps: McpAuthDeps,
): Promise<McpWorkPrincipal> {
  if (!worker.humanUserId) return { worker };
  const user = await deps.auth.getUserById(worker.humanUserId);
  return user ? { worker, user } : { worker };
}
