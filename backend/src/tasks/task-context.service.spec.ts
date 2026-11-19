import { BacklogStatus } from '../common/enums';
import { TaskContextService } from './task-context.service';

type Repo = { findOne: jest.Mock; find: jest.Mock };

function buildService(): {
  service: TaskContextService;
  taskRows: Repo;
  ticketRows: Repo;
  ticketRunRows: Repo;
  backlogs: Repo;
  iterations: Repo;
} {
  const taskRows: Repo = { findOne: jest.fn(), find: jest.fn() };
  const ticketRows: Repo = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
  };
  const ticketRunRows: Repo = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
  };
  const backlogs: Repo = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn(),
  };
  const iterations: Repo = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn(),
  };
  const service = new TaskContextService(
    taskRows as never,
    ticketRows as never,
    ticketRunRows as never,
    backlogs as never,
    iterations as never,
  );
  return { service, taskRows, ticketRows, ticketRunRows, backlogs, iterations };
}

function treeRow(over: Record<string, unknown> = {}) {
  return {
    id: 101,
    code: 'TK-0101',
    title: '交付任务',
    status: '进行中',
    subStatus: '执行中',
    parentId: null,
    handoffPath: null,
    handoffVersion: 0,
    ...over,
  };
}

describe('TaskContextService.buildSubtaskContext', () => {
  it('渲染任务树层级、状态与交付文档版本，并标注当前父任务', async () => {
    const { service, taskRows, backlogs, iterations } = buildService();
    taskRows.findOne.mockResolvedValue({ id: 102, rootId: 101, projectId: 7 });
    taskRows.find.mockResolvedValue([
      treeRow({ id: 101, code: 'TK-0101', title: '交付任务' }),
      treeRow({
        id: 102,
        code: 'TK-0102',
        title: '前端拆分',
        parentId: 101,
        handoffPath: '/task/20261119/TK-0102/HANDOFF.md',
        handoffVersion: 3,
      }),
      treeRow({
        id: 103,
        code: 'TK-0103',
        title: '接口开发',
        status: '已结束',
        subStatus: '完成',
        parentId: 101,
      }),
    ]);
    backlogs.findOne.mockResolvedValue({
      id: 12,
      code: 'BL-12',
      title: '礼包改版',
      status: BacklogStatus.EXECUTING,
      iterationId: 3,
      taskId: 101,
    });
    iterations.findOne.mockResolvedValue({
      id: 3,
      code: '2026W47',
      type: 'T7',
      description: '本周礼包迭代',
    });

    const text = await service.buildSubtaskContext(102);

    expect(taskRows.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: [{ id: 101 }, { rootId: 101 }],
        take: 201,
      }),
    );
    expect(text).toContain('- #101 TK-0101 交付任务（进行中-执行中）');
    expect(text).toContain(
      '  - #102 TK-0102 前端拆分（进行中-执行中）｜HANDOFF v3 ← 在此任务下创建',
    );
    expect(text).toContain('  - #103 TK-0103 接口开发（已结束-完成）');
    expect(text).toContain('- 迭代项：#12 BL-12 礼包改版（执行）');
    expect(text).toContain('- 迭代：#3 2026W47（T7）——本周礼包迭代');
    expect(text).toContain('- #102 TK-0102 前端拆分：HANDOFF v3');
    expect(text).toContain('`get_iteration`');
  });

  it('相关工单合并任务树、节点运行与迭代项来源并去重，按更新时间倒序', async () => {
    const { service, taskRows, ticketRows, ticketRunRows, backlogs } =
      buildService();
    taskRows.findOne.mockResolvedValue({ id: 101, rootId: 101, projectId: 7 });
    taskRows.find.mockResolvedValue([treeRow()]);
    backlogs.findOne.mockResolvedValue({
      id: 12,
      code: 'BL-12',
      title: '礼包改版',
      status: BacklogStatus.EXECUTING,
      iterationId: 3,
      taskId: 101,
    });
    const older = new Date('2026-11-15T10:00:00Z');
    const newer = new Date('2026-11-16T10:00:00Z');
    const ticket21 = {
      id: 21,
      code: 'WO-0021',
      title: '提测-礼包',
      workflowStatus: '进行中',
      currentNodeName: '测试验证',
      updatedAt: older,
    };
    const ticket22 = {
      id: 22,
      code: 'WO-0022',
      title: '审批-礼包',
      workflowStatus: '已完成',
      currentNodeName: null,
      updatedAt: newer,
    };
    // 1) 任务树工单 → 2) 迭代项直接工单 → 3) 节点运行反查（含重复的工单）
    ticketRows.find
      .mockResolvedValueOnce([ticket21])
      .mockResolvedValueOnce([ticket22])
      .mockResolvedValueOnce([ticket21, ticket22]);
    ticketRunRows.find.mockResolvedValue([{ ticketId: 21 }, { ticketId: 22 }]);

    const text = await service.buildSubtaskContext(101);

    const lines = text.split('\n');
    const idx21 = lines.findIndex((line) => line.includes('WO-0021'));
    const idx22 = lines.findIndex((line) => line.includes('WO-0022'));
    expect(idx21).toBeGreaterThan(-1);
    expect(idx22).toBeGreaterThan(-1);
    expect(idx22).toBeLessThan(idx21);
    expect(text.match(/WO-0021/g)?.length).toBe(1);
    expect(text).toContain('- #21 WO-0021 提测-礼包（进行中/测试验证）');
    expect(text).toContain('- #22 WO-0022 审批-礼包（已完成）');
  });

  it('无迭代项、工单与交付文档时给出降级文案', async () => {
    const { service, taskRows } = buildService();
    taskRows.findOne.mockResolvedValue({
      id: 101,
      rootId: 101,
      projectId: null,
    });
    taskRows.find.mockResolvedValue([treeRow()]);

    const text = await service.buildSubtaskContext(101);

    expect(text).toContain('（无关联迭代）');
    expect(text).toContain('（无相关工单）');
    expect(text).toContain('（暂无交付文档）');
  });

  it('交付任务未匹配时按项目回落未取消迭代项', async () => {
    const { service, taskRows, backlogs, iterations } = buildService();
    taskRows.findOne.mockResolvedValue({ id: 101, rootId: 101, projectId: 7 });
    taskRows.find.mockResolvedValue([treeRow()]);
    backlogs.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 12,
      code: 'BL-12',
      title: '礼包改版',
      status: BacklogStatus.WAITING,
      iterationId: 3,
      taskId: null,
    });
    iterations.findOne.mockResolvedValue({
      id: 3,
      code: '2026W47',
      type: 'T7',
      description: null,
    });

    const text = await service.buildSubtaskContext(101);

    const backlogCalls = backlogs.findOne.mock.calls as [
      { where: { projectId?: number } },
    ][];
    expect(backlogCalls[backlogCalls.length - 1][0].where.projectId).toBe(7);
    expect(text).toContain('- 迭代项：#12 BL-12 礼包改版（等待）');
    expect(text).toContain('- 迭代：#3 2026W47（T7）');
    expect(text).not.toContain('——');
  });

  it('任务树超过上限时截断并标注', async () => {
    const { service, taskRows } = buildService();
    taskRows.findOne.mockResolvedValue({ id: 1, rootId: 1, projectId: null });
    taskRows.find.mockResolvedValue(
      Array.from({ length: 201 }, (_, index) =>
        treeRow({
          id: index + 1,
          code: `TK-${index + 1}`,
          title: `任务${index + 1}`,
          parentId: index === 0 ? null : 1,
        }),
      ),
    );

    const text = await service.buildSubtaskContext(1);

    expect(text).toContain('（任务树超过 200 个节点，已截断）');
  });
});
