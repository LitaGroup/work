import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { feishuGroupSendPaused } from '../feishu-bot/feishu-bot-group-pause';
import { TopicWorkerInbox } from './topic-worker-inbox.entity';
import { Topic } from './topic.entity';
import { TopicReplyService } from './topic-reply.service';

/** 单轮处理的收件箱条数上限 */
const BATCH_SIZE = 10;

/** delivered 超过该时间未回帖视为卡住（进程重启/会话超时），重新排队 */
const STALE_DELIVERED_MS = 10 * 60 * 1000;

/**
 * 话题 LOOP：每 30 秒扫描 @ AI 机器人的待答复收件箱，
 * 交 TopicReplyService 创建一次性会话；未完成由服务自身退避重试。
 * 同时回收卡在 delivered 的条目，避免进程重启后永久停摆。
 * `FEISHU_GROUP_SEND_PAUSED` 暂停期间整体跳过（不消费重试次数），恢复后继续答复。
 */
@Injectable()
export class TopicLoopService {
  private readonly logger = new Logger(TopicLoopService.name);
  private running = false;

  constructor(
    @InjectRepository(TopicWorkerInbox)
    private readonly inbox: Repository<TopicWorkerInbox>,
    @InjectRepository(Topic)
    private readonly topics: Repository<Topic>,
    private readonly replies: TopicReplyService,
  ) {}

  @Cron('*/30 * * * * *')
  async tick(): Promise<void> {
    // 暂停期间不创建答复会话，收件箱条目保持待处理，恢复后继续答复
    if (feishuGroupSendPaused()) return;
    if (this.running) return;
    this.running = true;
    try {
      await this.recoverStale();
      await this.processPending();
    } catch (error) {
      this.logger.warn(`话题 LOOP 执行失败：${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async recoverStale(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_DELIVERED_MS);
    await this.inbox.update(
      { status: 'delivered', lastAttemptAt: LessThan(cutoff) },
      { status: 'pending', nextRetryAt: new Date() },
    );
  }

  private async processPending(): Promise<void> {
    const now = new Date();
    const rows = await this.inbox.find({
      where: [{ status: 'pending', nextRetryAt: IsNull() }],
      order: { id: 'ASC' },
      take: BATCH_SIZE,
    });
    const due = await this.inbox
      .createQueryBuilder('i')
      .where('i.status = :status', { status: 'pending' })
      .andWhere('i.nextRetryAt IS NOT NULL AND i.nextRetryAt <= :now', {
        now,
      })
      .orderBy('i.id', 'ASC')
      .take(Math.max(0, BATCH_SIZE - rows.length))
      .getMany();
    const seen = new Set(rows.map((row) => row.id));
    for (const row of due) {
      if (!seen.has(row.id)) rows.push(row);
    }
    for (const entry of rows) {
      const topic = await this.topics.findOne({
        where: { id: entry.topicId },
      });
      if (!topic) {
        await this.inbox.update(
          { id: entry.id },
          {
            status: 'dead',
            processedAt: new Date(),
            lastError: '话题不存在',
          },
        );
        continue;
      }
      await this.replies
        .reply(topic, entry)
        .catch((error: Error) =>
          this.logger.warn(
            `话题 #${entry.topicId} 答复执行异常：${error.message}`,
          ),
        );
    }
  }
}
