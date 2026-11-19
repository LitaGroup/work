import { Repository } from 'typeorm';
import { TaskTemplate } from './task-template.entity';

/**
 * 任务定义 ID 规则：
 * - id < 1000：系统任务定义（固定 ID，由平台约定，如未知任务定义）；
 * - id >= 1000：网页创建的自定义任务定义。
 */
export const SYSTEM_TASK_TEMPLATE_ID_LIMIT = 1000;

/** 系统未知任务定义固定 ID：平台无法匹配任务定义时用它兜底 */
export const SYSTEM_UNKNOWN_TASK_TEMPLATE_ID = 6;

/** 系统未知任务定义名称 / 描述（启动时缺失则补齐） */
export const SYSTEM_UNKNOWN_TASK_TEMPLATE_NAME = '未知任务';
export const SYSTEM_UNKNOWN_TASK_TEMPLATE_DESCRIPTION =
  '平台无法匹配任务定义对应机器人时自动归入，由系统未知任务定义（ID=6）接管；请在此配置处理机器人';

/** 项目详情「交给项目机器人」使用的系统任务定义固定 ID */
export const SYSTEM_PROJECT_DELIVERY_TASK_TEMPLATE_ID = 7;

/**
 * 研发操作指南：需求详情 .md 只保留基本信息/迭代/文档，
 * 研发类操作（脚本运行、节点、分支、提测、缺陷）随任务定义说明下发给执行机器人。
 */
export const DEVELOPMENT_OPERATION_GUIDE = [
  '## 研发操作指南',
  '',
  '- 需求上下文：`GET /api/requirements/{projectId}.md`（基本信息 + 对应迭代 + 文档资料）。',
  '- 需求配置：`POST /api/requirements/{projectId}/update.md`（脚本目录 / 描述 / 人员，空串清除）。',
  '- 文档：写入 `POST /api/documents/upsert.md`（按 projectId + fileName 判重）；阅读 `GET /api/documents/{id}.md`。',
  '',
  '### 脚本与运行',
  '',
  '- 导入脚本：`POST /api/scripts/import.md`，body `{"projectId": {projectId}}`（扫描项目脚本目录，按脚本路径判重）。',
  '- 运行检查 / 测试 / 导出 / 定时任务：`POST /api/checks/{id}/run.md`、`POST /api/tests/{id}/run.md`、`POST /api/exports/{id}/run.md`、`POST /api/schedules/{id}/run.md`（text/markdown，流式返回脚本输出）。',
  '- 运行详情：`GET /api/checks/runs/{runId}.md`、`GET /api/tests/runs/{runId}.md`、`GET /api/exports/runs/{runId}.md`。',
  '- 脚本目录配置：`PATCH /api/projects/{projectId}`，body `{"scriptsPath": "projects/xxx"}`（也可用需求 update.md）。',
  '',
  '### 节点与代码分支',
  '',
  '- 节点：`GET /api/milestones?projectId={projectId}`；新建 `POST /api/milestones`；达成 `PATCH /api/milestones/{id}`（body `{"achieved":"yes"}`，自动记录实际达成日期）。',
  '- 代码分支：`GET /api/code-branches?projectId={projectId}`；登记 `POST /api/code-branches`；提交记录 `GET /api/code-events.md?projectId={projectId}`。',
  '',
  '### 提测与缺陷',
  '',
  '- 提测：`POST /api/backlogs/release.md`，body `{"items": [{"backlogId": 123, "content": "提测内容 Markdown"}], "ends": ["APP"], "testers": ["张三"], "branches": [{"repo": "LitaGroup/xxx", "branch": "test"}], "urls": ["https://..."], "title": "可选", "taskId": 123}`（提测端至少 1 个：APP / H5 / 后端；测试人员至少 1 人且须为用户系统内用户；每个迭代项生成提测工单与提测记录，多个迭代项汇总为一条提测群消息；taskId 可省略，缺省自动关联当前执行中的任务）。',
  '- 提测记录与状态：`GET /api/releases.md?projectId={projectId}`；`POST /api/releases/{id}/status.md`，body `{"status": "已通过"}`。',
  '- 缺陷：`GET /api/defects.md?projectId={projectId}`；新建 `POST /api/defects/create.md`；详情 `GET /api/defects/{id}.md`；状态变更 `POST /api/defects/{id}/status.md`。',
  '',
  '### 其他',
  '',
  '- 平台设置：`GET /api/settings.md`；脚本仓库更新：`POST /api/settings/scripts/pull.md`。',
  '- 定时唤醒：等待人工确认/答复、等待工单审批或脚本运行结果时，可用 `lita-work` MCP `schedule_task_wakeup` 设置下次跟进时间（到期自动唤醒本任务），然后结束本轮；不要用轮询占用执行容量。',
  '- `lita-work` MCP 工具可直接执行上述大部分操作（需求详情、文档读写、脚本运行、缺陷、提测等）。',
].join('\n');

export const SYSTEM_PROJECT_DELIVERY_TASK_TEMPLATE_NAME = '技术-项目开发交付';
export const SYSTEM_PROJECT_DELIVERY_TASK_TEMPLATE_DESCRIPTION = [
  '承接项目详情页发起的项目实施与开发交付。',
  '',
  '## 任务范围',
  '',
  '- 读取需求 Markdown 上下文（`GET /api/requirements/{projectId}.md`），确认需求目标、范围、对应迭代与文档资料。',
  '- 梳理实施计划，完成开发、配置和必要的技术文档交付。',
  '- 按任务流程更新 HANDOFF，并在完成后申请验收。',
  '',
  '## 默认处理机器人',
  '',
  '由系统机器人「技术-项目经理」作为首位处理机器人，负责读取需求上下文、拆分并分派子任务、验收交付和整合结果；管理员可追加其它机器人作为兜底。',
  '',
  DEVELOPMENT_OPERATION_GUIDE,
].join('\n');

/** 飞书反馈群收录新反馈后自动派单使用的系统任务定义固定 ID */
export const SYSTEM_FEEDBACK_TASK_TEMPLATE_ID = 8;

export const SYSTEM_FEEDBACK_TASK_TEMPLATE_NAME = '用户反馈处理';
export const SYSTEM_FEEDBACK_TASK_TEMPLATE_DESCRIPTION = [
  '承接平台收录飞书反馈群话题后自动创建的用户反馈处理任务。',
  '',
  '## 任务范围',
  '',
  '- 读取任务描述中的反馈地址（`GET /api/feedbacks/{id}.md`），核实反馈正文与群内跟帖。',
  '- 判断反馈真实性、类型（BUG/建议/其它）与紧急程度，定位相关项目与系统。',
  '- 能处理的完成处理；不能直接处理的给出明确结论与转派建议。',
  '- 在 HANDOFF 中记录核实过程与处理结果，完成后申请需求方验收。',
  '',
  '## 默认处理机器人',
  '',
  '由系统机器人「系统-反馈处理」承接（收录时自动创建任务并指派，需求方为该机器人负责人）；管理员可追加其它机器人作为兜底。',
].join('\n');

/** 迭代项（Backlog）转入后自动创建交付任务使用的系统任务定义固定 ID */
export const SYSTEM_BACKLOG_DELIVERY_TASK_TEMPLATE_ID = 9;

export const SYSTEM_BACKLOG_DELIVERY_TASK_TEMPLATE_NAME = '迭代-Backlog交付';

export const SYSTEM_BACKLOG_DELIVERY_TASK_TEMPLATE_DESCRIPTION = [
  '承接迭代项（Backlog）转入后自动创建的开发交付任务。',
  '',
  '## 任务范围',
  '',
  '- 读取原始需求的 Markdown 上下文（任务描述中包含需求地址，`GET /api/requirements/{projectId}.md`），确认目标、范围与资料。',
  '- 按需求完成开发、配置和必要的技术文档交付，并在 HANDOFF 中记录实施过程。',
  '- 完成后显式申请验收；验收通过后交付内容供迭代项流转到「测试/发布/完成」参考。',
  '',
  '## 负责人',
  '',
  '任务创建时已明确指派给该迭代项的负责人机器人（AI 或真人），无需再经任务定义默认机器人分配。',
  '',
  DEVELOPMENT_OPERATION_GUIDE,
].join('\n');

/** 迭代级整体交付使用的系统任务定义固定 ID（10-15 为已退役工单调度定义，跳过不复用） */
export const SYSTEM_ITERATION_DELIVERY_TASK_TEMPLATE_ID = 16;

export const SYSTEM_ITERATION_DELIVERY_TASK_TEMPLATE_NAME = '技术-迭代-交付';

export const SYSTEM_ITERATION_DELIVERY_TASK_TEMPLATE_DESCRIPTION = [
  '承接一次迭代的整体交付：负责完成该迭代内全部 Backlog 的交付。',
  '',
  '## 任务范围',
  '',
  '- 读取迭代 Markdown 上下文（任务描述中包含迭代地址，`GET /api/iterations/{id}.md`），确认迭代标识、类型、起止日期与 Backlog 清单。',
  '- 逐个梳理 Backlog 的目标、负责人与状态（`GET /api/backlogs/{id}.md`），推进开发、配置和必要的技术文档交付。',
  '- 在 HANDOFF 中记录整体实施过程与各 Backlog 的交付结论，完成后显式申请验收。',
  '- 需要单条 Backlog 独立开发时，其交付任务使用「迭代-Backlog交付」（ID=9）；本定义负责迭代级统筹与整体交付。',
  '',
  '## 承接机器人',
  '',
  '普通 AI 机器人与真人类机器人均可承接；默认处理机器人由管理员配置，也可在创建任务时显式指派。',
].join('\n');

/** 系统任务定义固定 ID 集合（不可删除，名称/类型由平台保留） */
export const SYSTEM_TASK_TEMPLATE_IDS: ReadonlySet<number> = new Set([
  SYSTEM_UNKNOWN_TASK_TEMPLATE_ID,
  SYSTEM_PROJECT_DELIVERY_TASK_TEMPLATE_ID,
  SYSTEM_FEEDBACK_TASK_TEMPLATE_ID,
  SYSTEM_BACKLOG_DELIVERY_TASK_TEMPLATE_ID,
  SYSTEM_ITERATION_DELIVERY_TASK_TEMPLATE_ID,
]);

export function isSystemTaskTemplateId(id: number): boolean {
  return SYSTEM_TASK_TEMPLATE_IDS.has(id);
}

/**
 * 把 task_templates 自增序列抬到系统 ID 段之后，
 * 保证网页新建的自定义任务定义 id >= 1000（幂等，启动时执行）。
 */
export async function ensureTaskTemplateSequenceFloor(
  templates: Repository<TaskTemplate>,
): Promise<void> {
  await templates.query(
    `SELECT setval(
       pg_get_serial_sequence('task_templates', 'id'),
       GREATEST((SELECT COALESCE(MAX(id), 0) FROM task_templates), $1)
     )`,
    [SYSTEM_TASK_TEMPLATE_ID_LIMIT - 1],
  );
}
