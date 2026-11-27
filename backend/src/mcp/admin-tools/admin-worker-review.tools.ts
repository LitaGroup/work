import { Injectable, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WorkerReviewsService } from '../../knowledge/worker-reviews.service';
import { executeTool, markdownResult } from '../work-tools/work-tools.util';
import type {
  McpWorkPrincipal,
  WorkToolRegistrar,
} from '../work-tools/work-tools.types';

/** 机器人会话复盘只读查询（lita-work-admin，仅管理员） */
@Injectable()
export class AdminWorkerReviewTools implements WorkToolRegistrar {
  private readonly logger = new Logger(AdminWorkerReviewTools.name);

  constructor(private readonly reviews: WorkerReviewsService) {}

  register(server: McpServer, principal: McpWorkPrincipal): void {
    server.registerTool(
      'list_worker_reviews',
      {
        title: '查询机器人复盘',
        description:
          '管理员分页查询指定机器人的会话复盘清单，按创建时间倒序；全文用 read_worker_review。',
        inputSchema: {
          workerId: z.number().int().positive().describe('机器人 ID'),
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
        executeTool(this.logger, 'list_worker_reviews', principal, async () => {
          const result = await this.reviews.list(args.workerId, {
            page: args.page,
            pageSize: args.pageSize,
            from: args.from,
            to: args.to,
          });
          return markdownResult(
            this.reviews.renderListMarkdown(result, {
              scope: 'admin',
              readTool: 'read_worker_review',
            }),
          );
        }),
    );

    server.registerTool(
      'read_worker_review',
      {
        title: '读取机器人复盘',
        description:
          '管理员读取指定机器人的一篇会话复盘全文；name 为清单中的 14 位北京时间时间戳。',
        inputSchema: {
          workerId: z.number().int().positive().describe('机器人 ID'),
          name: z
            .string()
            .min(1)
            .describe('复盘名称：yyyyMMddHHmmss（不含 .md）'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'read_worker_review', principal, async () =>
          markdownResult(
            this.reviews.renderDetailMarkdown(
              await this.reviews.read(args.workerId, args.name),
            ),
          ),
        ),
    );
  }
}
