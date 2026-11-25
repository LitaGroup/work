import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { Observable } from 'rxjs';
import { Repository } from 'typeorm';
import {
  ExecutorType,
  WorkerGithubPermission,
  WorkerResourcePermission,
} from '../common/enums';
import { isAgentRuntime } from '../common/worker-runtime';
import { Executor } from '../executors/executor.entity';
import {
  createExecutorClient,
  type ExecutorClient,
} from '../executors/executor-client';
import { Worker } from './worker.entity';
import {
  ensureWorkerSkeleton,
  shouldDenyExternalDirectory,
  upsertWorkerEnv,
  WORKER_RULES_PATH,
  WORKER_SKILLS_PATH,
  writeKernelMcpConfig,
} from './worker-env';
import { WorkersService } from './workers.service';
import {
  LITA_WORK_ADMIN_SERVER_NAME,
  McpServersService,
} from '../mcp-servers/mcp-servers.service';
import { GithubPermissionCredentialService } from './github-permission-credential.service';
import { GithubCredentialStatus } from '../github-gateway/github-permission-credential.entity';
import {
  ManagedStandardFiles,
  WorkerStandardCatalogService,
} from './worker-standard-catalog.service';
import {
  ManagedSkillFiles,
  WorkerSkillCatalogService,
} from './worker-skill-catalog.service';
import { WorkerSourceCacheService } from './worker-source-cache.service';
import { resolveAccessLevel } from '../auth/worker-access';

/** 工位同步协议版本：同步逻辑变更时递增，强制重建全部工位 */
const STATION_SYNC_VERSION = 2;
/** 工位同步 manifest：记录内容版本与受管文件，用于无变化跳过和校验 */
const STATION_MANIFEST_PATH = '.agents/.station-manifest.json';
/** 文件写入并发上限 */
const SYNC_CONCURRENCY = 8;

interface StationWrite {
  path: string;
  bytes: Uint8Array;
}

interface DownloadedSource extends StationWrite {
  /** 源仓库内相对路径（不含工位前缀） */
  sourcePath: string;
}
/** 终态快照保留时长（晚订阅/刷新页面的客户端可立即拿到结果） */
const JOB_TTL_MS = 5 * 60_000;
/** SSE 心跳间隔（须小于网关空闲超时，如 ALB 60s） */
const STREAM_PING_MS = 15_000;
/** 进度行上限（防失控任务撑爆内存） */
const MAX_LINES = 500;

/**
 * 平台统一注入工位 AGENTS.md 的多机器人协同协议（角色定义之后原样保留）。
 * `appUrl` 为平台对外地址（含协议），用于写明 .md 端点的基础地址。
 */
export function buildTaskCollaborationAgents(appUrl: string): string {
  const base = appUrl.replace(/\/+$/, '');
  return `## 多机器人任务协同协议（平台固定）

### 平台地址（硬性）

- 平台访问地址：${base}（工位 \`.agents/.env\` 的 \`LITA_APP_URL\` 同值）。
- 所有 .md 端点与 JSON 接口的完整地址 = 平台访问地址 + \`/api\` + 路径，例如 \`${base}/api/tasks.md\`、\`${base}/api/backlogs/{id}.md\`。
- 不要猜测域名，也不要自行改写 http/https 协议；一律以上述地址为准。

### 基本原则

1. 一个任务有且只有一个负责机器人和一个需求方；需求方可以是人类用户，也可以是父任务机器人。
2. 任务来源包括人类创建和机器人通过 task-create 创建。你可以并行执行多个「进行中」任务，上限由平台配置（默认 3，1 表示串行）；达到上限时新任务保持等待，等待中的任务不占用执行容量，可以接受其他任务。
3. 机器人身份令牌位于工位 \`.agents/.env\` 的 \`LITA_WORK_TOKEN\`（新名，优先）与 \`LITA_PROJECT_TOKEN\`（兼容旧名），两者同值。调用平台所有 .md 接口时先执行 \`set -a; . .agents/.env; set +a\`，再使用 \`X-Agent-Token: \${LITA_WORK_TOKEN:-$LITA_PROJECT_TOKEN}\` 或 \`X-Worker-Token: $LITA_WORK_TOKEN\`；不得把令牌写入聊天、交付物或文档。

### 工位环境变量（.agents/.env）

- .agents/.env 由平台注入并维护（权限 600，不得读取展示、改写或删除）：
  - \`LITA_WORK_TOKEN\`：访问项目平台 .md 接口的机器人独立令牌（新名，优先使用），放在 \`X-Agent-Token\` 或 \`X-Worker-Token\` 均可。
  - \`LITA_PROJECT_TOKEN\`：同一机器人令牌的兼容旧名，仅在旧脚本只认旧名时使用；新调用优先 \`LITA_WORK_TOKEN\`。
  - \`LITA_USER_TOKEN\`：访问 Lita 平台的用户令牌，供 lita-api 等技能使用。
  - \`LITA_APP_URL\`：平台访问地址（含协议），用于拼接 .md 端点；与上方「平台地址」一致。
- **环境变量优先级（硬性）**：调用 lita-work 等技能前，工位 \`.agents/.env\` 中的环境变量优先级最高，高于当前进程环境变量；同名变量必须以 \`.agents/.env\` 为准，不得用进程环境中的同名值覆盖。
- 每次调用相关技能前，必须在同一个 shell 中先执行：\`set -a; . .agents/.env; set +a\`，再执行技能或接口调用。
- 不得把令牌写入聊天、交付物、文档或代码仓库。

### 工作区边界（平台强制）

- 全部文件读写必须位于当前工位目录内；禁止读写工位之外的任何路径，包括但不限于其他机器人工位、执行器宿主的 ~/.env、~/.config、/tmp、/etc，也不要用 .. 或绝对路径访问工位外文件；需要临时文件时放在工位目录内。
- opencode 执行器已在 \`.opencode/opencode.json\` 注入权限限制，越界的读取、写入与命令会被直接拒绝；其它执行内核以本协议约定为准（平台暂未提供强制拦截）。
- 任务确需工位之外的资料时，不要自行越界获取；通过 lita-work MCP、文档上传等平台渠道向需求方说明并获取。

### 平台 MCP 服务（lita-work）

- MCP 服务由平台初始化/派发时按当前执行内核写入并自动连接：opencode 为 \`.opencode/opencode.json\`、kiro 为 \`.kiro/settings/mcp.json\`、devin 为 \`.devin/mcp_config.json\`、droid 为 \`.factory/mcp.json\`；另有内核无关声明 \`.agents/mcp.json\`（平台维护，含凭据，不得读取展示、改写或删除）。
- MCP 服务 \`lita-work\` 指向平台 \`/api/mcp/work\`（Streamable HTTP，机器人令牌鉴权），无需手动配置或启动。
- 项目搜索/详情、项目文档、知识库、检查/用例/导出运行、缺陷、提测、代码分支、文件上传等操作优先使用 lita-work 的 MCP 工具。
- 任务协同与工单同样已提供 MCP 工具：任务 \`list_my_tasks\` / \`get_task\` / \`create_task\` / \`create_subtask\` / \`accept_task\` / \`refuse_task\` / \`ask_task_question\` / \`answer_task_question\` / \`reply_task_message\` / \`list_task_documents\` / \`upsert_task_document\` / \`read_task_handoff\` / \`update_task_handoff\` / \`apply_task_acceptance\` / \`accept_task_handoff\` / \`refuse_task_handoff\` / \`fail_task\`；工单 \`get_task_ticket\` / \`route_task_ticket\` / \`get_ticket\` / \`reject_ticket_node\` / 工单文档工具。MCP 不可用时再回退下方 \`.md\` 端点。
- 机器人、任务定义、测试集与评估等管理能力在独立服务 \`lita-work-admin\`（\`/api/mcp/work-admin\`，仅管理员可用）：访问级别为管理员的机器人由平台额外注入该服务（见下方「已配置的 MCP 服务」）；非管理员机器人没有该服务，不要尝试调用。
- 任务动作优先使用 MCP：接受邀约 \`accept_task\`、拒绝 \`refuse_task\`、提问 \`ask_task_question\`、更新交付 \`update_task_handoff\`、申请验收 \`apply_task_acceptance\`、验收 \`accept_task_handoff\` / \`refuse_task_handoff\`、判失败 \`fail_task\`。

### 任务状态与动作

- 待分配 → 待接受：平台按任务定义分配机器人并发送邀约。
- 待接受 → 执行中：确认任务匹配后调用 task-accept。接受失败或提示执行容量已满时不要执行，保持等待。
- 待接受 → 已拒绝：任务不匹配自己的职责时，只能在待接受阶段调用 task-refuse，必须填写拒绝理由 reason，并尽量给出发送建议 suggestion（推荐任务定义或机器人）。不得接受后再拒绝，也不得把不匹配任务转交他人代替拒绝接口。
- 执行中 → 待反馈：需要需求方澄清时调用 task-question-ask，由 project 创建和展示提问；不要使用 opencode 原生 question。调用后停止本轮，等待平台恢复。
- 待反馈 → 待继续 → 执行中：需求方答复后，平台在机器人仍有执行容量时恢复原任务会话。
- 执行中维护交付文档：接受任务并开始处理后，立即调用 task-handoff-update 创建 HANDOFF（首次使用 baseVersion=0）；每完成一个重要阶段、取得关键产物、完成验证或出现阻塞时及时更新，申请验收前补齐最终交付内容。
- 任务文档目录：任务相关文档默认放在 /task/{yyyyMMdd}/{任务编号}/，常用 API.md（接口）、TECH_DESIGN.md（技术方案）、HANDOFF.md（交付）、REVIEW.md（复盘，验收后平台生成）；需求明确指定文档地址时按指定地址写入，不要另起目录。
- 任务目录下的普通文档用 task-documents-list / task-documents-update 读写；HANDOFF 仍用 task-handoff-update，REVIEW 不要自行创建。
- 执行中 → 待申请验收：本轮答复结束且 opencode 会话没有后续排队消息时，平台会释放该任务的执行容量，任务转为「等待中-待申请验收」，你可以继续承接其它任务；平台会重新唤醒你申请验收。
- 待申请验收 → 待验收：完成、自检并准备好交付物后调用 task-handoff-apply；申请前必须确认 HANDOFF 已创建且为最终内容，申请验收只锁定当前交付文档版本，未创建或正文为空会被拒绝。会话结束不等于完成，不调用申请接口任务不会自动进入待验收。
- 待验收 → 完成/待继续或执行中/失败：只能由任务需求方分别调用 task-handoff-accept、task-handoff-refuse 或 task-fail。机器人不得代替需求方验收或判失败。

### 创建与处理子任务

1. 先阅读当前任务定义，判断是否需要其他类型机器人协同；不要无目的拆分。
2. 需要拆分时，先调用 task-defines 查询当前支持分发的任务定义，再调用 task-create 创建子任务，明确输入与输出要求。
3. 你是自己所创建子任务的需求方。子任务提问、申请验收或被拒绝时，平台会把事件持久化到收件箱，并在你仍有执行容量时唤醒父任务会话。
4. 对子任务提问调用 task-question-answer；对交付物调用 task-handoff-accept、task-handoff-refuse 或 task-fail；对被拒绝任务根据拒绝理由和分发建议决定是否重新创建子任务。
5. 处理完子任务事件后继续父任务。不要代替子任务执行机器人调用 task-accept、task-question-ask 或 task-handoff-apply。

### 我的任务与创建根任务

- 任务清单：优先 MCP \`list_my_tasks\`（按身份只返回自己作为需求方/执行方的任务）；.md 兼容：GET /api/tasks.md
- 任务详情：优先 MCP \`get_task\`（仅需求方/执行方可读）；.md 兼容：GET /api/tasks/{taskId}.md
- 创建根任务：优先 MCP \`create_task\`（至少提供 title 或 description；平台自动分配机器人）；.md 兼容：POST /api/tasks/create.md

### 可用操作（.md 兼容，优先使用对应 MCP 工具）

- task-defines：GET /api/tasks/defines.md
- task-create：POST /api/tasks/{parentTaskId}/subtasks/create.md
- task-accept：POST /api/tasks/{taskId}/accept-task.md
- task-refuse：POST /api/tasks/{taskId}/refuse.md
- task-question-ask：POST /api/tasks/{taskId}/questions/ask.md
- task-question-answer：POST /api/tasks/{taskId}/questions/{questionId}/answer.md
- task-documents-list：GET /api/tasks/{taskId}/documents.md
- task-documents-update：POST /api/tasks/{taskId}/documents.md
- ticket-documents-list：GET /api/tasks/{taskId}/ticket-documents.md（所属工单的交付文档清单与调用示例）
- ticket-documents-create：POST /api/tasks/{taskId}/ticket-documents.md（body 提供 title + url 或 content 二选一）
- ticket-documents-update：POST /api/tasks/{taskId}/ticket-documents/{documentId}/update.md
- ticket-documents-delete：POST /api/tasks/{taskId}/ticket-documents/{documentId}/delete.md
- task-handoff-read：GET /api/tasks/{taskId}/handoff.md
- task-handoff-update：POST /api/tasks/{taskId}/handoff/update.md
- task-handoff-apply：POST /api/tasks/{taskId}/handoff/apply.md
- task-handoff-accept：POST /api/tasks/{taskId}/handoff/accept.md
- task-handoff-refuse：POST /api/tasks/{taskId}/handoff/refuse.md
- task-fail：POST /api/tasks/{taskId}/fail.md
`;
}

/** 初始化状态：idle=无任务（从未初始化或快照已过期清理） */
export type WorkerInitializeStatus = 'idle' | 'running' | 'success' | 'failed';

/** 初始化快照：POST 响应、GET 查询与 SSE snapshot 事件共用（JSON 安全） */
export interface WorkerInitializeSnapshot {
  workerId: number;
  status: WorkerInitializeStatus;
  /** 进度行（时间正序，最新在末尾） */
  lines: string[];
  error: string | null;
  workdir: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** SSE 载荷：snapshot=全量快照（订阅即推+终态）；line=进度行增量；ping=心跳 */
type InitializeStreamPayload =
  | { type: 'snapshot'; snapshot: WorkerInitializeSnapshot }
  | { type: 'line'; line: string }
  | { type: 'ping' };

/** 一次初始化任务的内存态（不落库：平台重启即丢失，前端会提示重试） */
interface InitializeJob {
  workerId: number;
  status: WorkerInitializeStatus;
  lines: string[];
  error: string | null;
  workdir: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  /** SSE 订阅广播 */
  emitter: EventEmitter;
  /** 终态后的 TTL 清理定时器 */
  ttlTimer?: NodeJS.Timeout;
}

/**
 * 平台固定文案指纹：AGENTS.md 中不来自数据源、只随代码变化的章节
 *（协同协议 + 目录结构）。
 *
 * 工位同步以 revision 判等跳过，而 revision 只覆盖 prompt/技能/规范等数据源；
 * 平台改这里的文案而不升 STATION_SYNC_VERSION 时，已初始化的工位会静默留旧文案。
 * 把这段文案的 sha256 并入 revision 即可自动触发一次重同步。
 */
export function stationTemplateFingerprint(
  appUrl: string,
  kernel: ExecutorType,
): string {
  return createHash('sha256')
    .update(buildTaskCollaborationAgents(appUrl))
    .update('\n')
    .update(buildDirectoryAgentsSection(kernel))
    .digest('hex');
}

/** 写入 AGENTS.md 的目录结构章节（按内核列出适配物） */
export function buildDirectoryAgentsSection(kernel: ExecutorType): string {
  return `## 目录结构

- AGENTS.md    机器人的工作基本原则
- .agents/     通用 Agent 目录（内核无关的技能、规范与平台注入内容）
- .agents/.env   平台注入的工位环境变量（权限 600，不得读取展示、改写或删除）：LITA_WORK_TOKEN 访问项目平台 .md 接口（新名，优先）、LITA_PROJECT_TOKEN 兼容旧名（同值）、LITA_USER_TOKEN 访问 Lita 平台技能、LITA_APP_URL 平台访问地址
- .agents/mcp.json   平台注入的内核无关 MCP 声明（权限 600，含凭据，不得读取展示、改写或删除）
- .agents/skills/    当前机器人的技能源目录（opencode、devin 原生发现；kiro、droid 需镜像）
- .agents/rules/     平台同步的规范与规则源文档（保持规范库原始目录结构；.standards-manifest.json 是受管清单）
- .agents/rules/.standards-manifest.json   本次同步的规范文件清单（JSON：{"version":1,"files":[...]}）
- docs/         机器人自行维护的知识文档（可以根据完成任务的情况更新总结）
- .agents/.station-manifest.json   平台同步版本与文件校验清单（不得读取展示、改写或删除）
- 内核适配物（平台按执行器类型生成，权限 600，不得读取展示、改写或删除）：当前内核 ${kernel}；opencode 为 .opencode/opencode.json 与 .opencode/rules 镜像；kiro 为 .kiro/settings/mcp.json 与 .kiro/skills、.kiro/steering 镜像；devin 为 .devin/mcp_config.json；droid 为 .factory/mcp.json 与 .factory/skills、.factory/rules 镜像`;
}

/**
 * 机器人工作环境初始化：把数据库中的 AGENTS.md、技能引用与规范引用应用到工位。
 * 工位目录结构（内核无关）：
 * - AGENTS.md
 * - .agents/skills/（技能源；opencode、devin 原生发现，kiro/droid 由初始化镜像）
 * - .agents/rules/（规范源 + .standards-manifest.json 受管清单；按内核镜像）
 * - .agents/.env、.agents/mcp.json（平台注入，权限 600）
 * - docs/（机器人自行维护的知识文档）
 * - 内核适配物（.opencode/opencode.json、.kiro/settings/mcp.json 等，平台生成）
 *
 * 执行模型：POST 启动后台任务并立即返回运行快照，进度经 SSE 实时推送。
 * 初始化是平台确定性的文件发布，不创建模型会话：平台生成 AGENTS.md、下载技能/规范、
 * 生成内核镜像并批量写入执行器，最后以 `.agents/.station-manifest.json` 校验版本。
 * 内容版本未变化时只刷新凭据/MCP 配置并跳过文件同步。
 * 同步长请求会被网关（ALB 60s）以 504 掐断而后端继续跑完，故刻意异步化。
 */
@Injectable()
export class WorkerEnvironmentService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerEnvironmentService.name);
  /** workerId → 最近一次初始化任务（终态保留 JOB_TTL_MS 供晚订阅查询） */
  private readonly jobs = new Map<number, InitializeJob>();

  constructor(
    @InjectRepository(Worker)
    private readonly workers: Repository<Worker>,
    @InjectRepository(Executor)
    private readonly executors: Repository<Executor>,
    private readonly workersService: WorkersService,
    private readonly standardCatalog: WorkerStandardCatalogService,
    private readonly skillCatalog: WorkerSkillCatalogService,
    private readonly sourceCache: WorkerSourceCacheService,
    private readonly mcpServers: McpServersService,
    private readonly config: ConfigService,
    @Optional()
    private readonly githubCredentials?: GithubPermissionCredentialService,
  ) {}

  /**
   * 启动初始化任务：同步完成全部前置校验（配置类错误立即 400），
   * 随后后台执行确定性文件同步并立即返回运行快照；同一机器人进行中时幂等返回现有快照。
   */
  async start(id: number): Promise<WorkerInitializeSnapshot> {
    const worker = await this.workers.findOne({ where: { id } });
    if (!worker) throw new BadRequestException('机器人不存在');
    if (!isAgentRuntime(worker.runtime)) {
      throw new BadRequestException('仅支持 AI 机器人初始化');
    }
    // 工位同步是确定性的文件发布，不依赖供应商/模型；机器人启用配置仍由保存校验负责。
    if (!worker.executorId) {
      throw new BadRequestException('初始化工作环境前，请先配置执行器');
    }
    const workdir = this.workersService.workdirOf(worker.id);
    if (!workdir) {
      throw new BadRequestException('未配置 WORKER_BASE_DIR，无法确定工位目录');
    }
    const executor = await this.executors.findOne({
      where: { id: worker.executorId },
    });
    if (!executor || !executor.online) {
      throw new BadRequestException(
        `执行器 #${worker.executorId} 离线或不存在，无法初始化工作环境`,
      );
    }

    const running = this.jobs.get(id);
    if (running && running.status === 'running') {
      return this.toSnapshot(running);
    }
    // 覆盖终态旧任务：先清其 TTL 定时器，避免误清新任务
    if (running?.ttlTimer) clearTimeout(running.ttlTimer);
    const job: InitializeJob = {
      workerId: id,
      status: 'running',
      lines: [],
      error: null,
      workdir: null,
      startedAt: new Date(),
      finishedAt: null,
      emitter: new EventEmitter(),
    };
    // 编辑页/详情页可能同时订阅同一任务的进度
    job.emitter.setMaxListeners(50);
    this.jobs.set(id, job);
    // 刻意不 await：HTTP 请求立刻返回，文件同步在后台完成
    void this.run(job, worker, executor, workdir);
    return this.toSnapshot(job);
  }

  /** 最近一次初始化快照（无任务返回 idle） */
  snapshotOf(id: number): WorkerInitializeSnapshot {
    const job = this.jobs.get(id);
    if (job) return this.toSnapshot(job);
    return {
      workerId: id,
      status: 'idle',
      lines: [],
      error: null,
      workdir: null,
      startedAt: null,
      finishedAt: null,
    };
  }

  /**
   * 初始化进度 SSE：订阅即推当前快照，进度行增量推送，终态快照推送后完成流，
   * 心跳保活（小于 ALB 等网关的空闲超时）。
   */
  stream(id: number): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const job = this.jobs.get(id);
      if (!job) {
        // 无任务（从未初始化/服务重启后丢失）：推 idle 快照后结束，前端据此提示重试
        subscriber.next({
          data: {
            type: 'snapshot',
            snapshot: this.snapshotOf(id),
          } satisfies InitializeStreamPayload,
        });
        subscriber.complete();
        return;
      }
      let closed = false;
      const finishStream = () => {
        closed = true;
        clearInterval(keepalive);
        subscriber.complete();
      };
      const listener = (payload: InitializeStreamPayload) => {
        if (closed) return;
        subscriber.next({ data: payload });
        if (
          payload.type === 'snapshot' &&
          (payload.snapshot.status === 'success' ||
            payload.snapshot.status === 'failed')
        ) {
          finishStream();
        }
      };
      // 心跳先建（须小于网关空闲超时），保证任何触发路径都能安全清理
      const keepalive = setInterval(() => {
        if (!closed) {
          subscriber.next({
            data: { type: 'ping' } satisfies InitializeStreamPayload,
          });
        }
      }, STREAM_PING_MS);
      // 先挂监听再推快照，避免间隙漏事件
      job.emitter.on('payload', listener);
      listener({ type: 'snapshot', snapshot: this.toSnapshot(job) });
      return () => {
        closed = true;
        clearInterval(keepalive);
        job.emitter.off('payload', listener);
      };
    });
  }

  /** 后台执行：建工位 → 解析源版本 → 平台生成文件 → 批量同步 → 校验 manifest */
  private async run(
    job: InitializeJob,
    worker: Worker,
    executor: Executor,
    workdir: string,
  ): Promise<void> {
    const client = createExecutorClient(executor);
    const kernel = executor.type ?? ExecutorType.OPENCODE;
    try {
      this.pushLine(job, `▶ 开始初始化工位 ${workdir}`);
      this.pushLine(job, '· 创建工位目录…');
      await ensureWorkerSkeleton(client, workdir);

      const token = await this.workersService.ensureWorkToken(worker.id);
      const litaUserToken = this.resolveLitaUserToken();
      const [githubCredentialStatus, standards, skills] = await Promise.all([
        this.githubCredentials?.statusOf(worker.githubPermission) ??
          Promise.resolve({
            configured: false,
            enabled: false,
            githubAccount: null,
            rotatedAt: null,
          }),
        this.resolveStandardFiles(worker.standards),
        this.skillCatalog.resolveManagedFiles(worker.skills),
      ]);
      const accessLevel = resolveAccessLevel({ worker });
      const servers = await this.mcpServers.buildServersConfig(
        this.appUrl(),
        token,
        worker.mcps ?? [],
        accessLevel,
      );
      const mcpNames = Object.keys(servers).filter(
        (name) => name !== 'lita-work',
      );

      this.pushLine(
        job,
        `· 写入工位凭据与 MCP 配置（${kernel} + ${Object.keys(servers).length} 个服务）…`,
      );
      await Promise.all([
        this.writeWorkerSecrets(
          client,
          worker.id,
          workdir,
          token,
          litaUserToken,
        ),
        writeKernelMcpConfig(client, workdir, kernel, servers, {
          denyExternalDirectory: shouldDenyExternalDirectory(
            this.config.get<string>('WORKER_DENY_EXTERNAL_DIRECTORY'),
          ),
        }),
      ]);
      if (litaUserToken) {
        await this.syncLitaUserTokenToHost(client, litaUserToken);
      }

      const revision = this.stationRevision({
        worker,
        kernel,
        githubCredentialStatus,
        standards,
        skills,
        mcpNames,
      });
      const installed = await this.readJsonFile(
        client,
        workdir,
        STATION_MANIFEST_PATH,
      ).catch(() => null);
      if (installed?.revision === revision) {
        this.pushLine(job, '· 工位内容未变化，跳过文件同步');
        this.finish(job, 'success', null, workdir);
        return;
      }

      this.pushLine(
        job,
        `· 下载技能与规范（技能 ${skills.files.length} 个文件，规范 ${standards.files.length} 个文件）…`,
      );
      const [skillFiles, standardFiles] = await Promise.all([
        this.downloadSources(
          skills.rawBase,
          skills.files,
          WORKER_SKILLS_PATH,
          skills.entries,
        ),
        this.downloadSources(
          standards.rawBase,
          standards.files,
          WORKER_RULES_PATH,
          standards.entries,
        ),
      ]);
      const rulesSection = this.buildRulesSection(worker, standards);
      const mcpSection = this.buildMcpSection(mcpNames);
      const agents = this.buildAgentsDocument({
        worker,
        githubCredentialStatus,
        kernel,
        rulesSection,
        mcpSection,
      });

      const nextRulePaths = new Set(
        standardFiles.map((file) =>
          file.path.slice(`${WORKER_RULES_PATH}/`.length),
        ),
      );
      const oldRulePaths = await this.readManagedRulePaths(client, workdir);
      const staleRuleFiles = oldRulePaths
        .filter((path) => !nextRulePaths.has(path))
        .map((path) => `${WORKER_RULES_PATH}/${path}`);
      const mirrorDirs = this.mirrorDirs(kernel);
      const managedDirs = [WORKER_SKILLS_PATH, ...mirrorDirs];
      this.pushLine(job, '· 清理旧受管文件与内核镜像…');
      await Promise.all(
        managedDirs.map((dir) => client.removeDir(`${workdir}/${dir}`)),
      );
      await client.removeFiles(workdir, [
        ...staleRuleFiles,
        '.opencode/agent-token',
        '.opencode/.env',
      ]);
      await client
        .removeDir(`${workdir}/.opencode/docs`)
        .catch(() => undefined);
      await client
        .removeDir(`${workdir}/.opencode/skills`)
        .catch(() => undefined);

      const writes: StationWrite[] = [
        {
          path: 'AGENTS.md',
          bytes: Buffer.from(agents, 'utf8'),
        },
        ...skillFiles,
        ...standardFiles,
        ...this.mirrorWrites(kernel, standardFiles, skillFiles),
        {
          path: `${WORKER_RULES_PATH}/.standards-manifest.json`,
          bytes: Buffer.from(
            `${JSON.stringify(
              { version: 1, files: standards.files.slice().sort() },
              null,
              2,
            )}\n`,
            'utf8',
          ),
        },
      ];
      await this.ensureManagedDirs(client, workdir, kernel);
      this.pushLine(job, `· 发布 ${writes.length} 个工位文件…`);
      await mapWithConcurrency(writes, SYNC_CONCURRENCY, async (file) => {
        try {
          await client.writeFile(workdir, file.path, file.bytes);
        } catch (error) {
          throw new Error(
            `写入 ${file.path} 失败：${(error as Error).message}`,
          );
        }
      });

      const manifest = {
        version: STATION_SYNC_VERSION,
        revision,
        syncedAt: new Date().toISOString(),
        kernel,
        files: writes
          .map((file) => ({
            path: file.path,
            sha256: createHash('sha256').update(file.bytes).digest('hex'),
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      };
      this.pushLine(job, '· 写入同步 manifest 并校验…');
      await client.writeFile(
        workdir,
        STATION_MANIFEST_PATH,
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      );
      const verified = await this.readJsonFile(
        client,
        workdir,
        STATION_MANIFEST_PATH,
      );
      if (verified?.revision !== revision) {
        throw new Error('工位同步校验失败：manifest 版本不一致');
      }
      this.finish(job, 'success', null, workdir);
    } catch (e) {
      this.finish(job, 'failed', (e as Error).message);
    }
  }

  /**
   * 把机器人工作令牌与平台地址写入工位 .agents/.env：
   * LITA_WORK_TOKEN（新名，优先）与 LITA_PROJECT_TOKEN（兼容旧名）、LITA_APP_URL。
   * 个人 AGENT 使用其主人真人机器人的令牌。
   * 令牌只经服务端落盘，不进入初始化 Prompt、SSE 进度或日志。
   */
  private async writeWorkerSecrets(
    client: ExecutorClient,
    workerId: number,
    workdir: string,
    token?: string,
    litaUserToken?: string | null,
  ): Promise<void> {
    const workToken =
      token ?? (await this.workersService.ensureWorkToken(workerId));
    await upsertWorkerEnv(client, workdir, {
      LITA_WORK_TOKEN: workToken,
      LITA_PROJECT_TOKEN: workToken,
      LITA_APP_URL: this.appUrl(),
      ...(litaUserToken ? { LITA_USER_TOKEN: litaUserToken } : {}),
    });
  }

  /** 平台对外访问地址（含协议，去掉结尾斜杠） */
  private appUrl(): string {
    return (this.config.get<string>('APP_URL') ?? 'http://localhost:5273')
      .trim()
      .replace(/\/+$/, '');
  }

  /** Lita 用户令牌：优先工位专用配置，回退平台配置 */
  private resolveLitaUserToken(): string | null {
    return (
      this.config.get<string>('WORKER_LITA_USER_TOKEN')?.trim() ||
      this.config.get<string>('LITA_USER_TOKEN')?.trim() ||
      null
    );
  }

  /** 兼容按 ~/.env 读取令牌的技能；bridge 无 shell，失败只告警 */
  private async syncLitaUserTokenToHost(
    client: ExecutorClient,
    token: string,
  ): Promise<void> {
    try {
      await client.shell(
        `if [ -n "$HOME" ]; then { grep -v '^LITA_USER_TOKEN=' "$HOME/.env" 2>/dev/null; ` +
          `printf '%s\\n' 'LITA_USER_TOKEN=${token}'; } > "$HOME/.env.tmp" && ` +
          `chmod 600 "$HOME/.env.tmp" && mv "$HOME/.env.tmp" "$HOME/.env"; fi`,
      );
    } catch (e) {
      this.logger.warn(
        `同步 Lita 用户令牌到执行器 ~/.env 失败：${(e as Error).message}`,
      );
    }
  }

  /** 追加进度行并广播（超上限丢弃最旧行） */
  private pushLine(job: InitializeJob, line: string): void {
    job.lines.push(line);
    if (job.lines.length > MAX_LINES) {
      job.lines.splice(0, job.lines.length - MAX_LINES);
    }
    job.emitter.emit('payload', {
      type: 'line',
      line,
    } satisfies InitializeStreamPayload);
  }

  /** 终态落快照、广播、保留 TTL 后清理 */
  private finish(
    job: InitializeJob,
    status: 'success' | 'failed',
    error: string | null,
    workdir?: string,
  ): void {
    if (job.status !== 'running') return;
    job.status = status;
    job.error = error;
    job.workdir = workdir ?? null;
    job.finishedAt = new Date();
    const durationMs = job.finishedAt.getTime() - job.startedAt.getTime();
    if (status === 'success') {
      this.pushLine(
        job,
        `✅ 工作环境初始化完成：${workdir}（${formatDuration(durationMs)}）`,
      );
      this.logger.log(
        `机器人 #${job.workerId} 工作环境已初始化：${workdir}（${formatDuration(durationMs)}）`,
      );
    } else {
      this.pushLine(
        job,
        `✗ 初始化失败：${error ?? '未知错误'}（${formatDuration(durationMs)}）`,
      );
      this.logger.warn(
        `机器人 #${job.workerId} 工作环境初始化失败：${error ?? '未知错误'}（${formatDuration(durationMs)}）`,
      );
    }
    job.emitter.emit('payload', {
      type: 'snapshot',
      snapshot: this.toSnapshot(job),
    } satisfies InitializeStreamPayload);
    const timer = setTimeout(() => {
      // 仅清理自己：TTL 期间同机器人可能已启动新任务
      if (this.jobs.get(job.workerId) === job) this.jobs.delete(job.workerId);
    }, JOB_TTL_MS);
    timer.unref();
    job.ttlTimer = timer;
  }

  private toSnapshot(job: InitializeJob): WorkerInitializeSnapshot {
    return {
      workerId: job.workerId,
      status: job.status,
      lines: [...job.lines],
      error: job.error,
      workdir: job.workdir,
      startedAt: job.startedAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
    };
  }

  onModuleDestroy(): void {
    for (const job of this.jobs.values()) {
      if (job.ttlTimer) clearTimeout(job.ttlTimer);
    }
    this.jobs.clear();
  }

  /** 平台直接生成最终 AGENTS.md（不再由模型转写） */
  private buildAgentsDocument(input: {
    worker: Worker;
    githubCredentialStatus: GithubCredentialStatus;
    kernel: ExecutorType;
    rulesSection: string;
    mcpSection: string;
  }): string {
    const { worker, githubCredentialStatus, kernel, rulesSection, mcpSection } =
      input;
    const sections = [
      (worker.prompt ?? '').trim(),
      buildTaskCollaborationAgents(this.appUrl()),
      this.buildGithubAgentsSection(worker, githubCredentialStatus),
      this.buildResourceAgentsSection(worker),
      rulesSection,
      mcpSection,
      this.buildDirectorySection(kernel),
    ];
    return `${sections.filter(Boolean).join('\n\n')}\n`;
  }

  /** 写入 AGENTS.md 的规范清单：名称、说明、工位目录与全部规则文档 */
  private buildRulesSection(
    worker: Worker,
    standards: ManagedStandardFiles,
  ): string {
    if (!standards.directories.length) {
      return '## 规范与规则\n\n本次未选择规范。';
    }
    const standardsByDirectory = new Map(
      (worker.standards ?? []).map((item) => [item.directory, item]),
    );
    const ruleFiles = new Map<string, string[]>(
      standards.directories.map((directory) => [directory, []]),
    );
    for (const file of standards.files) {
      const owner = standards.directories
        .filter(
          (directory) => file === directory || file.startsWith(`${directory}/`),
        )
        .sort((a, b) => b.length - a.length)[0];
      if (owner) ruleFiles.get(owner)?.push(file);
    }
    return [
      '## 规范与规则',
      '',
      '以下规范由平台同步到 `.agents/rules/`，执行任务前按需阅读对应文档。',
      '',
      ...standards.directories.flatMap((directory) => {
        const standard = standardsByDirectory.get(directory);
        const name = standard?.name || directory;
        const description = standard?.description?.trim() || '（未提供说明）';
        const version = standard?.version?.trim();
        const sourceUrl = standard?.sourceUrl || standard?.url;
        const files = (ruleFiles.get(directory) ?? []).map((file) =>
          file === directory
            ? (file.split('/').pop() ?? file)
            : file.slice(directory.length + 1),
        );
        return [
          `### ${name}`,
          '',
          `- 说明：${description}`,
          ...(version ? [`- 版本：${version}`] : []),
          ...(sourceUrl ? [`- 原文：${sourceUrl}`] : []),
          `- 工位目录：\`.agents/rules/${directory}\``,
          '- 文档：',
          ...files.map((file) => `  - \`${file}\``),
          '',
        ];
      }),
    ].join('\n');
  }

  private buildMcpSection(mcpNames: string[]): string {
    const adminInjected = mcpNames.includes(LITA_WORK_ADMIN_SERVER_NAME);
    const customNames = mcpNames.filter(
      (name) => name !== LITA_WORK_ADMIN_SERVER_NAME,
    );
    return [
      '## 已配置的 MCP 服务',
      '',
      '平台固定注入：lita-work（Streamable HTTP，机器人令牌鉴权，由平台按执行内核写入配置文件并自动连接）。',
      ...(adminInjected
        ? [
            '',
            '额外注入：lita-work-admin（`/api/mcp/work-admin`）——本机器人访问级别为管理员，可管理机器人、任务定义、测试集与评估、执行记录。此类操作影响平台其他数据，只做明确被要求的事。',
          ]
        : []),
      ...(customNames.length
        ? [
            '',
            '机器人勾选的自定义 MCP（自动连接，可直接使用其工具）：',
            '',
            ...customNames.map((name) => `- ${name}`),
          ]
        : ['', '机器人未勾选其它自定义 MCP 服务。']),
    ].join('\n');
  }

  private buildDirectorySection(kernel: ExecutorType): string {
    return buildDirectoryAgentsSection(kernel);
  }

  /** 下载源仓库目录下的全部文件，并映射到工位路径 */
  private async downloadSources(
    rawBase: string,
    files: string[],
    destinationRoot: string,
    entries?: Array<{ path: string; sha: string }>,
  ): Promise<DownloadedSource[]> {
    if (!rawBase || !files.length) return [];
    const shaByPath = new Map(
      (entries ?? []).map((entry) => [entry.path, entry.sha]),
    );
    const rows = files.map((sourcePath) => {
      if (
        !sourcePath ||
        sourcePath.startsWith('/') ||
        sourcePath.split('/').includes('..')
      ) {
        throw new Error(`技能/规范源文件路径非法：${sourcePath}`);
      }
      const url = `${rawBase}/${sourcePath
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`;
      const sha = shaByPath.get(sourcePath) || '';
      return {
        sourcePath,
        url,
        // 内容缓存按 blob SHA 区分；同一分支更新后不会命中旧正文
        cacheKey: sha ? `${url}@${sha}` : url,
      };
    });
    const downloaded = await mapWithConcurrency(
      rows,
      SYNC_CONCURRENCY,
      async (row) => ({
        sourcePath: row.sourcePath,
        bytes: await this.sourceCache.get(row.url, row.cacheKey),
      }),
    );
    return downloaded.map((row) => ({
      sourcePath: row.sourcePath,
      path: `${destinationRoot}/${row.sourcePath}`,
      bytes: row.bytes,
    }));
  }

  /** 生成工位内容版本：机器人配置 + 权限 + 内核 + 源文件 blob SHA */
  private stationRevision(input: {
    worker: Worker;
    kernel: ExecutorType;
    githubCredentialStatus: GithubCredentialStatus;
    standards: ManagedStandardFiles;
    skills: ManagedSkillFiles;
    mcpNames: string[];
  }): string {
    const {
      worker,
      kernel,
      githubCredentialStatus,
      standards,
      skills,
      mcpNames,
    } = input;
    return createHash('sha256')
      .update(
        JSON.stringify({
          version: STATION_SYNC_VERSION,
          appUrl: this.appUrl(),
          template: stationTemplateFingerprint(this.appUrl(), kernel),
          kernel,
          prompt: worker.prompt ?? '',
          githubPermission: worker.githubPermission,
          githubCredential: {
            configured: githubCredentialStatus.configured,
            enabled: githubCredentialStatus.enabled,
            account: githubCredentialStatus.githubAccount,
          },
          resourcePermission: worker.resourcePermission,
          mcpNames: [...mcpNames].sort(),
          standards: {
            branch: standards.branch,
            entries: (
              standards.entries ??
              standards.files.map((path) => ({ path, sha: '' }))
            )
              .map((entry) => [entry.path, entry.sha])
              .sort(),
          },
          skills: {
            branch: skills.branch,
            entries: skills.entries
              .map((entry) => [entry.path, entry.sha])
              .sort(),
          },
        }),
      )
      .digest('hex');
  }

  /** 读取旧规范受管清单（迁移前路径也兼容） */
  private async readManagedRulePaths(
    client: ExecutorClient,
    workdir: string,
  ): Promise<string[]> {
    const paths = [
      `${WORKER_RULES_PATH}/.standards-manifest.json`,
      '.opencode/rules/.standards-manifest.json',
      '.opencode/docs/.standards-manifest.json',
    ];
    const manifests = await Promise.all(
      paths.map((path) =>
        this.readJsonFile(client, workdir, path).catch(() => null),
      ),
    );
    const files = new Set<string>();
    for (const manifest of manifests) {
      if (!Array.isArray(manifest?.files)) continue;
      for (const file of manifest.files) {
        if (typeof file !== 'string') continue;
        const normalized = file.replace(/^\/+/, '');
        if (
          normalized &&
          !normalized.split('/').includes('..') &&
          !normalized.startsWith('.agents/rules/')
        ) {
          files.add(normalized);
        }
      }
    }
    return [...files];
  }

  private async readJsonFile(
    client: ExecutorClient,
    workdir: string,
    path: string,
  ): Promise<Record<string, unknown> | null> {
    const bytes = await client.readFile(workdir, path);
    if (!bytes) return null;
    try {
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private mirrorDirs(kernel: ExecutorType): string[] {
    if (kernel === ExecutorType.OPENCODE) return ['.opencode/rules'];
    if (kernel === ExecutorType.KIRO) return ['.kiro/skills', '.kiro/steering'];
    if (kernel === ExecutorType.DROID) {
      return ['.factory/skills', '.factory/rules'];
    }
    return [];
  }

  private async ensureManagedDirs(
    client: ExecutorClient,
    workdir: string,
    kernel: ExecutorType,
  ): Promise<void> {
    const dirs = [
      WORKER_SKILLS_PATH,
      WORKER_RULES_PATH,
      ...this.mirrorDirs(kernel),
    ];
    await Promise.all(dirs.map((dir) => client.ensureDir(`${workdir}/${dir}`)));
  }

  /** 生成内核镜像写入（.agents 为唯一源） */
  private mirrorWrites(
    kernel: ExecutorType,
    standards: DownloadedSource[],
    skills: DownloadedSource[],
  ): StationWrite[] {
    const prefix = (root: string, file: DownloadedSource): StationWrite => ({
      path: `${root}/${file.sourcePath}`,
      bytes: file.bytes,
    });
    if (kernel === ExecutorType.OPENCODE) {
      return standards.map((file) => prefix('.opencode/rules', file));
    }
    if (kernel === ExecutorType.KIRO) {
      return [
        ...skills.map((file) => prefix('.kiro/skills', file)),
        ...standards.map((file) => prefix('.kiro/steering', file)),
      ];
    }
    if (kernel === ExecutorType.DROID) {
      return [
        ...skills.map((file) => prefix('.factory/skills', file)),
        ...standards.map((file) => prefix('.factory/rules', file)),
      ];
    }
    return [];
  }

  /**
   * 生成写入工位 AGENTS.md 的 GitHub 权限说明。
   * 只描述权限、允许/禁止事项与凭证可用性；不得出现 PAT、密文或 SecretRef。
   */
  private buildGithubAgentsSection(
    worker: Worker,
    status: GithubCredentialStatus,
  ): string {
    const permission = worker.githubPermission;
    const credentialText = !status.configured
      ? '未配置'
      : status.enabled
        ? `已配置${status.githubAccount ? `（GitHub 账号：${status.githubAccount}）` : ''}`
        : `已停用${status.githubAccount ? `（GitHub 账号：${status.githubAccount}）` : ''}`;

    if (permission === WorkerGithubPermission.NONE) {
      return `## GitHub 操作权限

当前权限：无权限。
凭证状态：${credentialText}。

禁止事项：
- 不要调用 OP Gateway 获取 GitHub 凭证。
- 不要 clone、fetch、pull 平台私有仓库，也不要 push 或创建 PR。
- 不要尝试审批或合并 PR。

如果当前任务确实需要 GitHub 操作，应向需求方说明：机器人尚未配置 GitHub 权限，需管理员在机器人配置页调整权限。`;
    }

    if (permission === WorkerGithubPermission.RELEASE) {
      return `## GitHub 操作权限

当前权限：发布权限。
凭证状态：${credentialText}。

允许事项：
- 通过 OP Gateway clone、fetch、pull 仓库。
- 创建任务分支、开发并提交代码。
- push 普通分支。
- 创建目标为 main、stable 的 PR。
- 在确认符合当前任务要求后，直接 push main、stable。
- 在确认符合当前任务要求后，审批 PR、合并 PR。

禁止事项：
- 修改仓库权限、Secret、Ruleset 或删除仓库。
- 试图读取、展示、导出或绕过 OP Gateway 获取 GitHub PAT。
- 执行与当前任务无关的写操作。`;
    }

    return `## GitHub 操作权限

当前权限：开发权限。
凭证状态：${credentialText}。

允许事项：
- 通过 OP Gateway clone、fetch、pull 仓库。
- 创建任务分支、开发并提交代码。
- push 普通分支。
- 创建目标为 main、stable 的 PR。

禁止事项：
- 直接 push main、stable。
- 审批或合并 PR。
- 修改仓库权限、Secret、Ruleset 或删除仓库。
- 试图读取、展示、导出或绕过 OP Gateway 获取 GitHub PAT。`;
  }

  /**
   * 生成写入工位 AGENTS.md 的资源网关权限说明。
   * 只描述权限与允许/禁止事项；不得出现资源密码、Token 或连接串。
   */
  private buildResourceAgentsSection(worker: Worker): string {
    const permission =
      worker.resourcePermission ?? WorkerResourcePermission.NONE;
    if (permission === WorkerResourcePermission.NONE) {
      return `## 资源访问权限

当前权限：无权限。

禁止事项：
- 不要调用 AI Gateway 的资源列表或 SQL 执行接口。
- 不要尝试通过管理接口修改资源配置或申请更高权限。
- 不要获取、展示或推断数据库密码。

如果当前任务确实需要访问内部资源，应向需求方说明：机器人尚未配置资源权限，需管理员在机器人配置页授权。`;
    }
    if (permission === WorkerResourcePermission.READ) {
      return `## 资源访问权限

当前权限：只读资源。

允许事项：
- 通过 AI Gateway 查询可访问的只读资源。
- 对 readOnly=true 的 MySQL 资源执行单条只读 SQL。
- 使用 .agents/skills 中已安装的 resource-gateway 技能调用资源接口。

禁止事项：
- 不要访问或尝试执行 readOnly=false 的可写资源；网关会返回 403。
- 不要执行 INSERT、UPDATE、DELETE、DDL 等写操作。
- 不要通过管理接口修改资源只读标记或权限。
- 不要获取、展示或写入数据库密码、Token 或连接串。`;
    }
    return `## 资源访问权限

当前权限：全部资源。

允许事项：
- 通过 AI Gateway 查询并访问全部已登记资源。
- 对 MySQL 资源执行任务所需的单条 SQL。
- 使用 .agents/skills 中已安装的 resource-gateway 技能调用资源接口。

禁止事项：
- readOnly=true 的资源仍执行只读事务；不要尝试绕过该限制。
- 未获得用户明确确认时，不要在生产环境执行写操作。
- 不要通过管理接口修改资源配置或权限。
- 不要获取、展示或写入数据库密码、Token 或连接串。`;
  }

  private githubPermissionLabel(
    permission: Worker['githubPermission'],
  ): string {
    if (permission === WorkerGithubPermission.RELEASE) return '发布权限';
    if (permission === WorkerGithubPermission.NONE) return '无权限';
    return '开发权限';
  }

  /** 解析本次需同步的规范目录与文件清单；规范库不可访问时初始化直接失败 */ private async resolveStandardFiles(
    standards: Worker['standards'],
  ): Promise<ManagedStandardFiles> {
    try {
      return await this.standardCatalog.resolveManagedFiles(standards);
    } catch (e) {
      throw new BadRequestException(`规范库读取失败：${(e as Error).message}`);
    }
  }
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 有限并发执行（保持结果顺序） */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      () => run(),
    ),
  );
  return results;
}
