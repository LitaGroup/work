import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { EvalRunRole, EvalRunStatus } from '../common/enums';
import type { EvalMcpPolicy, FrozenSuite } from './eval-worker-snapshot.entity';

/**
 * 评估批次（TECH_DESIGN 6.5 eval_run）：
 * 用某个测试集评估某份机器人配置的一次执行，包含若干个评估项（用例 × 重复）。
 * suiteSnapshot 在发起时冻结，后续编辑测试集不影响本批次。
 */
@Entity('eval_runs')
@Index(['suiteId'])
@Index(['targetWorkerId'])
@Index(['status'])
export class EvalRun {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  suiteId: number;

  /** 发起时测试集版本（suiteSnapshot.version） */
  @Column({ type: 'int' })
  suiteVersion: number;

  /** 发起时冻结的用例和要点全文，后续编辑测试集不影响本批次 */
  @Column({ type: 'simple-json' })
  suiteSnapshot: FrozenSuite;

  /** 被测机器人 */
  @Column({ type: 'int' })
  targetWorkerId: number;

  /** 被测机器人名称快照（展示用） */
  @Column({ type: 'varchar', length: 100 })
  targetWorkerName: string;

  /** 评估机器人（需求方与判定） */
  @Column({ type: 'int' })
  evaluatorWorkerId: number;

  /** 配置快照 */
  @Column({ type: 'int' })
  snapshotId: number;

  /** 评估候选配置时填写（第二期） */
  @Column({ type: 'int', nullable: true })
  proposalId: number | null;

  /** 批次角色：普通 / 基线 / 候选 */
  @Column({ type: 'varchar', length: 16, default: EvalRunRole.NORMAL })
  role: EvalRunRole;

  /** 每个用例重复次数（1-5，默认 3） */
  @Column({ type: 'int', default: 3 })
  repeatCount: number;

  /** 本批次最多同时执行几个评估项（默认 3），受全局评估并发上限约束 */
  @Column({ type: 'int', default: 3 })
  concurrency: number;

  /** 自定义 MCP 的评估策略 */
  @Column({ type: 'simple-json', nullable: true })
  mcpPolicy: EvalMcpPolicy | null;

  @Column({ type: 'varchar', length: 16, default: EvalRunStatus.QUEUED })
  status: EvalRunStatus;

  /** 汇总指标（批次结束时计算，见 TECH_DESIGN 15.2） */
  @Column({ type: 'simple-json', nullable: true })
  summary: Record<string, unknown> | null;

  /** 发起人（users.id，可空=优化机器人/系统） */
  @Column({ type: 'int', nullable: true })
  createdById: number | null;

  /** 发起人名称快照 */
  @Column({ type: 'varchar', length: 100, nullable: true })
  createdByName: string | null;

  /** 结束时失败原因（异常终止） */
  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
