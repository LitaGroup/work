import { Injectable, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BacklogMemberRole, UserRole } from '../../common/enums';
import { BacklogsService } from '../../iterations/backlogs.service';
import type { IterationActor } from '../../iterations/iteration.types';
import { executeTool, markdownResult } from './work-tools.util';
import type { McpWorkPrincipal, WorkToolRegistrar } from './work-tools.types';

const BacklogMemberRoleArg = z
  .enum(
    Object.values(BacklogMemberRole) as [
      BacklogMemberRole,
      ...BacklogMemberRole[],
    ],
  )
  .describe('成员角色：产品/业务/项目/前端/后端/测试/客户端');

/**
 * 迭代项（Backlog）成员：管理员或该迭代项负责人机器人可整体替换成员。
 * 成员以「角色 + 平台用户」维护，userId 与 name 二选一（name 支持多人顿号连接）。
 */
@Injectable()
export class WorkIterationTools implements WorkToolRegistrar {
  private readonly logger = new Logger(WorkIterationTools.name);

  constructor(private readonly backlogs: BacklogsService) {}

  register(server: McpServer, principal: McpWorkPrincipal): void {
    server.registerTool(
      'update_backlog_members',
      {
        title: '更新迭代项成员',
        description:
          '仅管理员或该迭代项负责人机器人：整体替换迭代项成员（role + userId 或 name，name 支持顿号连接多人）。传空数组清空成员。成员须在用户系统内存在（按姓名解析时要求启用）。',
        inputSchema: {
          backlogId: z.number().int().positive().describe('迭代项 ID'),
          members: z
            .array(
              z.object({
                role: BacklogMemberRoleArg,
                userId: z
                  .number()
                  .int()
                  .positive()
                  .optional()
                  .describe('平台用户 ID（与 name 二选一）'),
                name: z
                  .string()
                  .min(1)
                  .optional()
                  .describe('平台用户姓名（多个顿号连接可一次添加多人）'),
              }),
            )
            .describe('成员列表（整体替换；空数组清空）'),
        },
      },
      async (args) =>
        executeTool(
          this.logger,
          'update_backlog_members',
          principal,
          async () => {
            const backlog = await this.backlogs.updateMembers(
              args.backlogId,
              args.members,
              iterationActorOf(principal),
            );
            return markdownResult(
              await this.backlogs.findOneMarkdown(backlog.id),
            );
          },
        ),
    );
  }
}

/** MCP 身份 → 迭代操作人：真人机器人落到绑定真人，未绑定真人时记机器人名称 */
function iterationActorOf(principal: McpWorkPrincipal): IterationActor {
  return {
    userId: principal.user?.id ?? null,
    userName: principal.user?.name || principal.worker?.name || '公共 Agent',
    isAdmin: principal.user?.role === UserRole.ADMIN,
    workerId: principal.worker?.id ?? null,
  };
}
