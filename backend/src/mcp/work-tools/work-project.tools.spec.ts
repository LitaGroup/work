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
    create: jest.Mock;
  };
  documents: {
    findOneMarkdown: jest.Mock;
    upsertMarkdown: jest.Mock;
    syncFromApipost: jest.Mock;
    createMarkdown: jest.Mock;
    syncFromFeishu: jest.Mock;
    updateRemark: jest.Mock;
    remove: jest.Mock;
  };
} {
  const projects = {
    searchMarkdown: jest.fn().mockResolvedValue('# 搜索结果'),
    findOneRequirementMarkdown: jest.fn().mockResolvedValue('# 需求详情'),
    updateMarkdown: jest.fn().mockResolvedValue('# 已更新'),
    create: jest.fn().mockResolvedValue({ id: 7 }),
  };
  const documents = {
    findOneMarkdown: jest.fn().mockResolvedValue('# 文档'),
    upsertMarkdown: jest.fn().mockResolvedValue('# 已写入'),
    syncFromApipost: jest.fn().mockResolvedValue({ id: 1 }),
    createMarkdown: jest.fn().mockResolvedValue({ id: 12 }),
    syncFromFeishu: jest.fn().mockResolvedValue({ id: 13 }),
    updateRemark: jest.fn().mockResolvedValue({ id: 12 }),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const registrar = new WorkProjectTools(projects as never, documents as never);
  const { server, tools } = fakeServer();
  registrar.register(server, { user: { id: 1, name: '张三' } as never });
  return { tools, projects, documents };
}

describe('WorkProjectTools', () => {
  it('注册需求/文档工具', () => {
    const { tools } = buildTools();
    expect([...tools.keys()]).toEqual([
      'list_requirements',
      'get_requirement',
      'update_requirement',
      'create_requirement',
      'read_document',
      'upsert_document',
      'sync_apipost_document',
      'create_document',
      'sync_feishu_document',
      'update_document_remark',
      'delete_document',
    ]);
  });

  it('list_requirements 返回 service 的 Markdown 正文', async () => {
    const { tools, projects } = buildTools();
    const result = (await tools.get('list_requirements')!({ query: 'pk' })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(projects.searchMarkdown).toHaveBeenCalledWith('pk');
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('# 搜索结果');
  });

  it('update_requirement 透传本地字段', async () => {
    const { tools, projects } = buildTools();
    await tools.get('update_requirement')!({
      projectId: 9,
      owner: '张三',
      remark: 'P0',
    });
    expect(projects.updateMarkdown).toHaveBeenCalledWith(9, {
      owner: '张三',
      remark: 'P0',
    });
  });

  it('create_requirement 创建需求并返回需求 Markdown', async () => {
    const { tools, projects } = buildTools();
    const result = (await tools.get('create_requirement')!({
      name: 'PK 活动优化',
      type: '功能',
      expectedReleaseAt: '2026-12-01',
      description: '## 背景',
    })) as { content: { text: string }[] };
    expect(projects.create).toHaveBeenCalledWith({
      name: 'PK 活动优化',
      type: '功能',
      expectedReleaseAt: '2026-12-01',
      description: '## 背景',
    });
    expect(projects.findOneRequirementMarkdown).toHaveBeenCalledWith(7);
    expect(result.content[0].text).toBe('# 需求详情');
  });

  it('create_requirement 缺省字段原样传递（由服务层补默认值）', async () => {
    const { tools, projects } = buildTools();
    await tools.get('create_requirement')!({ name: '快速记录' });
    expect(projects.create).toHaveBeenCalledWith({
      name: '快速记录',
      type: undefined,
      expectedReleaseAt: undefined,
      description: undefined,
    });
  });

  it('create_document 新建文档并返回文档 Markdown', async () => {
    const { tools, documents } = buildTools();
    const result = (await tools.get('create_document')!({
      projectId: 7,
      title: '交互稿',
      type: '设计',
      url: 'https://figma.com/file/abc',
    })) as { content: { text: string }[] };
    expect(documents.createMarkdown).toHaveBeenCalledWith({
      projectId: 7,
      title: '交互稿',
      type: '设计',
      content: undefined,
      url: 'https://figma.com/file/abc',
    });
    expect(documents.findOneMarkdown).toHaveBeenCalledWith(12);
    expect(result.content[0].text).toBe('# 文档');
  });

  it('sync_feishu_document 导入飞书文档并返回文档 Markdown', async () => {
    const { tools, documents } = buildTools();
    await tools.get('sync_feishu_document')!({
      projectId: 7,
      type: '功能',
      url: 'https://feishu.cn/docx/abc',
      description: '产品方案',
    });
    expect(documents.syncFromFeishu).toHaveBeenCalledWith({
      projectId: 7,
      type: '功能',
      url: 'https://feishu.cn/docx/abc',
      description: '产品方案',
    });
    expect(documents.findOneMarkdown).toHaveBeenCalledWith(13);
  });

  it('update_document_remark 更新备注并返回文档 Markdown', async () => {
    const { tools, documents } = buildTools();
    await tools.get('update_document_remark')!({
      documentId: 12,
      remark: '后端接口约定',
    });
    expect(documents.updateRemark).toHaveBeenCalledWith(12, '后端接口约定');
    expect(documents.findOneMarkdown).toHaveBeenCalledWith(12);
  });

  it('delete_document 删除文档并返回删除结果', async () => {
    const { tools, documents } = buildTools();
    const result = (await tools.get('delete_document')!({
      documentId: 12,
    })) as { content: { text: string }[] };
    expect(documents.remove).toHaveBeenCalledWith(12);
    expect(result.content[0].text).toContain('文档已删除');
    expect(result.content[0].text).toContain('12');
  });

  it('工具失败返回 isError 与原始错误信息', async () => {
    const { tools, projects } = buildTools();
    projects.searchMarkdown.mockRejectedValueOnce(new Error('数据库不可用'));
    const result = (await tools.get('list_requirements')!({ query: 'pk' })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('数据库不可用');
  });
});
