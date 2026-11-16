import {
  BacklogMemberRole,
  BacklogStatus,
  IterationStatus,
  IterationType,
} from '../common/enums';

/** 操作用户身份（网页为真人登录；只有管理员可创建/追加/移动迭代项） */
export interface IterationActor {
  userId: number | null;
  userName: string;
  isAdmin: boolean;
}

/** 创建迭代：T0 不可创建（平台常驻单例），标识由后端按类型自动生成 */
export interface CreateIterationInput {
  /** 类型：T7 每周通道 / Tx 特殊通道 */
  type: IterationType;
  /** 开始日期 YYYY-MM-DD（必填） */
  startAt?: string | null;
  /** 结束日期 YYYY-MM-DD（必填） */
  endAt?: string | null;
}

export interface UpdateIterationInput {
  startAt?: string | null;
  endAt?: string | null;
  status?: IterationStatus;
}

/** 迭代项成员入参：角色 + 平台用户 */
export interface BacklogMemberInput {
  role: BacklogMemberRole;
  userId: number;
}

/** 转入/追加迭代项：原始需求 + 负责人机器人（可为空，后续再指定）+ 成员 */
export interface CreateBacklogItemInput {
  projectId: number;
  /** 负责人机器人（workers.id）；为空表示暂不指定，不创建交付任务 */
  ownerWorkerId?: number | null;
  members?: BacklogMemberInput[];
}

/** 提测工单工作流可用性（迭代项详情返回，供前端提测按钮置灰） */
export interface BacklogReleaseWorkflow {
  /** 工单配置（workflow_definitions.id） */
  id: number;
  /** 已启用且已发布版本（可创建工单） */
  enabled: boolean;
}

/** 迭代项任务面板任务摘要（交付任务树，含子任务） */
export interface BacklogTaskSummary {
  id: number;
  code: string;
  title: string;
  type: string;
  status: string;
  subStatus: string;
  parentId: number | null;
  rootId: number;
  projectId: number | null;
  agentId: number | null;
  templateName: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/** 迭代项任务面板工单摘要（直接关联 + 任务树关联） */
export interface BacklogTicketSummary {
  id: number;
  code: string;
  title: string;
  category: string;
  workflowStatus: string | null;
  currentNodeName: string | null;
  initiatorWorkerName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 迭代进度汇总 */
export interface IterationProgress {
  total: number;
  done: number;
  percent: number;
  statusCounts: Partial<Record<BacklogStatus, number>>;
}

/** 迭代列表项（含 backlog 进度） */
export interface IterationSummaryView extends IterationProgress {
  id: number;
  code: string;
  type: IterationType;
  startAt: string | null;
  endAt: string | null;
  status: IterationStatus;
  /** 是否当前迭代（非 T0 今天在起止区间内；T0 恒为 true） */
  current: boolean;
  createdAt: Date;
  updatedAt: Date;
}
