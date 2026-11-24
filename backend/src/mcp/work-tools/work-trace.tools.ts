import { Injectable, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  requireUserPrincipal,
  executeTool,
  markdownResult,
} from './work-tools.util';
import type { McpWorkPrincipal, WorkToolRegistrar } from './work-tools.types';
import { TraceService } from '../../trace/trace.service';
import { WorkerOwnerService } from '../../trace/worker-owner.service';
import { WorkersService } from '../../workers/workers.service';

/**
 * 执行记录读取工具（12.7，第一期只提供管理员/所有者路径；优化机器人第二期）：
 * - list_task_traces / read_task_trace / get_trace_stats；
 * - 权限（12.8）：仅登录用户身份（执行机器人自身、评估令牌不可读）；所有者=绑定真人的上级；
 * - 每次读取写访问日志。
 */
@Injectable()
export class WorkTraceTools implements WorkToolRegistrar {
  private readonly logger = new Logger(WorkTraceTools.name);

  constructor(
    private readonly trace: TraceService,
    private readonly owners: WorkerOwnerService,
    private readonly workers: WorkersService,
  ) {}

  register(server: McpServer, principal: McpWorkPrincipal): void {
    server.registerTool(
      'list_task_traces',
      {
        title: '执行记录列表',
        description:
          '按机器人/任务/结果筛选执行记录摘要（管理员或被查看机器人的所有者；执行机器人自身不可读）。',
        inputSchema: {
          workerId: z.number().int().positive().describe('机器人 ID'),
          from: z.string().optional().describe('开始时间（ISO 8601）'),
          to: z.string().optional().describe('结束时间（ISO 8601）'),
          outcome: z.array(z.string()).optional().describe('任务结果筛选'),
          isEval: z.boolean().optional().describe('仅评估任务/真实任务'),
          taskId: z.number().int().positive().optional().describe('指定任务'),
          page: z.number().int().positive().optional().describe('页码'),
          pageSize: z
            .number()
            .int()
            .positive()
            .max(100)
            .optional()
            .describe('每页条数'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'list_task_traces', principal, async () => {
          const user = requireUserPrincipal(principal);
          const worker = await this.workers.findOne(args.workerId);
          await this.owners.assertCanManageWorker(user, worker);
          const result = await this.trace.list({
            workerId: args.workerId,
            from: args.from ? new Date(args.from) : undefined,
            to: args.to ? new Date(args.to) : undefined,
            outcome: args.outcome,
            isEval: args.isEval,
            taskId: args.taskId,
            page: args.page,
            pageSize: args.pageSize,
          });
          for (const row of result.rows) {
            await this.trace.logAccess({
              traceId: row.id,
              readerName: user.name,
              readerKind: 'user',
              readerId: user.id,
              action: 'list',
            });
          }
          return markdownResult(
            [
              `# 执行记录（机器人 #${args.workerId}，共 ${result.total} 条）`,
              '',
              '| Trace | 任务 | 评估 | 结果 | 轮数 | 调用 | 报错 | 开始时间 |',
              '| --- | --- | --- | --- | --- | --- | --- | --- |',
              ...result.rows.map(
                (r) =>
                  `| ${r.id} | ${r.taskId ?? '-'} | ${r.isEval ? '是' : '否'} | ${
                    r.outcome ?? '-'
                  } | ${r.turnCount} | ${r.callCount} | ${r.callErrorCount} | ${r.startedAt.toISOString()} |`,
              ),
            ].join('\n'),
          );
        }),
    );

    server.registerTool(
      'read_task_trace',
      {
        title: '读取执行记录',
        description:
          '分页读取执行记录步骤（按轮/类型过滤）；内容已截断与脱敏。',
        inputSchema: {
          traceId: z.string().min(1).describe('执行记录 ID'),
          fromSeq: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('从第几步开始'),
          limit: z
            .number()
            .int()
            .positive()
            .max(200)
            .optional()
            .describe('单页条数（默认 100）'),
          types: z.array(z.string()).optional().describe('步骤类型筛选'),
          turn: z.number().int().positive().optional().describe('只看某一轮'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'read_task_trace', principal, async () => {
          const user = requireUserPrincipal(principal);
          const trace = await this.trace.findById(args.traceId);
          if (!trace) return markdownResult('执行记录不存在');
          const worker = await this.workers.findOne(trace.workerId);
          await this.owners.assertCanManageWorker(user, worker);
          const result = await this.trace.readSteps(args.traceId, {
            fromSeq: args.fromSeq,
            limit: args.limit,
            types: args.types,
            turn: args.turn,
          });
          await this.trace.logAccess({
            traceId: args.traceId,
            readerName: user.name,
            readerKind: 'user',
            readerId: user.id,
            action: 'read',
          });
          const lines = [
            `# 执行记录 ${args.traceId}`,
            '',
            `状态：${trace.status}｜轮数：${trace.turnCount}｜调用：${trace.callCount}｜报错：${trace.callErrorCount}｜被拦截：${trace.blockedCount}｜已脱敏：${trace.redactionCount} 处`,
            '',
          ];
          for (const step of result.steps) {
            lines.push(stepLine(step));
          }
          if (result.nextSeq) {
            lines.push(
              '',
              `> 还有更多：从 fromSeq=${result.nextSeq} 继续读取。`,
            );
          }
          return markdownResult(lines.join('\n'));
        }),
    );

    server.registerTool(
      'get_trace_stats',
      {
        title: '执行记录统计',
        description:
          '机器人维度聚合统计（平均轮数/调用/报错、被拦截、脱敏等）。',
        inputSchema: {
          workerId: z.number().int().positive().describe('机器人 ID'),
          from: z.string().optional().describe('开始时间（ISO 8601）'),
          to: z.string().optional().describe('结束时间（ISO 8601）'),
          isEval: z.boolean().optional().describe('仅评估任务/真实任务'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'get_trace_stats', principal, async () => {
          const user = requireUserPrincipal(principal);
          const worker = await this.workers.findOne(args.workerId);
          await this.owners.assertCanManageWorker(user, worker);
          const stats = await this.trace.stats({
            workerId: args.workerId,
            from: args.from ? new Date(args.from) : undefined,
            to: args.to ? new Date(args.to) : undefined,
            isEval: args.isEval,
          });
          await this.trace.logAccess({
            traceId: '*',
            readerName: user.name,
            readerKind: 'user',
            readerId: user.id,
            action: 'stats',
          });
          return markdownResult(
            `# 执行记录统计（机器人 #${args.workerId}）\n\n\`\`\`json\n${JSON.stringify(
              stats,
              null,
              2,
            )}\n\`\`\``,
          );
        }),
    );
  }
}

/** 单步渲染（Markdown） */
function stepLine(step: Record<string, unknown>): string {
  const type = asText(step.type);
  const at = asText(step.at);
  const turnValue = step.turn;
  const turn = typeof turnValue === 'number' ? `[第${turnValue}轮]` : '';
  if (type === 'platform_call') {
    return `- ${at} ${turn} 调用 \`${asText(step.tool)}\`（${asText(step.channel)}）→ ${asText(step.status)} ${asText(step.durationMs)}ms：${asText(step.args).slice(0, 300)} ⇒ ${asText(step.content).slice(0, 300)}`;
  }
  if (type === 'message_in') {
    return `- ${at} ${turn} 平台消息：${asText(step.text).slice(0, 400)}`;
  }
  if (type === 'task_event') {
    return `- ${at} ${turn} 任务事件：${asText(step.event)} ${asText(step.detail).slice(0, 300)}`;
  }
  return `- ${at} ${turn} ${type}：${asText(step).slice(0, 400)}`;
}

/** 值转文本（对象走 JSON，避免 [object Object]） */
function asText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
