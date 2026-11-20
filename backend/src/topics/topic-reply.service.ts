import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TopicStatus, WorkerRole } from '../common/enums';
import { isAgentRuntime } from '../common/worker-runtime';
import { beijingTime } from '../common/frontmatter';
import { Executor } from '../executors/executor.entity';
import { createExecutorClient } from '../executors/executor-client';
import { planPromptModels, runExecutorPrompt } from '../executors/executor-run';
import { nextInboxRetryDelay } from '../tasks/task-loop.rules';
import { TaskRequesterSessionService } from '../tasks/task-requester-session.service';
import { Worker } from '../workers/worker.entity';
import {
  upsertWorkerEnv,
  WORKER_ENV_SOURCE_COMMAND,
  WORKER_TOKEN_SHELL_ASSIGN,
} from '../workers/worker-env';
import { WorkersService } from '../workers/workers.service';
import { TopicPost } from './topic-post.entity';
import { TopicWorkerInbox } from './topic-worker-inbox.entity';
import { Topic } from './topic.entity';

/** 一次性答复会话最长耗时 */
const REPLY_TIMEOUT_MS = 180_000;

/** 提示词中正文截断长度 */
const MAX_CONTEXT_CHARS = 2_000;

/** 提示词携带的最近帖子数 */
const MAX_HISTORY_POSTS = 12;

/** 同一收件箱条目最多尝试次数（超过置 dead） */
export const TOPIC_REPLY_MAX_ATTEMPTS = 5;

interface ReplyEndpoint {
  worker: Worker;
  executor: Executor;
  providerId: string;
  modelId: string;
  variant: string | null;
  workdir: string;
}

function clip(value: string | null | undefined, limit: number): string {
  const text = value?.trim() ?? '';
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（已截断）`;
}

/**
 * 话题机器人答复：帖子（或首楼）@ 到 AI 机器人后，用该机器人自己的执行器
 * 创建一次性会话读取话题上下文，经 `POST /api/topics/{id}/posts.md` 回帖。
 * - 与任务需求方一次性会话共用 per-worker 互斥锁，避免同一工位并发；
 * - 会话结束仍未回帖按 2/10/30 分钟退避，超过上限置 dead；
 * - 回帖成功由 TopicsService 关闭对应收件箱条目。
 */
@Injectable()
export class TopicReplyService {
  private readonly logger = new Logger(TopicReplyService.name);
  private readonly apiUrl: string;

  constructor(
    @InjectRepository(Topic)
    private readonly topics: Repository<Topic>,
    @InjectRepository(TopicPost)
    private readonly posts: Repository<TopicPost>,
    @InjectRepository(TopicWorkerInbox)
    private readonly inbox: Repository<TopicWorkerInbox>,
    @InjectRepository(Executor)
    private readonly executors: Repository<Executor>,
    @InjectRepository(Worker)
    private readonly workers: Repository<Worker>,
    private readonly workersService: WorkersService,
    private readonly sessions: TaskRequesterSessionService,
    config: ConfigService,
  ) {
    this.apiUrl = (
      config.get<string>('API_URL') ?? 'http://localhost:3100/api'
    ).replace(/\/+$/, '');
  }

  /**
   * 尝试答复一条收件箱记录。
   * 返回 false 表示本次未完成（机器人不可用、会话被占用、会话未回帖等），由 LOOP 退避重试。
   */
  async reply(topic: Topic, entry: TopicWorkerInbox): Promise<boolean> {
    if (entry.status === 'done' || entry.status === 'dead') return true;
    if (topic.status === TopicStatus.CLOSED) {
      await this.markDead(entry.id, '话题已关闭，不再答复');
      return true;
    }
    const endpoint = await this.resolveEndpoint(entry.workerId);
    if (!endpoint) {
      await this.defer(entry, '机器人未启用、执行器离线或缺少可用模型');
      return false;
    }
    if (!this.sessions.tryAcquire(endpoint.worker.id)) return false;

    const client = createExecutorClient(endpoint.executor);
    let sessionId: string | null = null;
    try {
      await this.inbox.update(
        { id: entry.id },
        {
          status: 'delivered',
          attempts: entry.attempts + 1,
          lastAttemptAt: new Date(),
          deliveredAt: new Date(),
        },
      );
      const token = await this.workersService.ensureWorkToken(
        endpoint.worker.id,
      );
      await upsertWorkerEnv(client, endpoint.workdir, {
        LITA_WORK_TOKEN: token,
        LITA_PROJECT_TOKEN: token,
      });
      const plan = planPromptModels(endpoint.worker, endpoint.executor.id, {
        providerId: endpoint.providerId,
        modelId: endpoint.modelId,
        variant: endpoint.variant,
      });
      await runExecutorPrompt(client, {
        title: `话题答复 ${topic.id}`.slice(0, 100),
        model: plan.model,
        fallback: plan.fallback,
        onQuotaError: plan.onQuotaError,
        location: { directory: endpoint.workdir },
        prompt: await this.buildPrompt(topic, entry, endpoint.worker),
        timeoutMs: REPLY_TIMEOUT_MS,
        onSessionCreated: (id) => {
          sessionId = id;
        },
      });
      const latest = await this.inbox.findOne({ where: { id: entry.id } });
      if (latest?.status === 'done') return true;
      await this.defer(entry, '自动答复会话已结束，但机器人未调用回帖接口');
      return false;
    } catch (error) {
      await this.defer(entry, (error as Error).message);
      return false;
    } finally {
      this.sessions.release(endpoint.worker.id);
      if (sessionId) {
        await client
          .deleteSession(sessionId)
          .catch((e: Error) =>
            this.logger.warn(
              `话题答复会话 ${sessionId} 清理失败：${e.message}`,
            ),
          );
      }
    }
  }

  /** 机器人必须启用、有执行器与可用模型 */
  private async resolveEndpoint(
    workerId: number,
  ): Promise<ReplyEndpoint | null> {
    const worker = await this.workers.findOne({ where: { id: workerId } });
    if (
      !worker ||
      !worker.enabled ||
      worker.role !== WorkerRole.WORKER ||
      !isAgentRuntime(worker.runtime) ||
      worker.personalAgentUserId
    ) {
      return null;
    }
    if (!worker.executorId) return null;
    const executor = await this.executors.findOne({
      where: { id: worker.executorId },
    });
    if (!executor?.online) return null;

    let providerId = worker.providerId?.trim() || '';
    let modelId = worker.modelId?.trim() || '';
    if (!providerId || !modelId) {
      const provider = executor.providersCache?.find(
        (item) => item.models.length > 0,
      );
      providerId ||= provider?.id ?? '';
      modelId ||= provider?.models[0]?.id ?? '';
    }
    if (!providerId || !modelId) return null;
    const workdir = this.workersService.workdirOf(worker.id);
    if (!workdir) return null;
    return {
      worker,
      executor,
      providerId,
      modelId,
      variant: worker.variant ?? null,
      workdir,
    };
  }

  /** 未完成：退避重试；达到上限置 dead */
  private async defer(entry: TopicWorkerInbox, reason: string): Promise<void> {
    const attempts = entry.attempts + 1;
    if (attempts >= TOPIC_REPLY_MAX_ATTEMPTS) {
      await this.markDead(entry.id, reason);
      return;
    }
    const delay = nextInboxRetryDelay(entry.attempts);
    await this.inbox.update(
      { id: entry.id },
      {
        status: 'pending',
        nextRetryAt: new Date(Date.now() + delay),
        lastError: reason,
      },
    );
    this.logger.warn(
      `话题 #${entry.topicId} 机器人 #${entry.workerId} 答复未完成（第 ${attempts} 次），` +
        `${Math.round(delay / 60_000)} 分钟后重试：${reason}`,
    );
  }

  private async markDead(id: number, reason: string): Promise<void> {
    await this.inbox.update(
      { id },
      {
        status: 'dead',
        processedAt: new Date(),
        lastError: reason,
      },
    );
  }

  private async buildPrompt(
    topic: Topic,
    entry: TopicWorkerInbox,
    worker: Worker,
  ): Promise<string> {
    const rows = await this.posts.find({
      where: { topicId: topic.id },
      order: { id: 'DESC' },
      take: MAX_HISTORY_POSTS,
    });
    const history = rows.reverse().map((post) => {
      const quote = post.replyToPostId ? `（回复 #${post.replyToPostId}）` : '';
      return `- #${post.id} ${post.authorName}${quote} · ${beijingTime(post.createdAt)}：${clip(post.content, 400)}`;
    });
    const trigger = entry.postId
      ? rows.find((post) => post.id === entry.postId)
      : null;
    const lines: string[] = [
      `你是平台机器人「${worker.name}」。你在话题《${topic.title}》中被 @，请先阅读完整上下文，再以机器人身份回帖。`,
      '',
      '# 话题',
      '',
      `- 话题 ID：${topic.id}`,
      `- 主体：${topic.subjectType}·${topic.subjectTitle}（#${topic.subjectId}）`,
      `- 优先级：${topic.priority} · 状态：${topic.status}`,
      `- 标签：${(topic.tags ?? []).join('、') || '-'}`,
      `- 创建人：${topic.creatorName}`,
      `- 详情：GET ${this.apiUrl}/topics/${topic.id}.md`,
      '',
      '# 首楼',
      '',
      clip(topic.content, MAX_CONTEXT_CHARS),
      '',
      '# 最近帖子',
      '',
      ...(history.length > 0 ? history : ['（暂无帖子）']),
      '',
      '# 触发本帖',
      '',
      trigger
        ? `${trigger.authorName}：\n${clip(trigger.content, MAX_CONTEXT_CHARS)}`
        : `首楼 @ 了你：\n${clip(topic.content, MAX_CONTEXT_CHARS)}`,
      '',
      '# 必须执行的动作',
      '',
      '阅读 `GET ' +
        `${this.apiUrl}/topics/${topic.id}.md` +
        '` 了解完整上下文后，调用回帖接口：',
      '',
      '```bash',
      WORKER_ENV_SOURCE_COMMAND,
      WORKER_TOKEN_SHELL_ASSIGN,
      `curl -sS -X POST '${this.apiUrl}/topics/${topic.id}/posts.md' \\`,
      '  -H "X-Worker-Token: $TOKEN" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '${JSON.stringify({
        content: '你的回复内容',
        ...(entry.postId ? { replyToPostId: entry.postId } : {}),
      })}'`,
      '```',
      '',
      '# 回复要求',
      '',
      '- 直接回应被 @ 的问题，结合首楼与最近帖子给出准确、可执行的答复。',
      '- 只输出文字、不调用回帖接口会被视为未处理并自动重试。',
      '- 不要修改话题元信息，也不要 @ 其他机器人，避免循环触发。',
      '',
    ];
    return lines.join('\n');
  }
}
