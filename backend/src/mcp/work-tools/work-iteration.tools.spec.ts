import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { UserRole } from '../../common/enums';
import { WorkIterationTools } from './work-iteration.tools';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function buildTools(options?: {
  user?: { id: number; name: string; role: UserRole };
  worker?: { id: number; name: string };
}): {
  tools: Map<string, Handler>;
  backlogs: { updateMembers: jest.Mock; findOneMarkdown: jest.Mock };
} {
  const backlogs = {
    updateMembers: jest.fn().mockResolvedValue({ id: 33 }),
    findOneMarkdown: jest.fn().mockResolvedValue('# 迭代项详情'),
  };
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: Handler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  new WorkIterationTools(backlogs as never).register(server, {
    user: options?.user ?? {
      id: 1,
      name: '张三',
      role: UserRole.ADMIN,
    },
    worker: options?.worker,
  } as never);
  return { tools, backlogs };
}

describe('WorkIterationTools', () => {
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
});
