import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, MoreThan, Repository } from 'typeorm';
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
import { TaskDispatchService } from '../tasks/task-dispatch.service';
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
/** 同一提问答复失败上限（超过后评估项转异常，避免每 2 秒空转） */
const ANSWER_MAX_ATTEMPTS = 3;
/** 单个批次评估项数量上限（15.3） */
const RUN_ITEM_LIMIT = 200;
/** 同一时刻最多启动几个判定会话（判定与执行分开计数） */
export const EVAL_JUDGE_CONCURRENCY = 3;
/** 单个判定会话最长存活：判定会话自身 5 分钟超时 + 沙箱构建余量 */
const JUDGE_SESSION_DEADLINE_MS = 6 * 60_000;
/** 判定阶段整体兜底：每轮最多 JUDGE_MAX_ATTEMPTS 个会话，仍无结果即异常 */
const JUDGE_ITEM_TIMEOUT_MS =
  JUDGE_SESSION_DEADLINE_MS * JUDGE_MAX_ATTEMPTS + 5 * 60_000;
/** 会话执行失败后的自动续跑次数与退避 */
const TURN_FAILURE_MAX_RESUME = 2;
const TURN_FAILURE_RESUME_DELAYS_MS = [30_000, 3 * 60_000];
/** 每轮 tick 最多尝试启动的排队项、最多推进的活跃项 */
const PENDING_ADMISSION_BATCH = 50;
const ACTIVE_ITEM_LIMIT = 200;
/** 超时检查分页大小（避免只检查 id 最小的一批） */
const TIMEOUT_SCAN_PAGE = 100;

export const RULE_ANSWER_MORE =
  '补充信息已全部提供，请按你的理解继续完成并交付。';
export const RULE_ANSWER_STOP = '不再答复提问，请基于已有信息直接完成并交付。';

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

/**
 * 非终态评估项状态（调度/推进遍历用；排队项由启动流程单独处理）
 */
const ACTIVE_ITEM_STATUSES = [
  EvalItemStatus.PENDING,
  EvalItemStatus.PREPARING,
  EvalItemStatus.INVITED,
  EvalItemStatus.RUNNING,
  EvalItemStatus.WAITING_ANSWER,
  EvalItemStatus.JUDGING,
  EvalItemStatus.REWORKING,
];

/** 排队之外的非终态状态（每轮 tick 逐个推进） */
const IN_FLIGHT_ITEM_STATUSES = ACTIVE_ITEM_STATUSES.filter(
  (status) => status !== EvalItemStatus.PENDING,
);

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
  /** 判定会话开始时间（itemId → 毫秒，判定会话超时兜底用） */
  private readonly judgeStartedAt = new Map<number, number>();
  /** 判定会话 id（itemId → sessionId，评估项结束时销毁） */
  private readonly judgeSessions = new Map<number, string>();
  /** 正在启动（准备中 → 已邀约）的评估项，重启后需要重新进入启动流程 */
  private readonly launching = new Set<number>();
  /** 同一时刻只跑一个启动流程：占位计数与占位写入之间不允许并发穿透 */
  private admitting = false;
  /** 正在推进判定的评估项（提交与会话结束回调可能同时触发，防重复推进） */
  private readonly applying = new Set<number>();
  /** 会话执行失败后的自动续跑次数（itemId → 次数） */
  private readonly turnFailures = new Map<number, number>();
  /** 自动续跑定时器（itemId → timer） */
  private readonly resumeTimers = new Map<number, NodeJS.Timeout>();

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
    private readonly dispatch: TaskDispatchService,
    private readonly collaboration: TaskCollaborationService,
    private readonly taskDocuments: TaskDocumentService,
    private readonly workersService: WorkersService,
    private readonly sandbox: EvalSandboxService,
    private readonly token: EvalTokenService,
    private readonly judgeService: EvalJudgeService,
    private readonly progress: EvalProgressService,
    private readonly dataSource: DataSource,
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
    // 评估任务的会话失败由引擎收尾（派发侧只结束本轮）：回调注入避免模块循环依赖
    this.dispatch.evalTurnFailedHook = (task, reason) =>
      this.onEvalTurnFailed(task, reason);
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
    const pending = await this.items.find({
      where: { status: EvalItemStatus.PENDING, superseded: false },
      order: { id: 'ASC' },
      take: PENDING_ADMISSION_BATCH,
    });
    const active = await this.items.find({
      where: { status: In(IN_FLIGHT_ITEM_STATUSES), superseded: false },
      order: { id: 'ASC' },
      take: ACTIVE_ITEM_LIMIT,
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
    await this.admitPending(pending);
  }

  /**
   * 排队项启动：同一时刻只有一个启动流程，逐个「先计数、再原子占位」。
   * 占位成功的项已经是「准备中」并计入占用，后一个项看到的一定是最新占用数，
   * 因此不会出现同一轮把所有排队项都判为「有空位」一起放出去。
   */
  private async admitPending(pending: EvalRunItem[]): Promise<void> {
    if (this.admitting || pending.length === 0) return;
    this.admitting = true;
    try {
      for (const item of pending) {
        if (this.busy.has(item.id) || this.launching.has(item.id)) continue;
        const claim = await this.claimSlot(item);
        if (claim === 'claimed') {
          this.launch(item);
          continue;
        }
        // 全局已满：后面的排队项这轮也拿不到槽位，不必逐项再开事务
        if (claim === 'global-full') break;
      }
    } catch (error) {
      this.logger.warn(`评估项启动流程异常: ${(error as Error).message}`);
    } finally {
      this.admitting = false;
    }
  }

  /**
   * 原子占位：事务内加 advisory 锁后重新计数，再条件更新「排队 → 准备中」。
   * 只有更新成功的项才真正占到槽位，随后才建沙箱与任务。
   */
  private async claimSlot(
    item: EvalRunItem,
  ): Promise<'claimed' | 'run-full' | 'global-full' | 'skipped'> {
    const claimed = await this.dataSource.transaction(async (manager) => {
      // 全局槽位跨批次，行锁无法串行化，用常量 advisory 锁保证多实例下也只放行一个
      await manager.query(
        "SELECT pg_advisory_xact_lock(hashtext('eval:admission'))",
      );
      const run = await manager.findOne(EvalRun, { where: { id: item.runId } });
      if (!run || run.status === EvalRunStatus.CANCELED) return 'skipped';
      const runOccupying = await manager.count(EvalRunItem, {
        where: {
          runId: run.id,
          status: In(OCCUPYING_ITEM_STATUSES),
          superseded: false,
        },
      });
      if (runOccupying >= Math.max(1, run.concurrency)) return 'run-full';
      const globalOccupying = await manager.count(EvalRunItem, {
        where: { status: In(OCCUPYING_ITEM_STATUSES), superseded: false },
      });
      if (globalOccupying >= EVAL_GLOBAL_CONCURRENCY) return 'global-full';
      const updated = await manager.update(
        EvalRunItem,
        {
          id: item.id,
          status: EvalItemStatus.PENDING,
          superseded: false,
        },
        { status: EvalItemStatus.PREPARING },
      );
      return (updated.affected ?? 0) === 1 ? 'claimed' : 'skipped';
    });
    if (claimed === 'claimed') this.progress.emitRun(item.runId);
    return claimed;
  }

  /** 启动已占位的评估项：失败转异常并释放槽位 */
  private launch(item: EvalRunItem): void {
    this.launching.add(item.id);
    void this.startItem(item)
      .catch(async (error: Error) => {
        this.logger.warn(
          `评估项 #${item.id} 启动失败：${error.message}，转为异常`,
        );
        await this.markItemError(item.id, error.message);
      })
      .finally(() => this.launching.delete(item.id));
  }

  /**
   * 启动已占位的评估项（可重入）：建任务 → 建沙箱 → 推进到「待接受」。
   * 服务重启时停在「准备中」的项由 tick 重新进入这里，已创建的任务与已就绪的沙箱直接复用。
   */
  private async startItem(item: EvalRunItem): Promise<void> {
    const run = await this.runs.findOne({ where: { id: item.runId } });
    if (!run) throw new NotFoundException(`评估批次 #${item.runId} 不存在`);
    if (run.status === EvalRunStatus.CANCELED) {
      await this.updateItem(item.id, {
        status: EvalItemStatus.CANCELED,
        endedAt: new Date(),
      });
      await this.refreshRunSummary(item.runId);
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
    const sandboxId = item.sandboxId ?? `${run.id}/${item.id}`;
    const sandbox = this.workersService.evalSandboxWorkdir(sandboxId);
    if (!sandbox) {
      throw new ConflictException('未配置 WORKER_BASE_DIR，无法创建评估沙箱');
    }
    if (!item.sandboxId) await this.updateItem(item.id, { sandboxId });

    // 1. 评估任务（需求方=评估机器人，执行方=被测机器人）：重启重入时复用
    let task = item.taskId
      ? await this.tasks.findOne({ where: { id: item.taskId } })
      : null;
    if (!task) {
      task = await this.tasksService.create({
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
      await this.updateItem(item.id, { taskId: task.id });
      await this.addEvent(item.id, EvalEventType.TASK_CREATED, {
        taskId: task.id,
      });
    }

    // 2. 沙箱：复制真实工位 → 剔除 docs/ 与凭据 → 注入评估令牌与过滤后的 MCP
    if (!(await this.hasAnyEvent(item.id, EvalEventType.SANDBOX_READY))) {
      // 评估令牌（作用域=评估任务；协议层按 9.3 校验）
      const evalToken = this.token.sign({
        kind: 'eval',
        workerId: target.id,
        evalItemId: item.id,
        taskId: task.id,
        judge: false,
      });
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
    }

    // 3. 直接推进到「待接受」，由 LOOP offerPending 发送邀约（评估任务不占用真实容量）
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
    await this.updateItem(item.id, { status: EvalItemStatus.INVITED });
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
      case EvalItemStatus.PENDING:
        // 排队项统一由 admitPending 原子占位后启动，这里不再各自查槽位
        return;
      case EvalItemStatus.PREPARING:
        // 启动流程中断（服务重启/进程异常）：没有在跑的启动就重新进入
        if (!this.launching.has(item.id)) this.launch(item);
        return;
      case EvalItemStatus.INVITED:
      case EvalItemStatus.RUNNING:
      case EvalItemStatus.WAITING_ANSWER:
      case EvalItemStatus.REWORKING:
        await this.progressTaskRelation(item);
        return;
      case EvalItemStatus.JUDGING:
        await this.reconcileJudging(item);
        return;
      default:
        return;
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
      case TaskSubStatus.PENDING_FEEDBACK: {
        // 提问可能发生在刚接受（引擎还没观察到执行中）或返工中，都要按规则答复
        if (item.status === EvalItemStatus.INVITED) {
          await this.updateItem(item.id, {
            status: EvalItemStatus.RUNNING,
            acceptedAt: new Date(),
          });
          await this.addEvent(item.id, EvalEventType.ACCEPTED, {});
        }
        if (
          item.status === EvalItemStatus.RUNNING ||
          item.status === EvalItemStatus.WAITING_ANSWER ||
          item.status === EvalItemStatus.INVITED ||
          item.status === EvalItemStatus.REWORKING
        ) {
          const previous = item.status;
          await this.updateItem(item.id, {
            status: EvalItemStatus.WAITING_ANSWER,
          });
          await this.answerQuestion(item, task, previous);
        }
        return;
      }
      case TaskSubStatus.PENDING_RESUME:
      case TaskSubStatus.PENDING_APPLY:
        // 待继续：LOOP 会恢复执行；待申请验收：LOOP 会重新唤醒。引擎等待。
        // 会话成功推进到这两个状态即视为本轮成功，清除失败续跑计数。
        this.turnFailures.delete(item.id);
        return;
      case TaskSubStatus.PENDING_ACCEPT: {
        // 交付完成 → 判定（第 1 轮 / 第 2 轮）：先进入判定中，
        // 判定会话由 tick 的判定对账启动（受判定并发上限约束，重启后自动接上）
        if (item.status === EvalItemStatus.JUDGING) return;
        const round = item.firstApplyAt ? 2 : 1;
        if (round === 1) {
          await this.updateItem(item.id, {
            firstApplyAt: new Date(),
            status: EvalItemStatus.JUDGING,
          });
        } else {
          await this.updateItem(item.id, {
            finalApplyAt: new Date(),
            status: EvalItemStatus.JUDGING,
          });
        }
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

  /**
   * 规则答复提问（7.3 / 12.7）：
   * - 只能从选项中选择的提问（custom=false）不代答，整轮跳过（答复接口的跳过以整条提问为单位）；
   *   跳过次数超过测试集「提问上限」后直接判定评估项失败（提问超限），不空转到超时。
   * - 其余提问按问题个数逐条答复（第一次提问使用用例 clarify）。
   * - 答复失败不推进状态机，时间线记异常事件；同一提问连续失败 ANSWER_MAX_ATTEMPTS 次转异常项。
   */
  private async answerQuestion(
    item: EvalRunItem,
    task: Task,
    previous: EvalItemStatus,
  ): Promise<void> {
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
    const question = row?.question;
    if (!question || question.state !== 'pending') return;
    const questionId = question.id;
    const questionCount = await this.messages.count({
      where: { taskId: task.id, kind: 'question' },
    });
    await this.updateItem(item.id, { questionCount });

    // 「提问」事件按 questionId 幂等：答复失败重试时不重复写时间线
    if (
      !(await this.hasEvent(item.id, EvalEventType.QUESTION_ASKED, questionId))
    ) {
      await this.addEvent(item.id, EvalEventType.QUESTION_ASKED, {
        questionId,
        questionCount,
      });
    }

    const maxQuestions = Math.max(1, run.suiteSnapshot?.maxQuestions ?? 3);
    const caseFrozen = this.frozenCase(run, item.caseId);
    const actor = workerRequesterActor(evaluator);
    try {
      // 只能从选项中选择（明确不接受自由输入）时规则答复无法作答，整轮跳过
      if (question.questions.some((one) => one.custom === false)) {
        const skipped =
          (await this.events.count({
            where: { itemId: item.id, type: EvalEventType.QUESTION_SKIPPED },
          })) + 1;
        if (skipped > maxQuestions) {
          await this.failByQuestionLimit(
            item,
            task,
            evaluator,
            questionId,
            maxQuestions,
          );
          return;
        }
        await this.collaboration.answer(task.id, questionId, actor, {
          reject: true,
        });
        await this.addEvent(item.id, EvalEventType.QUESTION_SKIPPED, {
          questionId,
          skipped,
          maxQuestions,
        });
      } else {
        const reply =
          questionCount === 1 && caseFrozen?.clarify
            ? caseFrozen.clarify
            : questionCount <= maxQuestions
              ? RULE_ANSWER_MORE
              : RULE_ANSWER_STOP;
        // 一次提问可包含多个问题，答案必须按问题顺序逐条给出
        const answers = question.questions.map(() => [reply]);
        await this.collaboration.answer(task.id, questionId, actor, {
          answers,
        });
        await this.addEvent(item.id, EvalEventType.QUESTION_ANSWERED, {
          questionId,
          questionCount,
          reply,
        });
      }
    } catch (error) {
      await this.recordAnswerFailure(item, questionId, error);
      return;
    }
    // 答复成功后恢复原状态（返工中的提问回到返工中）
    await this.updateItem(item.id, {
      status:
        previous === EvalItemStatus.REWORKING
          ? EvalItemStatus.REWORKING
          : EvalItemStatus.RUNNING,
    });
  }

  /** 同一评估项是否已记录过该 questionId 的提问事件 */
  private async hasEvent(
    itemId: number,
    type: EvalEventType,
    questionId: string,
  ): Promise<boolean> {
    const rows = await this.events.find({
      where: { itemId, type },
      select: { id: true, payload: true },
    });
    return rows.some(
      (row) =>
        (row.payload as { questionId?: string } | null)?.questionId ===
        questionId,
    );
  }

  /** 答复提问失败：记异常事件并等待下一轮重试，同一提问失败达上限转异常项 */
  private async recordAnswerFailure(
    item: EvalRunItem,
    questionId: string,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.addEvent(item.id, EvalEventType.ERROR, {
      stage: 'answer',
      questionId,
      message,
    });
    const rows = await this.events.find({
      where: { itemId: item.id, type: EvalEventType.ERROR },
      select: { id: true, payload: true },
    });
    const failures = rows.filter((row) => {
      const payload = row.payload as {
        stage?: string;
        questionId?: string;
      } | null;
      return payload?.stage === 'answer' && payload.questionId === questionId;
    }).length;
    if (failures >= ANSWER_MAX_ATTEMPTS) {
      await this.markItemError(
        item.id,
        `提问答复失败（已重试 ${failures} 次）：${message}`,
      );
    }
  }

  /**
   * 选项题跳过次数超过「提问上限」：直接判定评估项失败（提问超限）并结束评估任务。
   * 平台没有「待反馈」下的判失败入口，这里先置终态再取消任务，避免留下悬挂任务。
   */
  private async failByQuestionLimit(
    item: EvalRunItem,
    task: Task,
    evaluator: Worker,
    questionId: string,
    maxQuestions: number,
  ): Promise<void> {
    this.logger.warn(
      `评估项 #${item.id} 选项题跳过超过上限（${maxQuestions} 次），直接判失败`,
    );
    await this.addEvent(item.id, EvalEventType.QUESTION_LIMIT, {
      questionId,
      maxQuestions,
    });
    await this.finishItem(item, {
      status: EvalItemStatus.DONE,
      result: EvalItemResult.QUESTION_LIMIT,
    });
    await this.interruptTaskSession(task).catch(() => {});
    await this.tasksService
      .cancel(task.id, evaluator.name)
      .catch((error: Error) =>
        this.logger.warn(
          `评估项 #${item.id} 结束评估任务失败: ${error.message}`,
        ),
      );
    await this.destroyItemSandbox(item);
  }

  /** 启动判定：判定沙箱 + 评估机器人一次性判定会话（11.2/11.5） */
  private async startJudge(
    item: EvalRunItem,
    task: Task,
    round: number,
  ): Promise<void> {
    if (this.judging.has(item.id)) return;
    // 判定会话与服务并发分开：超过上限时保持「判定中」，由 tick 下一轮再启动
    if (this.judging.size >= EVAL_JUDGE_CONCURRENCY) return;
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
    this.judgeStartedAt.set(item.id, Date.now());
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
        onSessionCreated: (sessionId) =>
          this.judgeSessions.set(item.id, sessionId),
        onSessionEnd: (itemId, endedRound) => {
          void this.onJudgeSessionEnd(itemId, endedRound);
        },
      })
      .catch((error: Error) => {
        this.logger.error(`评估项 #${item.id} 判定会话异常: ${error.message}`);
        // 判定沙箱/会话没跑起来：释放判定占用，交给 tick 的判定对账重试或判异常
        this.judging.delete(item.id);
        this.judgeStartedAt.delete(item.id);
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
   * 判定会话结束回调：只负责释放判定占用。
   * 未提交有效判定时由 tick 的判定对账决定重开还是判异常（重启、并发上限都在那里统一处理）。
   */
  private async onJudgeSessionEnd(
    itemId: number,
    round: number,
  ): Promise<void> {
    this.judging.delete(itemId);
    this.judgeStartedAt.delete(itemId);
    const item = await this.items.findOne({ where: { id: itemId } });
    if (!item) return;
    // 判定已结束时顺手销毁本项的会话（判定会话在此刻才真正空闲）
    if (TERMINAL_ITEM_STATUSES.includes(item.status)) {
      await this.destroyItemSessions(item);
      return;
    }
    if (item.status !== EvalItemStatus.JUDGING) return;
    const effective = await this.judgements.findOne({
      where: { itemId, round, effective: true },
      order: { id: 'DESC' },
    });
    if (effective) {
      // 判定已提交但状态机未推进（提交后进程异常等）：直接补推进
      await this.applyJudgement(item, round, effective);
      return;
    }
    this.logger.warn(
      `评估项 #${itemId} 第 ${round} 轮判定会话结束但未提交有效判定，等待对账重试`,
    );
  }

  /**
   * 判定中的每轮对账：判定会话在跑时只做超时兜底；没有会话在跑时按「已有生效判定 → 补推进 /
   * 任务仍在待验收 → 重开判定 / 其它 → 判异常」收口，重启后遗留的判定中项由此自动恢复。
   */
  private async reconcileJudging(item: EvalRunItem): Promise<void> {
    if (this.judging.has(item.id)) {
      const startedAt = this.judgeStartedAt.get(item.id) ?? 0;
      if (startedAt > 0 && Date.now() - startedAt > JUDGE_SESSION_DEADLINE_MS) {
        this.logger.warn(`评估项 #${item.id} 判定会话超时未结束，转异常`);
        this.judging.delete(item.id);
        this.judgeStartedAt.delete(item.id);
        await this.markItemError(item.id, '判定会话超时未结束（执行器无响应）');
      }
      return;
    }
    const round = item.reworkCount > 0 ? 2 : 1;
    const effective = await this.judgements.findOne({
      where: { itemId: item.id, round, effective: true },
      order: { id: 'DESC' },
    });
    if (effective) {
      await this.applyJudgement(item, round, effective);
      return;
    }
    const task = item.taskId
      ? await this.tasks.findOne({ where: { id: item.taskId } })
      : null;
    if (
      !task ||
      task.status !== TaskStatus.WAITING ||
      task.subStatus !== TaskSubStatus.PENDING_ACCEPT
    ) {
      await this.markItemError(item.id, '评估任务已不在待验收，判定无法继续');
      return;
    }
    const started = await this.judgeSessionStarts(item.id, round);
    if (started >= JUDGE_MAX_ATTEMPTS) {
      await this.addEvent(item.id, EvalEventType.JUDGE_FAILED, {
        round,
        message: '判定重试耗尽',
      });
      await this.markItemError(item.id, '判定失败：判定重试耗尽');
      return;
    }
    await this.startJudge(item, task, round);
  }

  /** 本轮已开启的判定会话数（按事件流统计，重启后仍准确，也不再与重跑次数混用） */
  private async judgeSessionStarts(
    itemId: number,
    round: number,
  ): Promise<number> {
    const rows = await this.events.find({
      where: { itemId, type: EvalEventType.JUDGE_STARTED },
      select: { id: true, payload: true },
    });
    return rows.filter(
      (row) => (row.payload as { round?: number } | null)?.round === round,
    ).length;
  }

  /**
   * 按生效判定推进状态机：提交后推进与重启后补推进共用（幂等）。
   */
  private async applyJudgement(
    item: EvalRunItem,
    round: number,
    judged: Pick<EvalJudgement, 'score' | 'pass' | 'pointsResult' | 'reason'>,
  ): Promise<void> {
    // 提交与「判定会话结束」可能同时触发推进，同一项只允许一个推进流程
    if (this.applying.has(item.id)) return;
    this.applying.add(item.id);
    try {
      await this.applyJudgementOnce(item, round, judged);
    } finally {
      this.applying.delete(item.id);
    }
  }

  private async applyJudgementOnce(
    item: EvalRunItem,
    round: number,
    judged: Pick<EvalJudgement, 'score' | 'pass' | 'pointsResult' | 'reason'>,
  ): Promise<void> {
    const fresh = await this.items.findOne({ where: { id: item.id } });
    if (!fresh || fresh.status !== EvalItemStatus.JUDGING) return;
    const run = await this.runs.findOne({ where: { id: fresh.runId } });
    if (!run) return;
    const caseFrozen = this.frozenCase(run, fresh.caseId);
    const task = fresh.taskId
      ? await this.tasks.findOne({ where: { id: fresh.taskId } })
      : null;
    if (round === 1) {
      await this.updateItem(fresh.id, { firstScore: judged.score });
      if (judged.pass) {
        await this.acceptAndFinish(fresh, EvalItemResult.FIRST_PASS);
        return;
      }
      const feedback = caseFrozen
        ? this.buildReworkFeedback(
            caseFrozen,
            (judged.pointsResult ?? []) as Array<{ idx: number; hit: number }>,
          )
        : '本次交付未通过验收，请自查是否完整满足任务要求后重新交付。';
      if (task) {
        await this.collaboration
          .refuseHandoff(
            task.id,
            workerRequesterActor(await this.requireEvaluator(run)),
            feedback,
          )
          .catch((error: Error) =>
            this.logger.warn(
              `评估项 #${fresh.id} 返工退回失败: ${error.message}`,
            ),
          );
      }
      await this.updateItem(fresh.id, {
        status: EvalItemStatus.REWORKING,
        reworkCount: 1,
      });
      await this.addEvent(fresh.id, EvalEventType.REWORK_SENT, { feedback });
      return;
    }
    await this.updateItem(fresh.id, { finalScore: judged.score });
    if (judged.pass) {
      await this.acceptAndFinish(fresh, EvalItemResult.PASS_AFTER_REWORK);
      return;
    }
    if (task) {
      await this.collaboration
        .fail(
          task.id,
          workerRequesterActor(await this.requireEvaluator(run)),
          '评估未通过，判定为不满足期望。',
        )
        .catch((error: Error) =>
          this.logger.warn(`评估项 #${fresh.id} 判失败失败: ${error.message}`),
        );
    }
    await this.finishItem(fresh, {
      status: EvalItemStatus.DONE,
      result: EvalItemResult.FAILED,
    });
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

    // 推进状态机（与重启后补推进共用同一入口）
    await this.applyJudgement(item, round, saved);
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
    this.releaseItemRuntime(item.id);
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
    // 任务会话此时已空闲；判定会话仍可能在跑（回合结束回调里再销毁）
    await this.destroyItemSessions(item, { judge: false });
    await this.refreshRunSummary(item.runId);
  }

  /** 等待答复总时长（10.1 wait_answer_ms） */
  private async totalWaitAnswerMs(itemId: number): Promise<number> {
    return this.sumAnswerWaits(itemId, null);
  }

  /** 第一次交付前的等待答复时长 */
  private async waitAnswerBefore(
    itemId: number,
    before: Date,
  ): Promise<number> {
    return this.sumAnswerWaits(itemId, before);
  }

  /**
   * 累计「提问 → 已答复/已跳过」的等待时长。
   * 跳过提问也算结束（耗时接近 0），不能只按 ANSWERED 配对，否则后续问答会错位。
   */
  private async sumAnswerWaits(
    itemId: number,
    before: Date | null,
  ): Promise<number> {
    const rows = await this.events.find({
      where: {
        itemId,
        type: In([
          EvalEventType.QUESTION_ASKED,
          EvalEventType.QUESTION_ANSWERED,
          EvalEventType.QUESTION_SKIPPED,
        ]),
      },
      order: { id: 'ASC' },
    });
    let total = 0;
    let openedAt: Date | null = null;
    for (const row of rows) {
      if (row.type === EvalEventType.QUESTION_ASKED) {
        openedAt = row.at;
        continue;
      }
      const closed =
        row.type === EvalEventType.QUESTION_ANSWERED ||
        row.type === EvalEventType.QUESTION_SKIPPED;
      if (!closed) continue;
      if (openedAt && (!before || row.at <= before)) {
        total += Math.max(0, row.at.getTime() - openedAt.getTime());
      }
      openedAt = null;
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
      questionLimit: rows.filter(
        (r) =>
          r.status === EvalItemStatus.DONE &&
          r.result === EvalItemResult.QUESTION_LIMIT,
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
    this.releaseItemRuntime(item.id);
    // 中断执行中的评估会话
    if (item.taskId) {
      const task = await this.tasks.findOne({ where: { id: item.taskId } });
      if (task) {
        await this.interruptTaskSession(task).catch(() => {});
        const run = await this.runs.findOne({ where: { id: item.runId } });
        const evaluator = run
          ? await this.requireEvaluator(run).catch(() => null)
          : null;
        if (task.subStatus === TaskSubStatus.PENDING_ACCEPT) {
          if (evaluator) {
            await this.collaboration
              .fail(task.id, workerRequesterActor(evaluator), '评估已取消')
              .catch(() => {});
          }
        } else if (task.status !== TaskStatus.FINISHED) {
          // 待反馈等其余等待态没有判失败入口，用平台取消收尾，避免悬挂任务
          await this.tasksService
            .cancel(task.id, evaluator?.name ?? null)
            .catch((error: Error) =>
              this.logger.warn(
                `评估项 #${item.id} 结束任务失败: ${error.message}`,
              ),
            );
        }
      }
    }
    await this.updateItem(item.id, {
      status: EvalItemStatus.CANCELED,
      endedAt: new Date(),
    });
    await this.addEvent(item.id, EvalEventType.CANCELED, {});
    await this.destroyItemSandbox(item);
    await this.destroyItemSessions(item);
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

  /** 超时检查（7.5）：按执行阶段分别计时，分页扫描避免只检查 id 最小的一批 */
  private async checkTimeouts(): Promise<void> {
    let cursor = 0;
    for (;;) {
      const rows = await this.items.find({
        where: {
          id: MoreThan(cursor),
          status: In([
            EvalItemStatus.PREPARING,
            EvalItemStatus.INVITED,
            EvalItemStatus.RUNNING,
            EvalItemStatus.WAITING_ANSWER,
            EvalItemStatus.REWORKING,
            EvalItemStatus.JUDGING,
          ]),
          superseded: false,
        },
        order: { id: 'ASC' },
        take: TIMEOUT_SCAN_PAGE,
      });
      for (const item of rows) {
        await this.checkItemTimeout(item);
      }
      if (rows.length < TIMEOUT_SCAN_PAGE) return;
      cursor = rows[rows.length - 1]?.id ?? 0;
      if (!cursor) return;
    }
  }

  private async checkItemTimeout(item: EvalRunItem): Promise<void> {
    const now = Date.now();
    if (item.status === EvalItemStatus.JUDGING) {
      // 判定阶段：从本轮第一次开启判定会话计时，超过「单会话上限 × 重试次数」仍无结果即超时
      const round = (item.reworkCount ?? 0) > 0 ? 2 : 1;
      const begin =
        (await this.judgeRoundStartedAt(item.id, round)) ??
        item.updatedAt ??
        item.createdAt;
      if (now - begin.getTime() > JUDGE_ITEM_TIMEOUT_MS) {
        await this.timeoutItem(item, Math.round(JUDGE_ITEM_TIMEOUT_MS / 1000));
      }
      return;
    }
    const run = await this.runs.findOne({ where: { id: item.runId } });
    if (!run) return;
    const caseFrozen = this.frozenCase(run, item.caseId);
    const timeoutSec =
      caseFrozen?.timeoutSec ?? run.suiteSnapshot?.defaultTimeoutSec ?? 1800;
    const started = await this.sandboxReadyAt(item.id);
    const begin = started ?? item.updatedAt ?? item.createdAt;
    if (now - begin.getTime() > timeoutSec * 1000) {
      await this.timeoutItem(item, timeoutSec);
    }
  }

  private async sandboxReadyAt(itemId: number): Promise<Date | null> {
    const ev = await this.events.findOne({
      where: { itemId, type: EvalEventType.SANDBOX_READY },
      order: { id: 'DESC' },
    });
    return ev?.at ?? null;
  }

  /** 本项本轮第一次开启判定会话的时间（判定阶段整体兜底） */
  private async judgeRoundStartedAt(
    itemId: number,
    round: number,
  ): Promise<Date | null> {
    const rows = await this.events.find({
      where: { itemId, type: EvalEventType.JUDGE_STARTED },
      order: { id: 'ASC' },
      select: { id: true, at: true, payload: true },
    });
    const matched = rows.find(
      (row) => (row.payload as { round?: number } | null)?.round === round,
    );
    return matched?.at ?? null;
  }

  private async timeoutItem(
    item: EvalRunItem,
    timeoutSec: number,
  ): Promise<void> {
    this.releaseItemRuntime(item.id);
    this.logger.warn(`评估项 #${item.id} 超时（${timeoutSec}s）`);
    await this.addEvent(item.id, EvalEventType.TIMEOUT, { timeoutSec });
    if (item.taskId) {
      const task = await this.tasks.findOne({ where: { id: item.taskId } });
      if (task) {
        await this.interruptTaskSession(task).catch(() => {});
        const run = await this.runs.findOne({ where: { id: item.runId } });
        const evaluator = run
          ? await this.requireEvaluator(run).catch(() => null)
          : null;
        if (
          task.status === TaskStatus.WAITING &&
          task.subStatus === TaskSubStatus.PENDING_ACCEPT
        ) {
          if (evaluator) {
            await this.collaboration
              .fail(task.id, workerRequesterActor(evaluator), '评估超时')
              .catch(() => {});
          }
        } else if (task.status !== TaskStatus.FINISHED) {
          // 待反馈/待继续等状态没有判失败入口，用平台取消收尾，避免悬挂任务
          await this.tasksService
            .cancel(task.id, evaluator?.name ?? null)
            .catch((error: Error) =>
              this.logger.warn(
                `评估项 #${item.id} 结束任务失败: ${error.message}`,
              ),
            );
        }
      }
    }
    await this.updateItem(item.id, {
      status: EvalItemStatus.TIMEOUT,
      endedAt: new Date(),
    });
    await this.destroyItemSandbox(item);
    await this.destroyItemSessions(item);
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
    this.releaseItemRuntime(itemId);
    await this.updateItem(itemId, {
      status: EvalItemStatus.ERROR,
      errorMessage: message.slice(0, 1024),
      endedAt: new Date(),
    });
    await this.addEvent(itemId, EvalEventType.ERROR, { message });
    await this.destroyItemSandbox(item);
    await this.destroyItemSessions(item);
    await this.refreshRunSummary(item.runId);
  }

  /** 释放评估项的内存运行时（判定会话、续跑定时器、失败计数） */
  private releaseItemRuntime(itemId: number): void {
    this.judging.delete(itemId);
    this.judgeStartedAt.delete(itemId);
    this.turnFailures.delete(itemId);
    const timer = this.resumeTimers.get(itemId);
    if (timer) {
      clearTimeout(timer);
      this.resumeTimers.delete(itemId);
    }
  }

  /** 评估项结束时销毁执行器侧会话（任务会话 + 判定会话），避免工位内存只增不减 */
  private async destroyItemSessions(
    item: EvalRunItem,
    options?: { judge?: boolean },
  ): Promise<void> {
    const task = item.taskId
      ? await this.tasks.findOne({ where: { id: item.taskId } })
      : null;
    if (task?.opencodeSessionId && task.executorId) {
      const executor = await this.executors.findOne({
        where: { id: task.executorId },
      });
      if (executor) {
        await createExecutorClient(executor)
          .deleteSession(task.opencodeSessionId)
          .catch((error: Error) =>
            this.logger.warn(
              `评估项 #${item.id} 销毁任务会话失败: ${error.message}`,
            ),
          );
        await this.tasks
          .update({ id: task.id }, { opencodeSessionId: null })
          .catch(() => undefined);
      }
    }
    const judgeSessionId = this.judgeSessions.get(item.id);
    if (!judgeSessionId || options?.judge === false) return;
    this.judgeSessions.delete(item.id);
    const run = await this.runs.findOne({ where: { id: item.runId } });
    const evaluator = run
      ? await this.workers.findOne({ where: { id: run.evaluatorWorkerId } })
      : null;
    const executor = evaluator?.executorId
      ? await this.executors.findOne({ where: { id: evaluator.executorId } })
      : null;
    if (!executor) return;
    await createExecutorClient(executor)
      .deleteSession(judgeSessionId)
      .catch((error: Error) =>
        this.logger.warn(
          `评估项 #${item.id} 销毁判定会话失败: ${error.message}`,
        ),
      );
  }

  /** 是否已写过某类事件（沙箱就绪判定等，按有无判断即可） */
  private async hasAnyEvent(
    itemId: number,
    type: EvalEventType,
  ): Promise<boolean> {
    return (await this.events.count({ where: { itemId, type } })) > 0;
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

  /**
   * 会话执行失败（SSE 与两分钟对账共用入口）：先自动续跑，超过上限才判异常。
   * 续跑以评估机器人（需求方）身份在同一会话投递，不影响人工介入统计。
   */
  private async onEvalTurnFailed(task: Task, reason: string): Promise<void> {
    if (!task.evalItemId) return;
    const item = await this.items.findOne({ where: { id: task.evalItemId } });
    if (
      !item ||
      item.superseded ||
      TERMINAL_ITEM_STATUSES.includes(item.status)
    ) {
      return;
    }
    const run = await this.runs.findOne({ where: { id: item.runId } });
    if (!run || run.status === EvalRunStatus.CANCELED) return;
    const failures = this.turnFailures.get(item.id) ?? 0;
    const message = reason.trim().slice(0, 400) || '未知原因';
    if (failures >= TURN_FAILURE_MAX_RESUME) {
      await this.addEvent(item.id, EvalEventType.ERROR, {
        stage: 'turn',
        failures,
        message,
      });
      await this.failEvalItem(
        item,
        task.id,
        `会话执行失败（已续跑 ${failures} 次）：${message}`,
      );
      return;
    }
    const attempt = failures + 1;
    this.turnFailures.set(item.id, attempt);
    const delay =
      TURN_FAILURE_RESUME_DELAYS_MS[
        Math.min(failures, TURN_FAILURE_RESUME_DELAYS_MS.length - 1)
      ] ?? 30_000;
    await this.addEvent(item.id, EvalEventType.ERROR, {
      stage: 'turn-resume',
      attempt,
      message,
    });
    this.scheduleResume(item.id, task.id, attempt, delay);
  }

  /** 评估项判异常并结束评估任务（任务已结束则只标评估项） */
  private async failEvalItem(
    item: EvalRunItem,
    taskId: number,
    message: string,
  ): Promise<void> {
    await this.markItemError(item.id, message);
    const task = await this.tasks.findOne({ where: { id: taskId } });
    if (!task || task.status === TaskStatus.FINISHED) return;
    const run = await this.runs.findOne({ where: { id: item.runId } });
    const evaluator = run
      ? await this.workers.findOne({ where: { id: run.evaluatorWorkerId } })
      : null;
    await this.tasksService
      .cancel(task.id, evaluator?.name ?? null)
      .catch((error: Error) =>
        this.logger.warn(
          `评估项 #${item.id} 结束评估任务失败: ${error.message}`,
        ),
      );
  }

  /** 退避后自动续跑（定时器不阻止进程退出；重启后由对账重新触发） */
  private scheduleResume(
    itemId: number,
    taskId: number,
    attempt: number,
    delayMs: number,
  ): void {
    const existing = this.resumeTimers.get(itemId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.resumeTimers.delete(itemId);
      void this.resumeTurn(itemId, taskId, attempt).catch(
        async (error: Error) => {
          this.logger.warn(`评估项 #${itemId} 自动续跑失败: ${error.message}`);
          const item = await this.items.findOne({ where: { id: itemId } });
          if (item) {
            await this.failEvalItem(
              item,
              taskId,
              `自动续跑失败：${error.message}`,
            );
          }
        },
      );
    }, delayMs);
    timer.unref();
    this.resumeTimers.set(itemId, timer);
    this.logger.log(
      `评估项 #${itemId} 会话失败，${Math.round(delayMs / 1000)} 秒后第 ${attempt} 次自动续跑`,
    );
  }

  /** 在同一会话继续执行（不打断会话、沿用上下文），完成后仍需机器人显式申请验收 */
  private async resumeTurn(
    itemId: number,
    taskId: number,
    attempt: number,
  ): Promise<void> {
    const item = await this.items.findOne({ where: { id: itemId } });
    if (
      !item ||
      item.superseded ||
      TERMINAL_ITEM_STATUSES.includes(item.status)
    ) {
      return;
    }
    const task = await this.tasks.findOne({ where: { id: taskId } });
    if (
      !task ||
      task.status !== TaskStatus.RUNNING ||
      task.subStatus !== TaskSubStatus.EXECUTING
    ) {
      return;
    }
    const run = await this.runs.findOne({ where: { id: item.runId } });
    if (!run || run.status === EvalRunStatus.CANCELED) return;
    const evaluator = await this.requireEvaluator(run);
    const text = [
      '# 上一轮执行中断',
      '',
      '执行器会话上一轮失败，平台已恢复执行。请在当前任务中继续完成剩余工作，不要重复已完成的部分；完成后必须调用验收申请接口。',
      '',
      `（第 ${attempt} 次自动续跑）`,
    ].join('\n');
    await this.dispatch.continueConversation(task.id, text, evaluator.name, {
      modelContent: text,
      actorWorkerId: evaluator.id,
      perspective: 'requester',
    });
    this.logger.log(`评估项 #${itemId} 已自动续跑（第 ${attempt} 次）`);
  }

  /** 平台重启恢复：需要任务才能恢复的状态，任务丢失则标 ERROR；其余交给 tick 对账 */
  async onApplicationBootstrap(): Promise<void> {
    const rows = await this.items.find({
      where: { status: In(IN_FLIGHT_ITEM_STATUSES), superseded: false },
      order: { id: 'ASC' },
      take: 200,
    });
    for (const item of rows) {
      // 排队项由 ticker 调度；准备中项由 tick 重新进入启动流程；
      // 判定中项由判定对账重开判定或判异常，这里不重复处理
      if (
        item.status === EvalItemStatus.PREPARING ||
        item.status === EvalItemStatus.JUDGING
      ) {
        continue;
      }
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
