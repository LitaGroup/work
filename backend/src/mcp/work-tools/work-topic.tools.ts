import { Injectable, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TopicPriority,
  TopicStatus,
  TopicSubjectType,
  UserRole,
  WorkerRuntime,
} from '../../common/enums';
import {
  TopicsService,
  type TopicActor,
  type UpdateTopicInput,
} from '../../topics/topics.service';
import { executeTool, markdownResult } from './work-tools.util';
import type { McpWorkPrincipal, WorkToolRegistrar } from './work-tools.types';

const SubjectTypeArg = z
  .enum(
    Object.values(TopicSubjectType) as [
      TopicSubjectType,
      ...TopicSubjectType[],
    ],
  )
  .describe('主体类型：迭代项/缺陷/任务/工单/需求');

const PriorityArg = z
  .enum(Object.values(TopicPriority) as [TopicPriority, ...TopicPriority[]])
  .describe('优先级：高/中/低');

const StatusArg = z
  .enum(Object.values(TopicStatus) as [TopicStatus, ...TopicStatus[]])
  .describe('状态：开放/已解决/已关闭');

/**
 * 话题（Topic）：挂在迭代项/缺陷/任务/工单/需求下的讨论串。
 * - 机器人可创建/回帖/查询；普通 AI 机器人以自身身份参与讨论；
 * - 个人 AGENT 与真人机器人落到绑定真人，避免把个人助手暴露为讨论参与者；
 * - 被 @ 的 AI 机器人收到答复会话后，用 reply_topic 回帖。
 */
@Injectable()
export class WorkTopicTools implements WorkToolRegistrar {
  private readonly logger = new Logger(WorkTopicTools.name);

  constructor(private readonly topics: TopicsService) {}

  register(server: McpServer, principal: McpWorkPrincipal): void {
    server.registerTool(
      'list_topics',
      {
        title: '话题清单',
        description:
          '按主体（迭代项/缺陷/任务/工单/需求）、状态、优先级、标签或关键词筛选话题，返回 Markdown 表格。',
        inputSchema: {
          subjectType: SubjectTypeArg.optional(),
          subjectId: z.number().int().positive().optional().describe('主体 ID'),
          status: StatusArg.optional(),
          priority: PriorityArg.optional(),
          tag: z.string().optional().describe('标签精确匹配'),
          q: z.string().optional().describe('关键词（标题/创建人，支持拼音）'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'list_topics', principal, async () =>
          markdownResult(await this.topics.listMarkdown(args)),
        ),
    );

    server.registerTool(
      'get_topic',
      {
        title: '话题详情',
        description:
          '读取话题元信息、首楼与全部帖子（含引用关系与 @ 机器人）。被 @ 时先读本工具再回帖。',
        inputSchema: {
          topicId: z.number().int().positive().describe('话题 ID'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'get_topic', principal, async () =>
          markdownResult(await this.topics.findOneMarkdown(args.topicId)),
        ),
    );

    server.registerTool(
      'create_topic',
      {
        title: '创建话题',
        description:
          '在主体下发起讨论。标题可省略（省略时用正文首行兜底并异步生成「TP-{id}」标题）；正文为 Markdown，图片需先上传得到 /images/... 地址。',
        inputSchema: {
          subjectType: SubjectTypeArg,
          subjectId: z.number().int().positive().describe('主体 ID'),
          content: z.string().min(1).describe('首楼正文（Markdown）'),
          title: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .describe('标题（可省略，由平台生成）'),
          priority: PriorityArg.optional(),
          tags: z
            .array(z.string())
            .max(10)
            .optional()
            .describe('标签（自由输入，最多 10 个）'),
          mentions: z
            .array(z.number().int().positive())
            .max(20)
            .optional()
            .describe('@ 的机器人 ID（workers.id）'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'create_topic', principal, async () => {
          const topic = await this.topics.create(args, topicActorOf(principal));
          return markdownResult(await this.topics.findOneMarkdown(topic.id));
        }),
    );

    server.registerTool(
      'reply_topic',
      {
        title: '话题回帖',
        description:
          '在话题下发帖；replyToPostId 引用同话题内的某条帖子（平铺楼层）。被 @ 的机器人应使用本工具答复。',
        inputSchema: {
          topicId: z.number().int().positive().describe('话题 ID'),
          content: z.string().min(1).describe('帖子正文（Markdown）'),
          replyToPostId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('引用的帖子 ID（同话题内）'),
          mentions: z
            .array(z.number().int().positive())
            .max(20)
            .optional()
            .describe('@ 的机器人 ID（workers.id）'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'reply_topic', principal, async () => {
          const post = await this.topics.createPost(
            args.topicId,
            {
              content: args.content,
              replyToPostId: args.replyToPostId ?? null,
              mentions: args.mentions,
            },
            topicActorOf(principal),
          );
          return markdownResult(
            `# 回帖成功\n\n- 帖子 ID：${post.id}\n- 话题：GET /api/topics/${args.topicId}.md\n`,
          );
        }),
    );

    server.registerTool(
      'update_topic',
      {
        title: '更新话题',
        description:
          '更新话题标题/首楼正文/优先级/标签/状态。仅创建人或管理员可改；已关闭的话题禁止新帖。',
        inputSchema: {
          topicId: z.number().int().positive().describe('话题 ID'),
          title: z.string().min(1).max(200).optional().describe('标题'),
          content: z
            .string()
            .min(1)
            .optional()
            .describe('首楼正文（Markdown）'),
          priority: PriorityArg.optional(),
          tags: z
            .array(z.string())
            .max(10)
            .optional()
            .describe('标签（全量覆盖）'),
          status: StatusArg.optional(),
        },
      },
      async (args) =>
        executeTool(this.logger, 'update_topic', principal, async () => {
          const input: UpdateTopicInput = {};
          if (args.title !== undefined) input.title = args.title;
          if (args.content !== undefined) input.content = args.content;
          if (args.priority !== undefined) input.priority = args.priority;
          if (args.tags !== undefined) input.tags = args.tags;
          if (args.status !== undefined) input.status = args.status;
          const topic = await this.topics.update(
            args.topicId,
            input,
            topicActorOf(principal),
          );
          return markdownResult(await this.topics.findOneMarkdown(topic.id));
        }),
    );
  }
}

/**
 * MCP 身份 → 话题操作人：
 * - 普通 AI 机器人以自身身份参与讨论；
 * - 真人机器人与个人 AGENT 落到绑定真人（避免个人助手出现在讨论参与者中）。
 */
function topicActorOf(principal: McpWorkPrincipal): TopicActor {
  const user = principal.user;
  const worker = principal.worker;
  if (
    worker &&
    !worker.personalAgentUserId &&
    worker.runtime !== WorkerRuntime.HUMAN
  ) {
    return {
      userId: null,
      workerId: worker.id,
      userName: worker.name,
      isAdmin: false,
    };
  }
  return {
    userId: user?.id ?? worker?.ownerUserId ?? null,
    workerId: null,
    userName: user?.name || worker?.name || '公共 Agent',
    isAdmin: user?.role === UserRole.ADMIN,
  };
}
