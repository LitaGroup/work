import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  MessageEvent,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Observable, filter } from 'rxjs';
import { Brackets, In, Repository } from 'typeorm';
import { Defect } from '../defects/defect.entity';
import { Project } from '../projects/project.entity';
import { Task } from '../tasks/task.entity';
import {
  TopicPostSource,
  TopicPriority,
  TopicStatus,
  TopicSubjectType,
  WorkerRuntime,
} from '../common/enums';
import { beijingTime, mdFrontmatter } from '../common/frontmatter';
import { matchesPinyinSearch } from '../common/pinyin-search';
import { Worker } from '../workers/worker.entity';
import { Backlog } from '../iterations/backlog.entity';
import { Ticket } from '../tickets/ticket.entity';
import { LlmService } from '../model-config/llm.service';
import { TopicFollow } from './topic-follow.entity';
import { TopicPost } from './topic-post.entity';
import { TopicWorkerInbox } from './topic-worker-inbox.entity';
import { Topic } from './topic.entity';
import { topicSectionFor } from './topic-markdown';
import {
  TOPIC_EVENT_BUS,
  type TopicEvent,
  type TopicEventBus,
} from './topic-events';

/** 列表查询上限（话题为轻量记录，SQL 过滤后内存完成标签/拼音过滤） */
const LIST_LIMIT = 500;

/** 标签数量与单标签长度上限 */
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 24;

/** 单条帖子 @ 机器人数量上限 */
const MAX_MENTIONS = 20;

/** 标题兜底：正文首行截断长度 */
const TITLE_LINE_LIMIT = 60;

/** 操作人身份：网页真人与机器人（普通机器人以自身身份参与讨论） */
export interface TopicActor {
  userId: number | null;
  workerId: number | null;
  userName: string;
  isAdmin: boolean;
}

export interface TopicListQuery {
  subjectType?: TopicSubjectType;
  subjectId?: number;
  status?: TopicStatus;
  priority?: TopicPriority;
  /** 标签精确匹配 */
  tag?: string;
  /** 关键词（标题/创建人，支持拼音） */
  q?: string;
  /** 只看该用户关注的话题 */
  followingUserId?: number;
}

export interface CreateTopicInput {
  subjectType: TopicSubjectType;
  subjectId: number;
  /** 可省略：省略时用正文首行兜底并异步由模型生成 */
  title?: string;
  content: string;
  priority?: TopicPriority;
  tags?: string[];
  /** @ 的机器人（workers.id） */
  mentions?: number[];
}

export interface UpdateTopicInput {
  title?: string;
  /** 首楼正文（创建人或管理员可改） */
  content?: string;
  priority?: TopicPriority;
  tags?: string[];
  /** 状态流转：开放/已解决/已关闭 */
  status?: TopicStatus;
}

export interface CreateTopicPostInput {
  content: string;
  /** 回复的目标帖子（同话题内） */
  replyToPostId?: number | null;
  /** @ 的机器人（workers.id） */
  mentions?: number[];
  /** 飞书回流来源（仅内部调用） */
  source?: TopicPostSource;
  sourceMessageId?: string | null;
  /** 飞书回流作者（仅内部调用；不传用 actor） */
  authorUserId?: number | null;
  authorWorkerId?: number | null;
  authorName?: string;
}

/** 帖子视图：附带被引用帖子摘要，供平铺楼层展示引用条 */
export interface TopicPostView extends TopicPost {
  replyTo?: {
    id: number;
    authorName: string;
    excerpt: string;
  } | null;
}

/** Markdown 表格单元格转义（换行与竖线） */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

/** 取 Markdown 首行作为标题兜底（去掉常见标记） */
export function fallbackTopicTitle(content: string): string {
  const line = (content ?? '')
    .split(/\r?\n/)
    .map((part) => part.replace(/^[#>\-*\d.\s]+/, '').trim())
    .find(Boolean);
  if (!line) return '新话题';
  return line.length > TITLE_LINE_LIMIT
    ? `${line.slice(0, TITLE_LINE_LIMIT)}…`
    : line;
}

/** 帖子引用摘要（纯文本截断） */
function postExcerpt(content: string): string {
  const text = content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** 主体展示名：类型 + 标题摘要（列表/卡片展示） */
export function subjectLabel(type: TopicSubjectType, title: string): string {
  return `${type}·${title}`;
}

@Injectable()
export class TopicsService {
  private readonly logger = new Logger(TopicsService.name);
  /** 正在生成标题的话题 ID，避免重复触发 */
  private readonly titleNaming = new Set<number>();

  constructor(
    @InjectRepository(Topic)
    private readonly topics: Repository<Topic>,
    @InjectRepository(TopicPost)
    private readonly posts: Repository<TopicPost>,
    @InjectRepository(TopicFollow)
    private readonly follows: Repository<TopicFollow>,
    @InjectRepository(TopicWorkerInbox)
    private readonly inbox: Repository<TopicWorkerInbox>,
    @InjectRepository(Worker)
    private readonly workers: Repository<Worker>,
    @InjectRepository(Backlog)
    private readonly backlogs: Repository<Backlog>,
    @InjectRepository(Defect)
    private readonly defects: Repository<Defect>,
    @InjectRepository(Task)
    private readonly tasks: Repository<Task>,
    @InjectRepository(Ticket)
    private readonly tickets: Repository<Ticket>,
    @InjectRepository(Project)
    private readonly projects: Repository<Project>,
    private readonly llm: LlmService,
    @Inject(TOPIC_EVENT_BUS)
    private readonly events: TopicEventBus,
  ) {}

  // ==== 主体 ====

  /**
   * 解析主体标题快照：主体不存在时拒绝建话题。
   * 缺陷没有独立标题，取「预期」首行。
   */
  async resolveSubject(
    type: TopicSubjectType,
    id: number,
  ): Promise<{ title: string }> {
    switch (type) {
      case TopicSubjectType.BACKLOG: {
        const row = await this.backlogs.findOne({
          where: { id },
          select: { id: true, title: true },
        });
        if (row) return { title: row.title };
        break;
      }
      case TopicSubjectType.DEFECT: {
        const row = await this.defects.findOne({
          where: { id },
          select: { id: true, expected: true },
        });
        if (row) return { title: fallbackTopicTitle(row.expected) };
        break;
      }
      case TopicSubjectType.TASK: {
        const row = await this.tasks.findOne({
          where: { id },
          select: { id: true, title: true },
        });
        if (row) return { title: row.title };
        break;
      }
      case TopicSubjectType.TICKET: {
        const row = await this.tickets.findOne({
          where: { id },
          select: { id: true, title: true },
        });
        if (row) return { title: row.title };
        break;
      }
      case TopicSubjectType.REQUIREMENT: {
        const row = await this.projects.findOne({
          where: { id },
          select: { id: true, name: true },
        });
        if (row) return { title: row.name };
        break;
      }
      default:
        throw new BadRequestException('未知的话题主体类型');
    }
    throw new NotFoundException(`话题主体不存在：${type} #${id}`);
  }

  // ==== 话题 ====

  /**
   * 话题列表（含首楼摘要，不含帖子正文）：主体/状态/优先级走 SQL 过滤，
   * 标签与关键词（标题/创建人拼音）在结果集内过滤。
   */
  async list(query: TopicListQuery): Promise<Topic[]> {
    const qb = this.topics.createQueryBuilder('t');
    if (query.subjectType) {
      qb.andWhere('t.subjectType = :subjectType', {
        subjectType: query.subjectType,
      });
    }
    if (query.subjectId) {
      qb.andWhere('t.subjectId = :subjectId', { subjectId: query.subjectId });
    }
    if (query.status) {
      qb.andWhere('t.status = :status', { status: query.status });
    }
    if (query.priority) {
      qb.andWhere('t.priority = :priority', { priority: query.priority });
    }
    if (query.followingUserId) {
      qb.andWhere(
        new Brackets((where) => {
          where.where(
            `EXISTS (SELECT 1 FROM "topic_follows" f WHERE f."topicId" = t.id AND f."userId" = :followingUserId)`,
            { followingUserId: query.followingUserId },
          );
        }),
      );
    }
    qb.orderBy('COALESCE(t.lastPostAt, t.createdAt)', 'DESC')
      .addOrderBy('t.id', 'DESC')
      .take(LIST_LIMIT);
    let rows = await qb.getMany();
    if (query.tag) {
      rows = rows.filter((row) =>
        (row.tags ?? []).includes(query.tag as string),
      );
    }
    if (query.q) {
      rows = rows.filter((row) =>
        matchesPinyinSearch(query.q as string, [
          row.title,
          row.creatorName,
          row.subjectTitle,
        ]),
      );
    }
    return rows;
  }

  async findOne(id: number): Promise<Topic> {
    const topic = await this.topics.findOne({ where: { id } });
    if (!topic) throw new NotFoundException(`Topic ${id} not found`);
    return topic;
  }

  async create(input: CreateTopicInput, actor: TopicActor): Promise<Topic> {
    const subjectType = input.subjectType;
    if (!Object.values(TopicSubjectType).includes(subjectType)) {
      throw new BadRequestException('未知的话题主体类型');
    }
    const subject = await this.resolveSubject(subjectType, input.subjectId);
    const content = (input.content ?? '').trim();
    if (!content) throw new BadRequestException('话题内容不能为空');
    const explicitTitle = (input.title ?? '').trim();
    const topic = this.topics.create({
      subjectType,
      subjectId: input.subjectId,
      subjectTitle: subject.title,
      title: explicitTitle
        ? this.normalizeTitle(explicitTitle)
        : fallbackTopicTitle(content),
      priority: this.normalizePriority(input.priority),
      status: TopicStatus.OPEN,
      tags: this.normalizeTags(input.tags),
      content,
      creatorUserId: actor.userId,
      creatorWorkerId: actor.workerId,
      creatorName: actor.userName,
      mentions: this.normalizeMentions(input.mentions),
      feishuChatId: null,
      feishuRootMessageId: null,
      feishuThreadId: null,
      postCount: 0,
      lastPostAt: null,
    });
    const saved = await this.topics.save(topic);
    await this.queueMentions(saved, 0, saved.mentions);
    if (!explicitTitle && content) this.scheduleTitleNaming(saved);
    this.emit({ kind: 'topic-created', topicId: saved.id });
    return saved;
  }

  /** 更新话题：元信息/首楼正文/状态；创建人（或同机器人）与管理员可改 */
  async update(
    id: number,
    input: UpdateTopicInput,
    actor: TopicActor,
  ): Promise<Topic> {
    const topic = await this.findOne(id);
    this.assertOwnerOrAdmin(topic, actor, '仅创建人或管理员可修改话题');

    if (input.title !== undefined) {
      topic.title = this.normalizeTitle(input.title);
    }
    if (input.content !== undefined) {
      const content = input.content.trim();
      if (!content) throw new BadRequestException('话题内容不能为空');
      topic.content = content;
    }
    if (input.priority !== undefined) {
      topic.priority = this.normalizePriority(input.priority);
    }
    if (input.tags !== undefined) {
      topic.tags = this.normalizeTags(input.tags);
    }
    if (input.status !== undefined) {
      topic.status = this.normalizeStatus(input.status);
    }
    const saved = await this.topics.save(topic);
    this.emit({ kind: 'topic-updated', topicId: saved.id });
    return saved;
  }

  /** 删除话题（仅管理员）：应用层清理帖子、关注与机器人收件箱 */
  async remove(id: number, actor: TopicActor): Promise<void> {
    if (!actor.isAdmin) {
      throw new ForbiddenException('仅管理员可删除话题');
    }
    const topic = await this.findOne(id);
    await this.posts.delete({ topicId: topic.id });
    await this.follows.delete({ topicId: topic.id });
    await this.inbox.delete({ topicId: topic.id });
    await this.topics.remove(topic);
  }

  // ==== 帖子 ====

  /** 帖子列表（按时间正序，平铺楼层 + 引用摘要） */
  async listPosts(topicId: number): Promise<TopicPostView[]> {
    await this.findOne(topicId);
    const rows = await this.posts.find({
      where: { topicId },
      order: { id: 'ASC' },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return rows.map((row) => {
      const target = row.replyToPostId
        ? byId.get(row.replyToPostId)
        : undefined;
      return Object.assign(row, {
        replyTo: target
          ? {
              id: target.id,
              authorName: target.authorName,
              excerpt: postExcerpt(target.content),
            }
          : null,
      });
    });
  }

  /**
   * 话题 SSE：订阅后先推快照（话题 + 帖子），再推 topic-created/post-created 增量；
   * 服务端重连不会漏掉终态（晚订阅直接拿最新快照）。
   */
  stream(topicId: number): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let closed = false;
      let subscription: { unsubscribe(): void } | null = null;
      void this.findOne(topicId)
        .then(async (topic) => {
          if (closed) return;
          const posts = await this.listPosts(topicId);
          subscriber.next({ data: { type: 'snapshot', topic, posts } });
          subscription = this.events
            .pipe(
              filter(
                (event: TopicEvent) =>
                  'topicId' in event && event.topicId === topicId,
              ),
            )
            .subscribe({
              next: (event) =>
                subscriber.next({ data: { type: 'event', event } }),
              error: (error: Error) => subscriber.error(error),
            });
        })
        .catch((error: Error) => subscriber.error(error));
      return () => {
        closed = true;
        subscription?.unsubscribe();
      };
    });
  }

  /** 发帖：话题已关闭时拒绝；引用帖必须属于同一话题 */
  async createPost(
    topicId: number,
    input: CreateTopicPostInput,
    actor: TopicActor,
  ): Promise<TopicPost> {
    const topic = await this.findOne(topicId);
    if (topic.status === TopicStatus.CLOSED) {
      throw new BadRequestException('话题已关闭，不能继续发帖');
    }
    const content = (input.content ?? '').trim();
    if (!content) throw new BadRequestException('帖子内容不能为空');
    if (input.replyToPostId) {
      const target = await this.posts.findOne({
        where: { id: input.replyToPostId, topicId },
      });
      if (!target) throw new BadRequestException('引用的帖子不属于该话题');
    }
    const post = this.posts.create({
      topicId,
      replyToPostId: input.replyToPostId ?? null,
      authorUserId: input.authorUserId ?? actor.userId,
      authorWorkerId: input.authorWorkerId ?? actor.workerId,
      authorName: input.authorName ?? actor.userName,
      content,
      mentions: this.normalizeMentions(input.mentions),
      source: input.source ?? TopicPostSource.PLATFORM,
      sourceMessageId: input.sourceMessageId ?? null,
    });
    const saved = await this.posts.save(post);
    await this.topics.update(
      { id: topicId },
      { postCount: topic.postCount + 1, lastPostAt: saved.createdAt },
    );
    await this.queueMentions(topic, saved.id, saved.mentions);
    // 机器人回帖即视为已完成被 @ 的答复（收件箱按 话题 + 机器人 关闭）
    const replyWorkerId = input.authorWorkerId ?? actor.workerId;
    if (replyWorkerId) {
      await this.inbox.update(
        {
          topicId,
          workerId: replyWorkerId,
          status: In(['pending', 'queued', 'delivered']),
        },
        { status: 'done', processedAt: new Date() },
      );
    }
    this.emit({ kind: 'post-created', topicId, postId: saved.id });
    return saved;
  }

  /** 删除帖子（仅管理员）：保留其余帖子的引用关系，前端展示「原帖已删除」 */
  async removePost(
    topicId: number,
    postId: number,
    actor: TopicActor,
  ): Promise<void> {
    if (!actor.isAdmin) {
      throw new ForbiddenException('仅管理员可删除帖子');
    }
    await this.findOne(topicId);
    const result = await this.posts.delete({ id: postId, topicId });
    if (!result.affected)
      throw new NotFoundException(`Post ${postId} not found`);
    const remaining = await this.posts.count({ where: { topicId } });
    const latest = await this.posts.findOne({
      where: { topicId },
      order: { id: 'DESC' },
    });
    await this.topics.update(
      { id: topicId },
      {
        postCount: remaining,
        lastPostAt: latest?.createdAt ?? null,
      },
    );
  }

  // ==== 关注 ====

  async isFollowing(topicId: number, userId: number | null): Promise<boolean> {
    if (!userId) return false;
    const row = await this.follows.findOne({ where: { topicId, userId } });
    return Boolean(row);
  }

  /** 关注（幂等） */
  async follow(topicId: number, userId: number): Promise<void> {
    await this.findOne(topicId);
    await this.follows
      .createQueryBuilder()
      .insert()
      .into(TopicFollow)
      .values({ topicId, userId })
      .orIgnore()
      .execute();
  }

  /** 取消关注（幂等） */
  async unfollow(topicId: number, userId: number): Promise<void> {
    await this.follows.delete({ topicId, userId });
  }

  /** 关注的用户 ID 列表（关注通知用） */
  async followerIds(topicId: number): Promise<number[]> {
    const rows = await this.follows.find({
      where: { topicId },
      select: { userId: true },
    });
    return rows.map((row) => row.userId);
  }

  /** 我关注的话题 */
  async listFollowed(userId: number): Promise<Topic[]> {
    const rows = await this.follows.find({
      where: { userId },
      order: { id: 'DESC' },
      take: LIST_LIMIT,
    });
    if (rows.length === 0) return [];
    const topics = await this.topics.find({
      where: { id: In(rows.map((row) => row.topicId)) },
    });
    const byId = new Map(topics.map((topic) => [topic.id, topic]));
    return rows
      .map((row) => byId.get(row.topicId))
      .filter((topic): topic is Topic => Boolean(topic));
  }

  /** 标签建议：最近话题中出现过的标签去重（按出现次数倒序） */
  async listTags(): Promise<string[]> {
    const rows = await this.topics.find({
      select: { tags: true },
      order: { id: 'DESC' },
      take: LIST_LIMIT,
    });
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const tag of row.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag)
      .slice(0, 50);
  }

  // ==== Markdown 视图 ====

  /** GET /api/topics.md：话题清单 Markdown 视图 */
  async listMarkdown(query: TopicListQuery): Promise<string> {
    const rows = await this.list(query);
    const head = mdFrontmatter({
      title: '话题列表',
      description: `共 ${rows.length} 条`,
    });
    const lines: string[] = [
      '# 话题',
      '',
      `共 ${rows.length} 条。详情：GET /api/topics/{id}.md；发帖：POST /api/topics/{id}/posts。`,
      '',
    ];
    if (rows.length === 0) {
      lines.push('（暂无话题）');
    } else {
      lines.push(
        '| ID | 标题 | 主体 | 优先级 | 状态 | 帖子 | 创建人 | 最近活动 | 详情 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      );
      for (const topic of rows) {
        lines.push(
          `| ${topic.id} | ${escapeCell(topic.title)} | ${escapeCell(
            subjectLabel(topic.subjectType, topic.subjectTitle),
          )} | ${topic.priority} | ${topic.status} | ${topic.postCount} | ${escapeCell(
            topic.creatorName,
          )} | ${beijingTime(topic.lastPostAt ?? topic.createdAt)} | /api/topics/${topic.id}.md |`,
        );
      }
    }
    return `${head}${lines.join('\n')}\n`;
  }

  /** GET /api/topics/:id.md：话题详情（首楼 + 帖子 + 操作指引） */
  async findOneMarkdown(id: number): Promise<string> {
    const topic = await this.findOne(id);
    const posts = await this.listPosts(id);
    const head = mdFrontmatter({
      update: topic.updatedAt,
      title: topic.title,
      subject: subjectLabel(topic.subjectType, topic.subjectTitle),
      priority: topic.priority,
      status: topic.status,
    });
    const meta = [
      `- 话题 ID：${topic.id}`,
      `- 主体：${subjectLabel(topic.subjectType, topic.subjectTitle)}（${topic.subjectType} #${topic.subjectId}）`,
      `- 优先级：${topic.priority}`,
      `- 状态：${topic.status}`,
      `- 标签：${(topic.tags ?? []).join('、') || '-'}`,
      `- 创建人：${topic.creatorName}（创建 ${beijingTime(topic.createdAt)}）`,
    ];
    if (topic.mentions?.length) {
      meta.push(
        `- 首楼 @ 机器人：${topic.mentions.map((wid) => `#${wid}`).join('、')}`,
      );
    }
    const sections = ['# 话题', '', ...meta, '', '## 首楼', '', topic.content];
    if (posts.length > 0) {
      sections.push('', `## 帖子（共 ${posts.length} 条）`, '');
      for (const post of posts) {
        const time = beijingTime(post.createdAt);
        const quote = post.replyTo
          ? `\n> 回复 ${post.replyTo.authorName}：${post.replyTo.excerpt}\n`
          : '';
        const mention = post.mentions?.length
          ? `\n@ ${post.mentions.map((wid) => `#${wid}`).join('、')}`
          : '';
        sections.push(
          `### 帖子 #${post.id} · ${post.authorName} · ${time}${post.source === TopicPostSource.FEISHU_GROUP ? ' · 飞书群' : ''}`,
          quote,
          post.content,
          mention,
          '',
        );
      }
    }
    sections.push(
      '## 操作',
      '',
      `- 回帖：POST /api/topics/${topic.id}/posts（body: { content, replyToPostId?, mentions? }）`,
      `- 被 @ 时先读本视图了解上下文，再回帖；不要修改话题元信息（除非创建人/管理员）。`,
      '',
    );
    return `${head}${sections.join('\n')}\n`;
  }

  /** 主体详情 .md 的话题清单小节（附到主体视图末尾） */
  async subjectMarkdownSection(
    subjectType: TopicSubjectType,
    subjectId: number,
  ): Promise<string> {
    return topicSectionFor(this.topics, subjectType, subjectId);
  }

  // ==== 机器人 @ 与标题 ====

  /**
   * 被 @ 的 AI 机器人写收件箱（真人机器人由通知服务发飞书私聊）。
   * 同一话题同一条帖子对同一机器人只保留一条待处理记录。
   */
  private async queueMentions(
    topic: Topic,
    postId: number,
    mentions: number[] | null,
  ): Promise<void> {
    if (!mentions?.length) return;
    const rows = await this.workers.find({
      where: { id: In(mentions) },
      select: {
        id: true,
        runtime: true,
        enabled: true,
        personalAgentUserId: true,
      },
    });
    for (const worker of rows) {
      if (!worker.enabled || worker.personalAgentUserId) continue;
      if (worker.runtime === WorkerRuntime.HUMAN) continue;
      const exists = await this.inbox.findOne({
        where: {
          topicId: topic.id,
          postId,
          workerId: worker.id,
          status: In(['pending', 'queued', 'delivered']),
        },
      });
      if (exists) continue;
      await this.inbox.save(
        this.inbox.create({
          topicId: topic.id,
          postId,
          workerId: worker.id,
          status: 'pending',
          attempts: 0,
          lastAttemptAt: null,
          nextRetryAt: null,
          lastError: null,
          deliveredAt: null,
          processedAt: null,
        }),
      );
    }
  }

  /** 未填写标题时异步生成「TP-{id}」+ 模型标题（人工改过则不覆盖） */
  private scheduleTitleNaming(topic: Topic): void {
    if (!topic.id || this.titleNaming.has(topic.id)) return;
    this.titleNaming.add(topic.id);
    void this.generateTitle(topic)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`话题 ${topic.id} 标题生成失败：${message}`);
      })
      .finally(() => this.titleNaming.delete(topic.id));
  }

  private async generateTitle(topic: Topic): Promise<void> {
    const material = topic.content.trim();
    if (!material) return;
    const generated = await this.llm.generateTitle(material.slice(0, 4000));
    if (!generated) return;
    const title = `「TP-${topic.id}」${generated}`.slice(0, 200);
    const result = await this.topics
      .createQueryBuilder()
      .update(Topic)
      .set({ title })
      .where('id = :id AND title = :original', {
        id: topic.id,
        original: topic.title,
      })
      .execute();
    if (result.affected) {
      this.logger.log(`话题 ${topic.id} 标题已生成：${title}`);
    }
  }

  // ==== 内部 ====

  private emit(event: TopicEvent): void {
    try {
      this.events.next(event);
    } catch (error) {
      this.logger.warn(`话题事件广播失败：${(error as Error).message}`);
    }
  }

  private assertOwnerOrAdmin(
    topic: Topic,
    actor: TopicActor,
    message: string,
  ): void {
    if (actor.isAdmin) return;
    const isOwner =
      (topic.creatorUserId !== null && topic.creatorUserId === actor.userId) ||
      (topic.creatorWorkerId !== null &&
        topic.creatorWorkerId === actor.workerId);
    if (!isOwner) throw new ForbiddenException(message);
  }

  private normalizeTitle(title: string): string {
    const trimmed = (title ?? '').trim();
    if (!trimmed) throw new BadRequestException('标题不能为空');
    if (trimmed.length > 200) throw new BadRequestException('标题最长 200 字');
    return trimmed;
  }

  private normalizePriority(priority?: TopicPriority): TopicPriority {
    if (priority === undefined) return TopicPriority.MEDIUM;
    if (!Object.values(TopicPriority).includes(priority)) {
      throw new BadRequestException('话题优先级仅允许：高/中/低');
    }
    return priority;
  }

  private normalizeStatus(status: TopicStatus): TopicStatus {
    if (!Object.values(TopicStatus).includes(status)) {
      throw new BadRequestException('话题状态仅允许：开放/已解决/已关闭');
    }
    return status;
  }

  /** 标签去重、去空、限长限量（空数组清除） */
  private normalizeTags(tags?: string[]): string[] | null {
    if (tags === undefined) return null;
    if (!Array.isArray(tags)) throw new BadRequestException('tags 必须为数组');
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of tags) {
      if (typeof raw !== 'string') {
        throw new BadRequestException('tags 必须为字符串数组');
      }
      const tag = raw.trim();
      if (!tag) continue;
      if (tag.length > MAX_TAG_LENGTH) {
        throw new BadRequestException(`单个标签最长 ${MAX_TAG_LENGTH} 字`);
      }
      if (seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
    }
    if (out.length > MAX_TAGS) {
      throw new BadRequestException(`标签最多 ${MAX_TAGS} 个`);
    }
    return out.length ? out : null;
  }

  /** @ 机器人：去重、数量上限、必须存在 */
  private normalizeMentions(mentions?: number[]): number[] | null {
    if (mentions === undefined) return null;
    if (!Array.isArray(mentions)) {
      throw new BadRequestException('mentions 必须为机器人 ID 数组');
    }
    const unique = [...new Set(mentions)];
    if (unique.length > MAX_MENTIONS) {
      throw new BadRequestException(`单条最多 @ ${MAX_MENTIONS} 个机器人`);
    }
    for (const id of unique) {
      if (!Number.isInteger(id) || id <= 0) {
        throw new BadRequestException('mentions 必须为正整数机器人 ID');
      }
    }
    return unique.length ? unique : null;
  }
}
