import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import type { Executor } from '../executors/executor.entity';
import { createExecutorClient } from '../executors/executor-client';
import { planPromptModels, runExecutorPrompt } from '../executors/executor-run';
import type { Worker } from '../workers/worker.entity';
import { EvalSandboxService } from './eval-sandbox.service';
import type { EvalRunItem } from './eval-run-item.entity';
import type { FrozenEvalCase } from './eval-worker-snapshot.entity';

/** 判定输入（引擎组装后作为判定会话第一条消息发送，也供 get_eval_judge_input 重读） */
export interface JudgeInput {
  round: number;
  prompt: string;
  points: Array<{
    idx: number;
    point: string;
    required: boolean;
    hint: string | null;
  }>;
  /** 交付内容（HANDOFF + 任务文档正文，判定用与证据校验用） */
  deliver: string;
  maxPointCount: number;
  digest: string;
  truncated: boolean;
}

/** 逐条判定结果（证据校验后） */
export interface JudgementPoint {
  idx: number;
  hit: 0 | 0.5 | 1;
  evidence: string;
  note: string;
  evidenceInvalid?: boolean;
}

/** 判定提交校验结果 */
export interface JudgementResult {
  ok: boolean;
  message?: string;
  points?: JudgementPoint[];
  score?: number;
  pass?: boolean;
  reason?: string;
}

/** 交付内容总长度上限（11.2） */
export const MAX_DELIVER_CHARS = 100_000;

/**
 * 判定服务（TECH_DESIGN 11）：
 * - 组装判定输入（用例 Prompt + 要点清单（无权重）+ 交付内容）；
 * - 为评估机器人开判定沙箱与一次性判定会话，首条消息发送判定提示词（11.5）；
 * - get_eval_judge_input / submit_eval_judgement 两个 MCP 工具的数据与校验入口（仅判定令牌可用）；
 * - 提交时校验格式 → 证据校验（11.3）→ 平台算分（10.3）。
 */
@Injectable()
export class EvalJudgeService {
  private readonly logger = new Logger(EvalJudgeService.name);

  /** itemId → 判定输入（JUDGE_STARTED 时组装；判定完成后清理） */
  private readonly inputs = new Map<number, JudgeInput>();
  /** itemId → 判定沙箱所在执行器（销毁沙箱用） */
  private readonly sandboxExecutors = new Map<number, number>();

  constructor(private readonly sandbox: EvalSandboxService) {}

  /** 组装判定输入 */
  buildInput(
    round: number,
    caseFrozen: FrozenEvalCase,
    deliver: string,
  ): JudgeInput {
    const points = caseFrozen.points.map((p, index) => ({
      idx: index + 1,
      point: p.point,
      required: p.required,
      hint: p.hint,
    }));
    const truncated = deliver.length > MAX_DELIVER_CHARS;
    const digest = createHash('sha256')
      .update(
        JSON.stringify({ round, prompt: caseFrozen.prompt, points, deliver }),
      )
      .digest('hex');
    return {
      round,
      prompt: caseFrozen.prompt,
      points,
      deliver: deliver.slice(0, MAX_DELIVER_CHARS),
      maxPointCount: points.length,
      digest,
      truncated,
    };
  }

  /** 登记判定输入（判定会话开始前调用） */
  storeInput(itemId: number, input: JudgeInput): void {
    this.inputs.set(itemId, input);
  }

  /** 读取本次判定输入（get_eval_judge_input 工具） */
  getInput(itemId: number): JudgeInput | null {
    return this.inputs.get(itemId) ?? null;
  }

  clearInput(itemId: number): void {
    this.inputs.delete(itemId);
  }

  /** 记录判定沙箱所在执行器（销毁沙箱用） */
  rememberSandboxExecutor(itemId: number, executorId: number): void {
    this.sandboxExecutors.set(itemId, executorId);
  }

  /**
   * 运行一次判定会话：
   * - 判定沙箱（评估机器人工位副本，docs 清空，凭据=判定令牌，HOME 隔离目录）
   * - 一次性会话（无记忆），首条消息按 11.5 模板；
   * - 会话终态后若期间未提交有效判定，回调 onSessionEnd 由引擎决定重试/判 ERROR。
   */
  async runJudge(options: {
    item: EvalRunItem;
    round: number;
    executor: Executor;
    evaluator: Worker;
    judgeToken: string;
    judgeSandbox: string;
    input: JudgeInput;
    appUrl: string;
    denyExternalDirectory: boolean;
    mcpServers: Record<string, unknown>;
    onSessionEnd: (itemId: number, round: number) => void;
  }): Promise<void> {
    const {
      item,
      round,
      executor,
      evaluator,
      judgeToken,
      judgeSandbox,
      input,
      appUrl,
      denyExternalDirectory,
      mcpServers,
      onSessionEnd,
    } = options;
    const client = createExecutorClient(executor);
    this.rememberSandboxExecutor(item.id, executor.id);
    this.storeInput(item.id, input);
    const evaluatorWorkdir = this.getWorkdirOf(evaluator.id);
    if (!evaluatorWorkdir) {
      throw new Error('未配置 WORKER_BASE_DIR，无法创建判定沙箱');
    }
    await this.sandbox.buildSandbox(
      client,
      evaluatorWorkdir,
      judgeSandbox,
      executor.type ?? null,
      mcpServers,
      judgeToken,
      appUrl,
      denyExternalDirectory,
    );
    const plan = planPromptModels(evaluator, executor.id, {
      providerId:
        evaluator.providerId ?? executor.providersCache?.[0]?.id ?? '',
      modelId:
        evaluator.modelId ??
        executor.providersCache?.[0]?.models?.[0]?.id ??
        '',
      variant: evaluator.variant ?? null,
    });
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      onSessionEnd(item.id, round);
    };
    try {
      await runExecutorPrompt(client, {
        title: `评估判定 #${item.id} 第 ${round} 轮`,
        model: plan.model,
        ...(plan.fallback ? { fallback: plan.fallback } : {}),
        onQuotaError: plan.onQuotaError,
        location: { directory: judgeSandbox },
        prompt: buildJudgePrompt(input),
        timeoutMs: JUDGE_SESSION_TIMEOUT_MS,
      });
    } catch (error) {
      this.logger.warn(
        `评估项 #${item.id} 第 ${round} 轮判定会话未正常结束: ${(error as Error).message}`,
      );
    } finally {
      end();
    }
  }

  /** 机器人真实工位路径（判定沙箱复制源） */
  private getWorkdirOf(workerId: number): string | null {
    // 由调用方注入（引擎绑定到 WorkersService.workdirOf）
    return this.workdirOf?.(workerId) ?? null;
  }

  /** 由引擎注入的工位路径解析（避免循环依赖） */
  workdirOf: ((workerId: number) => string | null) | null = null;

  /**
   * 校验判定提交（11.3/11.4）：格式 → 证据 → 算分 → 通过判定。
   * ok=false 时 message 为格式问题（判定会话内可修正后重新提交）。
   */
  validateJudgement(
    caseFrozen: FrozenEvalCase,
    deliver: string,
    raw: string,
  ): JudgementResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFence(raw));
    } catch {
      return {
        ok: false,
        message:
          '判定结果不是合法 JSON：请按 { "points": [{"idx": 1, "hit": 1, "evidence": "原文摘录", "note": ""}], "reason": "总体说明" } 格式提交。',
      };
    }
    const body = parsed as { points?: unknown; reason?: unknown };
    if (!Array.isArray(body.points) || body.points.length === 0) {
      return { ok: false, message: 'points 必须是非空数组' };
    }
    const expected = caseFrozen.points.length;
    if (body.points.length !== expected) {
      return {
        ok: false,
        message: `points 必须覆盖全部 ${expected} 个要点（当前 ${body.points.length} 个），idx 不重复、不遗漏。`,
      };
    }
    const problems: string[] = [];
    const seen = new Set<number>();
    const normalizedDeliver = normalizeEvidenceText(deliver);
    const points: JudgementPoint[] = [];
    for (const item of body.points as Array<Record<string, unknown>>) {
      const idx = Number(item.idx);
      const rawHit = item.hit;
      const hit =
        rawHit === 1
          ? (1 as const)
          : rawHit === 0.5
            ? (0.5 as const)
            : rawHit === 0
              ? (0 as const)
              : null;
      const evidence =
        typeof item.evidence === 'string' ? item.evidence.trim() : '';
      const note = typeof item.note === 'string' ? item.note.trim() : '';
      if (!Number.isInteger(idx) || idx < 1 || idx > expected) {
        problems.push(`idx=${String(item.idx)} 超出范围`);
        continue;
      }
      if (seen.has(idx)) {
        problems.push(`idx=${idx} 重复`);
        continue;
      }
      seen.add(idx);
      if (hit === null) {
        problems.push(`idx=${idx} 的 hit 只能取 0 / 0.5 / 1`);
        continue;
      }
      if (hit > 0 && evidence.length === 0) {
        problems.push(`idx=${idx} 命中/部分命中必须填写 evidence 原文摘录`);
        continue;
      }
      // 证据校验（11.3）：规范化后必须是交付内容子串，长度不少于 4；不通过则 hit 改为 0
      let evidenceInvalid = false;
      if (hit > 0) {
        const normalized = normalizeEvidenceText(evidence);
        if (normalized.length < 4 || !normalizedDeliver.includes(normalized)) {
          evidenceInvalid = true;
        }
      }
      points.push({
        idx,
        hit: evidenceInvalid ? 0 : hit,
        evidence,
        note,
        ...(evidenceInvalid ? { evidenceInvalid: true } : {}),
      });
    }
    if (problems.length > 0) {
      return { ok: false, message: `判定格式问题：${problems.join('；')}` };
    }
    return this.score(
      caseFrozen,
      points,
      typeof body.reason === 'string' ? body.reason.trim() : '',
    );
  }

  /** 算分（10.3）：score = round(100 × Σ(w×h) / Σw)；pass = 必需项全命中且 score ≥ 阈值 */
  private score(
    caseFrozen: FrozenEvalCase,
    points: JudgementPoint[],
    reason: string,
  ): JudgementResult {
    let weighted = 0;
    let totalWeight = 0;
    let requiredAllHit = true;
    for (const point of points) {
      const p = caseFrozen.points.find((c) => c.seq === point.idx);
      const weight = p ? Math.max(0.01, Number(p.weight) || 1) : 1;
      weighted += weight * point.hit;
      totalWeight += weight;
      if (p?.required && point.hit < 1) requiredAllHit = false;
    }
    const score = Math.round((weighted / totalWeight) * 100);
    const threshold = caseFrozen.passThreshold ?? 80;
    const pass = requiredAllHit && score >= threshold;
    return { ok: true, points, score, pass, reason };
  }
}

/** 判定会话超时（毫秒，5 分钟） */
const JUDGE_SESSION_TIMEOUT_MS = 5 * 60_000;

/** 判定提示词（11.5） */
export function buildJudgePrompt(input: JudgeInput): string {
  const pointLines = input.points
    .map((p) => `${p.idx}. [${p.required ? '必需' : '可选'}] ${p.point}`)
    .join('\n');
  return [
    '你是任务结果的判定员。请逐条判断「交付内容」是否满足「要点清单」中的每一个要点。',
    '',
    '## 判定规则',
    '1. 只依据「交付内容」判断。不要假设交付中没写出来的内容，也不要使用你自己的知识补全。',
    '2. 要点的意思被明确表达即为命中（hit=1），不要求措辞一致。',
    '3. 只满足一部分，或表达含糊、需要推测才能对上，记为部分命中（hit=0.5），并在 note 中说明缺了什么。',
    '4. 没有提到，或与要点矛盾，记为未命中（hit=0）。',
    '5. 命中和部分命中必须在 evidence 中填写交付内容里的原文摘录，逐字复制，不要改写。找不到原文就记为未命中。',
    '6. 每个要点独立判断，不要因为整体印象好或差而放宽或收紧。',
    '',
    '## 任务输入',
    input.prompt,
    '',
    '## 要点清单',
    pointLines,
    '',
    '## 交付内容',
    input.deliver,
    '',
    '## 提交',
    `完成判定后调用 submit_eval_judgement 提交，必须覆盖全部 ${input.maxPointCount} 个要点：`,
    '{"points": [{"idx": 1, "hit": 1, "evidence": "交付内容原文摘录", "note": ""}], "reason": "总体说明"}',
  ].join('\n');
}

/** 去掉 Markdown 围栏与前后噪声后提取 JSON */
export function stripFence(raw: string): string {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const target = fenced ? fenced[1].trim() : text;
  const start = target.indexOf('{');
  const end = target.lastIndexOf('}');
  if (start < 0 || end <= start) return target;
  return target.slice(start, end + 1);
}

/** 规范化文本（11.3）：合并连续空白、去掉 Markdown 标记符号 */
export function normalizeEvidenceText(text: string): string {
  return text
    .replace(/[*`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
