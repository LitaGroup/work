import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * 话题关注：用户关注后，新帖经平台官方机器人私聊卡片通知（发帖人除外），
 * 并可在个人中心「我关注的话题」查看。仅记录关系，无物理外键。
 */
@Entity('topic_follows')
@Index('UQ_topic_follows_topic_user', ['topicId', 'userId'], { unique: true })
export class TopicFollow {
  @PrimaryGeneratedColumn()
  id: number;

  /** 话题 ID（topics.id） */
  @Index()
  @Column({ type: 'int' })
  topicId: number;

  /** 关注用户 ID（users.id） */
  @Index()
  @Column({ type: 'int' })
  userId: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
