import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Subscription } from 'rxjs';
import { In, Repository } from 'typeorm';
import { User } from '../auth/user.entity';
import { WorkerRuntime } from '../common/enums';
import { FeishuBotClientService } from '../feishu-bot/feishu-bot-client.service';
import { FeishuBotConfigService } from '../feishu-bot/feishu-bot-config.service';
import { FeishuBotIdentityService } from '../feishu-bot/feishu-bot-identity.service';
import { feishuGroupSendPaused } from '../feishu-bot/feishu-bot-group-pause';
import { markdownCard } from '../feishu-bot/feishu-bot-message.service';
import { Worker } from '../workers/worker.entity';
import { TopicPost } from './topic-post.entity';
import { Topic } from './topic.entity';
import {
  TOPIC_EVENT_BUS,
  type TopicEvent,
  type TopicEventBus,
} from './topic-events';
import { TopicsService, topicWebPath } from './topics.service';

/** 通知正文摘要长度 */
const EXCERPT_LIMIT = 120;

/** 帖子正文纯文本摘要 */
function excerpt(content: string): string {
  const text = content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > EXCERPT_LIMIT
    ? `${text.slice(0, EXCERPT_LIMIT)}…`
    : text;
}

/**
 * 话题通知：关注新帖与 @ 真人机器人的飞书私聊卡片。
 * - 订阅话题事件总线，异步发送、失败只告警，不阻断话题/帖子写入；
 * - 关注通知排除发帖人本人；同一条帖子对同一用户只发一次（@ 优先）；
 * - @ AI 机器人的答复由收件箱与话题 LOOP 处理，这里只处理真人机器人；
 * - `FEISHU_GROUP_SEND_PAUSED` 暂停期间不发 @ 提及卡片（仍按「已提及」占位，
 *   避免关注通知补发同一条内容）。
 */
@Injectable()
export class TopicNotifyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TopicNotifyService.name);
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
    @InjectRepository(Worker)
    private readonly workers: Repository<Worker>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @Inject(TOPIC_EVENT_BUS)
    private readonly events: TopicEventBus,
  ) {}

  onModuleInit(): void {
    this.subscription = this.events.subscribe((event) => {
      void this.handle(event).catch((error: Error) => {
        this.logger.warn(`话题通知处理失败：${error.message}`);
      });
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }

  private async handle(event: TopicEvent): Promise<void> {
    if (event.kind === 'topic-created') {
      const topic = await this.topicRepo.findOne({
        where: { id: event.topicId },
      });
      if (!topic) return;
      await this.notifyMentions(
        topic,
        topic.content,
        topic.mentions,
        topic.creatorUserId,
      );
      return;
    }
    if (event.kind === 'post-created') {
      const [topic, post] = await Promise.all([
        this.topicRepo.findOne({ where: { id: event.topicId } }),
        this.postRepo.findOne({ where: { id: event.postId } }),
      ]);
      if (!topic || !post) return;
      const notified = await this.notifyMentions(
        topic,
        post.content,
        post.mentions,
        post.authorUserId,
      );
      await this.notifyFollowers(topic, post, notified);
    }
  }

  /** @ 真人机器人：给其绑定真人发飞书私聊卡片；返回已处理（发出或暂停跳过）的用户 ID（关注通知去重） */
  private async notifyMentions(
    topic: Topic,
    content: string,
    mentions: number[] | null,
    excludeUserId: number | null,
  ): Promise<Set<number>> {
    const notified = new Set<number>();
    if (!mentions?.length) return notified;
    const paused = feishuGroupSendPaused();
    const workers = await this.workers.find({
      where: { id: In(mentions) },
      select: {
        id: true,
        name: true,
        runtime: true,
        humanUserId: true,
        personalAgentUserId: true,
        enabled: true,
      },
    });
    for (const worker of workers) {
      if (!worker.enabled || worker.personalAgentUserId) continue;
      if (worker.runtime !== WorkerRuntime.HUMAN) continue;
      if (!worker.humanUserId) continue;
      const userId = worker.humanUserId;
      if (excludeUserId && userId === excludeUserId) continue;
      if (paused) {
        // 暂停期间不发卡片，但按已提及占位，避免关注通知补发同一条内容
        notified.add(userId);
        continue;
      }
      const sent = await this.sendToUser(
        userId,
        '你在话题中被提及',
        [
          `**话题**：${topic.title}`,
          `**主体**：${topic.subjectType}·${topic.subjectTitle}`,
          `**提及者**：${topic.creatorName}`,
          '',
          excerpt(content),
        ].join('\n'),
        topic,
      );
      if (sent) notified.add(userId);
    }
    return notified;
  }

  /** 关注者：新帖飞书私聊卡片（排除发帖人与已因 @ 通知过的用户） */
  private async notifyFollowers(
    topic: Topic,
    post: TopicPost,
    alreadyNotified: Set<number>,
  ): Promise<void> {
    const followerIds = await this.topics.followerIds(topic.id);
    for (const userId of followerIds) {
      if (post.authorUserId && userId === post.authorUserId) continue;
      if (alreadyNotified.has(userId)) continue;
      await this.sendToUser(
        userId,
        '关注的话题有新回复',
        [
          `**话题**：${topic.title}`,
          `**主体**：${topic.subjectType}·${topic.subjectTitle}`,
          `**回复人**：${post.authorName}`,
          '',
          excerpt(post.content),
        ].join('\n'),
        topic,
      );
    }
  }

  /** 平台官方机器人私聊发送 Markdown 卡片（失败只告警） */
  private async sendToUser(
    userId: number,
    title: string,
    content: string,
    topic: Topic,
  ): Promise<boolean> {
    const config = await this.configs.loadEnabledOfficial();
    if (!config) {
      this.logger.warn(`话题 #${topic.id} 通知未发送：平台官方机器人未配置`);
      return false;
    }
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, feishuOpenId: true },
    });
    if (!user) return false;
    try {
      const openId =
        (await this.identities
          .openIdFor(config.id, user.id)
          .catch(() => null)) ?? user.feishuOpenId;
      if (!openId) {
        this.logger.warn(
          `话题 #${topic.id} 通知未发送：用户 #${userId} 无飞书 open_id`,
        );
        return false;
      }
      const link = `[在平台查看话题](${this.client.appUrl}${topicWebPath(topic.subjectType, topic.subjectId, topic.id)})`;
      await this.client.sendCard(
        config.id,
        this.configs.secretsOf(config),
        'open_id',
        openId,
        markdownCard(`${content}\n\n${link}`, title),
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `话题 #${topic.id} 通知发送失败（用户 #${userId}）：${(error as Error).message}`,
      );
      return false;
    }
  }
}
