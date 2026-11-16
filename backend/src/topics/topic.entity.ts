import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TopicPriority, TopicStatus, TopicSubjectType } from '../common/enums';

/**
 * 话题（Topic）：挂载在主体（迭代项/缺陷/任务/工单/需求）下的讨论串。
 * - 主体为应用层软引用（subjectType + subjectId），不建物理外键；
 * - 标题由平台异步用模型生成「TP-{id}」+ 标题，人工可改；
 * - 正文即首楼（Markdown，图片内嵌 `/images/...`）；
 * - 主体已有飞书群时，首楼作为群内话题根消息同步，后续帖子以回复形式落入；
 * - 删除时应用层清理帖子、关注、机器人收件箱与飞书绑定。
 */
@Entity('topics')
@Index('IDX_topics_subject', ['subjectType', 'subjectId'])
@Index('IDX_topics_status', ['status'])
@Index('IDX_topics_creatorUserId', ['creatorUserId'])
@Index('IDX_topics_feishuChatId', ['feishuChatId'])
export class Topic {
  @PrimaryGeneratedColumn()
  id: number;

  /** 主体类型：迭代项/缺陷/任务/工单/需求 */
  @Column({ type: 'enum', enum: TopicSubjectType })
  subjectType: TopicSubjectType;

  /** 主体 ID（backlogs/defects/tasks/tickets/projects） */
  @Column({ type: 'int' })
  subjectId: number;

  /** 主体标题快照（列表/飞书卡片展示，主体改名不回填） */
  @Column({ type: 'varchar', length: 200 })
  subjectTitle: string;

  /** 标题（异步模型生成「TP-{id}」+ 标题；兜底正文首行） */
  @Column({ type: 'varchar', length: 200 })
  title: string;

  /** 优先级：高/中/低（默认中） */
  @Column({ type: 'enum', enum: TopicPriority, default: TopicPriority.MEDIUM })
  priority: TopicPriority;

  /** 状态：开放（默认）/ 已解决 / 已关闭（已关闭禁止新帖） */
  @Column({ type: 'enum', enum: TopicStatus, default: TopicStatus.OPEN })
  status: TopicStatus;

  /** 标签（自由输入，前端联想已有标签） */
  @Column({ type: 'simple-json', nullable: true })
  tags: string[] | null;

  /** 首楼正文（Markdown） */
  @Column({ type: 'text' })
  content: string;

  /** 创建人：网页/MCP 真人 */
  @Column({ type: 'int', nullable: true })
  creatorUserId: number | null;

  /** 创建人：机器人（普通机器人以自身身份参与讨论） */
  @Column({ type: 'int', nullable: true })
  creatorWorkerId: number | null;

  /** 创建人姓名快照（用户或机器人名称） */
  @Column({ type: 'varchar', length: 120 })
  creatorName: string;

  /** 首楼 @ 的机器人（workers.id 数组） */
  @Column({ type: 'simple-json', nullable: true })
  mentions: number[] | null;

  /** 飞书绑定群 chat_id（主体有群且同步成功后写入） */
  @Column({ type: 'varchar', length: 100, nullable: true })
  feishuChatId: string | null;

  /** 飞书话题根消息 message_id */
  @Column({ type: 'varchar', length: 100, nullable: true })
  feishuRootMessageId: string | null;

  /** 飞书话题 thread_id（入站消息按 thread_id/root_id 归一匹配） */
  @Column({ type: 'varchar', length: 100, nullable: true })
  feishuThreadId: string | null;

  /** 帖子数（含飞书来源，冗余供列表展示） */
  @Column({ type: 'int', default: 0 })
  postCount: number;

  /** 最近一条帖子时间 */
  @Column({ type: 'timestamptz', nullable: true })
  lastPostAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
