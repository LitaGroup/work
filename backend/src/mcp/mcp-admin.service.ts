import { Injectable, Logger } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { handleStatelessMcpRequest } from './mcp-http';
import { AdminEvalTools } from './admin-tools/admin-eval.tools';
import { AdminRunTools } from './admin-tools/admin-run.tools';
import { AdminTaskDefinesTools } from './admin-tools/admin-task-defines.tools';
import { WorkAgentTools } from './work-tools/work-agent.tools';
import { WorkTraceTools } from './work-tools/work-trace.tools';
import { identityLabelOf } from './work-tools/work-tools.types';
import type {
  McpWorkPrincipal,
  WorkToolRegistrar,
} from './work-tools/work-tools.types';

/**
 * lita-work-admin MCP 开放：管理面工具（机器人 / 任务定义 / 测试集与评估 /
 * 执行记录 / 平台设置），与基础业务工具（lita-work）物理隔离。
 * - 鉴权：仅管理员（公共 Agent 或管理员绑定的真人机器人令牌），评估令牌拒绝；
 * - 与 lita-work 共用 stateless Streamable HTTP 传输与执行记录采集。
 */
@Injectable()
export class McpAdminService {
  private readonly logger = new Logger(McpAdminService.name);

  private readonly registrars: WorkToolRegistrar[];

  constructor(
    agentTools: WorkAgentTools,
    taskDefinesTools: AdminTaskDefinesTools,
    runTools: AdminRunTools,
    evalTools: AdminEvalTools,
    traceTools: WorkTraceTools,
  ) {
    this.registrars = [
      agentTools,
      taskDefinesTools,
      runTools,
      evalTools,
      traceTools,
    ];
  }

  /** 处理一次 MCP HTTP 请求（stateless：每请求独立 server/transport） */
  async handleRequest(
    principal: McpWorkPrincipal,
    req: import('express').Request,
    res: import('express').Response,
    body: unknown,
  ): Promise<void> {
    const server = new McpServer(
      { name: 'lita-work-admin', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    for (const registrar of this.registrars) {
      registrar.register(server, principal);
    }
    this.logger.debug(
      `MCP lita-work-admin 请求：${identityLabelOf(principal)}`,
    );
    await handleStatelessMcpRequest(server, req, res, body);
  }
}
