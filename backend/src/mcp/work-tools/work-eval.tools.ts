import { Injectable, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EvalEngineService } from '../../eval/eval-engine.service';
import { EvalJudgeService } from '../../eval/eval-judge.service';
import { buildJudgePrompt } from '../../eval/eval-judge.service';
import {
  executeTool,
  markdownResult,
  toolErrorResult,
} from './work-tools.util';
import type { McpWorkPrincipal, WorkToolRegistrar } from './work-tools.types';

const JudgementPointArg = z.object({
  idx: z.number().int().positive().describe('要点序号（与判定输入一致）'),
  hit: z
    .union([z.literal(0), z.literal(0.5), z.literal(1)])
    .describe('命中值：1 命中 / 0.5 部分命中 / 0 未命中'),
  evidence: z
    .string()
    .default('')
    .describe('交付内容中的原文摘录（命中和部分命中必填）'),
  note: z.string().default('').describe('简短说明（部分命中时说明缺了什么）'),
});

/**
 * 评估判定工具（TECH_DESIGN 11.4）：仅判定专用令牌可用。
 * - get_eval_judge_input：读取引擎组装的判定输入（11.2）；
 * - submit_eval_judgement：提交逐条判定，平台做证据校验与算分。
 */
@Injectable()
export class WorkEvalTools implements WorkToolRegistrar {
  private readonly logger = new Logger(WorkEvalTools.name);

  constructor(
    private readonly engine: EvalEngineService,
    private readonly judge: EvalJudgeService,
  ) {}

  register(server: McpServer, principal: McpWorkPrincipal): void {
    server.registerTool(
      'get_eval_judge_input',
      {
        title: '读取评估判定输入',
        description:
          '读取本次判定的输入：任务输入、要点清单与交付内容。仅在评估判定会话中可用。',
        inputSchema: {},
      },
      () =>
        executeTool(this.logger, 'get_eval_judge_input', principal, () => {
          const ctx = principal.evalContext;
          if (!ctx?.judge) {
            return toolErrorResult('该工具仅评估判定令牌可用');
          }
          const input = this.judge.getInput(ctx.evalItemId);
          if (!input) {
            return toolErrorResult(
              '当前没有进行中的判定输入（可能已判定完成）',
            );
          }
          return markdownResult(buildJudgePrompt(input));
        }),
    );

    server.registerTool(
      'submit_eval_judgement',
      {
        title: '提交评估判定',
        description:
          '提交逐条判定结果。必须覆盖全部要点（idx 不重复、不遗漏）；命中与部分命中必须提供交付内容原文摘录作为证据。平台会校验证据并计算得分。',
        inputSchema: {
          points: z
            .array(JudgementPointArg)
            .describe('逐条判定结果，必须覆盖全部要点'),
          reason: z.string().default('').describe('总体说明'),
        },
      },
      (args) =>
        executeTool(
          this.logger,
          'submit_eval_judgement',
          principal,
          async () => {
            const ctx = principal.evalContext;
            if (!ctx?.judge) {
              return toolErrorResult('该工具仅评估判定令牌可用');
            }
            const input = this.judge.getInput(ctx.evalItemId);
            if (!input) {
              return toolErrorResult('当前没有进行中的判定（可能已判定完成）');
            }
            const raw = JSON.stringify({
              points: args.points,
              reason: args.reason,
            });
            const result = await this.engine.submitJudgement(
              ctx.evalItemId,
              input.round,
              raw,
            );
            if (!result.ok) {
              // 返回错误文本，判定机器人可在同一会话内修正后重新提交
              return toolErrorResult(result.message);
            }
            return markdownResult(
              `${result.message}\n\n> 判定已记录。本轮判定结束，无需再提交；请结束当前回合。`,
            );
          },
        ),
    );
  }
}
