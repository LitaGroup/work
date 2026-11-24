import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { EvalEventType } from '../common/enums';

/**
 * 评估项事件（TECH_DESIGN 6.7 eval_event）：
 * append-only 时间线，精确到毫秒；评估项详情页按此渲染事件流。
 */
@Entity('eval_events')
@Index(['itemId'])
export class EvalEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  itemId: number;

  @Column({ type: 'varchar', length: 32 })
  type: EvalEventType;

  /** 发生时间（精确到毫秒） */
  @Column({ type: 'timestamptz', precision: 3 })
  at: Date;

  /** 附加信息（时间点、引用、正文摘要等） */
  @Column({ type: 'simple-json', nullable: true })
  payload: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

/**
 * 判定记录（TECH_DESIGN 6.8 eval_judgement）：
 * 评估机器人对一次交付的逐条判定。round=1 首次交付 / 2 返工后；
 * attempt 为同轮判定尝试次数（格式错误重试、手动重新判定都会加 1）；
 * effective=1 的条目为对该轮的生效判定。
 */
@Entity('eval_judgements')
@Index(['itemId'])
export class EvalJudgement {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  itemId: number;

  /** 第 1 轮（首次交付）或第 2 轮（返工后） */
  @Column({ type: 'int' })
  round: number;

  /** 同一轮的第几次判定 */
  @Column({ type: 'int', default: 1 })
  attempt: number;

  /** 判定所用模型 */
  @Column({ type: 'varchar', length: 64, nullable: true })
  model: string | null;

  /** 判定输入的摘要 */
  @Column({ type: 'char', length: 64, nullable: true })
  inputDigest: string | null;

  /** 评估机器人提交的原始内容 */
  @Column({ type: 'text', nullable: true })
  rawOutput: string | null;

  /** 逐条结果（含证据校验后的命中值） */
  @Column({ type: 'simple-json', nullable: true })
  pointsResult: unknown[] | null;

  /** 平台计算的得分（0-100） */
  @Column({ type: 'int', nullable: true })
  score: number | null;

  /** 是否通过（必需项全命中且得分 ≥ 阈值） */
  @Column({ type: 'boolean', nullable: true })
  pass: boolean | null;

  /** 评估机器人给出的总体说明 */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  /** 交付内容是否被截断 */
  @Column({ default: false })
  truncated: boolean;

  /** 是否为该轮的生效判定 */
  @Column({ default: false })
  effective: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
