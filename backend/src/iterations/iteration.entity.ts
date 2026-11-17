import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { IterationStatus, IterationType } from '../common/enums';

/**
 * 迭代：由 backlog 组成的计划单元，独立于需求池。
 * - T0：常驻快速通道（单例，code 固定为 T0，无起止日期）；
 * - T7：每周通道，code 由开始日期所在自然周生成（如 2026W47），同一周只允许一个；
 * - Tx：特殊通道，code 为 `{yyyy}Tx{nn}`（当年内递增），用于同周追加或特殊情况。
 * 无物理外键：backlogs.iterationId 为应用层引用。
 */
@Entity('iterations')
@Index('IDX_iterations_type', ['type'])
@Index('IDX_iterations_status', ['status'])
export class Iteration {
  @PrimaryGeneratedColumn()
  id: number;

  /** 唯一标识：T0 固定为 T0；T7 如 2026W47；Tx 如 2026Tx01 */
  @Column({ length: 50, unique: true })
  code: string;

  @Column({ type: 'enum', enum: IterationType, default: IterationType.T7 })
  type: IterationType;

  /** 描述（可空，平台内维护；默认空，管理员可在迭代页就地编辑） */
  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** 开始日期（T7/Tx 必填；T0 为空） */
  @Column({ type: 'date', nullable: true })
  startAt: string | null;

  /** 结束日期（T7/Tx 必填；T0 为空） */
  @Column({ type: 'date', nullable: true })
  endAt: string | null;

  @Column({
    type: 'enum',
    enum: IterationStatus,
    default: IterationStatus.ACTIVE,
  })
  status: IterationStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
