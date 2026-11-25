import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EvalSuitePurpose, EvalSuiteStatus } from '../common/enums';
import { EvalRun } from './eval-run.entity';
import { EvalCase, EvalCasePoint, EvalSuite } from './eval-suite.entity';

/** 要点更新入参 */
export interface PointInput {
  seq: number;
  point: string;
  required?: boolean;
  weight?: number;
  hint?: string | null;
}

/** 用例更新入参（要点整体替换） */
export interface CaseInput {
  caseKey: string;
  seq?: number;
  title: string;
  prompt: string;
  clarify?: string | null;
  passThreshold?: number | null;
  timeoutSec?: number | null;
  enabled?: boolean;
  points: PointInput[];
}

/** 导入格式（14.2） */
export interface EvalSuiteExport {
  suite: {
    name: string;
    description?: string | null;
    purpose: string;
    passThreshold: number;
    defaultTimeoutSec: number;
    maxQuestions: number;
  };
  cases: Array<{
    caseKey: string;
    seq?: number;
    title: string;
    prompt: string;
    clarify?: string | null;
    passThreshold?: number | null;
    timeoutSec?: number | null;
    points: Array<{
      point: string;
      required?: boolean;
      weight?: number;
      hint?: string | null;
    }>;
  }>;
}

/** 单个标签最大长度 */
export const EVAL_SUITE_TAG_MAX_LENGTH = 20;

/** 单个测试集最多标签数 */
export const EVAL_SUITE_TAG_MAX_COUNT = 20;

/** 标签归一化：去首尾空格、忽略空值、按原写法去重 */
export function normalizeEvalSuiteTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) {
    throw new BadRequestException('标签必须为字符串数组');
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    if (typeof raw !== 'string') {
      throw new BadRequestException('标签必须为字符串数组');
    }
    const tag = raw.trim();
    if (!tag || seen.has(tag)) continue;
    if (tag.length > EVAL_SUITE_TAG_MAX_LENGTH) {
      throw new BadRequestException(
        `单个标签不能超过 ${EVAL_SUITE_TAG_MAX_LENGTH} 个字符`,
      );
    }
    seen.add(tag);
    result.push(tag);
  }
  if (result.length > EVAL_SUITE_TAG_MAX_COUNT) {
    throw new BadRequestException(`标签最多 ${EVAL_SUITE_TAG_MAX_COUNT} 个`);
  }
  return result;
}

/** 测试集 CRUD（14.1）：用例随测试集维护，要点随用例整体替换；支持 JSON 导入导出。 */
@Injectable()
export class EvalSuiteService {
  constructor(
    @InjectRepository(EvalSuite)
    private readonly suites: Repository<EvalSuite>,
    @InjectRepository(EvalCase)
    private readonly cases: Repository<EvalCase>,
    @InjectRepository(EvalCasePoint)
    private readonly points: Repository<EvalCasePoint>,
    @InjectRepository(EvalRun)
    private readonly runs: Repository<EvalRun>,
  ) {}

  async list(): Promise<
    Array<
      EvalSuite & {
        caseCount: number;
        enabledCaseCount: number;
        lastRunAt: Date | null;
      }
    >
  > {
    const rows = await this.suites.find({ order: { id: 'DESC' } });
    const counts = await this.cases
      .createQueryBuilder('c')
      .select('c.suiteId', 'suiteId')
      .addSelect('COUNT(*)', 'n')
      .addSelect('COUNT(*) FILTER (WHERE c.enabled = true)', 'enabledN')
      .groupBy('c.suiteId')
      .getRawMany<{ suiteId: string; n: string; enabledN: string }>();
    const bySuite = new Map(
      counts.map((r) => [
        Number(r.suiteId),
        { total: Number(r.n), enabled: Number(r.enabledN) },
      ]),
    );
    return rows.map((suite) => {
      const c = bySuite.get(suite.id) ?? { total: 0, enabled: 0 };
      return {
        ...suite,
        caseCount: c.total,
        enabledCaseCount: c.enabled,
        lastRunAt: null,
      };
    });
  }

  async create(input: {
    name: string;
    description?: string | null;
    purpose?: EvalSuitePurpose;
    passThreshold?: number;
    defaultTimeoutSec?: number;
    maxQuestions?: number;
    ownerId?: number | null;
  }): Promise<EvalSuite> {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('测试集名称不能为空');
    const exists = await this.suites.findOne({ where: { name } });
    if (exists) throw new BadRequestException('测试集名称已存在');
    const suite = await this.suites.save(
      this.suites.create({
        name,
        description: input.description?.trim() || null,
        tags: [],
        purpose: input.purpose ?? EvalSuitePurpose.VALIDATION,
        passThreshold: clampThreshold(input.passThreshold ?? 80),
        defaultTimeoutSec: clampPositive(input.defaultTimeoutSec ?? 1800, 1800),
        maxQuestions: clampPositive(input.maxQuestions ?? 3, 3),
        version: 1,
        ownerId: input.ownerId ?? null,
        status: EvalSuiteStatus.ACTIVE,
      }),
    );
    return suite;
  }

  async update(
    suiteId: number,
    input: {
      name?: string;
      description?: string | null;
      purpose?: EvalSuitePurpose;
      passThreshold?: number;
      defaultTimeoutSec?: number;
      maxQuestions?: number;
      status?: EvalSuiteStatus;
    },
  ): Promise<EvalSuite> {
    const suite = await this.suites.findOne({ where: { id: suiteId } });
    if (!suite) throw new NotFoundException('测试集不存在');
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new BadRequestException('测试集名称不能为空');
      if (name !== suite.name) {
        const exists = await this.suites.findOne({ where: { name } });
        if (exists) throw new BadRequestException('测试集名称已存在');
      }
    }
    const patch: Partial<EvalSuite> = {};
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.description !== undefined)
      patch.description = input.description?.trim() || null;
    if (input.purpose) patch.purpose = input.purpose;
    if (input.passThreshold !== undefined)
      patch.passThreshold = clampThreshold(input.passThreshold);
    if (input.defaultTimeoutSec !== undefined)
      patch.defaultTimeoutSec = clampPositive(input.defaultTimeoutSec, 1800);
    if (input.maxQuestions !== undefined)
      patch.maxQuestions = clampPositive(input.maxQuestions, 3);
    if (input.status) patch.status = input.status;
    patch.version = suite.version + 1;
    await this.suites.update({ id: suiteId }, patch);
    return this.suites.findOneOrFail({ where: { id: suiteId } });
  }

  /** 更新标签：仅分类元数据，不递增评估版本 */
  async updateTags(suiteId: number, tags: unknown): Promise<EvalSuite> {
    const suite = await this.suites.findOne({ where: { id: suiteId } });
    if (!suite) throw new NotFoundException('测试集不存在');
    const normalized = normalizeEvalSuiteTags(tags);
    if (
      normalized.length === (suite.tags ?? []).length &&
      normalized.every((tag, index) => tag === suite.tags[index])
    ) {
      return suite;
    }
    await this.suites.update({ id: suiteId }, { tags: normalized });
    return this.suites.findOneOrFail({ where: { id: suiteId } });
  }

  async archive(suiteId: number): Promise<EvalSuite> {
    return this.update(suiteId, { status: EvalSuiteStatus.ARCHIVED });
  }

  /** 删除测试集及其用例、要点；已有评估批次时拒绝，避免历史报告关联失效 */
  async remove(suiteId: number): Promise<void> {
    const suite = await this.suites.findOne({ where: { id: suiteId } });
    if (!suite) throw new NotFoundException('测试集不存在');
    const hasRuns = await this.runs.exists({ where: { suiteId } });
    if (hasRuns) {
      throw new BadRequestException('该测试集已发起评估，不能删除，可改为归档');
    }
    const cases = await this.cases.find({
      where: { suiteId },
      select: { id: true },
    });
    if (cases.length > 0) {
      await this.points.delete({ caseId: In(cases.map((row) => row.id)) });
    }
    await this.cases.delete({ suiteId });
    await this.suites.delete({ id: suiteId });
  }

  async detail(suiteId: number): Promise<{
    suite: EvalSuite;
    cases: Array<EvalCase & { points: EvalCasePoint[] }>;
  }> {
    const suite = await this.suites.findOne({ where: { id: suiteId } });
    if (!suite) throw new NotFoundException('测试集不存在');
    const cases = await this.cases.find({
      where: { suiteId },
      order: { seq: 'ASC', id: 'ASC' },
    });
    const pointRows = await this.points.find({
      where: { caseId: In(cases.map((c) => c.id)) },
      order: { seq: 'ASC', id: 'ASC' },
    });
    const byCase = new Map<number, EvalCasePoint[]>();
    for (const p of pointRows) {
      const list = byCase.get(p.caseId) ?? [];
      list.push(p);
      byCase.set(p.caseId, list);
    }
    return {
      suite,
      cases: cases.map((c) => ({ ...c, points: byCase.get(c.id) ?? [] })),
    };
  }

  /** 新增用例（要点随用例一起提交） */
  async addCase(suiteId: number, input: CaseInput): Promise<EvalCase> {
    const suite = await this.suites.findOne({ where: { id: suiteId } });
    if (!suite) throw new NotFoundException('测试集不存在');
    const { points, ...caseFields } = this.normalizeCaseInput(input, null);
    const maxSeq = await this.cases
      .createQueryBuilder('c')
      .select('COALESCE(MAX(c.seq), 0)', 'max')
      .where('c.suiteId = :suiteId', { suiteId })
      .getRawOne<{ max: string }>();
    const saved = await this.cases.save(
      this.cases.create({
        ...caseFields,
        suiteId,
        seq: caseFields.seq ?? Number(maxSeq?.max ?? 0) + 1,
      }),
    );
    await this.replacePoints(saved.id, points);
    await this.bumpVersion(suiteId);
    return saved;
  }

  /** 更新用例与要点（要点整体替换） */
  async updateCase(
    suiteId: number,
    caseId: number,
    input: CaseInput,
  ): Promise<EvalCase> {
    const row = await this.cases.findOne({
      where: { id: caseId, suiteId },
    });
    if (!row) throw new NotFoundException('用例不存在');
    const { points, ...caseFields } = this.normalizeCaseInput(input, row);
    await this.cases.update({ id: caseId }, caseFields);
    await this.replacePoints(caseId, points);
    await this.bumpVersion(suiteId);
    return this.cases.findOneOrFail({ where: { id: caseId } });
  }

  async deleteCase(suiteId: number, caseId: number): Promise<void> {
    await this.points.delete({ caseId });
    await this.cases.delete({ id: caseId, suiteId });
    await this.bumpVersion(suiteId);
  }

  /** 导入 JSON（按 caseKey 新增或覆盖）；返回 {added, updated} */
  async import(
    suiteId: number,
    payload: EvalSuiteExport,
  ): Promise<{ added: number; updated: number }> {
    const suite = await this.suites.findOne({ where: { id: suiteId } });
    if (!suite) throw new NotFoundException('测试集不存在');
    const exportSuite = payload.suite;
    if (exportSuite) {
      await this.update(suiteId, {
        description: exportSuite.description ?? suite.description,
        purpose: (exportSuite.purpose as EvalSuitePurpose) ?? suite.purpose,
        passThreshold: exportSuite.passThreshold,
        defaultTimeoutSec: exportSuite.defaultTimeoutSec,
        maxQuestions: exportSuite.maxQuestions,
      });
    }
    let added = 0;
    let updated = 0;
    for (const c of payload.cases ?? []) {
      if (!c.caseKey?.trim() || !c.prompt?.trim()) continue;
      const existing = await this.cases.findOne({
        where: { suiteId, caseKey: c.caseKey.trim() },
      });
      const input: CaseInput = {
        caseKey: c.caseKey.trim(),
        seq: c.seq ?? existing?.seq ?? 0,
        title: c.title?.trim() || deriveTitle(c.prompt),
        prompt: c.prompt,
        clarify: c.clarify ?? null,
        passThreshold: c.passThreshold ?? null,
        timeoutSec: c.timeoutSec ?? null,
        enabled: existing?.enabled ?? true,
        points: (c.points ?? []).map((p, index) => ({
          seq: index + 1,
          point: p.point,
          required: p.required ?? false,
          weight: p.weight ?? 1,
          hint: p.hint ?? null,
        })),
      };
      if (existing) {
        await this.updateCase(suiteId, existing.id, input);
        updated++;
      } else {
        await this.addCase(suiteId, input);
        added++;
      }
    }
    return { added, updated };
  }

  /** 导出 JSON（14.2） */
  async export(suiteId: number): Promise<EvalSuiteExport> {
    const { suite, cases } = await this.detail(suiteId);
    return {
      suite: {
        name: suite.name,
        description: suite.description,
        purpose: suite.purpose,
        passThreshold: suite.passThreshold,
        defaultTimeoutSec: suite.defaultTimeoutSec,
        maxQuestions: suite.maxQuestions,
      },
      cases: cases.map((c) => ({
        caseKey: c.caseKey,
        seq: c.seq,
        title: c.title,
        prompt: c.prompt,
        clarify: c.clarify,
        passThreshold: c.passThreshold,
        timeoutSec: c.timeoutSec,
        points: c.points.map((p) => ({
          point: p.point,
          required: p.required,
          weight: Number(p.weight),
          hint: p.hint,
        })),
      })),
    };
  }

  private async replacePoints(
    caseId: number,
    points: PointInput[],
  ): Promise<void> {
    await this.points.delete({ caseId });
    if (points.length === 0) {
      throw new BadRequestException('至少需要 1 个要点');
    }
    for (const p of points) {
      const point = p.point?.trim();
      if (!point) throw new BadRequestException('要点内容不能为空');
      const weight = Number(p.weight ?? 1);
      if (!(weight > 0 && weight <= 10)) {
        throw new BadRequestException('要点权重须在 (0, 10] 之间');
      }
      if (p.hint?.trim() && point.includes(p.hint.trim())) {
        // hint 包含要点原文时仅提示，不阻止保存（界面展示提示）
      }
      await this.points.save(
        this.points.create({
          caseId,
          seq: p.seq,
          point,
          required: p.required ?? false,
          weight: String(weight),
          hint: p.hint?.trim() || null,
        }),
      );
    }
  }

  private normalizeCaseInput(
    input: CaseInput,
    existing: EvalCase | null,
  ): {
    points: PointInput[];
    seq?: number;
    title: string;
    prompt: string;
    clarify: string | null;
    passThreshold: number | null;
    timeoutSec: number | null;
    enabled: boolean;
    caseKey: string;
  } {
    const caseKey = input.caseKey?.trim();
    if (!caseKey) throw new BadRequestException('caseKey 不能为空');
    const title = input.title?.trim() || deriveTitle(input.prompt);
    const prompt = input.prompt?.trim();
    if (!prompt) throw new BadRequestException('Prompt 不能为空');
    const points: PointInput[] = (input.points ?? []).map((p, index) => ({
      seq: p.seq ?? index + 1,
      point: p.point ?? '',
      required: p.required ?? false,
      weight: p.weight ?? 1,
      hint: p.hint ?? null,
    }));
    return {
      caseKey,
      seq: input.seq ?? existing?.seq ?? 0,
      title,
      prompt,
      clarify: input.clarify?.trim() || null,
      passThreshold:
        input.passThreshold == null
          ? (existing?.passThreshold ?? null)
          : clampThreshold(input.passThreshold),
      timeoutSec:
        input.timeoutSec == null
          ? (existing?.timeoutSec ?? null)
          : clampPositive(input.timeoutSec, 1800),
      enabled: input.enabled ?? existing?.enabled ?? true,
      points,
    };
  }

  private async bumpVersion(suiteId: number): Promise<void> {
    const suite = await this.suites.findOne({ where: { id: suiteId } });
    if (suite) {
      await this.suites.update({ id: suiteId }, { version: suite.version + 1 });
    }
  }
}

function clampThreshold(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function clampPositive(value: number, fallback: number): number {
  const n = Math.round(value);
  return n > 0 ? n : fallback;
}

/** 标题兜底：用 Prompt 首行 */
export function deriveTitle(prompt: string): string {
  const firstLine = prompt
    .trim()
    .split('\n')
    .find((line) => line.trim().length > 0);
  return (firstLine?.trim() ?? '新用例').slice(0, 200);
}
