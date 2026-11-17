import { Injectable, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { beijingTime } from '../../common/frontmatter';
import {
  type WakeupScheduleResult,
  WakeupsService,
} from '../../wakeups/wakeups.service';
import {
  executeTool,
  markdownResult,
  requireUserPrincipal,
  requireWorkerPrincipal,
} from './work-tools.util';
import type { McpWorkPrincipal, WorkToolRegistrar } from './work-tools.types';

/** 相对时长与绝对时间二选一（服务层做完整校验） */
const WakeTimeArg = {
  delayMinutes: z
    .number()
    .positive()
    .optional()
    .describe(
      '相对当前时间的延迟（分钟）：0.5 ~ 43200（30 秒 ~ 30 天）；与 wakeAt 二选一',
    ),
  wakeAt: z
    .string()
    .min(1)
    .optional()
    .describe(
      '绝对时间（ISO 8601，如 2026-11-18T09:00:00+08:00；不带时区按北京时间）：须在未来 30 天以内；与 delayMinutes 二选一',
    ),
};

const NoteArg = z
  .string()
  .max(2000)
  .optional()
  .describe('唤醒备注：到期时随唤醒消息回传，说明届时需要跟进的事项');

const AgentTargetArg = {
  taskId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      '任务独立会话：唤醒「我的 AI」中该任务的会话（与页面上下文二选一）',
    ),
  pageType: z
    .enum(['document', 'script', 'project', 'idea', 'backlog', 'topic'])
    .optional()
    .describe('详情页会话类型（与 pageId 成对使用，优先于 taskId）'),
  pageId: z
    .string()
    .min(1)
    .optional()
    .describe('详情页上下文 ID（如任务 ID、文档 ID、迭代项 ID）'),
};

/** 定时唤醒已设置的结果说明 */
function scheduleMarkdown(
  title: string,
  target: string,
  result: WakeupScheduleResult,
): string {
  const { wakeup, replaced, delayMinutes } = result;
  return [
    `# ${title}`,
    '',
    `- 目标：${target}`,
    `- 触发时间：${beijingTime(wakeup.wakeAt)}（北京时间）`,
    `- 距现在：约 ${delayMinutes} 分钟`,
    `- 唤醒备注：${wakeup.note ?? '（未填写）'}`,
    `- 是否覆盖旧的唤醒：${replaced ? '是' : '否'}`,
    '',
    '到期后平台会自动唤醒你继续跟进，唤醒消息会带上备注与当前状态。',
    '设置完成后请结束本轮，不要用轮询占用执行容量；',
    '如仍需等待，可在唤醒后再次设置；无需继续时不要再设置唤醒。',
  ].join('\n');
}

/** 取消结果说明 */
function cancelMarkdown(title: string, target: string, count: number): string {
  return [
    `# ${title}`,
    '',
    `- 目标：${target}`,
    `- 取消数量：${count}`,
    '',
    count > 0 ? '已取消待触发的定时唤醒。' : '没有待触发的定时唤醒。',
  ].join('\n');
}

/**
 * 机器人定时唤醒（MCP 二期）：
 * - 任务会话：等待人工确认/答复、等待工单或脚本结果时设置回访提醒；
 * - 「我的 AI」会话：个人 AGENT 给自己设置跟进提醒。
 * 每个目标只保留一条待触发唤醒，新设置覆盖旧的。
 */
@Injectable()
export class WorkWakeupTools implements WorkToolRegistrar {
  private readonly logger = new Logger(WorkWakeupTools.name);

  constructor(private readonly wakeups: WakeupsService) {}

  register(server: McpServer, principal: McpWorkPrincipal): void {
    server.registerTool(
      'schedule_task_wakeup',
      {
        title: '设置任务定时唤醒',
        description:
          '为当前任务设置定时唤醒（仅任务当前执行机器人）：到点后平台自动唤醒本任务会话继续跟进。' +
          '用于长任务等待人工确认/答复、等待工单审批或脚本运行结果等场景；' +
          '每个任务只保留一条待触发唤醒，新设置会覆盖旧的。设置后请结束本轮，不要轮询占用执行容量。',
        inputSchema: {
          taskId: z.number().int().positive().describe('任务 ID'),
          ...WakeTimeArg,
          note: NoteArg,
        },
      },
      async (args) =>
        executeTool(
          this.logger,
          'schedule_task_wakeup',
          principal,
          async () => {
            const worker = requireWorkerPrincipal(principal);
            const task = await this.wakeups.findTask(args.taskId);
            const result = await this.wakeups.scheduleTask(worker, args);
            return markdownResult(
              scheduleMarkdown(
                '任务定时唤醒已设置',
                `${task.code}「${task.title}」（ID=${task.id}）`,
                result,
              ),
            );
          },
        ),
    );

    server.registerTool(
      'cancel_task_wakeup',
      {
        title: '取消任务定时唤醒',
        description:
          '取消当前任务待触发的定时唤醒（仅任务当前执行机器人）。任务已结束时无需取消。',
        inputSchema: {
          taskId: z.number().int().positive().describe('任务 ID'),
        },
      },
      async (args) =>
        executeTool(this.logger, 'cancel_task_wakeup', principal, async () => {
          const worker = requireWorkerPrincipal(principal);
          const task = await this.wakeups.findTask(args.taskId);
          const count = await this.wakeups.cancelTask(worker, args.taskId);
          return markdownResult(
            cancelMarkdown(
              '任务定时唤醒已取消',
              `${task.code}「${task.title}」（ID=${task.id}）`,
              count,
            ),
          );
        }),
    );

    server.registerTool(
      'schedule_agent_wakeup',
      {
        title: '设置我的 AI 会话唤醒',
        description:
          '为当前用户的个人 AGENT「我的 AI」会话设置定时唤醒：到点后平台在该会话发送唤醒消息继续跟进。' +
          '会话范围：taskId=任务独立会话，pageType+pageId=详情页会话，都不传=通用会话；' +
          '每个会话范围只保留一条待触发唤醒，新设置会覆盖旧的。设置后请结束本轮。',
        inputSchema: {
          ...WakeTimeArg,
          note: NoteArg,
          ...AgentTargetArg,
        },
      },
      async (args) =>
        executeTool(
          this.logger,
          'schedule_agent_wakeup',
          principal,
          async () => {
            const user = requireUserPrincipal(principal);
            const result = await this.wakeups.scheduleAgent(user, args);
            return markdownResult(
              scheduleMarkdown(
                '我的 AI 定时唤醒已设置',
                `我的 AI 会话（${result.wakeup.scope}）`,
                result,
              ),
            );
          },
        ),
    );

    server.registerTool(
      'cancel_agent_wakeup',
      {
        title: '取消我的 AI 会话唤醒',
        description:
          '取消「我的 AI」会话待触发的定时唤醒。会话范围参数需与设置时一致（都不传表示通用会话）。',
        inputSchema: { ...AgentTargetArg },
      },
      async (args) =>
        executeTool(this.logger, 'cancel_agent_wakeup', principal, async () => {
          const user = requireUserPrincipal(principal);
          const count = await this.wakeups.cancelAgent(user, args);
          return markdownResult(
            cancelMarkdown('我的 AI 定时唤醒已取消', '我的 AI 会话', count),
          );
        }),
    );
  }
}
