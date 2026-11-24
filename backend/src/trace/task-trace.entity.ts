import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TraceRole, TraceStatus } from '../common/enums';

/**
 * 执行记录索引（TECH_DESIGN 12.6 task_trace）：
 * 一个任务对应一条执行记录，步骤流以 JSONL 存本地 traces/{yyyyMM}/{traceId}/steps.jsonl，
 * 到期（真实任务 180 天 / 评估任务 90 天）清理正文，索引保留统计字段。
 */
@Entity('task_traces')
export class TaskTrace {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string;

  /** 任务（评估判定会话无任务，为空） */
  @Index('IDX_task_traces_taskId', { unique: true })
  @Column({ type: 'int', nullable: true })
  taskId: number | null;

  /** 执行机器人 */
  @Index('IDX_task_traces_workerId')
  @Column({ type: 'int' })
  workerId: number;

  /** 派发时机器人配置的执行内核、模型 */
  @Column({ type: 'varchar', length: 32, nullable: true })
  kernel: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  model: string | null;

  /** 各轮使用的配置摘要（通常只有一个） */
  @Column({ type: 'simple-json', nullable: true })
  configDigests: string[] | null;

  /** 是否为评估任务（评估判定会话也标记） */
  @Column({ default: false })
  isEval: boolean;

  /** 评估项（可空） */
  @Column({ type: 'int', nullable: true })
  evalItemId: number | null;

  /** 角色：执行方 / 判定 */
  @Column({ type: 'varchar', length: 16, default: TraceRole.EXECUTOR })
  role: TraceRole;

  /** 采集中 / 已完成 / 不完整 / 已过期 */
  @Column({
    type: 'varchar',
    length: 16,
    default: TraceStatus.COLLECTING,
  })
  status: TraceStatus;

  /** 任务结果（任务终态后回填） */
  @Column({ type: 'text', nullable: true })
  outcome: string | null;

  @Column({ type: 'int', default: 0 })
  turnCount: number;

  @Column({ type: 'int', default: 0 })
  stepCount: number;

  /** 平台调用次数、调用报错次数 */
  @Column({ type: 'int', default: 0 })
  callCount: number;

  @Column({ type: 'int', default: 0 })
  callErrorCount: number;

  /** 被拦截的调用次数 */
  @Column({ type: 'int', default: 0 })
  blockedCount: number;

  /** 按窗口归属（attribution=window）的调用次数 */
  @Column({ type: 'int', default: 0 })
  windowAttributedCount: number;

  /** 未归属调用数（12.4 第 4 条，机器人维度累计） */
  @Column({ type: 'int', default: 0 })
  unattributedCount: number;

  /** 任务的提问、返工次数（任务终态后回填） */
  @Column({ type: 'int', default: 0 })
  questionCount: number;

  @Column({ type: 'int', default: 0 })
  reworkCount: number;

  /** 脱敏次数 */
  @Column({ type: 'int', default: 0 })
  redactionCount: number;

  /** 步骤流大小（字节） */
  @Column({ type: 'bigint', default: 0 })
  sizeBytes: string;

  /** 存储地址（相对 traceWebroot 的路径） */
  @Column({ type: 'varchar', length: 512 })
  storageUri: string;

  @Column({ type: 'timestamptz', precision: 3 })
  startedAt: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  endedAt: Date | null;

  /** 到期时间：真实任务 180 天 / 评估任务 90 天 */
  @Column({ type: 'timestamptz' })
  expireAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

/**
 * 执行记录访问日志（12.8）：每次读取记录读取人、记录、时间。
 * 读取人（users.id，为空表示管理员外的机器人主体）。
 */
@Entity('task_trace_accesses')
export class TaskTraceAccess {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('IDX_task_trace_accesses_traceId')
  @Column({ type: 'varchar', length: 36 })
  traceId: string;

  @Column({ type: 'varchar', length: 100 })
  readerName: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  readerKind: string | null;

  @Column({ type: 'int', nullable: true })
  readerId: number | null;

  /** 读取方式：list / read / signals / stats */
  @Column({ type: 'varchar', length: 32 })
  action: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
