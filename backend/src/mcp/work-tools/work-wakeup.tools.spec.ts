import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkWakeupTools } from './work-wakeup.tools';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
type ToolResult = { content: { text: string }[]; isError?: boolean };

function buildTools(principal: { user?: unknown; worker?: unknown }) {
  const wakeups = {
    findTask: jest.fn().mockResolvedValue({
      id: 42,
      code: 'TK-0042',
      title: '长任务',
    }),
    scheduleTask: jest.fn().mockResolvedValue({
      wakeup: {
        id: 7,
        scope: null,
        note: '检查工单',
        wakeAt: new Date('2026-11-17T03:00:00Z'),
      },
      replaced: false,
      delayMinutes: 30,
    }),
    cancelTask: jest.fn().mockResolvedValue(1),
    scheduleAgent: jest.fn().mockResolvedValue({
      wakeup: {
        id: 8,
        scope: 'agent:task:42',
        note: null,
        wakeAt: new Date('2026-11-17T03:00:00Z'),
      },
      replaced: true,
      delayMinutes: 10,
    }),
    cancelAgent: jest.fn().mockResolvedValue(0),
  };
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: Handler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  new WorkWakeupTools(wakeups as never).register(server, principal as never);
  return { tools, wakeups };
}

describe('WorkWakeupTools 定时唤醒工具', () => {
  it('注册任务与我的 AI 的唤醒/取消工具', () => {
    const { tools } = buildTools({
      user: { id: 9, name: '张三' },
      worker: { id: 1001, name: 'AI-执行' },
    });
    expect([...tools.keys()]).toEqual([
      'schedule_task_wakeup',
      'cancel_task_wakeup',
      'schedule_agent_wakeup',
      'cancel_agent_wakeup',
    ]);
  });

  it('任务唤醒仅接受机器人身份', async () => {
    const { tools, wakeups } = buildTools({ user: { id: 9, name: '张三' } });
    const result = (await tools.get('schedule_task_wakeup')!({
      taskId: 42,
      delayMinutes: 30,
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('仅接受机器人身份');
    expect(wakeups.scheduleTask).not.toHaveBeenCalled();
  });

  it('设置任务唤醒返回触发时间说明', async () => {
    const { tools, wakeups } = buildTools({
      worker: { id: 1001, name: 'AI-执行' },
    });
    const result = (await tools.get('schedule_task_wakeup')!({
      taskId: 42,
      delayMinutes: 30,
      note: '检查工单',
    })) as ToolResult;
    expect(result.isError).toBeUndefined();
    expect(wakeups.scheduleTask).toHaveBeenCalledWith(
      { id: 1001, name: 'AI-执行' },
      expect.objectContaining({
        taskId: 42,
        delayMinutes: 30,
        note: '检查工单',
      }),
    );
    expect(result.content[0].text).toContain('触发时间');
    expect(result.content[0].text).toContain('TK-0042');
  });

  it('取消任务唤醒返回取消数量', async () => {
    const { tools } = buildTools({ worker: { id: 1001, name: 'AI-执行' } });
    const result = (await tools.get('cancel_task_wakeup')!({
      taskId: 42,
    })) as ToolResult;
    expect(result.content[0].text).toContain('取消数量：1');
  });

  it('我的 AI 唤醒需要登录用户身份', async () => {
    const { tools } = buildTools({ worker: { id: 1001, name: 'AI-执行' } });
    const result = (await tools.get('schedule_agent_wakeup')!({
      delayMinutes: 10,
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('需要登录用户身份');
  });

  it('我的 AI 唤醒按会话范围设置并展示覆盖信息', async () => {
    const { tools, wakeups } = buildTools({ user: { id: 9, name: '张三' } });
    const result = (await tools.get('schedule_agent_wakeup')!({
      taskId: 42,
      wakeAt: '2026-11-18T09:00:00+08:00',
    })) as ToolResult;
    expect(wakeups.scheduleAgent).toHaveBeenCalledWith(
      { id: 9, name: '张三' },
      expect.objectContaining({
        taskId: 42,
        wakeAt: '2026-11-18T09:00:00+08:00',
      }),
    );
    expect(result.content[0].text).toContain('是否覆盖旧的唤醒：是');
  });

  it('取消我的 AI 唤醒可返回无待触发唤醒', async () => {
    const { tools } = buildTools({ user: { id: 9, name: '张三' } });
    const result = (await tools.get('cancel_agent_wakeup')!({})) as ToolResult;
    expect(result.content[0].text).toContain('没有待触发的定时唤醒');
  });
});
