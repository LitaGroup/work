import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { EvalSnapshotSource } from '../common/enums';

/**
 * 机器人配置快照（TECH_DESIGN 6.4 eval_worker_snapshot）：
 * 冻结一份机器人配置（AGENTS.md / 技能 / 规则 / MCP 勾选 / 内核与模型），
 * config_digest 相同的配置复用同一快照。
 * 快照包（packageUri）不包含 .env、mcp.json 等凭据文件。
 */
@Entity('eval_worker_snapshots')
@Index(['workerId'])
@Index(['configDigest'])
export class EvalWorkerSnapshot {
  @PrimaryGeneratedColumn()
  id: number;

  /** 被测机器人 */
  @Column({ type: 'int' })
  workerId: number;

  /** 来源：当前配置（一期）/ 变更提案（第二期） */
  @Column({
    type: 'varchar',
    length: 16,
    default: EvalSnapshotSource.LIVE,
  })
  source: EvalSnapshotSource;

  /** 来源为提案时填写（第二期） */
  @Column({ type: 'int', nullable: true })
  proposalId: number | null;

  /** 执行内核：opencode / kiro / devin / droid 等 */
  @Column({ type: 'varchar', length: 32, nullable: true })
  kernel: string | null;

  /** 使用的模型 */
  @Column({ type: 'varchar', length: 64, nullable: true })
  model: string | null;

  /** AGENTS.md 内容哈希 */
  @Column({ type: 'char', length: 64, nullable: true })
  agentsMdHash: string | null;

  /** 技能目录内容哈希 */
  @Column({ type: 'char', length: 64, nullable: true })
  skillsHash: string | null;

  /** 规则目录内容哈希 */
  @Column({ type: 'char', length: 64, nullable: true })
  rulesHash: string | null;

  /** 勾选的 MCP 列表及评估策略（9.5） */
  @Column({ type: 'simple-json', nullable: true })
  mcpServers: unknown[] | null;

  /** 快照包存储地址（不含凭据文件） */
  @Column({ type: 'varchar', length: 512, nullable: true })
  packageUri: string | null;

  /** 以上内容合并后的摘要（与执行记录 config_digest 同算法） */
  @Column({ type: 'char', length: 64, nullable: true })
  configDigest: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

/** 测试集冻结快照中的用例视图（run.suiteSnapshot 使用） */
export interface FrozenEvalCase {
  id: number;
  caseKey: string;
  seq: number;
  title: string;
  prompt: string;
  clarify: string | null;
  passThreshold: number | null;
  timeoutSec: number | null;
  enabled: boolean;
  points: Array<{
    id: number;
    seq: number;
    point: string;
    required: boolean;
    weight: string;
    hint: string | null;
  }>;
}

/** 批次冻结的测试集全文（发起时快照，后续编辑不影响本批次） */
export interface FrozenSuite {
  id: number;
  name: string;
  purpose: string;
  passThreshold: number;
  defaultTimeoutSec: number;
  maxQuestions: number;
  version: number;
  cases: FrozenEvalCase[];
}

/** MCP 评估策略（9.5）：保留/移除的自定义 MCP 服务名 */
export interface EvalMcpPolicy {
  keep?: string[];
  remove?: string[];
}
