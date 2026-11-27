import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { UserRole } from '../../common/enums';
import { WorkIterationTools } from './work-iteration.tools';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function buildTools(options?: {
  user?: { id: number; name: string; role: UserRole };
  worker?: { id: number; name: string };
}): {
  tools: Map<string, Handler>;
  backlogs: {
    updateMembers: jest.Mock;
    updateBacklog: jest.Mock;
    updateStatus: jest.Mock;
    move: jest.Mock;
    createBatch: jest.Mock;
    createTask: jest.Mock;
    submitReleaseMarkdown: jest.Mock;
    findOneMarkdown: jest.Mock;
  };
  iterations: { findOneMarkdown: jest.Mock; listMarkdown: jest.Mock };
} {
  const backlogs = {
    updateMembers: jest.fn().mockResolvedValue({ id: 33 }),
    updateBacklog: jest.fn().mockResolvedValue({ id: 33 }),
    updateStatus: jest.fn().mockResolvedValue({ id: 33 }),
    move: jest.fn().mockResolvedValue({ id: 33 }),
    createBatch: jest.fn().mockResolvedValue([
      { id: 33, code: 'BL-0033', title: 'BL-0033 PK 活动优化' },
      { id: 34, code: 'BL-0034', title: 'BL-0034 签到改版' },
    ]),
    createTask: jest
      .fn()
      .mockResolvedValue({ id: 55, code: 'TK-0055', title: '子任务' }),
    submitReleaseMarkdown: jest.fn().mockResolvedValue('# 提测结果'),
    findOneMarkdown: jest.fn().mockResolvedValue('# 迭代项详情'),
  };
  const iterations = {
    findOneMarkdown: jest.fn().mockResolvedValue('# 迭代详情'),
    listMarkdown: jest.fn().mockResolvedValue('# 迭代清单'),
  };
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: Handler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  new WorkIterationTools(backlogs as never, iterations as never).register(
    server,
    {
      user: options?.user ?? {
        id: 1,
        name: '张三',
        role: UserRole.ADMIN,
      },
      worker: options?.worker,
    } as never,
  );
  return { tools, backlogs, iterations };
}

describe('WorkIterationTools', () => {
  it('注册迭代项工具', () => {
    const { tools } = buildTools();
    expect([...tools.keys()]).toEqual([
      'get_backlog',
      'get_iteration',
      'list_iterations',
      'update_backlog_members',
      'update_backlog',
      'change_backlog_status',
      'move_backlog',
      'create_backlogs',
      'create_backlog_task',
      'create_backlog_release',
    ]);
  });

  it('get_backlog 返回迭代项 Markdown', async () => {
    const { tools, backlogs } = buildTools();
    const result = (await tools.get('get_backlog')!({ backlogId: 33 })) as {
      content: { text: string }[];
    };
    expect(backlogs.findOneMarkdown).toHaveBeenCalledWith(33);
    expect(result.content[0].text).toBe('# 迭代项详情');
  });

  it('get_iteration 返回迭代 Markdown', async () => {
    const { tools, iterations } = buildTools();
    const result = (await tools.get('get_iteration')!({
      iterationId: 7,
    })) as { content: { text: string }[] };
    expect(iterations.findOneMarkdown).toHaveBeenCalledWith(7);
    expect(result.content[0].text).toBe('# 迭代详情');
  });

  it('list_iterations 透传类型/状态过滤并返回清单 Markdown', async () => {
    const { tools, iterations } = buildTools();
    const result = (await tools.get('list_iterations')!({
      type: 'T7',
      status: '进行中',
    })) as { content: { text: string }[] };
    expect(iterations.listMarkdown).toHaveBeenCalledWith({
      type: 'T7',
      status: '进行中',
    });
    expect(result.content[0].text).toBe('# 迭代清单');
  });

  it('create_backlogs 以管理员身份批量转入并返回迭代项清单', async () => {
    const { tools, backlogs } = buildTools();
    const result = (await tools.get('create_backlogs')!({
      iterationId: 7,
      items: [
        {
          projectId: 21,
          ownerWorkerId: 1002,
          members: [{ role: '前端', userId: 7 }],
        },
        { projectId: 22 },
      ],
    })) as { content: { text: string }[] };
    expect(backlogs.createBatch).toHaveBeenCalledWith(
      7,
      [
        {
          projectId: 21,
          ownerWorkerId: 1002,
          members: [{ role: '前端', userId: 7 }],
        },
        { projectId: 22, ownerWorkerId: null, members: undefined },
      ],
      expect.objectContaining({
        userId: 1,
        userName: '张三',
        isAdmin: true,
        workerId: null,
      }),
    );
    expect(backlogs.findOneMarkdown).toHaveBeenCalledWith(33);
    expect(backlogs.findOneMarkdown).toHaveBeenCalledWith(34);
    expect(result.content[0].text).toContain('BL-0033');
    expect(result.content[0].text).toContain('BL-0034');
  });

  it('create_backlogs 非管理员身份传入 isAdmin=false 由服务层拒绝', async () => {
    const { tools, backlogs } = buildTools({
      user: { id: 2, name: '负责人', role: UserRole.MEMBER },
      worker: { id: 1002, name: '迭代负责人机器人' },
    });
    backlogs.createBatch.mockRejectedValueOnce(
      new Error('仅管理员可将需求转入迭代'),
    );
    const result = (await tools.get('create_backlogs')!({
      iterationId: 7,
      items: [{ projectId: 21 }],
    })) as { content: { text: string }[]; isError?: boolean };
    expect(backlogs.createBatch).toHaveBeenCalledWith(
      7,
      [{ projectId: 21, ownerWorkerId: null, members: undefined }],
      expect.objectContaining({ userId: 2, isAdmin: false, workerId: 1002 }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('仅管理员可将需求转入迭代');
  });

  it('update_backlog_members 以管理员身份更新并返回迭代项 Markdown', async () => {
    const { tools, backlogs } = buildTools();
    const result = (await tools.get('update_backlog_members')!({
      backlogId: 33,
      members: [
        { role: '前端', userId: 7 },
        { role: '测试', name: '小明' },
      ],
    })) as { content: { text: string }[] };
    expect(backlogs.updateMembers).toHaveBeenCalledWith(
      33,
      [
        { role: '前端', userId: 7 },
        { role: '测试', name: '小明' },
      ],
      expect.objectContaining({
        userId: 1,
        userName: '张三',
        isAdmin: true,
        workerId: null,
      }),
    );
    expect(backlogs.findOneMarkdown).toHaveBeenCalledWith(33);
    expect(result.content[0].text).toBe('# 迭代项详情');
  });

  it('AI 机器人身份：非管理员且带上机器人 ID 供负责人校验', async () => {
    const { tools, backlogs } = buildTools({
      user: { id: 2, name: '负责人', role: UserRole.MEMBER },
      worker: { id: 1002, name: '迭代负责人机器人' },
    });
    await tools.get('update_backlog_members')!({
      backlogId: 33,
      members: [],
    });
    expect(backlogs.updateMembers).toHaveBeenCalledWith(
      33,
      [],
      expect.objectContaining({
        userId: 2,
        userName: '负责人',
        isAdmin: false,
        workerId: 1002,
      }),
    );
  });

  it('update_backlog 透传预期上线时间与负责人', async () => {
    const { tools, backlogs } = buildTools();
    await tools.get('update_backlog')!({
      backlogId: 33,
      expectedOnlineAt: '2026-11-20T18:00:00+08:00',
      ownerWorkerId: 1002,
    });
    expect(backlogs.updateBacklog).toHaveBeenCalledWith(
      33,
      {
        expectedOnlineAt: '2026-11-20T18:00:00+08:00',
        ownerWorkerId: 1002,
      },
      expect.objectContaining({ userId: 1, isAdmin: true }),
    );
    expect(backlogs.findOneMarkdown).toHaveBeenCalledWith(33);
  });

  it('change_backlog_status 透传状态与备注', async () => {
    const { tools, backlogs } = buildTools();
    await tools.get('change_backlog_status')!({
      backlogId: 33,
      status: '测试',
      remark: '提测通过',
    });
    expect(backlogs.updateStatus).toHaveBeenCalledWith(
      33,
      '测试',
      expect.objectContaining({ userName: '张三' }),
      '提测通过',
    );
    expect(backlogs.findOneMarkdown).toHaveBeenCalledWith(33);
  });

  it('move_backlog 透传目标迭代', async () => {
    const { tools, backlogs } = buildTools();
    await tools.get('move_backlog')!({ backlogId: 33, iterationId: 7 });
    expect(backlogs.move).toHaveBeenCalledWith(
      33,
      7,
      expect.objectContaining({ userId: 1 }),
    );
    expect(backlogs.findOneMarkdown).toHaveBeenCalledWith(33);
  });

  it('create_backlog_task 返回新建任务信息与迭代项详情', async () => {
    const { tools, backlogs } = buildTools();
    const result = (await tools.get('create_backlog_task')!({
      backlogId: 33,
      title: '子任务',
      agentId: 1002,
    })) as { content: { text: string }[] };
    expect(backlogs.createTask).toHaveBeenCalledWith(
      33,
      {
        title: '子任务',
        description: null,
        templateId: null,
        agentId: 1002,
      },
      expect.objectContaining({ userId: 1 }),
    );
    expect(result.content[0].text).toContain('已创建任务 #55（TK-0055）');
    expect(result.content[0].text).toContain('# 迭代项详情');
  });

  it('create_backlog_release 透传批量入参与创建人并返回 Markdown', async () => {
    const { tools, backlogs } = buildTools({
      user: { id: 2, name: '负责人', role: UserRole.MEMBER },
      worker: { id: 1002, name: '迭代负责人机器人' },
    });
    const result = (await tools.get('create_backlog_release')!({
      items: [{ backlogId: 33 }, { backlogId: 34 }],
      ends: ['APP', 'H5'],
      inputValues: { branch: 'test' },
    })) as { content: { text: string }[] };
    expect(backlogs.submitReleaseMarkdown).toHaveBeenCalledWith(
      {
        items: [{ backlogId: 33 }, { backlogId: 34 }],
        title: undefined,
        ends: ['APP', 'H5'],
        inputValues: { branch: 'test' },
        taskId: undefined,
      },
      expect.objectContaining({
        userId: 2,
        userName: '负责人',
        isAdmin: false,
        workerId: 1002,
      }),
      {
        user: { id: 2, name: '负责人', role: UserRole.MEMBER },
        worker: { id: 1002, name: '迭代负责人机器人' },
      },
    );
    expect(result.content[0].text).toBe('# 提测结果');
  });
});
