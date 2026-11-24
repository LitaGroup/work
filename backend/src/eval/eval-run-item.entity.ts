import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { EvalItemResult, EvalItemStatus } from '../common/enums';

/**
 * 评估项（TECH_DESIGN 6.6 eval_run_item）：
 * 批次中的一个「用例 × 第 k 次重复」，是执行和统计的最小单位。
 * 每个评估项创建一个 `is_eval=1` 的平台任务（taskId），在独立沙箱中执行。
 * 重跑会生成新记录（attempt+1），旧记录标记 superseded=1，统计时排除。
 */
@Entity('eval_run_items')
@Index(['runId'])
@Index(['taskId'])
@Index(['status'])
export class EvalRunItem {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  runId: number;

  @Column({ type: 'int' })
  caseId: number;

  /** 第几次重复（1 起） */
  @Column({ type: 'int' })
  repeatIndex: number;

  /** 重跑次数（从 1 开始；重跑生成新记录） */
  @Column({ type: 'int', default: 1 })
  attempt: number;

  /** 是否已被重跑替代（统计时排除被替代记录） */
  @Column({ default: false })
  superseded: boolean;

  /** 评估任务 ID（is_eval=1；执行记录通过它关联） */
  @Column({ type: 'int', nullable: true })
  taskId: number | null;

  /** 沙箱 ID（{runId}/{itemId}） */
  @Column({ type: 'varchar', length: 64, nullable: true })
  sandboxId: string | null;

  @Column({ type: 'varchar', length: 24, default: EvalItemStatus.PENDING })
  status: EvalItemStatus;

  /** 结果分档（仅 status=已完成） */
  @Column({ type: 'varchar', length: 24, nullable: true })
  result: EvalItemResult | null;

  /** 第一次交付的得分 */
  @Column({ type: 'int', nullable: true })
  firstScore: number | null;

  /** 最终交付的得分 */
  @Column({ type: 'int', nullable: true })
  finalScore: number | null;

  /** 提问次数（每次提问计 1，超过 max_questions 的也计） */
  @Column({ type: 'int', default: 0 })
  questionCount: number;

  /** 返工次数（0 或 1，见 D4 一次返工） */
  @Column({ type: 'int', default: 0 })
  reworkCount: number;

  /** 人工介入次数（评估任务上出现非评估机器人、非被测机器人的操作） */
  @Column({ type: 'int', default: 0 })
  humanCount: number;

  /** intervention_count = question + rework + human（10.2） */
  @Column({ type: 'int', default: 0 })
  interventionCount: number;

  /** 被测方接受任务的时间 */
  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt: Date | null;

  /** 第一次 / 最终申请验收的时间 */
  @Column({ type: 'timestamptz', nullable: true })
  firstApplyAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finalApplyAt: Date | null;

  /** 结束时间 */
  @Column({ type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  /** 等待答复的总时长（毫秒） */
  @Column({ type: 'bigint', nullable: true })
  waitAnswerMs: string | null;

  /** 净执行时间（毫秒）= final_apply - accepted - 等待答复 - 第 1 轮判定等待，见 10.1 */
  @Column({ type: 'bigint', nullable: true })
  netExecMs: string | null;

  /** 第一次交付的净执行时间（毫秒） */
  @Column({ type: 'bigint', nullable: true })
  firstNetExecMs: string | null;

  /** 被拦截的写操作次数 */
  @Column({ type: 'int', default: 0 })
  blockedWriteCount: number;

  /** 异常信息 */
  @Column({ type: 'varchar', length: 1024, nullable: true })
  errorMessage: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
