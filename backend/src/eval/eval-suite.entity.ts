import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { EvalSuitePurpose, EvalSuiteStatus } from '../common/enums';

/**
 * 评估测试集（TECH_DESIGN 6.1 eval_suite）：
 * 一组用例（eval_cases）+ 通过阈值/超时/提问上限等配置。
 * 支持 JSON 导入导出（按用例 caseKey 匹配）；编辑递增 version。
 */
@Entity('eval_suites')
export class EvalSuite {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 128, unique: true })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** 标签：人工维护的分类元数据，不参与评估计分和批次快照 */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  tags: string[];

  /** 用途：训练（优化机器人可见）/ 验证（优化机器人不可见） */
  @Column({
    type: 'varchar',
    length: 16,
    default: EvalSuitePurpose.VALIDATION,
  })
  purpose: EvalSuitePurpose;

  /** 通过阈值（0-100，默认 80），用例可覆盖 */
  @Column({ type: 'int', default: 80 })
  passThreshold: number;

  /** 用例默认超时（秒，默认 1800） */
  @Column({ type: 'int', default: 1800 })
  defaultTimeoutSec: number;

  /** 每个评估项最多答复几次提问（默认 3；超过上限不再答复但仍计数） */
  @Column({ type: 'int', default: 3 })
  maxQuestions: number;

  /** 每次编辑加 1（批次冻结 suiteVersion 用） */
  @Column({ type: 'int', default: 1 })
  version: number;

  /** 创建人（users.id，可空=系统） */
  @Column({ type: 'int', nullable: true })
  ownerId: number | null;

  /** 状态：启用 / 归档 */
  @Column({
    type: 'varchar',
    length: 16,
    default: EvalSuiteStatus.ACTIVE,
  })
  status: EvalSuiteStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

/** 用例（6.2 eval_case）：一个 Prompt + 要点清单 + 补充信息 + 可选覆盖配置 */
@Entity('eval_cases')
@Index(['suiteId', 'caseKey'], { unique: true })
export class EvalCase {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  suiteId: number;

  /** 测试集内唯一，导入导出匹配用 */
  @Column({ type: 'varchar', length: 64 })
  caseKey: string;

  /** 排序 */
  @Column({ type: 'int', default: 0 })
  seq: number;

  /** 标题，作为评估任务标题 */
  @Column({ type: 'varchar', length: 256 })
  title: string;

  /** 输入，Markdown，作为评估任务描述 */
  @Column({ type: 'text' })
  prompt: string;

  /** 补充信息：被测方第一次提问时原样答复（可空） */
  @Column({ type: 'text', nullable: true })
  clarify: string | null;

  /** 可空，覆盖测试集通过阈值 */
  @Column({ type: 'int', nullable: true })
  passThreshold: number | null;

  /** 可空，覆盖测试集超时 */
  @Column({ type: 'int', nullable: true })
  timeoutSec: number | null;

  @Column({ default: true })
  enabled: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

/** 要点（6.3 eval_case_point）：期望结果中一条可判定内容，判定时用 idx 引用 */
@Entity('eval_case_points')
@Index(['caseId'])
export class EvalCasePoint {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  caseId: number;

  /** 序号（判定时按 idx 引用，从 1 开始） */
  @Column({ type: 'int' })
  seq: number;

  /** 要点内容 */
  @Column({ type: 'text' })
  point: string;

  /** 是否必需（默认否）：必需项完全命中（hit=1）才判通过 */
  @Column({ default: false })
  required: boolean;

  /** 权重（默认 1，取值 (0, 10]） */
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 1 })
  weight: string;

  /** 返工提示（可空）：不能直接写出期望答案，界面校验是否包含要点原文 */
  @Column({ type: 'text', nullable: true })
  hint: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
