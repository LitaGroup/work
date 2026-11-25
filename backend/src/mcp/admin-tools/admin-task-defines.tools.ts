import { Injectable, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TaskCollaborationService } from '../../tasks/task-collaboration.service';
import { executeTool, markdownResult } from '../work-tools/work-tools.util';
import type {
  McpWorkPrincipal,
  WorkToolRegistrar,
} from '../work-tools/work-tools.types';

/**
 * 任务定义清单（管理面）：从 lita-work 迁入。
 * 只读清单归 lita-work-admin，基础任务工具所需的 templateId 由需求方提供。
 */
@Injectable()
export class AdminTaskDefinesTools implements WorkToolRegistrar {
  private readonly logger = new Logger(AdminTaskDefinesTools.name);

  constructor(private readonly collaboration: TaskCollaborationService) {}

  register(server: McpServer, principal: McpWorkPrincipal): void {
    server.registerTool(
      'list_task_defines',
      {
        title: '任务定义清单',
        description:
          '查询当前支持分发的任务定义（名称、说明与可用机器人），创建任务/子任务前用于确认 templateId。',
        inputSchema: {},
      },
      async () =>
        executeTool(this.logger, 'list_task_defines', principal, async () =>
          markdownResult(await this.collaboration.definesMarkdown()),
        ),
    );
  }
}
