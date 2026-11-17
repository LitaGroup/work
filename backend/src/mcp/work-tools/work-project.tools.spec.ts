import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkProjectTools } from './work-project.tools';

/** 收集 registerTool 注册的 handler，供用例直接调用 */
type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function fakeServer(): { server: McpServer; tools: Map<string, Handler> } {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: Handler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, tools };
}

function buildTools(): {
  tools: Map<string, Handler>;
  projects: {
    searchMarkdown: jest.Mock;
    findOneRequirementMarkdown: jest.Mock;
    updateMarkdown: jest.Mock;
  };
} {
  const projects = {
    searchMarkdown: jest.fn().mockResolvedValue('# 搜索结果'),
    findOneRequirementMarkdown: jest.fn().mockResolvedValue('# 需求详情'),
    updateMarkdown: jest.fn().mockResolvedValue('# 已更新'),
  };
  const documents = {
    findOneMarkdown: jest.fn().mockResolvedValue('# 文档'),
    upsertMarkdown: jest.fn().mockResolvedValue('# 已写入'),
    syncFromApipost: jest.fn().mockResolvedValue({ id: 1 }),
  };
  const registrar = new WorkProjectTools(projects as never, documents as never);
  const { server, tools } = fakeServer();
  registrar.register(server, { user: { id: 1, name: '张三' } as never });
  return { tools, projects };
}

describe('WorkProjectTools', () => {
  it('注册需求/文档工具', () => {
    const { tools } = buildTools();
    expect([...tools.keys()]).toEqual([
      'search_projects',
      'get_project',
      'update_project',
      'read_document',
      'upsert_document',
      'sync_apipost_document',
    ]);
  });

  it('search_projects 返回 service 的 Markdown 正文', async () => {
    const { tools, projects } = buildTools();
    const result = (await tools.get('search_projects')!({ query: 'pk' })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(projects.searchMarkdown).toHaveBeenCalledWith('pk');
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('# 搜索结果');
  });

  it('update_project 透传本地字段', async () => {
    const { tools, projects } = buildTools();
    await tools.get('update_project')!({
      projectId: 9,
      owner: '张三',
      remark: 'P0',
    });
    expect(projects.updateMarkdown).toHaveBeenCalledWith(9, {
      owner: '张三',
      remark: 'P0',
    });
  });

  it('工具失败返回 isError 与原始错误信息', async () => {
    const { tools, projects } = buildTools();
    projects.searchMarkdown.mockRejectedValueOnce(new Error('数据库不可用'));
    const result = (await tools.get('search_projects')!({ query: 'pk' })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('数据库不可用');
  });
});
