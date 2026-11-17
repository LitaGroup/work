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
  /**
   * 调用方机器人（MCP：机器人令牌；网页通常为空）。
   * 成员维护允许迭代项负责人机器人操作，网页负责人真人登录经 userId 反查其真人机器人。
   */
  workerId?: number | null;
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
  /** 描述（可空；传 null 清空，最长 200 字） */
  description?: string | null;
}

/** 迭代项成员入参：角色 + 机器人（AI 用 workerId；真人用 userId/name，后端映射为其真人机器人） */
export interface BacklogMemberInput {
  role: BacklogMemberRole;
  /** 机器人 ID（workers.id，AI 或真人机器人，与 userId/name 三选一） */
  workerId?: number;
  /** 平台用户 ID（真人；后端映射为其真人机器人） */
  userId?: number;
  /** 平台用户姓名（真人；多个姓名顿号连接时展开为多条记录） */
  name?: string;
}

/** 转入/追加迭代项：原始需求 + 负责人机器人（可为空，后续再指定）+ 成员 */
export interface CreateBacklogItemInput {
  projectId: number;
  /** 负责人机器人（workers.id）；为空表示暂不指定，不创建交付任务 */
  ownerWorkerId?: number | null;
  members?: BacklogMemberInput[];
}

/**
 * 迭代项新建任务：
 * - 已有交付任务：作为交付任务的子任务创建，描述自动附带迭代与父/兄弟任务上下文；
 * - 无交付任务：按执行机器人创建交付任务，并登记为迭代项负责人（仅管理员）。
 */
export interface CreateBacklogTaskInput {
  /** 标题（可空，缺省按描述首行生成；交付任务缺省用「迭代任务-{需求名}」） */
  title?: string;
  /** 任务描述（子任务必填；交付任务缺省写入迭代与需求上下文） */
  description?: string | null;
  /** 任务定义（可空；交付任务缺省用系统「迭代-Backlog交付」） */
  templateId?: number | null;
  /** 执行机器人（可空；无交付任务时作为负责人，必填） */
  agentId?: number | null;
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
  /** 处理机器人名称（agentId 对应的 workers.name） */
  agentName: string | null;
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
  /** 描述（可空，默认空） */
  description: string | null;
  startAt: string | null;
  endAt: string | null;
  status: IterationStatus;
  /** 是否当前迭代（非 T0 今天在起止区间内；T0 恒为 true） */
  current: boolean;
  createdAt: Date;
  updatedAt: Date;
}
