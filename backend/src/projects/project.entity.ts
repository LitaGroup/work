import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ProjectStatus, ProjectType } from '../common/enums';
import { Check } from '../checks/check.entity';
import { AppVersion } from '../app-versions/app-version.entity';
import { Schedule } from '../schedules/schedule.entity';
import { Test } from '../tests/test.entity';
import { Export } from '../exports/export.entity';
import { Document } from '../documents/document.entity';
import { Defect } from '../defects/defect.entity';
import { Resource } from '../resources/resource.entity';
import { Milestone } from '../milestones/milestone.entity';
import { ProjectBranch } from '../github/project-branch.entity';
import { ProjectRelease } from '../releases/project-release.entity';

@Entity('projects')
export class Project {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 200 })
  name: string;

  @Column({ type: 'enum', enum: ProjectType, default: ProjectType.OTHER })
  type: ProjectType;

  @Column({ type: 'enum', enum: ProjectStatus, default: ProjectStatus.PLANNED })
  status: ProjectStatus;

  /** 预期发布时间 */
  @Column({ type: 'date', nullable: true })
  expectedReleaseAt: string | null;

  /** 优先级（飞书同步：S0/S1/...），手工项目可空 */
  @Column({ type: 'varchar', length: 20, nullable: true })
  priority: string | null;

  /** 迭代周期（飞书字段 w，同步时归一化为 "w281: 08/19-08/25"，无法识别的一律为 "-"） */
  @Column({ type: 'varchar', length: 50, nullable: true })
  iterationCycle: string | null;

  /** 需求方（飞书「需求方」人员字段同步，多姓名顿号连接；编辑校验用户系统内，飞书同步会覆盖） */
  @Column({ type: 'varchar', length: 200, nullable: true })
  owner: string | null;

  /** 涉及方（飞书「涉及方」多选字段同步，如 Android/iOS/H5/Backend/Admin/Data；平台内可编辑，下次同步覆盖） */
  @Column({ type: 'simple-json', nullable: true })
  involvedParties: string[] | null;

  /** 备注：由飞书「排期优先级」「排期备注」同步合成（单行分号分隔）；平台内可编辑，下次同步覆盖 */
  @Column({ type: 'text', nullable: true })
  remark: string | null;

  /** 飞书多维表格 record_id，增量同步判重用 */
  @Column({ type: 'varchar', length: 50, nullable: true, unique: true })
  feishuRecordId: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** 需求摘要：模型根据需求描述与「需求」类文档生成，≤200 字；人工可改（清空后重新满足自动生成条件） */
  @Column({ type: 'text', nullable: true })
  summary: string | null;

  /** 脚本目录：相对 CHECK_SCRIPTS_DIR 的路径，登记检查时只在该子目录下扫描 .check.ts */
  @Column({ type: 'varchar', length: 500, nullable: true })
  scriptsPath: string | null;

  /** 飞书通知群 webhook（已停用：群 webhook 通知整体下线，仅保留历史数据，不再读写） */
  @Column({ type: 'varchar', length: 500, nullable: true })
  feishuWebhook: string | null;

  @OneToMany(() => Document, (doc) => doc.project)
  documents: Document[];

  @OneToMany(() => Check, (check) => check.project)
  checks: Check[];

  @OneToMany(() => Test, (test) => test.project)
  tests: Test[];

  @OneToMany(() => Export, (exportItem) => exportItem.project)
  exports: Export[];

  @OneToMany(() => Schedule, (schedule) => schedule.project)
  schedules: Schedule[];

  @OneToMany(() => Defect, (defect) => defect.project)
  defects: Defect[];

  @OneToMany(() => AppVersion, (appVersion) => appVersion.project)
  appVersions: AppVersion[];

  /** 资源（需求方提供的素材/信息）。命名避开上方人员 resources 列 */
  @OneToMany(() => Resource, (resource) => resource.project)
  projectResources: Resource[];

  /** 节点：项目在某个时间点需要完成的事项（状态由服务层推导，不落库） */
  @OneToMany(() => Milestone, (milestone) => milestone.project)
  milestones: Milestone[];

  /** 代码分支：项目涉及修改的 GitHub 仓库与分支登记 */
  @OneToMany(() => ProjectBranch, (branch) => branch.project)
  projectBranches: ProjectBranch[];

  /** 提测记录（点「提测」生成，倒序展示） */
  @OneToMany(() => ProjectRelease, (release) => release.project)
  projectReleases: ProjectRelease[];

  /** 列表按创建时间倒序展示，建索引避免全表 filesort */
  @Index('IDX_projects_createdAt')
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
