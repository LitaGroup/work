/**
 * 评估模式权限策略（TECH_DESIGN 9.4 lita-work 工具的权限策略）。
 * 纯函数分类：给定评估上下文与一次调用（MCP 工具名或 .md 路径），返回
 * allow / block（含子类 write|subtask|scope）。
 */
import type { EvalContext } from './eval-token.service';

export type EvalCheck =
  | { decision: 'allow' }
  | {
      decision: 'block';
      kind: 'write' | 'subtask' | 'scope' | 'judge';
      reason: string;
    };

const EVAL_MODE_ERROR = '评估模式下不允许此操作';

/** 判定令牌只开放判定工具 */
export const EVAL_JUDGE_TOOLS = new Set([
  'get_eval_judge_input',
  'submit_eval_judgement',
]);

/** 判定工具仅判定令牌可用；普通评估令牌一律拦截 */
const JUDGE_ONLY_TOOLS = EVAL_JUDGE_TOOLS;

/** 任务协同类工具：允许，但只作用于当前评估任务 */
const TASK_COOP_TOOLS = new Set([
  'accept_task',
  'refuse_task',
  'ask_task_question',
  'reply_task_message',
  'update_task_handoff',
  'apply_task_acceptance',
  'read_task_handoff',
  'list_task_documents',
  'upsert_task_document',
]);

/** 任务查询类工具：允许，仅当前评估任务 */
const TASK_QUERY_TOOLS = new Set(['get_task']);

/** 需求方动作：被测方不是需求方，拦截 */
const REQUESTER_ACTION_TOOLS = new Set([
  'accept_task_handoff',
  'refuse_task_handoff',
  'fail_task',
  'answer_task_question',
]);

/** 工单写操作、机器人与任务定义写操作、所有平台写操作 */
const WRITE_TOOLS = new Set([
  // 子任务与新建任务（D6）
  'create_task',
  'create_subtask',
  // 需求方动作
  ...REQUESTER_ACTION_TOOLS,
  // 工单写
  'route_task_ticket',
  'reject_ticket_node',
  'create_ticket',
  'update_ticket',
  'delete_ticket',
  'upsert_ticket_document',
  'delete_ticket_document',
  // 机器人 / 任务定义写（已迁 lita-work-admin；保留拦截防重名）
  'create_worker',
  'update_worker',
  'delete_worker',
  'create_task_definition',
  'update_task_definition',
  'delete_task_definition',
  // 项目 / 文档 / 知识库 / 缺陷 / 提测 / 代码分支 写（创建、更新、删除、运行检查等）
  'create_project',
  'update_project',
  'delete_project',
  'create_document',
  'update_document',
  'delete_document',
  'create_knowledge',
  'update_knowledge',
  'delete_knowledge',
  'create_defect',
  'update_defect',
  'delete_defect',
  'create_release',
  'create_check_run',
  'create_test_run',
  'create_export_run',
  'create_backlog',
  'update_backlog',
  'change_backlog_status',
  'move_backlog',
  'create_backlog_release',
  'create_iteration',
  'update_iteration',
  'create_idea',
  'update_idea',
  'delete_idea',
  'create_feedback',
  'update_feedback',
  'delete_feedback',
  'create_topic',
  'reply_topic',
  'update_topic',
  'rename_project_branch',
  'delete_project_branch',
  'create_github_branch',
  // 执行记录读取（12.7 工具全部拦截，已迁 lita-work-admin）
  'list_task_traces',
  'read_task_trace',
  'get_task_signals',
  'get_trace_stats',
  // 评估体系管理（lita-work-admin；管理端点已拒绝评估令牌，这里再按工具名防御）
  'list_eval_suites',
  'get_eval_suite',
  'create_eval_suite',
  'update_eval_suite',
  'archive_eval_suite',
  'delete_eval_suite',
  'upsert_eval_case',
  'delete_eval_case',
  'import_eval_suite',
  'export_eval_suite',
  'list_eval_runs',
  'create_eval_run',
  'run_eval',
  'get_eval_run',
  'get_worker_eval_summary',
  'get_eval_run_report',
  'cancel_eval_run',
  'get_eval_item',
  'rerun_eval_item',
  'rejudge_eval_item',
  // 优化与提案（第二期工具，预留拦截）
  'get_worker_config_files',
  'create_change_proposal',
  'update_change_proposal',
  'run_proposal_evaluation',
  'get_proposal_evaluation',
  // 平台设置与脚本仓库维护（已迁 lita-work-admin）
  'pull_scripts',
  // 定时唤醒与对外发送
  'schedule_task_wakeup',
  'cancel_task_wakeup',
  'schedule_agent_wakeup',
  'cancel_agent_wakeup',
  'feishu_send_message',
]);

/**
 * MCP 工具调用分类。
 */
export function classifyEvalTool(
  tool: string,
  args: Record<string, unknown>,
  ctx: EvalContext,
): EvalCheck {
  if (ctx.judge) {
    return EVAL_JUDGE_TOOLS.has(tool)
      ? { decision: 'allow' }
      : {
          decision: 'block',
          kind: 'judge',
          reason: `判定令牌仅可调用 ${[...EVAL_JUDGE_TOOLS].join(' / ')}`,
        };
  }
  // 判定工具对普通评估令牌不可见（防备误调）
  if (JUDGE_ONLY_TOOLS.has(tool)) {
    return { decision: 'block', kind: 'judge', reason: EVAL_MODE_ERROR };
  }
  if (TASK_COOP_TOOLS.has(tool) || TASK_QUERY_TOOLS.has(tool)) {
    const taskId = parseTaskId(args);
    if (taskId !== null && taskId !== ctx.taskId) {
      return {
        decision: 'block',
        kind: 'scope',
        reason: `评估令牌只能操作当前评估任务（#${ctx.taskId ?? '-'}）`,
      };
    }
    return { decision: 'allow' };
  }
  if (tool === 'list_my_tasks') return { decision: 'allow' };
  if (WRITE_TOOLS.has(tool)) {
    return {
      decision: 'block',
      kind:
        tool === 'create_task' || tool === 'create_subtask'
          ? 'subtask'
          : 'write',
      reason: EVAL_MODE_ERROR,
    };
  }
  // 其余工具按读放行（工单/机器人/任务定义/项目/知识/缺陷等读操作）
  return { decision: 'allow' };
}

/** 从工具参数中提取任务 ID（taskId / parentTaskId / id 等） */
function parseTaskId(
  args: Record<string, unknown> | null | undefined,
): number | null {
  if (!args || typeof args !== 'object') return null;
  for (const key of ['taskId', 'parentTaskId', 'task_id']) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

/**
 * .md 端点分类：method + 路径。
 * 原则：GET 读放行（任务端点按评估任务作用域）；写操作只放行任务协同端点（作用域内）。
 */
export function classifyEvalMdRequest(
  method: string,
  pathname: string,
  ctx: EvalContext,
): EvalCheck {
  const path = pathname.replace(/\/+$/, '');
  const isRead = method === 'GET' || method === 'HEAD';

  // 任务相关端点：一律校验作用域（含 /api/tasks/{id}.md 与 /api/tasks/{id}/...）
  const taskMatch = /^\/api\/tasks\/(\d+)(?:\.md)?(\/.*)?$/.exec(path);
  if (taskMatch) {
    const taskId = Number(taskMatch[1]);
    if (taskId !== ctx.taskId) {
      return {
        decision: 'block',
        kind: 'scope',
        reason: `评估令牌只能操作当前评估任务（#${ctx.taskId ?? '-'}）`,
      };
    }
    const sub = taskMatch[2] ?? '';
    if (isRead) return { decision: 'allow' };
    // 子任务创建（D6）与需求方动作拦截
    if (sub.includes('/subtasks/create')) {
      return { decision: 'block', kind: 'subtask', reason: EVAL_MODE_ERROR };
    }
    // 执行方提问（ask）属于评估任务本身的协同动作，须先于「需求方动作」放行
    if (sub.includes('/questions/ask')) return { decision: 'allow' };
    if (
      sub.includes('/handoff/accept') ||
      sub.includes('/handoff/refuse') ||
      sub.includes('/fail') ||
      sub.includes('/questions/')
    ) {
      return { decision: 'block', kind: 'write', reason: EVAL_MODE_ERROR };
    }
    if (
      sub.includes('/accept-task') ||
      sub.includes('/refuse') ||
      sub.includes('/handoff/update') ||
      sub.includes('/handoff/apply') ||
      sub.includes('/deliver/apply') ||
      sub.includes('/documents') ||
      sub.includes('/messages/reply') ||
      sub === ''
    ) {
      return { decision: 'allow' };
    }
    return { decision: 'block', kind: 'write', reason: EVAL_MODE_ERROR };
  }

  // 任务清单
  if (path === '/api/tasks' || path === '/api/tasks.md') {
    return { decision: 'allow' };
  }

  // 名单类读视图
  if (isRead) {
    return { decision: 'allow' };
  }

  return { decision: 'block', kind: 'write', reason: EVAL_MODE_ERROR };
}

export { EVAL_MODE_ERROR };
