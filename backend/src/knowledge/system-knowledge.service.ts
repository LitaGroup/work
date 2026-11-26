import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EvalJudgement } from '../eval/eval-judgement.entity';
import { EvalRunItem } from '../eval/eval-run-item.entity';
import { EvalRun } from '../eval/eval-run.entity';
import { EvalCase, EvalCasePoint, EvalSuite } from '../eval/eval-suite.entity';
import { McpServer } from '../mcp-servers/mcp-server.entity';
import { TaskTemplate } from '../tasks/task-template.entity';
import { Worker } from '../workers/worker.entity';
import {
  systemEvalRunRootPath,
  systemEvalSuiteRootPath,
  systemTaskDefinitionRootPath,
  systemWorkerRootPath,
} from './knowledge.path';
import { KnowledgeService } from './knowledge.service';

const README = 'README';
const CONFIG_SYNC_INTERVAL_MS = 5 * 60_000;
const RUN_SYNC_INTERVAL_MS = 60_000;
const RUN_SYNC_DEBOUNCE_MS = 1_000;

function text(value: string | null | undefined): string {
  return value?.trim() || '（未配置）';
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return `\`${JSON.stringify(value)}\``;
}

function codeBlock(value: string | null | undefined): string {
  const body = value?.trim();
  return body ? ['```markdown', body, '```'].join('\n') : '（未配置）';
}

/** 镜像属于知识检索范围，避免配置正文中误写的凭据被带入 */
function redactSensitive(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(token|secret|password|passwd|api[_-]?key|authorization)\b(\s*[:=]\s*)(["']?)[^\s"']+/gi,
      '$1$2$3[REDACTED]',
    );
}

function resolveMcpNames(
  ids: number[] | null | undefined,
  servers: McpServer[],
): string {
  if (!ids?.length) return '仅 lita-work';
  const byId = new Map(servers.map((server) => [server.id, server.name]));
  return ids.map((id) => byId.get(id) ?? `#${id}`).join('、');
}

function renderWorker(worker: Worker, servers: McpServer[]): string {
  const skills = worker.skills ?? [];
  const standards = worker.standards ?? [];
  const taskDefs = worker.taskDefs ?? [];
  const lines = [
    `# ${worker.name} · 机器人设定`,
    '',
    '> 本页由平台根据机器人配置自动生成，只读；修改请前往管理区机器人配置。',
    '',
    '## 基本信息',
    '',
    `- ID：${worker.id}`,
    `- 名称：${worker.name}`,
    `- 系统标识：${show(worker.systemKey)}`,
    `- 类型：${worker.role}`,
    `- 运行内核：${worker.runtime}`,
    `- 状态：${worker.enabled ? '启用' : '停用'}`,
    `- 真人绑定：${show(worker.humanUserName)}`,
    `- 负责人：${show(worker.ownerName)}`,
    `- 执行器 ID：${show(worker.executorId)}`,
    `- 主模型：${[worker.providerId, worker.modelId, worker.variant].filter(Boolean).join(' / ') || '—'}`,
    `- 备用模型：${[worker.backupProviderId, worker.backupModelId, worker.backupVariant].filter(Boolean).join(' / ') || '—'}`,
    `- 平台访问级别：${worker.accessLevel}`,
    `- GitHub 权限：${worker.githubPermission}`,
    `- 资源网关权限：${worker.resourcePermission}`,
    `- 并行执行上限：${worker.maxParallelTasks}`,
    `- 执行记录采集：${worker.traceEnabled ? '开启' : '关闭'}`,
    `- 允许优化机器人读取：${worker.optimizerReadable ? '是' : '否'}`,
    '',
    '## 简介',
    '',
    text(worker.intro),
    '',
    '## 机器人定义（AGENTS.md）',
    '',
    codeBlock(worker.prompt),
    '',
    '## 技能',
    '',
    ...(skills.length
      ? [
          '| 技能 | 路径 | 版本 | 描述 |',
          '| --- | --- | --- | --- |',
          ...skills.map(
            (skill) =>
              `| ${skill.name} | \`${skill.path}\` | ${show(skill.version)} | ${show(skill.description)} |`,
          ),
        ]
      : ['（未选择技能）']),
    '',
    '## 规范',
    '',
    ...(standards.length
      ? [
          '| 规范 | 目录 | 版本 | 描述 |',
          '| --- | --- | --- | --- |',
          ...standards.map(
            (standard) =>
              `| ${standard.name} | \`${standard.directory}\` | ${show(standard.version)} | ${show(standard.description)} |`,
          ),
        ]
      : ['（未选择规范）']),
    '',
    '## MCP 服务',
    '',
    resolveMcpNames(worker.mcps, servers),
    '',
    '## 任务能力',
    '',
  ];
  if (taskDefs.length === 0) lines.push('（未声明任务能力）');
  for (const [index, definition] of taskDefs.entries()) {
    lines.push(
      `### 任务能力 ${index + 1}`,
      '',
      `- 完成方式：${show(definition.how)}`,
      '',
      '输入：',
      ...(definition.inputs?.length
        ? definition.inputs.map(
            (input) =>
              `- ${input.name}${input.required ? '（必填）' : ''}：${show(input.desc)}`,
          )
        : ['- （无）']),
      '',
      '输出：',
      ...(definition.outputs?.length
        ? definition.outputs.map(
            (output) => `- ${output.name}：${show(output.desc)}`,
          )
        : ['- （无）']),
      '',
    );
  }
  lines.push('## 更新时间', '', worker.updatedAt.toISOString(), '');
  return lines.join('\n');
}

function renderTaskDefinition(template: TaskTemplate): string {
  return [
    `# ${template.name} · 任务定义`,
    '',
    '> 本页由平台根据任务定义自动生成，只读；修改请前往管理区任务定义。',
    '',
    `- ID：${template.id}`,
    `- 名称：${template.name}`,
    `- 默认处理机器人：${template.agentIds?.length ? template.agentIds.map((id) => `#${id}`).join('、') : '—'}`,
    `- 创建人：${show(template.createdByName)}`,
    `- 更新时间：${template.updatedAt.toISOString()}`,
    '',
    '## 定义说明',
    '',
    text(template.description),
    '',
  ].join('\n');
}

function renderEvalSuite(
  suite: EvalSuite,
  cases: Array<EvalCase & { points: EvalCasePoint[] }>,
): string {
  const lines = [
    `# ${suite.name} · 机器人评测测试集`,
    '',
    '> 本页由平台根据评估测试集自动生成，只读；修改请前往管理区机器人评测。',
    '',
    `- ID：${suite.id}`,
    `- 版本：v${suite.version}`,
    `- 状态：${suite.status}`,
    `- 用途：${suite.purpose}`,
    `- 通过阈值：${suite.passThreshold}`,
    `- 默认超时：${suite.defaultTimeoutSec} 秒`,
    `- 提问上限：${suite.maxQuestions}`,
    `- 标签：${suite.tags?.length ? suite.tags.join('、') : '—'}`,
    `- 用例数：${cases.length}`,
    `- 更新时间：${suite.updatedAt.toISOString()}`,
    '',
    '## 说明',
    '',
    text(suite.description),
    '',
    '## 用例',
    '',
  ];
  if (cases.length === 0) lines.push('（无用例）');
  for (const item of cases) {
    lines.push(
      `### ${item.seq}. ${item.title}（${item.caseKey}）`,
      '',
      `- 状态：${item.enabled ? '启用' : '停用'}`,
      `- 通过阈值覆盖：${show(item.passThreshold)}`,
      `- 超时覆盖：${show(item.timeoutSec)} 秒`,
      '',
      '#### 输入 Prompt',
      '',
      codeBlock(item.prompt),
      '',
      '#### 补充信息',
      '',
      codeBlock(item.clarify),
      '',
      '#### 评分要点',
      '',
      ...(item.points.length
        ? [
            '| 序号 | 要点 | 必需 | 权重 | 返工提示 |',
            '| --- | --- | --- | --- | --- |',
            ...item.points.map(
              (point) =>
                `| ${point.seq} | ${point.point.replace(/\|/g, '\\|')} | ${point.required ? '是' : '否'} | ${point.weight} | ${(point.hint ?? '—').replace(/\|/g, '\\|')} |`,
            ),
          ]
        : ['（无评分要点）']),
      '',
    );
  }
  return lines.join('\n');
}

function renderEvalRun(input: {
  run: EvalRun;
  items: EvalRunItem[];
  judgements: EvalJudgement[];
  suiteLink: string;
}): string {
  const { run, items, judgements, suiteLink } = input;
  const judgementsByItem = new Map<number, EvalJudgement[]>();
  for (const judgement of judgements) {
    const list = judgementsByItem.get(judgement.itemId) ?? [];
    list.push(judgement);
    judgementsByItem.set(judgement.itemId, list);
  }
  const lines = [
    `# 评测批次 #${run.id} · ${run.targetWorkerName}`,
    '',
    '> 本页由平台根据评估批次自动生成，只读；仅包含汇总与判定说明，不包含执行日志和原始工具调用。',
    '',
    `- 测试集：[${run.suiteSnapshot?.name ?? `#${run.suiteId}`}](${suiteLink}) v${run.suiteVersion}`,
    `- 被测机器人：${run.targetWorkerName}（#${run.targetWorkerId}）`,
    `- 评估机器人：#${run.evaluatorWorkerId}`,
    `- 状态：${run.status}`,
    `- 角色：${run.role}`,
    `- 重复次数：${run.repeatCount}`,
    `- 并发：${run.concurrency}`,
    `- 创建：${run.createdAt.toISOString()}`,
    `- 开始：${show(run.startedAt?.toISOString())}`,
    `- 结束：${show(run.finishedAt?.toISOString())}`,
    `- 错误：${show(run.error)}`,
    '',
    '## 汇总',
    '',
    '```json',
    JSON.stringify(run.summary ?? {}, null, 2),
    '```',
    '',
    '## 评估项',
    '',
  ];
  if (items.length === 0) lines.push('（暂无评估项）');
  else {
    lines.push(
      '| 项 | 状态 | 结果 | 首次得分 | 最终得分 | 提问 | 返工 | 人工介入 | 异常 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...items.map(
        (item) =>
          `| #${item.id} | ${item.status} | ${show(item.result)} | ${show(item.firstScore)} | ${show(item.finalScore)} | ${item.questionCount} | ${item.reworkCount} | ${item.humanCount} | ${show(item.errorMessage)} |`,
      ),
    );
  }
  lines.push('', '## 有效判定', '');
  const effective = items.flatMap((item) =>
    (judgementsByItem.get(item.id) ?? [])
      .filter((judgement) => judgement.effective)
      .map((judgement) => ({ item, judgement })),
  );
  if (effective.length === 0) lines.push('（暂无有效判定）');
  for (const { item, judgement } of effective) {
    lines.push(
      `### 评估项 #${item.id} · 第 ${judgement.round} 轮`,
      '',
      `- 得分：${show(judgement.score)}`,
      `- 通过：${judgement.pass === null ? '—' : judgement.pass ? '是' : '否'}`,
      `- 判定模型：${show(judgement.model)}`,
      '',
      text(judgement.reason),
      '',
    );
  }
  return lines.join('\n');
}

/**
 * `/99-system/**` 自动镜像：机器人设定、任务定义、机器人评测。
 * 管理页与数据库仍是配置源；知识库只保留可检索的只读摘要。
 */
@Injectable()
export class SystemKnowledgeService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SystemKnowledgeService.name);
  private configTimer: NodeJS.Timeout | null = null;
  private runTimer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<string>();
  private readonly runDebounce = new Map<number, NodeJS.Timeout>();

  constructor(
    private readonly knowledge: KnowledgeService,
    @InjectRepository(Worker)
    private readonly workers: Repository<Worker>,
    @InjectRepository(McpServer)
    private readonly mcpServers: Repository<McpServer>,
    @InjectRepository(TaskTemplate)
    private readonly templates: Repository<TaskTemplate>,
    @InjectRepository(EvalSuite)
    private readonly suites: Repository<EvalSuite>,
    @InjectRepository(EvalCase)
    private readonly cases: Repository<EvalCase>,
    @InjectRepository(EvalCasePoint)
    private readonly points: Repository<EvalCasePoint>,
    @InjectRepository(EvalRun)
    private readonly runs: Repository<EvalRun>,
    @InjectRepository(EvalRunItem)
    private readonly runItems: Repository<EvalRunItem>,
    @InjectRepository(EvalJudgement)
    private readonly judgements: Repository<EvalJudgement>,
  ) {}

  onApplicationBootstrap(): void {
    this.initialTimer = setTimeout(() => {
      void this.syncAllConfig().catch((error: Error) => {
        this.logger.warn(`系统知识镜像初始同步失败：${error.message}`);
      });
      void this.syncAllEvalRuns().catch((error: Error) => {
        this.logger.warn(`评测知识镜像初始同步失败：${error.message}`);
      });
      this.configTimer = setInterval(() => {
        void this.syncAllConfig().catch((error: Error) => {
          this.logger.warn(`系统知识镜像同步失败：${error.message}`);
        });
      }, CONFIG_SYNC_INTERVAL_MS);
      this.configTimer.unref();
      this.runTimer = setInterval(() => {
        void this.syncRecentRuns().catch((error: Error) => {
          this.logger.warn(`评测知识镜像同步失败：${error.message}`);
        });
      }, RUN_SYNC_INTERVAL_MS);
      this.runTimer.unref();
    }, 5_000);
    this.initialTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.configTimer) clearInterval(this.configTimer);
    if (this.runTimer) clearInterval(this.runTimer);
    for (const timer of this.runDebounce.values()) clearTimeout(timer);
    this.runDebounce.clear();
  }

  async syncAllConfig(): Promise<void> {
    if (!this.knowledge.isEnabled) return;
    const [workers, templates, suites] = await Promise.all([
      this.workers.find(),
      this.templates.find(),
      this.suites.find(),
    ]);
    for (const worker of workers) await this.syncWorker(worker.id);
    for (const template of templates) {
      await this.syncTaskDefinition(template.id);
    }
    for (const suite of suites) await this.syncEvalSuite(suite.id);
    await this.pruneStaleMirrors(
      '/99-system/workers',
      new Set(workers.map((worker) => worker.id)),
    );
    await this.pruneStaleMirrors(
      '/99-system/task-definitions',
      new Set(templates.map((template) => template.id)),
    );
    await this.pruneStaleMirrors(
      '/99-system/evaluations/suites',
      new Set(suites.map((suite) => suite.id)),
    );
  }

  /** 清理已删除实体的历史镜像目录，避免知识检索残留旧配置 */
  private async pruneStaleMirrors(
    parentPath: string,
    validIds: Set<number>,
  ): Promise<void> {
    const nodes = await this.knowledge.listNodesByPrefix(parentPath);
    for (const node of nodes) {
      if (node.kind !== 'directory' || node.parentPath !== parentPath) continue;
      if (!/^\d+$/.test(node.name)) continue;
      if (validIds.has(Number(node.name))) continue;
      await this.knowledge.removeSystemPath(node.path);
    }
  }

  /** 启动全量回填历史评测报告，分批读取避免一次加载过多冻结快照 */
  async syncAllEvalRuns(): Promise<void> {
    if (!this.knowledge.isEnabled) return;
    const batchSize = 200;
    for (let offset = 0; ; offset += batchSize) {
      const runs = await this.runs.find({
        select: { id: true },
        order: { id: 'ASC' },
        skip: offset,
        take: batchSize,
      });
      if (runs.length === 0) break;
      for (const run of runs) await this.syncEvalRun(run.id);
      if (runs.length < batchSize) break;
    }
  }

  /** 周期同步最近更新的批次；历史终态报告在启动时已全量回填 */
  async syncRecentRuns(): Promise<void> {
    if (!this.knowledge.isEnabled) return;
    const runs = await this.runs.find({
      order: { updatedAt: 'DESC', id: 'DESC' },
      take: 100,
    });
    for (const run of runs) await this.syncEvalRun(run.id);
  }

  async syncWorker(workerId: number): Promise<void> {
    const key = `worker:${workerId}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      const worker = await this.workers.findOne({ where: { id: workerId } });
      const root = systemWorkerRootPath(workerId);
      if (!worker || worker.personalAgentUserId) {
        await this.knowledge.removeSystemPath(root);
        return;
      }
      const servers = await this.mcpServers.find();
      await this.knowledge.upsertSystemArticle({
        path: `${root}/${README}`,
        title: `机器人 #${worker.id} ${worker.name} · 设定`,
        content: redactSensitive(renderWorker(worker, servers)),
      });
    } catch (error) {
      this.logger.warn(
        `机器人 #${workerId} 知识镜像同步失败：${(error as Error).message}`,
      );
    } finally {
      this.inFlight.delete(key);
    }
  }

  async syncTaskDefinition(templateId: number): Promise<void> {
    const key = `template:${templateId}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      const template = await this.templates.findOne({
        where: { id: templateId },
      });
      const root = systemTaskDefinitionRootPath(templateId);
      if (!template) {
        await this.knowledge.removeSystemPath(root);
        return;
      }
      await this.knowledge.upsertSystemArticle({
        path: `${root}/${README}`,
        title: `任务定义 #${template.id} ${template.name}`,
        content: redactSensitive(renderTaskDefinition(template)),
      });
    } catch (error) {
      this.logger.warn(
        `任务定义 #${templateId} 知识镜像同步失败：${(error as Error).message}`,
      );
    } finally {
      this.inFlight.delete(key);
    }
  }

  async syncEvalSuite(suiteId: number): Promise<void> {
    const key = `suite:${suiteId}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      const suite = await this.suites.findOne({ where: { id: suiteId } });
      const root = systemEvalSuiteRootPath(suiteId);
      if (!suite) {
        await this.knowledge.removeSystemPath(root);
        return;
      }
      const cases = await this.cases.find({
        where: { suiteId },
        order: { seq: 'ASC', id: 'ASC' },
      });
      const pointRows = cases.length
        ? await this.points.find({
            where: { caseId: In(cases.map((item) => item.id)) },
            order: { seq: 'ASC', id: 'ASC' },
          })
        : [];
      const byCase = new Map<number, EvalCasePoint[]>();
      for (const point of pointRows) {
        const list = byCase.get(point.caseId) ?? [];
        list.push(point);
        byCase.set(point.caseId, list);
      }
      await this.knowledge.upsertSystemArticle({
        path: `${root}/${README}`,
        title: `评测测试集 #${suite.id} ${suite.name}`,
        content: redactSensitive(
          renderEvalSuite(
            suite,
            cases.map((item) => ({
              ...item,
              points: byCase.get(item.id) ?? [],
            })),
          ),
        ),
      });
    } catch (error) {
      this.logger.warn(
        `评测测试集 #${suiteId} 知识镜像同步失败：${(error as Error).message}`,
      );
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** 评测批次变化较频繁：短去抖后同步，终态也会在下一次周期同步兜底 */
  queueEvalRunSync(runId: number): void {
    const existing = this.runDebounce.get(runId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.runDebounce.delete(runId);
      void this.syncEvalRun(runId);
    }, RUN_SYNC_DEBOUNCE_MS);
    timer.unref();
    this.runDebounce.set(runId, timer);
  }

  async syncEvalRun(runId: number): Promise<void> {
    const key = `run:${runId}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      const run = await this.runs.findOne({ where: { id: runId } });
      const root = run
        ? systemEvalRunRootPath(run)
        : `/99-system/evaluations/runs/removed/${runId}`;
      if (!run) {
        await this.knowledge.removeSystemPath(root);
        return;
      }
      const items = await this.runItems.find({
        where: { runId },
        order: { id: 'ASC' },
      });
      const judgements = items.length
        ? await this.judgements.find({
            where: { itemId: In(items.map((item) => item.id)) },
            order: { itemId: 'ASC', round: 'DESC', attempt: 'DESC' },
          })
        : [];
      const suiteRoot = systemEvalSuiteRootPath(run.suiteId);
      await this.knowledge.upsertSystemArticle({
        path: `${root}/${README}`,
        title: `评测批次 #${run.id} ${run.targetWorkerName}`,
        content: redactSensitive(
          renderEvalRun({
            run,
            items,
            judgements,
            suiteLink: `/docs/detail${suiteRoot}/`,
          }),
        ),
      });
    } catch (error) {
      this.logger.warn(
        `评测批次 #${runId} 知识镜像同步失败：${(error as Error).message}`,
      );
    } finally {
      this.inFlight.delete(key);
    }
  }
}
