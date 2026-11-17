import { Injectable, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BacklogMemberRole, BacklogStatus, UserRole } from '../../common/enums';
import { BacklogsService } from '../../iterations/backlogs.service';
import type { IterationActor } from '../../iterations/iteration.types';
import { TicketsService } from '../../tickets/tickets.service';
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

const BacklogStatusArg = z
  .enum(Object.values(BacklogStatus) as [BacklogStatus, ...BacklogStatus[]])
  .describe('迭代项状态：等待/执行/测试/发布/完成/取消');

/**
 * 迭代项（Backlog）：读取详情、维护成员与属性、状态流转、移动迭代、
 * 新建任务与发起提测工单。写操作按网页同等规则校验身份
 * （成员 / 迭代项负责人 / 管理员），操作人取 MCP 调用方身份。
 */
@Injectable()
export class WorkIterationTools implements WorkToolRegistrar {
  private readonly logger = new Logger(WorkIterationTools.name);

  constructor(
    private readonly backlogs: BacklogsService,
    private readonly tickets: TicketsService,
  ) {}

  register(server: McpServer, principal: McpWorkPrincipal): void {
    server.registerTool(
      'get_backlog',
      {
        title: '迭代项详情',
        description:
          '读取迭代项详情：元信息（原始需求/所属迭代/状态/需求方/涉及方/备注/负责人/预期上线/交付任务）、成员、文档清单与最近事件。',
        inputSchema: {
          backlogId: z.number().int().positive().describe('迭代项 ID'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'get_backlog', principal, async () =>
          markdownResult(await this.backlogs.findOneMarkdown(args.backlogId)),
        ),
    );

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

    server.registerTool(
      'update_backlog',
      {
        title: '更新迭代项属性',
        description:
          '修改预期上线时间（ISO 时间字符串，到小时；传 null 或空串清空）与负责人（ownerWorkerId：管理员指定/改派，改派会取消旧交付任务并按新负责人重建）。预期上线时间成员或管理员可改。',
        inputSchema: {
          backlogId: z.number().int().positive().describe('迭代项 ID'),
          expectedOnlineAt: z
            .string()
            .nullable()
            .optional()
            .describe(
              '预期上线时间（ISO 字符串，如 2026-11-20T18:00:00+08:00；null/空串清空）',
            ),
          ownerWorkerId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('负责人机器人 ID（仅管理员，改派时重建交付任务）'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'update_backlog', principal, async () => {
          const backlog = await this.backlogs.updateBacklog(
            args.backlogId,
            {
              expectedOnlineAt: args.expectedOnlineAt,
              ownerWorkerId: args.ownerWorkerId,
            },
            iterationActorOf(principal),
          );
          return markdownResult(
            await this.backlogs.findOneMarkdown(backlog.id),
          );
        }),
    );

    server.registerTool(
      'change_backlog_status',
      {
        title: '推进迭代项状态',
        description:
          '迭代项状态流转（等待/执行/测试/发布/完成/取消），备注可空并写入事件流；仅成员或管理员。已结束（完成/取消）不可再变更；取消会联动取消未结束的交付任务。',
        inputSchema: {
          backlogId: z.number().int().positive().describe('迭代项 ID'),
          status: BacklogStatusArg,
          remark: z
            .string()
            .optional()
            .describe('推进备注（可空，写入迭代项事件流）'),
        },
      },
      async (args) =>
        executeTool(
          this.logger,
          'change_backlog_status',
          principal,
          async () => {
            const backlog = await this.backlogs.updateStatus(
              args.backlogId,
              args.status,
              iterationActorOf(principal),
              args.remark,
            );
            return markdownResult(
              await this.backlogs.findOneMarkdown(backlog.id),
            );
          },
        ),
    );

    server.registerTool(
      'move_backlog',
      {
        title: '移动迭代项',
        description:
          '把迭代项移动到另一个未结束的迭代（仅管理员），不重建交付任务与沟通群；目标迭代 ID 可从 `GET /api/iterations.md` 获取。已结束的迭代项不可移动。',
        inputSchema: {
          backlogId: z.number().int().positive().describe('迭代项 ID'),
          iterationId: z.number().int().positive().describe('目标迭代 ID'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'move_backlog', principal, async () => {
          const backlog = await this.backlogs.move(
            args.backlogId,
            args.iterationId,
            iterationActorOf(principal),
          );
          return markdownResult(
            await this.backlogs.findOneMarkdown(backlog.id),
          );
        }),
    );

    server.registerTool(
      'create_backlog_task',
      {
        title: '新建迭代项任务',
        description:
          '迭代项「任务」分区新建任务：已有交付任务时创建其子任务（成员或管理员）；无交付任务时按所选执行机器人创建交付任务并登记负责人（仅管理员）。返回新建任务 ID 与迭代项详情。',
        inputSchema: {
          backlogId: z.number().int().positive().describe('迭代项 ID'),
          title: z.string().optional().describe('任务标题'),
          description: z.string().optional().describe('任务描述（Markdown）'),
          templateId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              '任务定义 ID（可空；交付任务缺省用系统「迭代-Backlog交付」）',
            ),
          agentId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('执行机器人 ID（可空；无交付任务时作为负责人）'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'create_backlog_task', principal, async () => {
          const task = await this.backlogs.createTask(
            args.backlogId,
            {
              title: args.title,
              description: args.description ?? null,
              templateId: args.templateId ?? null,
              agentId: args.agentId ?? null,
            },
            iterationActorOf(principal),
          );
          const detail = await this.backlogs.findOneMarkdown(args.backlogId);
          return markdownResult(
            `已创建任务 #${task.id}（${task.code}）：${task.title}\n任务详情：\`GET /api/tasks/${task.id}.md\`\n\n${detail}`,
          );
        }),
    );

    server.registerTool(
      'create_backlog_release_ticket',
      {
        title: '发起迭代项提测',
        description:
          '按系统「提测工单」工作流创建提测工单，自动填入迭代项上下文，可补充说明；仅成员或管理员。返回工单详情 Markdown。',
        inputSchema: {
          backlogId: z.number().int().positive().describe('迭代项 ID'),
          title: z
            .string()
            .optional()
            .describe('工单标题（缺省自动生成「提测-{code} {标题}」）'),
          supplement: z
            .string()
            .optional()
            .describe('补充说明（Markdown，拼入工单描述）'),
        },
      },
      async (args) =>
        executeTool(
          this.logger,
          'create_backlog_release_ticket',
          principal,
          async () => {
            const ticket = await this.backlogs.createReleaseTicket(
              args.backlogId,
              { title: args.title, supplement: args.supplement },
              iterationActorOf(principal),
              { user: principal.user, worker: principal.worker },
            );
            return markdownResult(
              await this.tickets.ticketMarkdown(ticket.ticketId),
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
