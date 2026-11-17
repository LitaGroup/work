import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** 唤醒目标：task=任务会话（任务执行机器人）；agent=「我的 AI」会话（个人 AGENT） */
export type WakeupKind = 'task' | 'agent';

/**
 * 投递状态：
 * - scheduled=待触发（到期或退避后由扫描器投递）；
 * - delivered=已投递（投递成功或正在投递）；
 * - canceled=已取消（被新唤醒覆盖或人工取消）；
 * - recorded=任务已结束，仅记录不再唤醒；
 * - dead=多次重试仍无法投递，放弃。
 */
export type WakeupStatus =
  'scheduled' | 'delivered' | 'canceled' | 'recorded' | 'dead';

/**
 * 机器人定时唤醒：机器人自主设置的「多久后唤醒我」回访提醒。
 * 先落库再由扫描器到期投递，进程重启后可继续补投；
 * 每任务 / 每用户会话范围只保留一条 scheduled，新设置覆盖旧的。
 */
@Entity('wakeups')
@Index('UQ_wakeups_task_scheduled', ['taskId'], {
  unique: true,
  where: `"kind" = 'task' AND "status" = 'scheduled'`,
})
@Index('UQ_wakeups_agent_scheduled', ['userId', 'scope'], {
  unique: true,
  where: `"kind" = 'agent' AND "status" = 'scheduled'`,
})
@Index('IDX_wakeups_due', ['status', 'wakeAt'])
@Index('IDX_wakeups_taskId', ['taskId'])
export class Wakeup {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 10 })
  kind: WakeupKind;

  /** 任务会话：tasks.id（应用层软引用）；「我的 AI」任务会话同时记录便于排查 */
  @Column({ type: 'int', nullable: true })
  taskId: number | null;

  /** 「我的 AI」会话：归属用户 */
  @Column({ type: 'int', nullable: true })
  userId: number | null;

  /** 「我的 AI」会话范围：agent:global / agent:task:{id} / agent:page:{type}:{hash} */
  @Column({ type: 'varchar', length: 120, nullable: true })
  scope: string | null;

  /** 设置者机器人：任务=当前执行机器人；「我的 AI」=个人 AGENT */
  @Column({ type: 'int' })
  workerId: number;

  /** 唤醒备注（到期后随唤醒消息回传给机器人） */
  @Column({ type: 'text', nullable: true })
  note: string | null;

  /** 到期时间（timestamptz） */
  @Column({ type: 'timestamptz' })
  wakeAt: Date;

  @Column({ type: 'varchar', length: 20, default: 'scheduled' })
  status: WakeupStatus;

  /** 已尝试投递次数（退避依据） */
  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastAttemptAt: Date | null;

  /** 下次允许重试的时间（延迟投递/退避） */
  @Column({ type: 'timestamptz', nullable: true })
  nextRetryAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  canceledAt: Date | null;

  /** 取消原因：replaced=被新唤醒覆盖 / manual=机器人主动取消 */
  @Column({ type: 'varchar', length: 200, nullable: true })
  canceledReason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
