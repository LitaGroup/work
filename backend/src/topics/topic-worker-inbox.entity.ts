import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** pending=待排队；queued=已写入待继续上下文；delivered=已发起会话；done/dead=结束 */
export type TopicInboxStatus =
  'pending' | 'queued' | 'delivered' | 'done' | 'dead';

/**
 * 话题机器人收件箱：帖子（或首楼）@ 到 AI 机器人后，
 * 由 LOOP 唤起该机器人的一次性会话阅读上下文并回帖；
 * 会话未回复按 2/10/30 分钟退避持续重试，超过上限置 dead。
 * 无物理外键，话题删除时由应用层清理。
 */
@Entity('topic_worker_inbox')
@Index('IDX_topic_worker_inbox_workerId_status', ['workerId', 'status'])
@Index('IDX_topic_worker_inbox_topicId_status', ['topicId', 'status'])
@Index('IDX_topic_worker_inbox_postId', ['postId'])
export class TopicWorkerInbox {
  @PrimaryGeneratedColumn()
  id: number;

  /** 话题（topics.id） */
  @Column({ type: 'int' })
  topicId: number;

  /** 触发本帖（topic_posts.id；首楼用 0 占位） */
  @Column({ type: 'int' })
  postId: number;

  /** 被 @ 的机器人（workers.id） */
  @Column({ type: 'int' })
  workerId: number;

  /** pending / queued / delivered / done / dead */
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: TopicInboxStatus;

  /** 已尝试唤醒次数（用于退避与上限判断） */
  @Column({ type: 'int', default: 0 })
  attempts: number;

  /** 最近一次尝试时间 */
  @Column({ type: 'timestamptz', nullable: true })
  lastAttemptAt: Date | null;

  /** 下次允许重试时间（退避） */
  @Column({ type: 'timestamptz', nullable: true })
  nextRetryAt: Date | null;

  /** 最近一次失败原因 */
  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  /** 会话发起时间 */
  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  /** 结束时间（done/dead） */
  @Column({ type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
