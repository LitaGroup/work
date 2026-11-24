import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { createExecutorClient } from '../executors/executor-client';
import { Executor } from '../executors/executor.entity';
import { TaskStatus, TaskSubStatus, WorkerRuntime } from '../common/enums';
import {
  EvalEventType,
  EvalItemResult,
  EvalItemStatus,
  EvalRunRole,
  EvalRunStatus,
} from '../common/enums';
import { Worker } from '../workers/worker.entity';
import { WorkersService } from '../workers/workers.service';
import { shouldDenyExternalDirectory } from '../workers/worker-env';
import { Task } from '../tasks/task.entity';
import { TaskMessage } from '../tasks/task-message.entity';
import { TaskEvent } from '../tasks/task-event.entity';
import { TasksService } from '../tasks/tasks.service';
import { TaskCollaborationService } from '../tasks/task-collaboration.service';
import { TaskDocumentService } from '../tasks/task-document.service';
import { workerRequesterActor } from '../tasks/task-requester';
import { EvalSuite } from './eval-suite.entity';
import { EvalCase, EvalCasePoint } from './eval-suite.entity';
import { EvalRun } from './eval-run.entity';
import { EvalRunItem } from './eval-run-item.entity';
import { EvalEvent } from './eval-judgement.entity';
import { EvalJudgement } from './eval-judgement.entity';
import { EvalMcpPolicy, FrozenEvalCase } from './eval-worker-snapshot.entity';
import { EvalSandboxService } from './eval-sandbox.service';
import { EvalTokenService } from './eval-token.service';
import { EvalJudgeService } from './eval-judge.service';
import { EvalProgressService } from './eval-progress.service';

/** 全局评估并发上限（TECH_DESIGN 15.3） */
export const EVAL_GLOBAL_CONCURRENCY = 5;
/** 判定失败最大重试次数（新判定会话） */
const JUDGE_MAX_ATTEMPTS = 3;
/** 单个批次评估项数量上限（15.3） */
const RUN_ITEM_LIMIT = 200;

const RULE_ANSWER_MORE = '补充信息已全部提供，请按你的理解继续完成并交付。';
const RULE_ANSWER_STOP = '不再答复提问，请基于已有信息直接完成并交付。';

/** 发起评估入参（14.1 POST /api/eval/runs） */
export interface CreateEvalRunInput {
  suiteId: number;
  targetWorkerId: number;
  evaluatorWorkerId: number;
  repeatCount?: number;
  concurrency?: number;
  mcpPolicy?: EvalMcpPolicy | null;
  createdById?: number | null;
  createdByName?: string | null;
}

/** 非终态评估项状态（调度/推进遍历用） */
const ACTIVE_ITEM_STATUSES = [
  EvalItemStatus.PENDING,
  EvalItemStatus.PREPARING,
  EvalItemStatus.INVITED,
  EvalItemStatus.RUNNING,
  EvalItemStatus.WAITING_ANSWER,
  EvalItemStatus.JUDGING,
  EvalItemStatus.REWORKING,
];

/**
 * 占用并发槽位的评估项状态（15.3）：
 * 排队项尚未启动、不占槽，若计入占用数，
 * 项数 ≥ 并发上限的批次会因「排队占满槽位」而永久无法启动（死锁）。
 */
const OCCUPYING_ITEM_STATUSES = [
  EvalItemStatus.PREPARING,
  EvalItemStatus.INVITED,
  EvalItemStatus.RUNNING,
  EvalItemStatus.WAITING_ANSWER,
  EvalItemStatus.JUDGING,
  EvalItemStatus.REWORKING,
];

const TERMINAL_ITEM_STATUSES = [
  EvalItemStatus.DONE,
  EvalItemStatus.REFUSED,
  EvalItemStatus.TIMEOUT,
  EvalItemStatus.ERROR,
  EvalItemStatus.CANCELED,
];

/**
 * 评估引擎（TECH_DESIGN 7/8/10/11/16）：
 * 发起评估 → 冻结测试集 → 生成配置快照与评估项 → 逐个创建评估任务（is_eval=1，
 * 需求方=评估机器人，执行方=被测机器人，沙箱工位）→ 观察任务状态推进状态机 →
 * 按规则答复提问 → 判定（评估机器人判定会话 + 平台证据校验与算分）→ 一次返工 →
 * 汇总报告。批量取消 / 单项重跑 / 重新判定 / 平台重启恢复按 16 节处理。
 */
@Injectable()
export class EvalEngineService implements OnModuleInit {
  private readonly logger = new Logger(EvalEngineService.name);
  private readonly appUrl: string;
  private readonly denyExternalDirectory: boolean;

  /** 正在处理的评估项 id（防重入） */
  private readonly busy = new Set<number>();
  /** 正在判定中（等待提交或会话结束）的评估项 */
  private readonly judging = new Set<number>();

  constructor(
    @InjectRepository(EvalRun)
    private readonly runs: Repository<EvalRun>,
    @InjectRepository(EvalRunItem)
    private readonly items: Repository<EvalRunItem>,
    @InjectRepository(EvalEvent)
    private readonly events: Repository<EvalEvent>,
    @InjectRepository(EvalJudgement)
    private readonly judgements: Repository<EvalJudgement>,
    @InjectRepository(EvalSuite)
    private readonly suites: Repository<EvalSuite>,
    @InjectRepository(EvalCase)
    private readonly cases: Repository<EvalCase>,
    @InjectRepository(EvalCasePoint)
    private readonly points: Repository<EvalCasePoint>,
    @InjectRepository(Worker)
    private readonly workers: Repository<Worker>,
    @InjectRepository(Executor)
    private readonly executors: Repository<Executor>,
    @InjectRepository(Task)
    private readonly tasks: Repository<Task>,
    @InjectRepository(TaskMessage)
    private readonly messages: Repository<TaskMessage>,
    @InjectRepository(TaskEvent)
    private readonly taskEvents: Repository<TaskEvent>,
    private readonly tasksService: TasksService,
    private readonly collaboration: TaskCollaborationService,
    private readonly taskDocuments: TaskDocumentService,
    private readonly workersService: WorkersService,
    private readonly sandbox: EvalSandboxService,
    private readonly token: EvalTokenService,
    private readonly judgeService: EvalJudgeService,
    private readonly progress: EvalProgressService,
  ) {
    this.appUrl = (process.env.APP_URL ?? 'http://localhost:5273').replace(
      /\/$/,
      '',
    );
    this.denyExternalDirectory = shouldDenyExternalDirectory(
      process.env.WORKER_DENY_EXTERNAL_DIRECTORY,
    );
  }

  /** 启动定时扫描（每 2 秒推进评估项） */
  onModuleInit(): void {
    this.startTicker();
  }

  /** 启动定时扫描（每 2 秒推进评估项） */
  startTicker(): void {
    const timer = setInterval(() => {
      void this.tick().catch((error: Error) => {
        this.logger.error(`评估引擎 tick 异常: ${error.message}`);
      });
    }, 2_000);
    timer.unref();
  }

  /** 引擎主循环：推进活跃项 → 启动排队项 → 超时检查 */
  async tick(): Promise<void> {
    // 1. 推进活跃评估项
    const active = await this.items.find({
      where: { status: In(ACTIVE_ITEM_STATUSES), superseded: false },
      order: { id: 'ASC' },
      take: 100,
    });
    for (const item of active) {
      if (this.busy.has(item.id)) continue;
      this.busy.add(item.id);
      void this.processItem(item)
        .catch((error: Error) => {
          this.logger.error(`评估项 #${item.id} 推进失败: ${error.message}`);
        })
        .finally(() => this.busy.delete(item.id));
    }
    await this.checkTimeouts();
  }

  /** 并发槽位：全局评估并发上限 + 批次并发上限（仅占用态计数，排队不占槽） */
  private async slotAvailable(
    run: EvalRun,
    currentActive: number,
  ): Promise<boolean> {
    if (currentActive >= EVAL_GLOBAL_CONCURRENCY) return false;
    const runOccupying = await this.items.count({
      where: {
        runId: run.id,
        status: In(OCCUPYING_ITEM_STATUSES),
        superseded: false,
      },
    });
    return runOccupying < Math.max(1, run.concurrency);
  }

  /** 启动评估项：建沙箱 → 建评估任务 → 写评估令牌 → 进入已邀约 */
  private async startItem(item: EvalRunItem): Promise<void> {
    const run = await this.runs.findOne({ where: { id: item.runId } });
    if (!run) throw new NotFoundException(`评估批次 #${item.runId} 不存在`);
    if (run.status === EvalRunStatus.CANCELED) {
      await this.updateItem(item.id, {
        status: EvalItemStatus.CANCELED,
        endedAt: new Date(),
      });
      return;
    }
    const target = await this.workers.findOne({
      where: { id: run.targetWorkerId },
    });
    if (!target) throw new NotFoundException('被测机器人不存在');
    if (target.runtime === WorkerRuntime.HUMAN || !target.executorId) {
      throw new ConflictException('被测机器人须为 AI 机器人且已配置执行器');
    }
    const executor = await this.executors.findOne({
      where: { id: target.executorId },
    });
    if (!executor || !executor.online) {
      throw new ConflictException(
        `被测机器人执行器 #${target.executorId} 离线或不存在`,
      );
    }
    const caseFrozen = this.frozenCase(run, item.caseId);
    if (!caseFrozen) {
      throw new NotFoundException(`用例 #${item.caseId} 不在批次冻结范围内`);
    }

    await this.updateItem(item.id, { status: EvalItemStatus.PREPARING });
    const sandboxId = `${run.id}/${item.id}`;
    const sandbox = this.workersService.evalSandboxWorkdir(sandboxId);
    if (!sandbox) {
      throw new ConflictException('未配置 WORKER_BASE_DIR，无法创建评估沙箱');
    }
    await this.updateItem(item.id, { sandboxId });

    // 1. 创建评估任务（需求方=评估机器人，执行方=被测机器人），创建后为「待分配」
    const task = await this.tasksService.create({
      title: caseFrozen.title,
      description: caseFrozen.prompt,
      input: null,
      outputSpec: null,
      requesterType: 'worker',
      requesterId: run.evaluatorWorkerId,
      agentId: target.id,
      isEval: true,
      evalItemId: item.id,
      createdById: run.createdById ?? null,
      operatorName: run.createdByName ?? undefined,
    });
    await this.updateItem(item.id, {
      taskId: task.id,
      status: EvalItemStatus.INVITED,
    });
    await this.addEvent(item.id, EvalEventType.TASK_CREATED, {
      taskId: task.id,
    });

    // 2. 评估令牌（作用域=评估任务；协议层按 9.3 校验）
    const evalToken = this.token.sign({
      kind: 'eval',
      workerId: target.id,
      evalItemId: item.id,
      taskId: task.id,
      judge: false,
    });

    // 3. 构建沙箱：复制真实工位 → 剔除 docs/ 与凭据 → 注入评估令牌与过滤后的 MCP
    const client = createExecutorClient(executor);
    const workdir = this.workersService.workdirOf(target.id);
    if (!workdir) {
      throw new ConflictException('未配置 WORKER_BASE_DIR，无法确定工位目录');
    }
    const mcpServers = this.buildSandboxMcpServers(run, target, evalToken);
    await this.sandbox.buildSandbox(
      client,
      workdir,
      sandbox,
      executor.type,
      mcpServers,
      evalToken,
      this.appUrl,
      this.denyExternalDirectory,
    );
    await this.addEvent(item.id, EvalEventType.SANDBOX_READY, { sandboxId });

    // 4. 直接推进到「待接受」，由 LOOP offerPending 发送邀约（评估任务不占用真实容量）
    await this.tasks.update(
      {
        id: task.id,
        status: TaskStatus.WAITING,
        subStatus: TaskSubStatus.PENDING_ASSIGNMENT,
      },
      {
        subStatus: TaskSubStatus.PENDING_ACCEPTANCE,
        offerAttemptAt: null,
        offerStallRemindCount: 0,
        remindCount: 0,
        firstRemindedAt: null,
        lastRemindedAt: null,
      },
    );
    this.logger.log(
      `评估项 #${item.id} 已就绪：任务 #${task.id} 沙箱 ${sandboxId}`,
    );
  }

  /** 评估沙箱 MCP 配置：lita-work（评估令牌）+ 按 mcpPolicy 保留的自定义 MCP */
  private buildSandboxMcpServers(
    run: EvalRun,
    target: Worker,
    evalToken: string,
  ): Record<string, unknown> {
    const servers: Record<string, unknown> = {
      ['lita-work']: {
        type: 'remote',
        url: `${this.appUrl.replace(/\/+$/, '')}/api/mcp/work`,
        oauth: false,
        headers: { 'X-Worker-Token': evalToken },
      },
    };
    // 阶段一：只保留 mcpPolicy.keep 明确列出的自定义 MCP，其余移除（9.5）
    const keep = new Set(run.mcpPolicy?.keep ?? []);
    const removed = new Set(run.mcpPolicy?.remove ?? []);
    if (Array.isArray(target.mcps)) {
      for (const name of String(namesOfMcp(target.mcps))) {
        if (removed.has(name)) continue;
        if (keep.size === 0 || keep.has(name)) {
          // 自定义 MCP 配置内容由 MCP 注册表提供；阶段一不注入自定义服务，
          // 只记录策略（见 9.5：默认只保留标记为「评估模式可用」的服务）
        }
      }
    }
    return servers;
  }

  /** 处理单个评估项的状态机推进 */
  private async processItem(item: EvalRunItem): Promise<void> {
    switch (item.status) {
      case EvalItemStatus.PENDING: {
        const run = await this.runs.findOne({ where: { id: item.runId } });
        if (!run || run.status === EvalRunStatus.CANCELED) return;
        const occupyingCount = await this.items.count({
          where: {
            status: In(OCCUPYING_ITEM_STATUSES),
            superseded: false,
          },
        });
        if (!(await this.slotAvailable(run, occupyingCount))) return;
        await this.startItem(item).catch(async (error: Error) => {
          this.logger.warn(
            `评估项 #${item.id} 启动失败：${error.message}，转为异常`,
          );
          await this.markItemError(item.id, error.message);
        });
        break;
      }
      case EvalItemStatus.PREPARING:
      case EvalItemStatus.INVITED:
      case EvalItemStatus.RUNNING:
      case EvalItemStatus.WAITING_ANSWER:
      case EvalItemStatus.REWORKING:
        await this.progressTaskRelation(item);
        break;
      case EvalItemStatus.JUDGING:
        // 判定会话异步进行，等待提交或会话结束回调
        break;
      default:
        break;
    }
  }

  /** 推进：观察评估任务状态 → 接受/拒绝/提问/交付/超时 */
  private async progressTaskRelation(item: EvalRunItem): Promise<void> {
    if (!item.taskId) return;
    const task = await this.tasks.findOne({ where: { id: item.taskId } });
    if (!task) {
      await this.markItemError(item.id, '评估任务已不存在');
      return;
    }

    if (task.status === TaskStatus.FINISHED) {
      await this.onTaskTerminal(item, task);
      return;
    }

    switch (task.subStatus) {
      case TaskSubStatus.EXECUTING:
        if (item.status === EvalItemStatus.INVITED) {
          await this.updateItem(item.id, {
            status: EvalItemStatus.RUNNING,
            acceptedAt: new Date(),
          });
          await this.addEvent(item.id, EvalEventType.ACCEPTED, {});
        }
        return;
      case TaskSubStatus.PENDING_FEEDBACK:
        if (
          item.status === EvalItemStatus.RUNNING ||
          item.status === EvalItemStatus.WAITING_ANSWER
        ) {
          await this.updateItem(item.id, {
            status: EvalItemStatus.WAITING_ANSWER,
          });
          await this.answerQuestion(item, task);
        }
        return;
      case TaskSubStatus.PENDING_RESUME:
      case TaskSubStatus.PENDING_APPLY:
        // 待继续：LOOP 会恢复执行；待申请验收：LOOP 会重新唤醒。引擎等待。
        return;
      case TaskSubStatus.PENDING_ACCEPT: {
        // 交付完成 → 判定（第 1 轮 / 第 2 轮）
        if (item.status === EvalItemStatus.JUDGING) return;
        const round = item.firstApplyAt ? 2 : 1;
        if (round === 1) {
          await this.updateItem(item.id, { firstApplyAt: new Date() });
        } else {
          await this.updateItem(item.id, { finalApplyAt: new Date() });
        }
        await this.startJudge(item, task, round);
        return;
      }
      default:
        return;
    }
  }

  /** 评估任务异常提前终态（非引擎驱动的完成/失败/取消） */
  private async onTaskTerminal(item: EvalRunItem, task: Task): Promise<void> {
    if (task.subStatus === TaskSubStatus.REFUSED) {
      await this.addEvent(item.id, EvalEventType.REFUSED, {
        reason: task.refusalReason,
      });
      await this.finishItem(item, {
        status: EvalItemStatus.REFUSED,
        result: null,
      });
      return;
    }
    if (item.status === EvalItemStatus.DONE) return;
    await this.addEvent(item.id, EvalEventType.ERROR, {
      message: `评估任务异常终态（${task.subStatus}）`,
    });
    await this.markItemError(item.id, `评估任务异常终态（${task.subStatus}）`);
  }

  /** 规则答复提问（7.3） */
  private async answerQuestion(item: EvalRunItem, task: Task): Promise<void> {
    const run = await this.runs.findOne({ where: { id: item.runId } });
    if (!run) return;
    const evaluator = await this.workers.findOne({
      where: { id: run.evaluatorWorkerId },
    });
    if (!evaluator) return;

    // 取最近一条待答复提问
    const row = await this.messages
      .createQueryBuilder('m')
      .where('m.taskId = :taskId AND m.kind = :kind', {
        taskId: task.id,
        kind: 'question',
      })
      .orderBy('m.id', 'DESC')
      .getOne();
    const questionId = row?.question?.id;
    if (!questionId || row.question?.state !== 'pending') return;
    const questionCount = await this.messages.count({
      where: { taskId: task.id, kind: 'question' },
    });
    await this.updateItem(item.id, { questionCount });

    const caseFrozen = this.frozenCase(run, item.caseId);
    const reply =
      questionCount === 1 && caseFrozen?.clarify
        ? caseFrozen.clarify
        : questionCount <= Math.max(1, run.suiteSnapshot?.maxQuestions ?? 3)
          ? RULE_ANSWER_MORE
          : RULE_ANSWER_STOP;
    await this.addEvent(item.id, EvalEventType.QUESTION_ASKED, {
      questionId,
      questionCount,
    });
    await this.collaboration.answer(
      task.id,
      questionId,
      workerRequesterActor(evaluator),
      { answers: [[reply]] },
    );
    await this.addEvent(item.id, EvalEventType.QUESTION_ANSWERED, {
      questionId,
      reply,
    });
    await this.updateItem(item.id, { status: EvalItemStatus.RUNNING });
  }

  /** 启动判定：判定沙箱 + 评估机器人一次性判定会话（11.2/11.5） */
  private async startJudge(
    item: EvalRunItem,
    task: Task,
    round: number,
  ): Promise<void> {
    const run = await this.runs.findOne({ where: { id: item.runId } });
    if (!run) return;
    const evaluator = await this.workers.findOne({
      where: { id: run.evaluatorWorkerId },
    });
    if (!evaluator || !evaluator.executorId) {
      await this.markItemError(item.id, '评估机器人未配置');
      return;
    }
    const executor = await this.executors.findOne({
      where: { id: evaluator.executorId },
    });
    if (!executor || !executor.online) {
      await this.markItemError(item.id, '评估机器人执行器离线');
      return;
    }
    await this.updateItem(item.id, { status: EvalItemStatus.JUDGING });
    await this.addEvent(item.id, EvalEventType.JUDGE_STARTED, { round });

    const judgeToken = this.token.sign({
      kind: 'eval',
      workerId: evaluator.id,
      evalItemId: item.id,
      taskId: task.id,
      judge: true,
    });
    const sandboxRoot = this.workersService.evalSandboxRoot();
    if (!sandboxRoot) {
      await this.markItemError(
        item.id,
        '未配置 WORKER_BASE_DIR，无法创建判定沙箱',
      );
      return;
    }
    const judgeSandbox = `${sandboxRoot}/judge/${item.id}/${round}`;
    const caseFrozen = this.frozenCase(run, item.caseId);
    if (!caseFrozen) {
      await this.markItemError(item.id, '用例不在冻结范围内');
      return;
    }
    const deliver = await this.deliverContent(task);
    const input = this.judgeService.buildInput(round, caseFrozen, deliver);
    this.judgeService.workdirOf = (workerId) =>
      this.workersService.workdirOf(workerId);
    const mcpServers = this.judgeMcpServers(judgeToken);
    this.judging.add(item.id);
    void this.judgeService
      .runJudge({
        item,
        round,
        executor,
        evaluator,
        judgeToken,
        judgeSandbox,
        input,
        appUrl: this.appUrl,
        denyExternalDirectory: this.denyExternalDirectory,
        mcpServers,
        onSessionEnd: (itemId, endedRound) => {
          void this.onJudgeSessionEnd(itemId, endedRound);
        },
      })
      .catch((error: Error) => {
        this.logger.error(`评估项 #${item.id} 判定会话异常: ${error.message}`);
        void this.onJudgeFailed(item.id, round, error.message);
      });
  }

  /** 判定沙箱 MCP 配置：lita-work（判定令牌） */
  private judgeMcpServers(judgeToken: string): Record<string, unknown> {
    return {
      ['lita-work']: {
        type: 'remote',
        url: `${this.appUrl.replace(/\/+$/, '')}/api/mcp/work`,
        oauth: false,
        headers: { 'X-Worker-Token': judgeToken },
      },
    };
  }

  /** 交付正文：HANDOFF 正文 + 任务文本类文档正文（判定输入用） */
  private async deliverContent(task: Task): Promise<string> {
    const handoff = await this.taskDocuments
      .readHandoff(task)
      .catch(() => null);
    const parts: string[] = [
      `### HANDOFF\n${handoff?.content ?? '（无交付内容）'}`,
    ];
    try {
      const docs = await this.taskDocuments.listTaskDocuments(task);
      for (const doc of docs) {
        parts.push(`### 文档：${doc.name}\n${doc.description ?? ''}`);
      }
    } catch {
      /* 文档读取失败不阻断判定 */
    }
    return parts.join('\n\n');
  }

  /**
   * 判定会话结束回调：未提交有效判定时重试（最多 JUDGE_MAX_ATTEMPTS 次），
   * 仍失败 → JUDGE_FAILED + 评估项 ERROR（16 节）。
   */
  private async onJudgeSessionEnd(
    itemId: number,
    round: number,
  ): Promise<void> {
    this.judging.delete(itemId);
    const item = await this.items.findOne({ where: { id: itemId } });
    if (!item || item.status !== EvalItemStatus.JUDGING) return;
    // 已提交有效判定（由 submit_eval_judgement 处理并推进）则无需重试
    const effective = await this.judgements.findOne({
      where: { itemId, round, effective: true },
    });
    if (effective) return;
    const attempts = item.attempt ?? 1;
    if (attempts < JUDGE_MAX_ATTEMPTS) {
      await this.updateItem(itemId, { attempt: attempts + 1 });
      void this.onJudgeFailed(itemId, round, '判定会话未提交有效结果');
      return;
    }
    await this.onJudgeFailed(itemId, round, '判定重试耗尽');
  }

  /** 判定失败统一处理：更新重试或终止 */
  private async onJudgeFailed(
    itemId: number,
    round: number,
    message: string,
  ): Promise<void> {
    const item = await this.items.findOne({ where: { id: itemId } });
    if (!item) return;
    const attempts = item.attempt ?? 1;
    if (attempts < JUDGE_MAX_ATTEMPTS) {
      // 未到上限：重开判定会话（同一轮）
      await this.updateItem(itemId, { attempt: attempts + 1 });
      const task = item.taskId
        ? await this.tasks.findOne({ where: { id: item.taskId } })
        : null;
      if (task && task.subStatus === TaskSubStatus.PENDING_ACCEPT) {
        await this.startJudge(item, task, round);
      }
      return;
    }
    await this.addEvent(itemId, EvalEventType.JUDGE_FAILED, {
      round,
      message,
    });
    await this.markItemError(itemId, `判定失败：${message}`);
  }

  /** MCP submit_eval_judgement 入口：校验 → 证据 → 算分 → 落库 → 推进 */
  async submitJudgement(
    itemId: number,
    round: number,
    raw: string,
  ): Promise<{ ok: boolean; message: string; score?: number; pass?: boolean }> {
    const item = await this.items.findOne({ where: { id: itemId } });
    if (!item) return { ok: false, message: '评估项不存在' };
    if (item.status !== EvalItemStatus.JUDGING) {
      return { ok: false, message: '当前不在判定阶段' };
    }
    const run = await this.runs.findOne({ where: { id: item.runId } });
    if (!run) return { ok: false, message: '评估批次不存在' };
    const caseFrozen = this.frozenCase(run, item.caseId);
    if (!caseFrozen) return { ok: false, message: '用例不在冻结范围内' };
    const task = item.taskId
      ? await this.tasks.findOne({ where: { id: item.taskId } })
      : null;
    const deliver = task ? await this.deliverContent(task) : '';
    const result = this.judgeService.validateJudgement(
      caseFrozen,
      deliver,
      raw,
    );
    if (!result.ok) {
      return { ok: false, message: result.message ?? '判定格式错误' };
    }
    const input = this.judgeService.getInput(itemId);
    const saved = await this.judgements.save(
      this.judgements.create({
        itemId,
        round,
        attempt: item.attempt ?? 1,
        model: null,
        inputDigest: input?.digest ?? null,
        rawOutput: raw,
        pointsResult: result.points ?? [],
        score: result.score,
        pass: result.pass,
        reason: result.reason ?? '',
        truncated: input?.truncated ?? false,
        effective: true,
      }),
    );
    await this.judgements.update(
      { itemId, round, effective: true },
      { effective: false },
    );
    await this.judgements.update({ id: saved.id }, { effective: true });
    await this.addEvent(item.id, EvalEventType.JUDGE_DONE, {
      round,
      score: result.score,
      pass: result.pass,
    });
    this.judgeService.clearInput(itemId);

    // 推进状态机
    if (round === 1) {
      await this.updateItem(item.id, { firstScore: result.score });
      if (result.pass) {
        await this.acceptAndFinish(item, EvalItemResult.FIRST_PASS);
      } else {
        const feedback = this.buildReworkFeedback(
          caseFrozen,
          result.points ?? [],
        );
        const task = item.taskId
          ? await this.tasks.findOne({ where: { id: item.taskId } })
          : null;
        if (task) {
          await this.collaboration
            .refuseHandoff(
              task.id,
              workerRequesterActor(await this.requireEvaluator(run)),
              feedback,
            )
            .catch((error: Error) =>
              this.logger.warn(
                `评估项 #${item.id} 返工退回失败: ${error.message}`,
              ),
            );
        }
        await this.updateItem(item.id, {
          status: EvalItemStatus.REWORKING,
          reworkCount: 1,
        });
        await this.addEvent(item.id, EvalEventType.REWORK_SENT, { feedback });
      }
    } else {
      await this.updateItem(item.id, { finalScore: result.score });
      if (result.pass) {
        await this.acceptAndFinish(item, EvalItemResult.PASS_AFTER_REWORK);
      } else {
        const task = item.taskId
          ? await this.tasks.findOne({ where: { id: item.taskId } })
          : null;
        if (task) {
          await this.collaboration
            .fail(
              task.id,
              workerRequesterActor(await this.requireEvaluator(run)),
              '评估未通过，判定为不满足期望。',
            )
            .catch((error: Error) =>
              this.logger.warn(
                `评估项 #${item.id} 判失败失败: ${error.message}`,
              ),
            );
        }
        await this.finishItem(item, {
          status: EvalItemStatus.DONE,
          result: EvalItemResult.FAILED,
        });
      }
    }
    return {
      ok: true,
      message: `判定已提交：${result.pass ? '通过' : '未通过'}（得分 ${result.score}）`,
      score: result.score,
      pass: result.pass,
    };
  }

  private async acceptAndFinish(
    item: EvalRunItem,
    result: EvalItemResult,
  ): Promise<void> {
    const run = await this.runs.findOne({ where: { id: item.runId } });
    const task = item.taskId
      ? await this.tasks.findOne({ where: { id: item.taskId } })
      : null;
    if (run && task) {
      await this.collaboration
        .acceptHandoff(
          task.id,
          workerRequesterActor(await this.requireEvaluator(run)),
        )
        .catch((error: Error) =>
          this.logger.warn(`评估项 #${item.id} 验收通过失败: ${error.message}`),
        );
    }
    await this.finishItem(item, { status: EvalItemStatus.DONE, result });
  }

  private async requireEvaluator(run: EvalRun): Promise<Worker> {
    const evaluator = await this.workers.findOne({
      where: { id: run.evaluatorWorkerId },
    });
    if (!evaluator) throw new NotFoundException('评估机器人不存在');
    return evaluator;
  }

  /** 返工反馈（7.4）：只使用 hint，不暴露要点原文 */
  private buildReworkFeedback(
    caseFrozen: FrozenEvalCase,
    points: Array<{ idx: number; hit: number }>,
  ): string {
    const missed = points
      .filter((p) => p.hit < 1)
      .sort((a, b) => a.idx - b.idx);
    const hints = missed
      .map((m) => caseFrozen.points[m.idx - 1]?.hint?.trim() ?? null)
      .filter((h): h is string => Boolean(h));
    if (hints.length > 0) {
      return [
        '本次交付未通过验收，请根据以下提示修改后重新交付：',
        ...hints.map((h) => `- ${h}`),
      ].join('\n');
    }
    return '本次交付未通过验收，请自查是否完整满足任务要求后重新交付。';
  }

  /** 结束评估项：终态 + 指标回填 + 汇总 */
  private async finishItem(
    item: EvalRunItem,
    terminal: { status: EvalItemStatus; result: EvalItemResult | null },
  ): Promise<void> {
    const endedAt = new Date();
    await this.updateItem(item.id, {
      status: terminal.status,
      result: terminal.result,
      endedAt,
    });
    // 净执行时间（10.1）：结束 - 接受 - 等待答复
    if (item.acceptedAt) {
      const waitAnswer = await this.totalWaitAnswerMs(item.id);
      const net = Math.max(
        0,
        endedAt.getTime() - item.acceptedAt.getTime() - waitAnswer,
      );
      await this.updateItem(item.id, { netExecMs: String(net) });
    }
    if (item.firstApplyAt && item.acceptedAt) {
      const beforeFirstAnswer = await this.waitAnswerBefore(
        item.id,
        item.firstApplyAt,
      );
      const firstNet = Math.max(
        0,
        item.firstApplyAt.getTime() -
          item.acceptedAt.getTime() -
          beforeFirstAnswer,
      );
      await this.updateItem(item.id, { firstNetExecMs: String(firstNet) });
    }
    // 人工介入累计（10.2 human_count）
    await this.accumulateHumanActions(item);
    await this.refreshRunSummary(item.runId);
  }

  /** 等待答复总时长（10.1 wait_answer_ms） */
  private async totalWaitAnswerMs(itemId: number): Promise<number> {
    const rows = await this.events.find({
      where: {
        itemId,
        type: In([
          EvalEventType.QUESTION_ASKED,
          EvalEventType.QUESTION_ANSWERED,
        ]),
      },
      order: { id: 'ASC' },
    });
    let total = 0;
    for (let i = 0; i + 1 < rows.length; i += 2) {
      const asked = rows[i];
      const answered = rows[i + 1];
      if (
        asked.type === EvalEventType.QUESTION_ASKED &&
        answered.type === EvalEventType.QUESTION_ANSWERED
      ) {
        total += Math.max(0, answered.at.getTime() - asked.at.getTime());
      }
    }
    return total;
  }

  /** 第一次交付前的等待答复时长 */
  private async waitAnswerBefore(
    itemId: number,
    before: Date,
  ): Promise<number> {
    const rows = await this.events.find({
      where: {
        itemId,
        type: In([
          EvalEventType.QUESTION_ASKED,
          EvalEventType.QUESTION_ANSWERED,
        ]),
      },
      order: { id: 'ASC' },
    });
    let total = 0;
    for (let i = 0; i + 1 < rows.length; i += 2) {
      const asked = rows[i];
      const answered = rows[i + 1];
      if (
        asked.type === EvalEventType.QUESTION_ASKED &&
        answered.type === EvalEventType.QUESTION_ANSWERED &&
        answered.at <= before
      ) {
        total += Math.max(0, answered.at.getTime() - asked.at.getTime());
      }
    }
    return total;
  }

  /** 人工介入累计：评估任务上出现非评估机器人、非被测机器人的操作（10.2/9.6） */
  private async accumulateHumanActions(item: EvalRunItem): Promise<void> {
    if (!item.taskId) return;
    const run = await this.runs.findOne({ where: { id: item.runId } });
    if (!run) return;
    const target = await this.workers.findOne({
      where: { id: run.targetWorkerId },
    });
    const evaluator = await this.workers.findOne({
      where: { id: run.evaluatorWorkerId },
    });
    const known = new Set(
      [target?.name, evaluator?.name].filter((n): n is string => Boolean(n)),
    );
    const rows = await this.taskEvents.find({
      where: { taskId: item.taskId },
      select: { id: true, operator: true },
    });
    const human = rows.filter(
      (row) => row.operator && !known.has(row.operator),
    ).length;
    if (human > 0) {
      await this.items.increment({ id: item.id }, 'humanCount', human);
      await this.addEvent(item.id, EvalEventType.HUMAN_ACTION, {
        count: human,
      });
    }
  }

  /** 汇总批次（15.2 卡片指标子集） */
  private async refreshRunSummary(runId: number): Promise<void> {
    const run = await this.runs.findOne({ where: { id: runId } });
    if (!run) return;
    const rows = await this.items.find({
      where: { runId, superseded: false },
    });
    const valid = rows.filter(
      (r) =>
        r.status !== EvalItemStatus.ERROR &&
        r.status !== EvalItemStatus.CANCELED,
    );
    const done = rows.filter((r) => r.status === EvalItemStatus.DONE);
    const firstPass = done.filter(
      (r) => r.result === EvalItemResult.FIRST_PASS,
    ).length;
    const passAfterRework = done.filter(
      (r) => r.result === EvalItemResult.PASS_AFTER_REWORK,
    ).length;
    const scores = done
      .map((r) => r.finalScore ?? r.firstScore)
      .filter((s): s is number => s != null);
    const waitAnswers = rows
      .map((r) => Number(r.waitAnswerMs ?? 0))
      .filter(Boolean);
    const summary = {
      total: rows.length,
      done: rows.filter((r) => !ACTIVE_ITEM_STATUSES.includes(r.status)).length,
      firstPass,
      passAfterRework,
      failed: rows.filter(
        (r) =>
          r.status === EvalItemStatus.DONE &&
          r.result === EvalItemResult.FAILED,
      ).length,
      refused: rows.filter((r) => r.status === EvalItemStatus.REFUSED).length,
      timeout: rows.filter((r) => r.status === EvalItemStatus.TIMEOUT).length,
      error: rows.filter((r) => r.status === EvalItemStatus.ERROR).length,
      canceled: rows.filter((r) => r.status === EvalItemStatus.CANCELED).length,
      avgScore: scores.length
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        : null,
      passRate: valid.length
        ? Math.round(((firstPass + passAfterRework) / valid.length) * 100)
        : null,
      avgIntervention: rows.length
        ? Math.round(
            (rows.reduce((a, r) => a + r.interventionCount, 0) / rows.length) *
              10,
          ) / 10
        : 0,
      avgWaitAnswerMs: waitAnswers.length
        ? Math.round(
            waitAnswers.reduce((a, b) => a + b, 0) / waitAnswers.length,
          )
        : null,
    };
    const activeRemain = rows.some((r) =>
      ACTIVE_ITEM_STATUSES.includes(r.status),
    );
    const newStatus = activeRemain
      ? run.status === EvalRunStatus.CANCELED
        ? EvalRunStatus.CANCELED
        : EvalRunStatus.RUNNING
      : EvalRunStatus.COMPLETED;
    await this.runs.update(
      { id: runId },
      {
        summary: summary as never,
        status: newStatus,
        finishedAt: activeRemain ? run.finishedAt : new Date(),
      },
    );
  }

  /** 冻结用例（批次快照内查找） */
  private frozenCase(run: EvalRun, caseId: number): FrozenEvalCase | null {
    return run.suiteSnapshot?.cases?.find((c) => c.id === caseId) ?? null;
  }

  /** 创建评估批次（14.1 POST /api/eval/runs） */
  async createRun(input: CreateEvalRunInput): Promise<EvalRun> {
    const suite = await this.suites.findOne({ where: { id: input.suiteId } });
    if (!suite) throw new NotFoundException('测试集不存在');
    const target = await this.workers.findOne({
      where: { id: input.targetWorkerId },
    });
    if (!target || !target.enabled) {
      throw new BadRequestException('被测机器人不存在或已停用');
    }
    if (target.runtime === WorkerRuntime.HUMAN) {
      throw new BadRequestException('真人机器人不能作为被测对象');
    }
    const evaluator = await this.workers.findOne({
      where: { id: input.evaluatorWorkerId },
    });
    if (!evaluator || !evaluator.enabled) {
      throw new BadRequestException('评估机器人不存在或已停用');
    }
    const repeatCount = Math.min(5, Math.max(1, input.repeatCount ?? 3));
    const concurrency = Math.min(5, Math.max(1, input.concurrency ?? 3));

    const cases = await this.cases.find({
      where: { suiteId: suite.id, enabled: true },
      order: { seq: 'ASC', id: 'ASC' },
    });
    if (cases.length === 0) {
      throw new BadRequestException('测试集没有启用中的用例');
    }
    if (cases.length * repeatCount > RUN_ITEM_LIMIT) {
      throw new BadRequestException(
        `评估项数量超过上限（${RUN_ITEM_LIMIT}）：用例 ${cases.length} × 重复 ${repeatCount}`,
      );
    }
    const pointRows = await this.points.find({
      where: { caseId: In(cases.map((c) => c.id)) },
      order: { seq: 'ASC', id: 'ASC' },
    });
    const pointsByCase = new Map<number, FrozenEvalCase['points']>();
    for (const point of pointRows) {
      const list = pointsByCase.get(point.caseId) ?? [];
      list.push({
        id: point.id,
        seq: point.seq,
        point: point.point,
        required: point.required,
        weight: point.weight,
        hint: point.hint,
      });
      pointsByCase.set(point.caseId, list);
    }
    const frozenCases: FrozenEvalCase[] = cases.map((c) => ({
      id: c.id,
      caseKey: c.caseKey,
      seq: c.seq,
      title: c.title,
      prompt: c.prompt,
      clarify: c.clarify,
      passThreshold: c.passThreshold,
      timeoutSec: c.timeoutSec,
      enabled: true,
      points: pointsByCase.get(c.id) ?? [],
    }));

    const snapshot = await this.sandbox.ensureSnapshot(target);
    const run = await this.runs.save(
      this.runs.create({
        suiteId: suite.id,
        suiteVersion: suite.version,
        suiteSnapshot: {
          id: suite.id,
          name: suite.name,
          purpose: suite.purpose,
          passThreshold: suite.passThreshold,
          defaultTimeoutSec: suite.defaultTimeoutSec,
          maxQuestions: suite.maxQuestions,
          version: suite.version,
          cases: frozenCases,
        },
        targetWorkerId: target.id,
        targetWorkerName: target.name,
        evaluatorWorkerId: evaluator.id,
        snapshotId: snapshot.id,
        role: EvalRunRole.NORMAL,
        repeatCount,
        concurrency,
        mcpPolicy: input.mcpPolicy ?? null,
        status: EvalRunStatus.QUEUED,
        createdById: input.createdById ?? null,
        createdByName: input.createdByName ?? null,
      }),
    );
    for (const caseFrozen of frozenCases) {
      for (let k = 1; k <= repeatCount; k++) {
        await this.items.save(
          this.items.create({
            runId: run.id,
            caseId: caseFrozen.id,
            repeatIndex: k,
            attempt: 1,
            superseded: false,
            status: EvalItemStatus.PENDING,
          }),
        );
      }
    }
    await this.runs.update(
      { id: run.id },
      { status: EvalRunStatus.RUNNING, startedAt: new Date() },
    );
    void this.tick().catch(() => {});
    return this.runs.findOneOrFail({ where: { id: run.id } });
  }

  /** 取消批次（未开始项直接取消；执行中项停止会话、销毁沙箱） */
  async cancelRun(runId: number): Promise<EvalRun> {
    const run = await this.runs.findOne({ where: { id: runId } });
    if (!run) throw new NotFoundException('评估批次不存在');
    if (run.status === EvalRunStatus.COMPLETED) {
      throw new ConflictException('评估批次已完成，不能取消');
    }
    await this.runs.update(
      { id: runId },
      { status: EvalRunStatus.CANCELED, finishedAt: new Date() },
    );
    const items = await this.items.find({
      where: { runId, superseded: false },
    });
    for (const item of items) {
      if (ACTIVE_ITEM_STATUSES.includes(item.status)) {
        await this.cancelItem(item);
      }
    }
    await this.refreshRunSummary(runId);
    return this.runs.findOneOrFail({ where: { id: runId } });
  }

  private async cancelItem(item: EvalRunItem): Promise<void> {
    // 中断执行中的评估会话
    if (item.taskId) {
      const task = await this.tasks.findOne({ where: { id: item.taskId } });
      if (task) {
        await this.interruptTaskSession(task).catch(() => {});
        if (task.subStatus === TaskSubStatus.PENDING_ACCEPT) {
          const run = await this.runs.findOne({ where: { id: item.runId } });
          if (run) {
            await this.collaboration
              .fail(
                task.id,
                workerRequesterActor(await this.requireEvaluator(run)),
                '评估已取消',
              )
              .catch(() => {});
          }
        }
      }
    }
    await this.updateItem(item.id, {
      status: EvalItemStatus.CANCELED,
      endedAt: new Date(),
    });
    await this.addEvent(item.id, EvalEventType.CANCELED, {});
    await this.destroyItemSandbox(item);
  }

  /** 重跑评估项（仅 ERROR/TIMEOUT；旧记录标记被替代） */
  async rerunItem(itemId: number): Promise<EvalRunItem> {
    const item = await this.items.findOne({ where: { id: itemId } });
    if (!item) throw new NotFoundException('评估项不存在');
    if (item.superseded) throw new ConflictException('评估项已被重跑替代');
    if (![EvalItemStatus.ERROR, EvalItemStatus.TIMEOUT].includes(item.status)) {
      throw new ConflictException('仅异常/超时的评估项可以重跑');
    }
    await this.items.update({ id: item.id }, { superseded: true });
    const newItem = await this.items.save(
      this.items.create({
        runId: item.runId,
        caseId: item.caseId,
        repeatIndex: item.repeatIndex,
        attempt: item.attempt + 1,
        superseded: false,
        status: EvalItemStatus.PENDING,
      }),
    );
    // 已完成批次重跑后重新进入执行中（批次状态仅在项终态时重算）
    const run = await this.runs.findOne({ where: { id: item.runId } });
    if (run && run.status === EvalRunStatus.COMPLETED) {
      await this.runs.update({ id: run.id }, { status: EvalRunStatus.RUNNING });
    }
    void this.tick().catch(() => {});
    return newItem;
  }

  /** 重新判定：用当前（归档的最终）交付内容重开判定，新判定生效、旧判定保留 */
  async rejudgeItem(itemId: number): Promise<EvalJudgement> {
    const item = await this.items.findOne({ where: { id: itemId } });
    if (!item) throw new NotFoundException('评估项不存在');
    const run = await this.runs.findOne({ where: { id: item.runId } });
    if (!run) throw new NotFoundException('评估批次不存在');
    const caseFrozen = this.frozenCase(run, item.caseId);
    if (!caseFrozen) throw new NotFoundException('用例不在冻结范围内');
    const task = item.taskId
      ? await this.tasks.findOne({ where: { id: item.taskId } })
      : null;
    const deliver = task ? await this.deliverContent(task) : '';
    const round = item.firstApplyAt ? (item.reworkCount > 0 ? 2 : 1) : 1;
    const raw = ''; // 重新判定：重开判定会话（异步）由引擎推进
    void raw;
    // 阶段一：重新判定走判定会话（JUDGING 状态）
    if (item.status !== EvalItemStatus.JUDGING) {
      await this.updateItem(item.id, { status: EvalItemStatus.JUDGING });
      if (task) {
        await this.startJudge(item, task, round);
      } else {
        await this.markItemError(item.id, '评估任务已不存在，无法重新判定');
      }
    }
    const latest = await this.judgements.findOne({
      where: { itemId, round, effective: true },
      order: { id: 'DESC' },
    });
    if (!latest) throw new NotFoundException('没有可用的判定记录');
    void deliver;
    return latest;
  }

  /** 超时检查（7.5）：从 SANDBOX_READY 起计时，超过 timeout_sec 判超时 */
  private async checkTimeouts(): Promise<void> {
    const rows = await this.items.find({
      where: {
        status: In([
          EvalItemStatus.PREPARING,
          EvalItemStatus.INVITED,
          EvalItemStatus.RUNNING,
          EvalItemStatus.WAITING_ANSWER,
          EvalItemStatus.REWORKING,
        ]),
        superseded: false,
      },
      order: { id: 'ASC' },
      take: 50,
    });
    const now = Date.now();
    for (const item of rows) {
      const run = await this.runs.findOne({ where: { id: item.runId } });
      if (!run) continue;
      const caseFrozen = this.frozenCase(run, item.caseId);
      const timeoutSec =
        caseFrozen?.timeoutSec ?? run.suiteSnapshot?.defaultTimeoutSec ?? 1800;
      const started = await this.sandboxReadyAt(item.id);
      const begin = started ?? item.updatedAt ?? item.createdAt;
      if (now - begin.getTime() > timeoutSec * 1000) {
        await this.timeoutItem(item, timeoutSec);
      }
    }
  }

  private async sandboxReadyAt(itemId: number): Promise<Date | null> {
    const ev = await this.events.findOne({
      where: { itemId, type: EvalEventType.SANDBOX_READY },
      order: { id: 'DESC' },
    });
    return ev?.at ?? null;
  }

  private async timeoutItem(
    item: EvalRunItem,
    timeoutSec: number,
  ): Promise<void> {
    this.logger.warn(`评估项 #${item.id} 超时（${timeoutSec}s）`);
    await this.addEvent(item.id, EvalEventType.TIMEOUT, { timeoutSec });
    if (item.taskId) {
      const task = await this.tasks.findOne({ where: { id: item.taskId } });
      if (task) {
        await this.interruptTaskSession(task).catch(() => {});
        if (
          task.status === TaskStatus.WAITING &&
          task.subStatus === TaskSubStatus.PENDING_ACCEPT
        ) {
          const run = await this.runs.findOne({ where: { id: item.runId } });
          if (run) {
            await this.collaboration
              .fail(
                task.id,
                workerRequesterActor(await this.requireEvaluator(run)),
                '评估超时',
              )
              .catch(() => {});
          }
        }
      }
    }
    await this.updateItem(item.id, {
      status: EvalItemStatus.TIMEOUT,
      endedAt: new Date(),
    });
    await this.destroyItemSandbox(item);
    await this.refreshRunSummary(item.runId);
  }

  private async interruptTaskSession(task: Task): Promise<void> {
    if (!task.executorId || !task.opencodeSessionId) return;
    const executor = await this.executors.findOne({
      where: { id: task.executorId },
    });
    if (!executor) return;
    await createExecutorClient(executor)
      .interrupt(task.opencodeSessionId)
      .catch(() => {});
  }

  /** 销毁评估项沙箱（被测方沙箱 + 判定沙箱） */
  private async destroyItemSandbox(item: EvalRunItem): Promise<void> {
    const root = this.workersService.evalSandboxRoot();
    const run = await this.runs.findOne({ where: { id: item.runId } });
    // 判定沙箱：位于评估机器人执行器宿主的 {root}/judge/{itemId}
    if (root && run) {
      const evaluator = await this.workers.findOne({
        where: { id: run.evaluatorWorkerId },
      });
      const judgeExecutor = evaluator?.executorId
        ? await this.executors.findOne({ where: { id: evaluator.executorId } })
        : null;
      if (judgeExecutor) {
        await this.sandbox
          .destroySandbox(
            createExecutorClient(judgeExecutor),
            `${root}/judge/${item.id}`,
          )
          .catch(() => {});
      }
    }
    if (!item.sandboxId) return;
    const sandbox = this.workersService.evalSandboxWorkdir(item.sandboxId);
    const task = item.taskId
      ? await this.tasks.findOne({ where: { id: item.taskId } })
      : null;
    const workerId = task?.agentId ?? null;
    if (!sandbox || !workerId) return;
    const worker = await this.workers.findOne({ where: { id: workerId } });
    const executor = worker?.executorId
      ? await this.executors.findOne({ where: { id: worker.executorId } })
      : null;
    if (!executor) return;
    await this.sandbox
      .destroySandbox(createExecutorClient(executor), sandbox)
      .catch(() => {});
    await this.addEvent(item.id, EvalEventType.SANDBOX_DESTROYED, {});
  }

  async markItemError(itemId: number, message: string): Promise<void> {
    const item = await this.items.findOne({ where: { id: itemId } });
    if (!item || TERMINAL_ITEM_STATUSES.includes(item.status)) return;
    await this.updateItem(itemId, {
      status: EvalItemStatus.ERROR,
      errorMessage: message.slice(0, 1024),
      endedAt: new Date(),
    });
    await this.addEvent(itemId, EvalEventType.ERROR, { message });
    await this.destroyItemSandbox(item);
    await this.refreshRunSummary(item.runId);
  }

  private async updateItem(
    itemId: number,
    patch: Partial<EvalRunItem>,
  ): Promise<void> {
    await this.items.update({ id: itemId }, patch);
    const item = await this.items.findOne({ where: { id: itemId } });
    if (item) this.progress.emitRun(item.runId);
  }

  /** 写评估项事件 */
  async addEvent(
    itemId: number,
    type: EvalEventType,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.events
      .save(
        this.events.create({
          itemId,
          type,
          at: new Date(),
          payload: payload ?? null,
        }),
      )
      .catch((error: Error) => {
        this.logger.warn(`评估事件写入失败 #${itemId}: ${error.message}`);
      });
  }

  /** 记录被拦截的写操作（9.4） */
  async recordBlocked(
    evalItemId: number,
    kind: 'write' | 'subtask',
    tool: string,
  ): Promise<void> {
    await this.addEvent(evalItemId, EvalEventType.WRITE_BLOCKED, {
      tool,
      kind,
    });
    await this.items
      .increment({ id: evalItemId }, 'blockedWriteCount', 1)
      .catch(() => {});
  }

  /** 平台重启恢复：非终态项 → 任务丢失/执行器会话丢失标 ERROR（16 节） */
  async onApplicationBootstrap(): Promise<void> {
    const rows = await this.items.find({
      where: { status: In(ACTIVE_ITEM_STATUSES), superseded: false },
      order: { id: 'ASC' },
      take: 200,
    });
    for (const item of rows) {
      // 排队项无任务、无沙箱，无中断态可恢复，重启后由 ticker 继续调度
      if (item.status === EvalItemStatus.PENDING) continue;
      if (!item.taskId) {
        await this.markItemError(item.id, '平台重启导致评估中断（任务未创建）');
        continue;
      }
      const task = await this.tasks.findOne({ where: { id: item.taskId } });
      if (!task) {
        await this.markItemError(item.id, '评估任务丢失');
        continue;
      }
      if (item.status === EvalItemStatus.RUNNING && task.opencodeSessionId) {
        // 会话是否仍在：交给派发层恢复（reconcileExecuting），此处不重复判定
      }
    }
  }

  /** 查询辅助（报告 / 单项详情 / 事件 / 判定记录） */
  async findRun(runId: number): Promise<EvalRun> {
    const run = await this.runs.findOne({ where: { id: runId } });
    if (!run) throw new NotFoundException('评估批次不存在');
    return run;
  }

  async listRuns(query: {
    suiteId?: number;
    targetWorkerId?: number;
    limit?: number;
  }): Promise<EvalRun[]> {
    const where: Record<string, unknown> = {};
    if (query.suiteId) where.suiteId = query.suiteId;
    if (query.targetWorkerId) where.targetWorkerId = query.targetWorkerId;
    return this.runs.find({
      where,
      order: { id: 'DESC' },
      take: Math.min(100, query.limit ?? 50),
    });
  }

  async listItems(runId: number): Promise<EvalRunItem[]> {
    return this.items.find({
      where: { runId },
      order: { id: 'ASC' },
    });
  }

  async findItem(itemId: number): Promise<EvalRunItem> {
    const item = await this.items.findOne({ where: { id: itemId } });
    if (!item) throw new NotFoundException('评估项不存在');
    return item;
  }

  async listEvents(itemId: number): Promise<EvalEvent[]> {
    return this.events.find({
      where: { itemId },
      order: { id: 'ASC' },
    });
  }

  async listJudgements(itemId: number): Promise<EvalJudgement[]> {
    return this.judgements.find({
      where: { itemId },
      order: { id: 'ASC' },
    });
  }
}

/** 工具函数：MCP 名称占位（自定义 MCP 阶段一不注入，保留策略记录） */
function namesOfMcp(mcps: number[]): string[] {
  void mcps;
  return [];
}
