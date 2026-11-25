import { Injectable, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  EvalItemResult,
  EvalRunStatus,
  EvalSuitePurpose,
  EvalSuiteStatus,
} from '../../common/enums';
import {
  type CaseInput,
  type EvalSuiteExport,
  EvalSuiteService,
} from '../../eval/eval-suite.service';
import { EvalEngineService } from '../../eval/eval-engine.service';
import type { EvalRun } from '../../eval/eval-run.entity';
import type { EvalRunItem } from '../../eval/eval-run-item.entity';
import { EvalProgressService } from '../../eval/eval-progress.service';
import { createProgressEmitter, type ProgressFn } from '../mcp-progress';
import {
  executeTool,
  jsonResult,
  markdownResult,
} from '../work-tools/work-tools.util';
import type {
  McpWorkPrincipal,
  WorkToolRegistrar,
} from '../work-tools/work-tools.types';

/** 评估运行等待终态默认上限：30 分钟（超时只结束等待，批次在平台继续） */
const EVAL_WAIT_DEFAULT_SECONDS = 1800;

/** 评估项终态（用于进度统计） */
const TERMINAL_ITEM_STATUSES = new Set([
  '已完成',
  '已拒绝',
  '超时',
  '异常',
  '已取消',
]);

const PurposeArg = z.enum(
  Object.values(EvalSuitePurpose) as [EvalSuitePurpose, ...EvalSuitePurpose[]],
);
const StatusArg = z.enum(
  Object.values(EvalSuiteStatus) as [EvalSuiteStatus, ...EvalSuiteStatus[]],
);

const PointArg = z.object({
  point: z.string().min(1).describe('要点内容'),
  required: z
    .boolean()
    .optional()
    .describe('是否必需（必需项完全命中才判通过）'),
  weight: z.number().optional().describe('权重 (0, 10]，默认 1'),
  hint: z.string().nullish().describe('返工提示（不能直接写出期望答案）'),
});

const McpPolicyArg = z.object({
  keep: z.array(z.string()).optional().describe('保留的自定义 MCP 服务名'),
  remove: z.array(z.string()).optional().describe('移除的自定义 MCP 服务名'),
});

const ImportPayloadArg = z.object({
  suite: z
    .object({
      name: z.string().optional(),
      description: z.string().nullish(),
      purpose: z.string().optional(),
      passThreshold: z.number().optional(),
      defaultTimeoutSec: z.number().optional(),
      maxQuestions: z.number().optional(),
    })
    .optional()
    .describe('测试集级配置（可选，缺省保持原值）'),
  cases: z
    .array(
      z.object({
        caseKey: z.string().describe('测试集内唯一，导入按它匹配'),
        seq: z.number().optional(),
        title: z.string().optional(),
        prompt: z.string().describe('用例输入（Markdown）'),
        clarify: z
          .string()
          .nullish()
          .describe('补充信息（被测方首次提问时答复）'),
        passThreshold: z.number().nullish(),
        timeoutSec: z.number().nullish(),
        points: z.array(PointArg).optional().describe('要点清单'),
      }),
    )
    .describe('用例列表'),
});

/**
 * 评估体系管理（lita-work-admin）：测试集 / 用例 / 批次 / 评估项。
 * 复用网页 `/api/eval` 相同的服务，权限由 admin 端点统一收敛为管理员。
 */
@Injectable()
export class AdminEvalTools implements WorkToolRegistrar {
  private readonly logger = new Logger(AdminEvalTools.name);

  constructor(
    private readonly suites: EvalSuiteService,
    private readonly engine: EvalEngineService,
    private readonly progress: EvalProgressService,
  ) {}

  register(server: McpServer, principal: McpWorkPrincipal): void {
    // ---- 测试集 ----

    server.registerTool(
      'list_eval_suites',
      {
        title: '测试集清单',
        description:
          '列出评估测试集（含用例数、启用用例数与版本），按创建时间倒序。',
        inputSchema: {},
      },
      () =>
        executeTool(this.logger, 'list_eval_suites', principal, async () =>
          jsonResult(await this.suites.list()),
        ),
    );

    server.registerTool(
      'get_eval_suite',
      {
        title: '测试集详情',
        description: '读取测试集配置、用例与要点清单。',
        inputSchema: {
          suiteId: z.number().int().positive().describe('测试集 ID'),
        },
      },
      (args) =>
        executeTool(this.logger, 'get_eval_suite', principal, async () =>
          jsonResult(await this.suites.detail(args.suiteId)),
        ),
    );

    server.registerTool(
      'create_eval_suite',
      {
        title: '创建测试集',
        description:
          '创建评估测试集（名称唯一）；阈值默认 80、用例超时默认 1800 秒、提问上限默认 3。',
        inputSchema: {
          name: z.string().min(1).describe('测试集名称（唯一）'),
          description: z.string().nullish().describe('说明'),
          purpose:
            PurposeArg.optional().describe('用途：训练 / 验证（默认验证）'),
          passThreshold: z
            .number()
            .optional()
            .describe('通过阈值 0-100（默认 80）'),
          defaultTimeoutSec: z
            .number()
            .optional()
            .describe('用例默认超时秒数（默认 1800）'),
          maxQuestions: z
            .number()
            .optional()
            .describe('每个评估项最多答复提问次数（默认 3）'),
          tags: z.array(z.string()).optional().describe('标签'),
        },
      },
      (args) =>
        executeTool(this.logger, 'create_eval_suite', principal, async () => {
          const suite = await this.suites.create({
            name: args.name,
            description: args.description,
            purpose: args.purpose,
            passThreshold: args.passThreshold,
            defaultTimeoutSec: args.defaultTimeoutSec,
            maxQuestions: args.maxQuestions,
            ownerId: principal.user?.id ?? null,
          });
          const saved =
            args.tags && args.tags.length > 0
              ? await this.suites.updateTags(suite.id, args.tags)
              : suite;
          return jsonResult(saved);
        }),
    );

    server.registerTool(
      'update_eval_suite',
      {
        title: '编辑测试集',
        description:
          '编辑测试集配置（未提交字段保持不变）；提交 tags 时整体替换标签；编辑递增版本号。',
        inputSchema: {
          suiteId: z.number().int().positive().describe('测试集 ID'),
          name: z.string().min(1).optional().describe('新名称'),
          description: z.string().nullish().describe('说明'),
          purpose: PurposeArg.optional().describe('用途'),
          passThreshold: z.number().optional().describe('通过阈值 0-100'),
          defaultTimeoutSec: z.number().optional().describe('用例默认超时秒数'),
          maxQuestions: z.number().optional().describe('提问上限'),
          status: StatusArg.optional().describe('状态：启用 / 归档'),
          tags: z.array(z.string()).optional().describe('标签（整体替换）'),
        },
      },
      (args) =>
        executeTool(this.logger, 'update_eval_suite', principal, async () => {
          const { suiteId, tags, ...patch } = args;
          let suite = await this.suites.update(suiteId, patch);
          if (tags !== undefined) {
            suite = await this.suites.updateTags(suiteId, tags);
          }
          return jsonResult(suite);
        }),
    );

    server.registerTool(
      'archive_eval_suite',
      {
        title: '归档测试集',
        description: '归档测试集（状态置为「归档」，历史批次不受影响）。',
        inputSchema: {
          suiteId: z.number().int().positive().describe('测试集 ID'),
        },
      },
      (args) =>
        executeTool(this.logger, 'archive_eval_suite', principal, async () =>
          jsonResult(await this.suites.archive(args.suiteId)),
        ),
    );

    // ---- 用例 ----

    server.registerTool(
      'upsert_eval_case',
      {
        title: '新增/更新用例',
        description:
          '提交用例与要点清单（要点整体替换，至少 1 条）。不传 caseId 时新增，传 caseId 时更新；caseKey 测试集内唯一。',
        inputSchema: {
          suiteId: z.number().int().positive().describe('测试集 ID'),
          caseId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('用例 ID（更新时传）'),
          caseKey: z
            .string()
            .min(1)
            .describe('用例标识（测试集内唯一，导入导出匹配用）'),
          title: z.string().optional().describe('标题（缺省取 Prompt 首行）'),
          prompt: z
            .string()
            .min(1)
            .describe('用例输入（Markdown，作为评估任务描述）'),
          clarify: z
            .string()
            .nullish()
            .describe('补充信息（被测方首次提问时原样答复）'),
          passThreshold: z.number().nullish().describe('覆盖测试集通过阈值'),
          timeoutSec: z.number().nullish().describe('覆盖测试集超时'),
          enabled: z.boolean().optional().describe('是否启用（默认启用）'),
          points: z.array(PointArg).min(1).describe('要点清单（整体替换）'),
        },
      },
      (args) =>
        executeTool(this.logger, 'upsert_eval_case', principal, async () => {
          const { suiteId, caseId, ...input } = args;
          const caseInput: CaseInput = {
            ...input,
            title: input.title ?? '',
            points: input.points.map((point, index) => ({
              ...point,
              seq: index + 1,
            })),
          };
          const saved = caseId
            ? await this.suites.updateCase(suiteId, caseId, caseInput)
            : await this.suites.addCase(suiteId, caseInput);
          return jsonResult(saved);
        }),
    );

    server.registerTool(
      'delete_eval_case',
      {
        title: '删除用例',
        description: '删除用例及其要点（不影响历史批次的冻结快照）。',
        inputSchema: {
          suiteId: z.number().int().positive().describe('测试集 ID'),
          caseId: z.number().int().positive().describe('用例 ID'),
        },
      },
      (args) =>
        executeTool(this.logger, 'delete_eval_case', principal, async () => {
          await this.suites.deleteCase(args.suiteId, args.caseId);
          return markdownResult(
            `已删除用例 #${args.caseId}（测试集 #${args.suiteId}）。`,
          );
        }),
    );

    // ---- 导入导出 ----

    server.registerTool(
      'import_eval_suite',
      {
        title: '导入测试集 JSON',
        description:
          '按 JSON 导入用例（caseKey 匹配：已存在则覆盖，不存在则新增）；可选提交测试集级配置。',
        inputSchema: {
          suiteId: z.number().int().positive().describe('测试集 ID'),
          payload: ImportPayloadArg.describe('导入内容'),
        },
      },
      (args) =>
        executeTool(this.logger, 'import_eval_suite', principal, async () => {
          const result = await this.suites.import(
            args.suiteId,
            args.payload as unknown as EvalSuiteExport,
          );
          return jsonResult(result);
        }),
    );

    server.registerTool(
      'export_eval_suite',
      {
        title: '导出测试集 JSON',
        description:
          '导出测试集配置、用例与要点（可用于备份或导入其它测试集）。',
        inputSchema: {
          suiteId: z.number().int().positive().describe('测试集 ID'),
        },
      },
      (args) =>
        executeTool(this.logger, 'export_eval_suite', principal, async () =>
          jsonResult(await this.suites.export(args.suiteId)),
        ),
    );

    // ---- 评估批次 ----

    server.registerTool(
      'list_eval_runs',
      {
        title: '评估批次清单',
        description:
          '列出评估批次（可按测试集 / 被测机器人筛选，倒序，上限 100）。',
        inputSchema: {
          suiteId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('按测试集筛选'),
          targetWorkerId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('按被测机器人筛选'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('返回条数（默认 50）'),
        },
      },
      (args) =>
        executeTool(this.logger, 'list_eval_runs', principal, async () =>
          jsonResult(await this.engine.listRuns(args)),
        ),
    );

    server.registerTool(
      'create_eval_run',
      {
        title: '发起评估',
        description:
          '用指定测试集评估某个机器人：冻结测试集快照、生成评估项并异步执行。发起人记当前管理员身份。',
        inputSchema: {
          suiteId: z.number().int().positive().describe('测试集 ID'),
          targetWorkerId: z.number().int().positive().describe('被测机器人 ID'),
          evaluatorWorkerId: z
            .number()
            .int()
            .positive()
            .describe('评估机器人 ID（作为需求方与判定）'),
          repeatCount: z
            .number()
            .int()
            .min(1)
            .max(5)
            .optional()
            .describe('每用例重复次数（1-5，默认 3）'),
          concurrency: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('并发评估项上限（默认 3）'),
          mcpPolicy: McpPolicyArg.nullish().describe('自定义 MCP 的评估策略'),
        },
      },
      (args) =>
        executeTool(this.logger, 'create_eval_run', principal, async () => {
          const run = await this.engine.createRun({
            suiteId: args.suiteId,
            targetWorkerId: args.targetWorkerId,
            evaluatorWorkerId: args.evaluatorWorkerId,
            repeatCount: args.repeatCount,
            concurrency: args.concurrency,
            mcpPolicy: args.mcpPolicy ?? null,
            createdById: principal.user?.id ?? null,
            createdByName: principal.user?.name ?? null,
          });
          return jsonResult(run);
        }),
    );

    server.registerTool(
      'run_eval',
      {
        title: '运行评估',
        description:
          '发起评估并等待批次终态：执行过程经 progress 推送（评估项完成数），终态返回评估报告。' +
          `默认等待 ${EVAL_WAIT_DEFAULT_SECONDS} 秒；超时只结束等待，批次在平台继续，可稍后用 get_eval_run_report 查询。`,
        inputSchema: {
          suiteId: z.number().int().positive().describe('测试集 ID'),
          targetWorkerId: z.number().int().positive().describe('被测机器人 ID'),
          evaluatorWorkerId: z
            .number()
            .int()
            .positive()
            .describe('评估机器人 ID（作为需求方与判定）'),
          repeatCount: z
            .number()
            .int()
            .min(1)
            .max(5)
            .optional()
            .describe('每用例重复次数（1-5，默认 3）'),
          concurrency: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('并发评估项上限（默认 3）'),
          mcpPolicy: McpPolicyArg.nullish().describe('自定义 MCP 的评估策略'),
          timeout_seconds: z
            .number()
            .int()
            .min(10)
            .max(1800)
            .optional()
            .describe(
              `等待终态的秒数（10-1800，默认 ${EVAL_WAIT_DEFAULT_SECONDS}）；超时只结束等待，批次在平台继续`,
            ),
        },
      },
      (args, extra) =>
        executeTool(this.logger, 'run_eval', principal, async () => {
          const run = await this.engine.createRun({
            suiteId: args.suiteId,
            targetWorkerId: args.targetWorkerId,
            evaluatorWorkerId: args.evaluatorWorkerId,
            repeatCount: args.repeatCount,
            concurrency: args.concurrency,
            mcpPolicy: args.mcpPolicy ?? null,
            createdById: principal.user?.id ?? null,
            createdByName: principal.user?.name ?? null,
          });
          const latest = await this.waitRun(
            run.id,
            createProgressEmitter(extra),
            extra.signal,
            this.evalTimeoutMs(args.timeout_seconds),
          );
          const items = await this.engine.listItems(run.id);
          const report = this.renderReport(latest, items);
          return markdownResult(
            latest.status === EvalRunStatus.COMPLETED ||
              latest.status === EvalRunStatus.CANCELED
              ? report
              : `${report}\n> 等待超时：批次在平台继续执行，可稍后用 get_eval_run_report 查询终态。\n`,
          );
        }),
    );

    server.registerTool(
      'get_eval_run_report',
      {
        title: '评估报告',
        description:
          '读取评估批次报告：批次信息、汇总指标与逐项结果（用例/重复/状态/得分/提问返工等）。',
        inputSchema: {
          runId: z.number().int().positive().describe('评估批次 ID'),
        },
      },
      (args) =>
        executeTool(this.logger, 'get_eval_run_report', principal, async () => {
          const run = await this.engine.findRun(args.runId);
          const items = await this.engine.listItems(args.runId);
          return markdownResult(this.renderReport(run, items));
        }),
    );

    server.registerTool(
      'cancel_eval_run',
      {
        title: '取消评估',
        description: '取消评估批次（未完成评估项一并取消）。',
        inputSchema: {
          runId: z.number().int().positive().describe('评估批次 ID'),
        },
      },
      (args) =>
        executeTool(this.logger, 'cancel_eval_run', principal, async () =>
          jsonResult(await this.engine.cancelRun(args.runId)),
        ),
    );

    server.registerTool(
      'get_eval_run',
      {
        title: '评估批次状态',
        description:
          '读取评估批次状态与进度：批次信息、汇总指标、评估项状态计数（不展开逐项；明细用 get_eval_run_report）。',
        inputSchema: {
          runId: z.number().int().positive().describe('评估批次 ID'),
        },
      },
      (args) =>
        executeTool(this.logger, 'get_eval_run', principal, async () => {
          const run = await this.engine.findRun(args.runId);
          const items = await this.engine.listItems(args.runId);
          return markdownResult(this.renderRunStatus(run, items));
        }),
    );

    server.registerTool(
      'get_worker_eval_summary',
      {
        title: '机器人评估成绩',
        description:
          '按被测机器人汇总最近评估批次：状态、通过率、平均得分、评估项数与时间，用于查看机器人的评估历史。',
        inputSchema: {
          workerId: z.number().int().positive().describe('被测机器人 ID'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe('最近批次数（默认 10）'),
        },
      },
      (args) =>
        executeTool(
          this.logger,
          'get_worker_eval_summary',
          principal,
          async () => {
            const runs = await this.engine.listRuns({
              targetWorkerId: args.workerId,
              limit: args.limit ?? 10,
            });
            return markdownResult(
              this.renderWorkerSummary(args.workerId, runs),
            );
          },
        ),
    );

    // ---- 评估项 ----

    server.registerTool(
      'get_eval_item',
      {
        title: '评估项详情',
        description: '读取评估项状态、得分、事件流与判定明细。',
        inputSchema: {
          itemId: z.number().int().positive().describe('评估项 ID'),
        },
      },
      (args) =>
        executeTool(this.logger, 'get_eval_item', principal, async () => {
          const [item, events, judgements] = await Promise.all([
            this.engine.findItem(args.itemId),
            this.engine.listEvents(args.itemId),
            this.engine.listJudgements(args.itemId),
          ]);
          return jsonResult({ item, events, judgements });
        }),
    );

    server.registerTool(
      'rerun_eval_item',
      {
        title: '重跑评估项',
        description:
          '重跑单个评估项（生成新记录，旧记录标记被替代，统计时不重复计入）。',
        inputSchema: {
          itemId: z.number().int().positive().describe('评估项 ID'),
        },
      },
      (args) =>
        executeTool(this.logger, 'rerun_eval_item', principal, async () =>
          jsonResult(await this.engine.rerunItem(args.itemId)),
        ),
    );

    server.registerTool(
      'rejudge_eval_item',
      {
        title: '重新判定评估项',
        description:
          '对评估项重新执行判定（复用已有交付内容，生成新的判定记录）。',
        inputSchema: {
          itemId: z.number().int().positive().describe('评估项 ID'),
        },
      },
      (args) =>
        executeTool(this.logger, 'rejudge_eval_item', principal, async () =>
          jsonResult(await this.engine.rejudgeItem(args.itemId)),
        ),
    );
  }

  /** 等待评估批次终态：进度事件 + 15 秒保底轮询；超时或调用方断开只结束等待 */
  private waitRun(
    runId: number,
    notify: ProgressFn | null,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<EvalRun> {
    return new Promise<EvalRun>((resolve, reject) => {
      let current: EvalRun | null = null;
      let settled = false;
      let lastProgress = -1;
      let pollTimer: NodeJS.Timeout | null = null;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let unsubscribe: (() => void) | null = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        unsubscribe?.();
        signal?.removeEventListener('abort', onAbort);
        if (current) resolve(current);
        else reject(new Error('评估批次不存在'));
      };
      const onAbort = () => finish();

      const poll = async () => {
        if (settled) return;
        try {
          const run = await this.engine.findRun(runId);
          current = run;
          const items = await this.engine.listItems(runId);
          const active = items.filter((item) => !item.superseded);
          const completed = active.filter((item) =>
            TERMINAL_ITEM_STATUSES.has(item.status),
          ).length;
          if (notify && completed !== lastProgress) {
            lastProgress = completed;
            void notify(
              completed,
              `评估批次 #${runId}：${run.status}，已完成 ${completed}/${active.length}`,
            ).catch(() => {});
          }
          if (this.isTerminalRun(run.status)) finish();
        } catch {
          finish();
        }
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      pollTimer = setInterval(() => void poll(), 15_000);
      pollTimer.unref?.();
      timeoutTimer = setTimeout(() => finish(), timeoutMs);
      timeoutTimer.unref?.();
      unsubscribe = this.progress.onRun(runId, () => void poll());
      void poll();
    });
  }

  private isTerminalRun(status: EvalRunStatus): boolean {
    return (
      status === EvalRunStatus.COMPLETED || status === EvalRunStatus.CANCELED
    );
  }

  private evalTimeoutMs(seconds: number | undefined): number {
    const value = seconds && seconds > 0 ? seconds : EVAL_WAIT_DEFAULT_SECONDS;
    return Math.min(Math.max(value, 10), 1800) * 1000;
  }

  /** 批次状态与进度（不展开逐项） */
  private renderRunStatus(run: EvalRun, items: EvalRunItem[]): string {
    const active = items.filter((item) => !item.superseded);
    const completed = active.filter((item) =>
      TERMINAL_ITEM_STATUSES.has(item.status),
    ).length;
    const counts = new Map<string, number>();
    for (const item of active) {
      counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    }
    return [
      `# 评估批次 #${run.id}`,
      '',
      `- 测试集：${run.suiteSnapshot.name}（#${run.suiteId}，版本 v${run.suiteVersion}）`,
      `- 被测机器人：${run.targetWorkerName}（#${run.targetWorkerId}）`,
      `- 评估机器人：#${run.evaluatorWorkerId}`,
      `- 状态：${run.status}`,
      `- 进度：${completed}/${active.length} 项结束`,
      `- 创建时间：${run.createdAt.toISOString()}`,
      ...(run.finishedAt
        ? [`- 结束时间：${run.finishedAt.toISOString()}`]
        : []),
      ...(run.error ? [`- 失败原因：${run.error}`] : []),
      '',
      '## 评估项状态',
      '',
      ...(counts.size > 0
        ? [...counts.entries()].map(
            ([status, count]) => `- ${status}：${count}`,
          )
        : ['- （暂无评估项）']),
      ...(run.summary
        ? [
            '',
            '## 汇总',
            '',
            '```json',
            JSON.stringify(run.summary, null, 2),
            '```',
          ]
        : []),
      '',
      `> 逐项明细用 get_eval_run_report（runId=${run.id}）。`,
      '',
    ].join('\n');
  }

  /** 机器人评估成绩：最近批次汇总 */
  private renderWorkerSummary(workerId: number, runs: EvalRun[]): string {
    if (runs.length === 0) {
      return `# 机器人评估成绩\n\n机器人 #${workerId} 暂无评估批次。\n`;
    }
    const metric = (run: EvalRun, key: string): string => {
      const value = run.summary?.[key];
      return typeof value === 'number' ? String(value) : '-';
    };
    return [
      `# 机器人评估成绩：${runs[0].targetWorkerName}（#${workerId}）`,
      '',
      `最近 ${runs.length} 个评估批次：`,
      '',
      '| 批次 | 测试集 | 状态 | 通过率 | 平均分 | 评估项 | 发起人 | 创建时间 |',
      '|---|---|---|---|---|---|---|---|',
      ...runs.map((run) => {
        const passRate = metric(run, 'passRate');
        return `| #${run.id} | ${run.suiteSnapshot.name.replace(/\|/g, '\\|')} | ${run.status} | ${passRate === '-' ? '-' : `${passRate}%`} | ${metric(run, 'avgScore')} | ${metric(run, 'total')} | ${run.createdByName ?? '-'} | ${run.createdAt.toISOString()} |`;
      }),
      '',
      '> 逐项明细用 get_eval_run_report（runId 取上表批次号）。',
      '',
    ].join('\n');
  }

  /** 评估报告 Markdown：批次信息 + 汇总 + 逐项结果 */
  private renderReport(
    run: Awaited<ReturnType<EvalEngineService['findRun']>>,
    items: Awaited<ReturnType<EvalEngineService['listItems']>>,
  ): string {
    const active = items.filter((item) => !item.superseded);
    const passed = active.filter(
      (item) =>
        item.result === EvalItemResult.FIRST_PASS ||
        item.result === EvalItemResult.PASS_AFTER_REWORK,
    ).length;
    const caseTitles = new Map(
      run.suiteSnapshot.cases.map((item) => [item.id, item.title]),
    );
    const lines = [
      `# 评估报告：批次 #${run.id}`,
      '',
      `- 测试集：${run.suiteSnapshot.name}（#${run.suiteId}，版本 v${run.suiteVersion}）`,
      `- 被测机器人：${run.targetWorkerName}（#${run.targetWorkerId}）`,
      `- 评估机器人：#${run.evaluatorWorkerId}`,
      `- 状态：${run.status}`,
      `- 重复次数：${run.repeatCount}；并发：${run.concurrency}`,
      `- 发起人：${run.createdByName ?? '-'}`,
      `- 创建时间：${run.createdAt.toISOString()}`,
      ...(run.finishedAt
        ? [`- 结束时间：${run.finishedAt.toISOString()}`]
        : []),
      ...(run.error ? [`- 失败原因：${run.error}`] : []),
      '',
      '## 汇总',
      '',
      `- 有效评估项：${active.length}；通过：${passed}`,
      ...(run.summary
        ? ['', '```json', JSON.stringify(run.summary, null, 2), '```']
        : []),
      '',
      '## 评估项',
      '',
      '| 评估项 | 用例 | 重复 | 状态 | 结果 | 首轮分 | 最终分 | 提问 | 返工 | 拦截写 |',
      '|---|---|---|---|---|---|---|---|---|---|',
      ...items.map((item) =>
        [
          `#${item.id}${item.superseded ? '（已替代）' : ''}`,
          (caseTitles.get(item.caseId) ?? `#${item.caseId}`).replace(
            /\|/g,
            '\\|',
          ),
          item.repeatIndex,
          item.status,
          item.result ?? '-',
          item.firstScore ?? '-',
          item.finalScore ?? '-',
          item.questionCount,
          item.reworkCount,
          item.blockedWriteCount,
        ].join(' | '),
      ),
      '',
    ];
    return lines.join('\n');
  }
}
