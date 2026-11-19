import { Injectable, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  MANUAL_BACKLOG_MEMBER_ROLES,
  BacklogStatus,
  UserRole,
} from '../../common/enums';
import type { BacklogMemberRole } from '../../common/enums';
import { BacklogsService } from '../../iterations/backlogs.service';
import type { IterationActor } from '../../iterations/iteration.types';
import { IterationsService } from '../../iterations/iterations.service';
import { executeTool, markdownResult } from './work-tools.util';
import type { McpWorkPrincipal, WorkToolRegistrar } from './work-tools.types';

const BacklogMemberRoleArg = z
  .enum(
    MANUAL_BACKLOG_MEMBER_ROLES as [BacklogMemberRole, ...BacklogMemberRole[]],
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
    private readonly iterations: IterationsService,
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
      'get_iteration',
      {
        title: '迭代详情',
        description:
          '读取迭代详情：标识、类型、状态、描述、起止日期、平台链接与迭代项清单（含交付任务）。',
        inputSchema: {
          iterationId: z.number().int().positive().describe('迭代 ID'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'get_iteration', principal, async () =>
          markdownResult(
            await this.iterations.findOneMarkdown(args.iterationId),
          ),
        ),
    );

    server.registerTool(
      'update_backlog_members',
      {
        title: '更新迭代项成员',
        description:
          '仅管理员或该迭代项负责人机器人：整体替换迭代项成员（role + 机器人：workerId 直接选机器人，或 userId/name 选真人自动映射其真人机器人）。传空数组清空手动成员（负责人/需求方自动维持）。成员角色仅产品/业务/项目/前端/后端/测试/客户端。',
        inputSchema: {
          backlogId: z.number().int().positive().describe('迭代项 ID'),
          members: z
            .array(
              z.object({
                role: BacklogMemberRoleArg,
                workerId: z
                  .number()
                  .int()
                  .positive()
                  .optional()
                  .describe('机器人 ID（workers.id，AI 或真人机器人）'),
                userId: z
                  .number()
                  .int()
                  .positive()
                  .optional()
                  .describe(
                    '平台用户 ID（真人，映射其为真人机器人；与 workerId/name 三选一）',
                  ),
                name: z
                  .string()
                  .min(1)
                  .optional()
                  .describe('平台用户姓名（真人；多个顿号连接可一次添加多人）'),
              }),
            )
            .describe('成员列表（整体替换手动成员；空数组清空）'),
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
          '迭代项「任务」分区新建任务：已有交付任务时创建其子任务（成员或管理员；任务描述自动附带系统上下文：任务树/迭代/相关工单/交付文档）；无交付任务时按所选执行机器人创建交付任务并登记负责人（仅管理员）。返回新建任务 ID 与迭代项详情。',
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
      'create_backlog_release',
      {
        title: '发起迭代项批量提测',
        description:
          '批量提测：每个迭代项按系统「提测工单」工作流创建工单并生成提测记录（互相绑定），多个迭代项汇总为一条提测群消息（平台官方机器人）。提测端至少 1 个（APP / H5 / 后端），测试人员至少 1 人且须为用户系统内用户；仅所选迭代项成员或管理员。',
        inputSchema: {
          items: z
            .array(
              z.object({
                backlogId: z.number().int().positive().describe('迭代项 ID'),
                content: z
                  .string()
                  .optional()
                  .describe('该迭代项的提测内容（Markdown）'),
              }),
            )
            .min(1)
            .describe('提测的迭代项（可跨迭代，至少 1 个）'),
          title: z
            .string()
            .optional()
            .describe(
              '提测标题（多个迭代项缺省「{首个迭代项标题} 等x个迭代」）',
            ),
          ends: z
            .array(z.enum(['APP', 'H5', '后端']))
            .min(1)
            .describe('提测端（至少 1 个）'),
          testers: z
            .array(z.string())
            .min(1)
            .describe('测试人员姓名（须为用户系统内用户）'),
          branches: z
            .array(z.object({ repo: z.string(), branch: z.string() }))
            .optional()
            .describe('代码分支（整单共用，可空）'),
          urls: z
            .array(z.string())
            .optional()
            .describe('访问地址（整单共用，可空）'),
          inputValues: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              '提测工单配置（release-ticket）动态字段值：除保留 key（title/description/content/testEnds/testers/branch/url/backlogs）外的起始字段原样透传',
            ),
          taskId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('来源任务（机器人可选，缺省取当前执行中的任务）'),
        },
      },
      async (args) =>
        executeTool(
          this.logger,
          'create_backlog_release',
          principal,
          async () => {
            const markdown = await this.backlogs.submitReleaseMarkdown(
              {
                items: args.items,
                title: args.title,
                ends: args.ends,
                testers: args.testers,
                branches: args.branches,
                urls: args.urls,
                inputValues: args.inputValues,
                taskId: args.taskId,
              },
              iterationActorOf(principal),
              { user: principal.user, worker: principal.worker },
            );
            return markdownResult(markdown);
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
