import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EvalItemResult, EvalRunStatus, UserRole } from '../../common/enums';
import { AdminEvalTools } from './admin-eval.tools';

type Handler = (
  args: Record<string, unknown>,
  extra?: unknown,
) => Promise<unknown>;

const runFixture = {
  id: 5,
  suiteId: 1,
  suiteVersion: 3,
  suiteSnapshot: {
    name: '登录测试集',
    cases: [
      { id: 10, title: '正常登录' },
      { id: 11, title: '异常登录' },
    ],
  },
  targetWorkerId: 1002,
  targetWorkerName: '活动开发机器人',
  evaluatorWorkerId: 1001,
  repeatCount: 3,
  concurrency: 3,
  status: EvalRunStatus.COMPLETED,
  createdByName: '管理员',
  createdAt: new Date('2026-11-25T00:00:00.000Z'),
  finishedAt: new Date('2026-11-25T01:00:00.000Z'),
  error: null,
  summary: { passRate: 66.7, avgScore: 70, total: 2 },
};

function buildTools(): {
  tools: Map<string, Handler>;
  suites: {
    list: jest.Mock;
    detail: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateTags: jest.Mock;
    addCase: jest.Mock;
    updateCase: jest.Mock;
    import: jest.Mock;
    export: jest.Mock;
  };
  engine: {
    listRuns: jest.Mock;
    createRun: jest.Mock;
    findRun: jest.Mock;
    listItems: jest.Mock;
  };
  progress: { onRun: jest.Mock };
} {
  const suites = {
    list: jest.fn().mockResolvedValue([{ id: 1, name: '登录测试集' }]),
    detail: jest.fn().mockResolvedValue({ suite: { id: 1 }, cases: [] }),
    create: jest.fn().mockResolvedValue({ id: 2, name: '新测试集' }),
    update: jest.fn().mockResolvedValue({ id: 2, name: '改名' }),
    updateTags: jest.fn().mockResolvedValue({ id: 2, tags: ['登录'] }),
    addCase: jest.fn().mockResolvedValue({ id: 10, caseKey: 'c1' }),
    updateCase: jest.fn().mockResolvedValue({ id: 10, caseKey: 'c1' }),
    import: jest.fn().mockResolvedValue({ added: 1, updated: 0 }),
    export: jest.fn().mockResolvedValue({ suite: {}, cases: [] }),
  };
  const engine = {
    listRuns: jest.fn().mockResolvedValue([runFixture]),
    createRun: jest.fn().mockResolvedValue({ id: 5 }),
    findRun: jest.fn().mockResolvedValue(runFixture),
    listItems: jest.fn().mockResolvedValue([
      {
        id: 20,
        caseId: 10,
        repeatIndex: 1,
        status: '已完成',
        result: EvalItemResult.FIRST_PASS,
        firstScore: 100,
        finalScore: 100,
        questionCount: 0,
        reworkCount: 0,
        blockedWriteCount: 1,
        superseded: false,
      },
      {
        id: 21,
        caseId: 11,
        repeatIndex: 1,
        status: '已完成',
        result: EvalItemResult.FAILED,
        firstScore: 40,
        finalScore: 40,
        questionCount: 1,
        reworkCount: 1,
        blockedWriteCount: 0,
        superseded: false,
      },
    ]),
  };
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: Handler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  const progress = { onRun: jest.fn().mockReturnValue(() => {}) };
  new AdminEvalTools(
    suites as never,
    engine as never,
    progress as never,
  ).register(server, {
    user: { id: 1, name: '管理员', role: UserRole.ADMIN },
  } as never);
  return { tools, suites, engine, progress };
}

describe('AdminEvalTools', () => {
  it('注册全部评估管理工具', () => {
    const { tools } = buildTools();
    expect([...tools.keys()]).toEqual(
      expect.arrayContaining([
        'list_eval_suites',
        'get_eval_suite',
        'create_eval_suite',
        'update_eval_suite',
        'archive_eval_suite',
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
      ]),
    );
  });

  it('upsert_eval_case 自动补齐 title 与要点序号', async () => {
    const { tools, suites } = buildTools();
    await tools.get('upsert_eval_case')!({
      suiteId: 1,
      caseKey: 'c1',
      prompt: '请完成登录',
      points: [
        { point: '能登录成功' },
        { point: '有错误提示', required: true },
      ],
    });
    expect(suites.addCase).toHaveBeenCalledWith(1, {
      caseKey: 'c1',
      title: '',
      prompt: '请完成登录',
      clarify: undefined,
      passThreshold: undefined,
      timeoutSec: undefined,
      enabled: undefined,
      points: [
        { point: '能登录成功', seq: 1 },
        { point: '有错误提示', required: true, seq: 2 },
      ],
    });
  });

  it('create_eval_run 记录管理员为发起人', async () => {
    const { tools, engine } = buildTools();
    await tools.get('create_eval_run')!({
      suiteId: 1,
      targetWorkerId: 1002,
      evaluatorWorkerId: 1001,
    });
    expect(engine.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        suiteId: 1,
        targetWorkerId: 1002,
        evaluatorWorkerId: 1001,
        createdById: 1,
        createdByName: '管理员',
      }),
    );
  });

  it('get_eval_run_report 渲染批次报告与用例标题', async () => {
    const { tools } = buildTools();
    const result = (await tools.get('get_eval_run_report')!({ runId: 5 })) as {
      content: { text: string }[];
    };
    const text = result.content[0].text;
    expect(text).toContain('评估报告：批次 #5');
    expect(text).toContain('登录测试集');
    expect(text).toContain('正常登录');
    expect(text).toContain('异常登录');
    expect(text).toContain('通过：1');
  });

  it('run_eval 发起后等待终态并返回报告', async () => {
    const { tools, engine } = buildTools();
    const result = (await tools.get('run_eval')!(
      { suiteId: 1, targetWorkerId: 1002, evaluatorWorkerId: 1001 },
      { _meta: {} },
    )) as { content: { text: string }[] };
    expect(engine.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        suiteId: 1,
        targetWorkerId: 1002,
        evaluatorWorkerId: 1001,
      }),
    );
    expect(result.content[0].text).toContain('评估报告：批次 #5');
  });

  it('get_eval_run 输出批次状态与评估项计数', async () => {
    const { tools } = buildTools();
    const result = (await tools.get('get_eval_run')!({ runId: 5 })) as {
      content: { text: string }[];
    };
    const text = result.content[0].text;
    expect(text).toContain('评估批次 #5');
    expect(text).toContain('进度：2/2 项结束');
    expect(text).toContain('已完成：2');
  });

  it('get_worker_eval_summary 汇总机器人最近批次', async () => {
    const { tools, engine } = buildTools();
    const result = (await tools.get('get_worker_eval_summary')!({
      workerId: 1002,
    })) as { content: { text: string }[] };
    expect(engine.listRuns).toHaveBeenCalledWith({
      targetWorkerId: 1002,
      limit: 10,
    });
    const text = result.content[0].text;
    expect(text).toContain('机器人评估成绩：活动开发机器人（#1002）');
    expect(text).toContain('登录测试集');
    expect(text).toContain('66.7%');
  });
});
