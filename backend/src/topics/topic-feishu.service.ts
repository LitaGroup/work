import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import { Subscription } from 'rxjs';
import { FindOptionsWhere, In, Repository } from 'typeorm';
import { imageWebroot } from '../common/paths';
import { TopicPostSource, TopicSubjectType } from '../common/enums';
import { FeishuBotBacklogChat } from '../feishu-bot/feishu-bot-backlog-chat.entity';
import { FeishuBotClientService } from '../feishu-bot/feishu-bot-client.service';
import {
  FeishuBotConfig,
  type FeishuBotSecrets,
} from '../feishu-bot/feishu-bot-config.entity';
import { FeishuBotConfigService } from '../feishu-bot/feishu-bot-config.service';
import { FeishuBotIdentityService } from '../feishu-bot/feishu-bot-identity.service';
import {
  imageKeysOf,
  placeholderOf,
} from '../feishu-bot/feishu-bot-feedback.service';
import { markdownCard } from '../feishu-bot/feishu-bot-message.service';
import type { FeishuInboundMessage } from '../feishu-bot/feishu-bot-p2p.service';
import type { FeishuSenderId } from '../feishu-bot/feishu-bot-identity.service';
import { FeishuBotProjectChat } from '../feishu-bot/feishu-bot-project-chat.entity';
import { FeishuBotTaskChat } from '../feishu-bot/feishu-bot-task-chat.entity';
import { Task } from '../tasks/task.entity';
import { Worker } from '../workers/worker.entity';
import { TopicPost } from './topic-post.entity';
import { Topic } from './topic.entity';
import {
  TOPIC_EVENT_BUS,
  type TopicEvent,
  type TopicEventBus,
} from './topic-events';
import { subjectLabel, TopicsService } from './topics.service';

/** 单条消息最多转存的图片数（与反馈一致） */
const MAX_IMAGES = 9;

/** 单条卡片最多上传替换的图片数 */
const MAX_CARD_IMAGES = 5;

/** 飞书群绑定：主体对应一个 chat */
interface TopicChatBinding {
  chatId: string;
  officialConfigId: number;
}

/**
 * 话题与飞书群双向同步：
 * - 出站：话题首楼作为群内话题根卡片，后续帖子以回复形式落入同一话题（图片上传为 image_key）；
 * - 入站：绑定话题内的群消息回流为帖子（按消息 id 去重，source=飞书群，不再回传）；
 * - 主体无飞书群（缺陷/工单或尚未建群）时跳过，帖子下次同步时懒绑定；
 * - 平台官方机器人自身消息忽略，避免回声。
 */
@Injectable()
export class TopicFeishuService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TopicFeishuService.name);
  private subscription: Subscription | null = null;

  constructor(
    private readonly configs: FeishuBotConfigService,
    private readonly client: FeishuBotClientService,
    private readonly identities: FeishuBotIdentityService,
    private readonly topics: TopicsService,
    @InjectRepository(Topic)
    private readonly topicRepo: Repository<Topic>,
    @InjectRepository(TopicPost)
    private readonly postRepo: Repository<TopicPost>,
    @InjectRepository(FeishuBotBacklogChat)
    private readonly backlogChats: Repository<FeishuBotBacklogChat>,
    @InjectRepository(FeishuBotTaskChat)
    private readonly taskChats: Repository<FeishuBotTaskChat>,
    @InjectRepository(FeishuBotProjectChat)
    private readonly projectChats: Repository<FeishuBotProjectChat>,
    @InjectRepository(FeishuBotConfig)
    private readonly configRepo: Repository<FeishuBotConfig>,
    @InjectRepository(Task)
    private readonly tasks: Repository<Task>,
    @InjectRepository(Worker)
    private readonly workers: Repository<Worker>,
    @Inject(TOPIC_EVENT_BUS)
    private readonly events: TopicEventBus,
  ) {}

  onModuleInit(): void {
    this.subscription = this.events.subscribe((event) => {
      void this.handleEvent(event).catch((error: Error) => {
        this.logger.warn(`话题飞书同步失败：${error.message}`);
      });
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }

  private async handleEvent(event: TopicEvent): Promise<void> {
    if (event.kind === 'topic-created') {
      await this.ensureTopicRoot(event.topicId);
      return;
    }
    if (event.kind === 'post-created') {
      const post = await this.postRepo.findOne({
        where: { id: event.postId },
      });
      // 飞书回流帖子不再回传，避免回声
      if (!post || post.source === TopicPostSource.FEISHU_GROUP) return;
      await this.syncPost(event.topicId, post);
    }
  }

  // ==== 出站 ====

  /** 建立话题根卡片（幂等；无群可绑定时静默跳过） */
  private async ensureTopicRoot(topicId: number): Promise<void> {
    const topic = await this.topicRepo.findOne({ where: { id: topicId } });
    if (!topic || topic.feishuChatId || topic.feishuRootMessageId) return;
    const binding = await this.resolveChat(topic.subjectType, topic.subjectId);
    if (!binding) return;
    const config = await this.configs.loadEnabledOfficial();
    if (!config) {
      this.logger.warn(
        `话题 #${topic.id} 未同步飞书群：平台官方机器人未配置或未启用`,
      );
      return;
    }
    try {
      const secrets = this.configs.secretsOf(config);
      const body = await this.renderContent(
        config.id,
        secrets,
        [
          `**主体**：${subjectLabel(topic.subjectType, topic.subjectTitle)}`,
          `**发起人**：${topic.creatorName}`,
          `**优先级**：${topic.priority} · **状态**：${topic.status}`,
          topic.tags?.length ? `**标签**：${topic.tags.join('、')}` : '',
          '',
          topic.content,
          '',
          `[在平台查看话题](${this.client.appUrl}/topics/${topic.id})`,
        ]
          .filter((line) => line !== null)
          .join('\n'),
      );
      const result = await this.client.sendCard(
        config.id,
        secrets,
        'chat_id',
        binding.chatId,
        markdownCard(body, `话题：${topic.title}`.slice(0, 80)),
      );
      if (!result.messageId) return;
      await this.topicRepo.update(
        { id: topic.id },
        {
          feishuChatId: binding.chatId,
          feishuRootMessageId: result.messageId,
          feishuThreadId: result.messageId,
        },
      );
    } catch (error) {
      this.logger.warn(
        `话题 #${topic.id} 飞书同步失败：${(error as Error).message}`,
      );
    }
  }

  /** 平台帖子同步到已绑定话题（未绑定时先补建根卡片） */
  private async syncPost(topicId: number, post: TopicPost): Promise<void> {
    let topic = await this.topicRepo.findOne({ where: { id: topicId } });
    if (!topic) return;
    if (!topic.feishuRootMessageId) {
      await this.ensureTopicRoot(topicId);
      topic = await this.topicRepo.findOne({ where: { id: topicId } });
      if (!topic?.feishuRootMessageId) return;
    }
    const config = await this.configs.loadEnabledOfficial();
    if (!config) return;
    try {
      const secrets = this.configs.secretsOf(config);
      const quote = post.replyToPostId
        ? `> 回复帖子 #${post.replyToPostId}\n`
        : '';
      const body = await this.renderContent(
        config.id,
        secrets,
        [
          quote,
          `**${post.authorName}**：`,
          '',
          post.content,
          '',
          `[在平台查看](${this.client.appUrl}/topics/${topic.id})`,
        ].join('\n'),
      );
      await this.client.replyCard(
        config.id,
        secrets,
        topic.feishuRootMessageId,
        markdownCard(body),
      );
    } catch (error) {
      this.logger.warn(
        `话题 #${topicId} 帖子 #${post.id} 飞书同步失败：${(error as Error).message}`,
      );
    }
  }

  /**
   * 主体 → 飞书群：迭代项群 / 任务群（回退任务所属项目沟通群）/ 需求项目沟通群；
   * 缺陷与工单无群，返回 null。
   */
  private async resolveChat(
    subjectType: TopicSubjectType,
    subjectId: number,
  ): Promise<TopicChatBinding | null> {
    if (subjectType === TopicSubjectType.BACKLOG) {
      const row = await this.backlogChats.findOne({
        where: { backlogId: subjectId, state: 'active' },
      });
      return row?.chatId
        ? { chatId: row.chatId, officialConfigId: row.officialConfigId }
        : null;
    }
    if (subjectType === TopicSubjectType.TASK) {
      const row = await this.taskChats.findOne({
        where: { taskId: subjectId, state: 'active' },
      });
      if (row?.chatId) {
        return { chatId: row.chatId, officialConfigId: row.officialConfigId };
      }
      const task = await this.tasks.findOne({
        where: { id: subjectId },
        select: { id: true, projectId: true },
      });
      if (task?.projectId) {
        return this.resolveProjectChat(task.projectId);
      }
      return null;
    }
    if (subjectType === TopicSubjectType.REQUIREMENT) {
      return this.resolveProjectChat(subjectId);
    }
    return null;
  }

  private async resolveProjectChat(
    projectId: number,
  ): Promise<TopicChatBinding | null> {
    const row = await this.projectChats.findOne({
      where: { projectId, state: 'active' },
    });
    return row?.chatId
      ? { chatId: row.chatId, officialConfigId: row.officialConfigId }
      : null;
  }

  /** Markdown 中的 /images 路径上传为飞书 image_key（失败保留原链接） */
  private async renderContent(
    configId: number,
    secrets: FeishuBotSecrets,
    content: string,
  ): Promise<string> {
    const matches = [...content.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)].slice(
      0,
      MAX_CARD_IMAGES,
    );
    let out = content;
    for (const match of matches) {
      const [full, alt, url] = match;
      if (!url.startsWith('/images/')) continue;
      try {
        const key = await this.client.uploadLocalImage(configId, secrets, url);
        if (key) out = out.split(full).join(`![${alt || '图片'}](${key})`);
      } catch (error) {
        this.logger.warn(
          `话题图片上传飞书失败（${url}）：${(error as Error).message}`,
        );
      }
    }
    return out;
  }

  // ==== 入站 ====

  /**
   * 群消息入站：命中话题绑定（同群 + 话题 thread/root）时回流为帖子并返回 true，
   * 调用方据此跳过任务群/外部群逻辑。
   */
  async handleInboundMessage(
    config: FeishuBotConfig,
    secrets: FeishuBotSecrets,
    sender: FeishuSenderId,
    message: FeishuInboundMessage,
    senderType?: string,
  ): Promise<boolean> {
    if (message.chatType !== 'group') return false;
    const topic = await this.findTopicByMessage(message);
    if (!topic) return false;
    // 机器人（含平台官方机器人）自身消息不入库，避免与出站帖子重复
    if (senderType === 'app') return true;
    const existed = await this.postRepo.findOne({
      where: { topicId: topic.id, sourceMessageId: message.messageId },
    });
    if (existed) return true;

    const user = await this.identities
      .resolve(config, sender)
      .catch(() => null);
    const text = extractText(message);
    const images = await this.transferImages(config, secrets, message).catch(
      (error: Error) => {
        this.logger.warn(
          `话题群图片转存失败（message=${message.messageId}）：${error.message}`,
        );
        return [] as string[];
      },
    );
    const content = [
      text || placeholderOf(message.messageType),
      ...images.map((url) => `![](${url})`),
    ].join('\n\n');
    const mentions = await this.resolveMentionWorkers(config, message);
    let replyToPostId: number | null = null;
    if (message.parentId) {
      const target = await this.postRepo.findOne({
        where: { topicId: topic.id, sourceMessageId: message.parentId },
      });
      replyToPostId = target?.id ?? null;
    }
    try {
      await this.topics.createPost(
        topic.id,
        {
          content,
          replyToPostId,
          mentions: mentions ?? undefined,
          source: TopicPostSource.FEISHU_GROUP,
          sourceMessageId: message.messageId,
          authorUserId: user?.id ?? null,
          authorWorkerId: null,
          authorName: user?.name ?? '群成员',
        },
        { userId: null, workerId: null, userName: '群成员', isAdmin: false },
      );
    } catch (error) {
      // 并发重复事件：唯一索引冲突视为已收录
      if (!(error as Error).message?.includes('UQ_topic_posts_topic_message')) {
        throw error;
      }
    }
    return true;
  }

  /** 按同群 + 话题 thread/root 查找绑定话题（回复以 root_id 归一） */
  private async findTopicByMessage(
    message: FeishuInboundMessage,
  ): Promise<Topic | null> {
    const thread = message.threadId?.trim();
    const root = message.rootId?.trim() || message.parentId?.trim();
    const where: FindOptionsWhere<Topic>[] = [];
    if (thread) {
      where.push({ feishuChatId: message.chatId, feishuThreadId: thread });
    }
    if (root) {
      where.push({ feishuChatId: message.chatId, feishuRootMessageId: root });
    }
    if (where.length === 0) return null;
    return this.topicRepo.findOne({ where });
  }

  /**
   * 群消息 @ 映射为机器人：优先按机器人应用自身 open_id（botOpenId）定位机器人，
   * 否则按平台用户解析其真人机器人。
   */
  private async resolveMentionWorkers(
    config: FeishuBotConfig,
    message: FeishuInboundMessage,
  ): Promise<number[] | null> {
    const openIds = (message.mentions ?? [])
      .map((mention) => mention.openId)
      .filter(Boolean);
    if (openIds.length === 0) return null;
    const workerIds = new Set<number>();
    const configs = await this.configRepo.find({
      where: { botOpenId: In(openIds) },
      select: { id: true, workerId: true, botOpenId: true },
    });
    for (const row of configs) {
      if (row.workerId) workerIds.add(row.workerId);
    }
    for (const mention of message.mentions ?? []) {
      if (!mention.openId) continue;
      if (configs.some((row) => row.botOpenId === mention.openId)) continue;
      const user = await this.identities
        .resolve(config, { openId: mention.openId, unionId: null })
        .catch(() => null);
      if (!user) continue;
      const human = await this.workers.findOne({
        where: { humanUserId: user.id },
        select: { id: true },
      });
      if (human) workerIds.add(human.id);
    }
    return workerIds.size ? [...workerIds] : null;
  }

  /** 下载消息图片转存平台 /images，返回路径数组 */
  private async transferImages(
    config: FeishuBotConfig,
    secrets: FeishuBotSecrets,
    message: FeishuInboundMessage,
  ): Promise<string[]> {
    const keys = imageKeysOf(message.messageType, message.content);
    if (keys.length === 0) return [];
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const out: string[] = [];
    for (const imageKey of keys.slice(0, MAX_IMAGES)) {
      try {
        const buffer = await this.client.downloadImage(
          config.id,
          secrets,
          message.messageId,
          imageKey,
        );
        const relPath = path.posix.join('uploads', date, `${randomUUID()}.png`);
        const absPath = path.join(imageWebroot(), relPath);
        await mkdir(path.dirname(absPath), { recursive: true });
        await writeFile(absPath, buffer);
        out.push(`/images/${relPath}`);
      } catch (error) {
        this.logger.warn(
          `话题群图片下载失败（key=${imageKey}）：${(error as Error).message}`,
        );
      }
    }
    return out;
  }
}

/** 消息正文：文本/富文本抽取 @ 名称替换占位符，其他类型给占位 */
function extractText(message: FeishuInboundMessage): string {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(message.content || '{}') as Record<string, unknown>;
  } catch {
    return '';
  }
  let text = '';
  if (message.messageType === 'text') {
    text = typeof payload.text === 'string' ? payload.text : '';
  } else if (message.messageType === 'post') {
    text = postTextOf(payload);
  } else {
    return '';
  }
  const names = new Map(
    (message.mentions ?? []).map((mention) => [mention.key, mention.name]),
  );
  return text
    .replace(/@_user_\d+/g, (placeholder) => {
      const name = names.get(placeholder);
      return name ? `@${name}` : '';
    })
    .trim();
}

/** 富文本 post 正文抽取（段落内文本节点拼接，图片由 imageKeysOf 转存） */
function postTextOf(payload: Record<string, unknown>): string {
  const paragraphs = Array.isArray(payload.content)
    ? (payload.content as unknown[])
    : [];
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    const parts: string[] = [];
    for (const node of paragraph as Record<string, unknown>[]) {
      if (node.tag === 'text' && typeof node.text === 'string') {
        parts.push(node.text);
      }
    }
    const line = parts.join('').trim();
    if (line) lines.push(line);
  }
  return lines.join('\n');
}
