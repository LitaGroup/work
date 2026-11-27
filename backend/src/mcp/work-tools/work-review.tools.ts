import { Injectable, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WorkerReviewsService } from '../../knowledge/worker-reviews.service';
import {
  executeTool,
  markdownResult,
  requireWorkerPrincipal,
} from './work-tools.util';
import type { McpWorkPrincipal, WorkToolRegistrar } from './work-tools.types';

/**
 * 机器人个人会话复盘（lita-work）：
 * 机器人只能查询、上传和修改自己的复盘，目标工作区由当前机器人令牌确定，
 * 不接受调用方传入机器人 ID 或知识路径。
 */
@Injectable()
export class WorkReviewTools implements WorkToolRegistrar {
  private readonly logger = new Logger(WorkReviewTools.name);

  constructor(private readonly reviews: WorkerReviewsService) {}

  register(server: McpServer, principal: McpWorkPrincipal): void {
    server.registerTool(
      'list_my_reviews',
      {
        title: '查询我的复盘',
        description:
          '分页查询自己（当前机器人）的会话复盘清单，按创建时间倒序；只返回标题与时间，全文用 read_my_review。',
        inputSchema: {
          page: z.number().int().min(1).optional().describe('页码，从 1 开始'),
          pageSize: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('每页条数 1..100，默认 20'),
          from: z
            .string()
            .optional()
            .describe('创建时间下界（ISO 8601，含边界）'),
          to: z
            .string()
            .optional()
            .describe('创建时间上界（ISO 8601，不含边界）'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'list_my_reviews', principal, async () => {
          const worker = requireWorkerPrincipal(principal);
          const result = await this.reviews.list(worker.id, {
            page: args.page,
            pageSize: args.pageSize,
            from: args.from,
            to: args.to,
          });
          return markdownResult(
            this.reviews.renderListMarkdown(result, {
              scope: 'mine',
              readTool: 'read_my_review',
            }),
          );
        }),
    );

    server.registerTool(
      'read_my_review',
      {
        title: '读取我的复盘',
        description:
          '读取自己（当前机器人）的一篇会话复盘全文；name 为清单中的 14 位北京时间时间戳。',
        inputSchema: {
          name: z
            .string()
            .min(1)
            .describe('复盘名称：yyyyMMddHHmmss（不含 .md）'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'read_my_review', principal, async () => {
          const worker = requireWorkerPrincipal(principal);
          return markdownResult(
            this.reviews.renderDetailMarkdown(
              await this.reviews.read(worker.id, args.name),
            ),
          );
        }),
    );

    server.registerTool(
      'create_my_review',
      {
        title: '上传我的复盘',
        description:
          '把自己对个人会话的总结复盘保存到机器人工作区 reviews 目录。平台生成创建时间与知识路径，不覆盖已有复盘；不要写入令牌或其它敏感信息。',
        inputSchema: {
          title: z.string().optional().describe('复盘标题，缺省按时间生成'),
          content: z
            .string()
            .min(1)
            .describe(
              '整理后的 Markdown 复盘正文（问题、原因、做法与可复用经验）',
            ),
        },
      },
      async (args) =>
        executeTool(this.logger, 'create_my_review', principal, async () => {
          const worker = requireWorkerPrincipal(principal);
          return markdownResult(
            this.reviews.renderCreatedMarkdown(
              await this.reviews.create(worker.id, {
                title: args.title,
                content: args.content,
              }),
            ),
          );
        }),
    );

    server.registerTool(
      'update_my_review',
      {
        title: '修改我的复盘',
        description:
          '修改自己（当前机器人）已有复盘的标题或正文；不能移动、重命名、改归属或删除。',
        inputSchema: {
          name: z
            .string()
            .min(1)
            .describe('复盘名称：yyyyMMddHHmmss（不含 .md）'),
          title: z.string().optional().describe('新标题'),
          content: z.string().optional().describe('新的完整 Markdown 正文'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'update_my_review', principal, async () => {
          const worker = requireWorkerPrincipal(principal);
          return markdownResult(
            this.reviews.renderUpdatedMarkdown(
              await this.reviews.update(worker.id, args.name, {
                title: args.title,
                content: args.content,
              }),
            ),
          );
        }),
    );
  }
}
