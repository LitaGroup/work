import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TopicPostSource } from '../common/enums';

/**
 * 话题帖子（append-only）：平铺楼层 + 引用回复（replyToPostId）。
 * - 平台帖子（网页/MCP）与飞书群回流帖子共用本表；
 * - 飞书来源按 (topicId, sourceMessageId) 唯一去重，且不再回传飞书（防回声）；
 * - 图片内嵌在 Markdown 正文（`/images/...`），不单独存数组。
 */
@Entity('topic_posts')
@Index('IDX_topic_posts_topic', ['topicId', 'id'])
@Index('IDX_topic_posts_worker', ['authorWorkerId'])
@Index('UQ_topic_posts_topic_message', ['topicId', 'sourceMessageId'], {
  unique: true,
})
export class TopicPost {
  @PrimaryGeneratedColumn()
  id: number;

  /** 所属话题（topics.id，应用层引用） */
  @Column({ type: 'int' })
  topicId: number;

  /** 回复的目标帖子（平铺楼层的引用条；空=直接回复话题） */
  @Column({ type: 'int', nullable: true })
  replyToPostId: number | null;

  /** 作者：平台用户 */
  @Column({ type: 'int', nullable: true })
  authorUserId: number | null;

  /** 作者：机器人（AI/真人机器人） */
  @Column({ type: 'int', nullable: true })
  authorWorkerId: number | null;

  /** 作者展示名快照 */
  @Column({ type: 'varchar', length: 120 })
  authorName: string;

  /** 正文（Markdown） */
  @Column({ type: 'text' })
  content: string;

  /** 本帖 @ 的机器人（workers.id 数组） */
  @Column({ type: 'simple-json', nullable: true })
  mentions: number[] | null;

  /** 来源：平台 / 飞书群 */
  @Column({
    type: 'enum',
    enum: TopicPostSource,
    default: TopicPostSource.PLATFORM,
  })
  source: TopicPostSource;

  /** 飞书消息 id（去重键；平台帖子为空） */
  @Column({ type: 'varchar', length: 100, nullable: true })
  sourceMessageId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
