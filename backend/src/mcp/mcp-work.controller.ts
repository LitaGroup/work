import {
  Controller,
  Post,
  Req,
  Res,
  UnauthorizedException,
  Body,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { Public } from '../auth/public.decorator';
import { WorkersService } from '../workers/workers.service';
import { EvalTokenService } from '../eval/eval-token.service';
import type { Worker } from '../workers/worker.entity';
import { McpWorkService } from './mcp-work.service';
import type { McpWorkPrincipal } from './work-tools/work-tools.types';
import { TraceService } from '../trace/trace.service';

/**
 * lita-work MCP 开放端点（MCP Streamable HTTP，stateless）：
 * POST /api/mcp/work —— 外部 AI Agent 调用平台项目/知识/运行/缺陷等工具。
 * 鉴权（与 `.md` 端点一致）：
 * - X-Worker-Token：机器人令牌 → worker 身份（任务协同等需要机器人身份的接口）；
 * - Authorization: Bearer / X-Agent-Token / ?token=：机器人令牌（真人机器人 / AI 机器人）
 *   或公共 Agent 令牌；真人机器人令牌同时解析出其绑定用户，保持真人身份语义。
 * 真人用户没有独立令牌，个人 AGENT 使用其主人真人机器人的令牌。
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
    const traceCtx = this.beginTrace(principal, res, body);
    try {
      await this.mcp.handleRequest(principal, req, res, body);
    } finally {
      traceCtx?.();
    }
  }

  private async authenticate(req: Request): Promise<McpWorkPrincipal> {
    const workerHeader = req.headers['x-worker-token'];
    const workerToken = (
      Array.isArray(workerHeader) ? workerHeader[0] : workerHeader
    )?.trim();
    if (workerToken) {
      // 评估令牌优先（评估沙箱 .env 的 LITA_WORK_TOKEN 即评估令牌）
      const evalClaims = this.evalToken.verify(workerToken);
      if (evalClaims) return this.evalPrincipalOf(evalClaims);
      const worker = await this.workers.findByAgentToken(workerToken);
      if (!worker) {
        throw new UnauthorizedException(
          '无效的机器人访问令牌（由平台在初始化或首次派发时生成到工位 .agents/.env 的 LITA_WORK_TOKEN）',
        );
      }
      return this.principalOf(worker);
    }

    const header = req.headers['authorization'];
    const bearer =
      typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
        ? header.slice(7).trim()
        : '';
    const agentHeader = req.headers['x-agent-token'];
    const agentToken = Array.isArray(agentHeader)
      ? agentHeader[0]
      : agentHeader;
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
    const evalClaims = this.evalToken.verify(token);
    if (evalClaims) return this.evalPrincipalOf(evalClaims);
    const publicAgent = this.auth.getPublicAgentByToken(token);
    if (publicAgent) return { user: publicAgent };
    // 工位 .agents/.env 的 LITA_WORK_TOKEN 是机器人令牌：
    // 统一按 Bearer / X-Agent-Token 传入时同样识别为机器人身份
    const worker = await this.workers.findByAgentToken(token);
    if (worker) return this.principalOf(worker);
    throw new UnauthorizedException(
      '无效的机器人访问令牌（可在平台个人中心重置后更新 MCP 配置）',
    );
  }

  /** 评估令牌 → 机器人身份 + 评估上下文（9.3；评估令牌下授予受限权限） */
  private async evalPrincipalOf(
    claims: Awaited<ReturnType<EvalTokenService['verify']>>,
  ): Promise<McpWorkPrincipal> {
    if (!claims) throw new UnauthorizedException('无效的评估令牌');
    const worker = await this.workers
      .findOne(claims.workerId)
      .catch(() => null);
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
      const user = await this.auth.getUserById(worker.humanUserId);
      if (user) principal.user = user;
    }
    return principal;
  }

  /** 机器人身份；绑定真人时同时挂载用户，保持真人操作语义 */
  private async principalOf(worker: Worker): Promise<McpWorkPrincipal> {
    if (!worker.humanUserId) return { worker };
    const user = await this.auth.getUserById(worker.humanUserId);
    return user ? { worker, user } : { worker };
  }

  /**
   * 执行记录（12.4）：解析 JSON-RPC tools/call，采集平台调用（工具名/参数/返回/耗时/状态）。
   * 响应为 SSE 流，这里透传写入并顺手截取（≤128KB）用于记录。
   */
  private beginTrace(
    principal: McpWorkPrincipal,
    res: Response,
    body: unknown,
  ): (() => void) | null {
    const worker = principal.worker;
    if (!worker) return null;
    const calls = extractToolCalls(body);
    if (calls.length === 0) return null;
    const startedAt = Date.now();
    const chunks: string[] = [];
    let captured = 0;
    const originalWrite = (
      typeof res.write === 'function' ? res.write.bind(res) : () => true
    ) as (chunk: unknown, ...args: unknown[]) => boolean;
    res.write = ((chunk: unknown, ...args: unknown[]) => {
      try {
        if (chunk && captured < 128 * 1024) {
          const text =
            typeof chunk === 'string'
              ? chunk
              : Buffer.isBuffer(chunk)
                ? chunk.toString('utf8')
                : '';
          if (text) {
            chunks.push(text);
            captured += text.length;
          }
        }
      } catch {
        /* 忽略捕获失败 */
      }
      return originalWrite(chunk, ...args);
    }) as typeof res.write;

    return () => {
      const responses = parseSseResponses(chunks.join(''));
      for (const call of calls) {
        const response = responses.get(call.id);
        const status = response?.error || response?.isError ? 'error' : 'ok';
        const text = response?.text ?? response?.error ?? '';
        void this.trace
          .recordPlatformCall({
            workerId: worker.id,
            channel: 'mcp',
            tool: call.name,
            args: call.args,
            status,
            content: text,
            durationMs: Date.now() - startedAt,
            evalItemId: principal.evalContext?.evalItemId ?? null,
            evalTaskId: principal.evalContext?.taskId ?? null,
            taskId:
              numberField(call.args, 'taskId') ??
              numberField(call.args, 'parentTaskId'),
          })
          .catch(() => {});
      }
    };
  }
}

/** 从 JSON-RPC 请求体中提取 tools/call（支持批量） */
function extractToolCalls(body: unknown): Array<{
  id: string | number | null;
  name: string;
  args: Record<string, unknown>;
}> {
  const messages = Array.isArray(body) ? body : [body];
  const calls: Array<{
    id: string | number | null;
    name: string;
    args: Record<string, unknown>;
  }> = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const row = message as {
      id?: string | number | null;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    if (row.method !== 'tools/call' || !row.params?.name) continue;
    calls.push({
      id: row.id ?? null,
      name: row.params.name,
      args: row.params.arguments ?? {},
    });
  }
  return calls;
}

/** 解析 SSE 响应中 JSON-RPC result（按 id 归并文本/错误） */
function parseSseResponses(
  raw: string,
): Map<
  string | number | null,
  { text: string; error?: string; isError?: boolean }
> {
  const map = new Map<
    string | number | null,
    { text: string; error?: string; isError?: boolean }
  >();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const jsonText = trimmed.slice(5).trim();
    if (!jsonText) continue;
    try {
      const payload = JSON.parse(jsonText) as {
        id?: string | number | null;
        result?: {
          isError?: boolean;
          content?: Array<{ type?: string; text?: string }>;
        };
        error?: { message?: string };
      };
      if (payload.error) {
        map.set(payload.id ?? null, {
          text: '',
          error: payload.error.message ?? '调用失败',
          isError: true,
        });
        continue;
      }
      const text = (payload.result?.content ?? [])
        .filter((item) => item.type === 'text' && item.text)
        .map((item) => item.text!)
        .join('\n');
      map.set(payload.id ?? null, {
        text,
        isError: payload.result?.isError === true,
        ...(payload.result?.isError ? { error: text } : {}),
      });
    } catch {
      /* 忽略非 JSON 行 */
    }
  }
  return map;
}

/** 数字字段读取 */
function numberField(
  args: Record<string, unknown>,
  key: string,
): number | null {
  const value = args[key];
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}
