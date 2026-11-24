import { classifyEvalMdRequest, classifyEvalTool } from './eval-policy';
import type { EvalContext } from './eval-token.service';

const ctx: EvalContext = {
  workerId: 100,
  evalItemId: 5,
  taskId: 42,
  judge: false,
};

describe('评估模式权限策略（TECH_DESIGN 9.4）', () => {
  it('任务协同工具只作用于当前评估任务', () => {
    expect(classifyEvalTool('accept_task', { taskId: 42 }, ctx).decision).toBe(
      'allow',
    );
    expect(classifyEvalTool('accept_task', { taskId: 43 }, ctx).decision).toBe(
      'block',
    );
  });

  it('创建任务与子任务被拦截', () => {
    const createSub = classifyEvalTool('create_subtask', {}, ctx);
    expect(createSub.decision).toBe('block');
    expect(createSub.decision === 'block' && createSub.kind).toBe('subtask');
  });

  it('需求方动作与写操作被拦截', () => {
    expect(classifyEvalTool('answer_task_question', {}, ctx).decision).toBe(
      'block',
    );
    expect(classifyEvalTool('feishu_send_message', {}, ctx).decision).toBe(
      'block',
    );
    expect(classifyEvalTool('create_project', {}, ctx).decision).toBe('block');
  });

  it('读操作放行', () => {
    expect(classifyEvalTool('list_workers', {}, ctx).decision).toBe('allow');
    expect(classifyEvalTool('get_ticket', {}, ctx).decision).toBe('allow');
  });

  it('判定令牌只开放判定工具', () => {
    const judge: EvalContext = { ...ctx, judge: true, taskId: 42 };
    expect(classifyEvalTool('get_eval_judge_input', {}, judge).decision).toBe(
      'allow',
    );
    expect(
      classifyEvalTool('accept_task', { taskId: 42 }, judge).decision,
    ).toBe('block');
  });

  it('.md 端点：任务协同放行、子任务与需求方动作拦截', () => {
    expect(
      classifyEvalMdRequest('POST', '/api/tasks/42/accept-task.md', ctx)
        .decision,
    ).toBe('allow');
    // 执行方提问放行（派发提示词用 .md 入口），需求方答复仍拦截
    expect(
      classifyEvalMdRequest('POST', '/api/tasks/42/questions/ask.md', ctx)
        .decision,
    ).toBe('allow');
    expect(
      classifyEvalMdRequest(
        'POST',
        '/api/tasks/42/questions/project-q1/answer.md',
        ctx,
      ).decision,
    ).toBe('block');
    expect(
      classifyEvalMdRequest('POST', '/api/tasks/42/subtasks/create.md', ctx)
        .decision,
    ).toBe('block');
    expect(
      classifyEvalMdRequest('POST', '/api/tasks/42/handoff/accept.md', ctx)
        .decision,
    ).toBe('block');
    expect(classifyEvalMdRequest('GET', '/api/tasks/43.md', ctx).decision).toBe(
      'block',
    );
    expect(classifyEvalMdRequest('GET', '/api/projects.md', ctx).decision).toBe(
      'allow',
    );
  });
});
