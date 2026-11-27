import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkReviewTools } from './work-review.tools';

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { text: string }[];
}>;

function buildTools(): {
  tools: Map<string, Handler>;
  reviews: {
    list: jest.Mock;
    read: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    renderListMarkdown: jest.Mock;
    renderDetailMarkdown: jest.Mock;
    renderCreatedMarkdown: jest.Mock;
    renderUpdatedMarkdown: jest.Mock;
  };
} {
  const reviews = {
    list: jest.fn().mockResolvedValue({ items: [] }),
    read: jest.fn().mockResolvedValue({ content: '正文' }),
    create: jest.fn().mockResolvedValue({ content: '正文' }),
    update: jest.fn().mockResolvedValue({ content: '正文' }),
    renderListMarkdown: jest.fn().mockReturnValue('# 我的复盘'),
    renderDetailMarkdown: jest.fn().mockReturnValue('# 复盘详情'),
    renderCreatedMarkdown: jest.fn().mockReturnValue('# 复盘已保存'),
    renderUpdatedMarkdown: jest.fn().mockReturnValue('# 复盘已更新'),
  };
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: Handler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  new WorkReviewTools(reviews as never).register(server, {
    worker: { id: 1001, name: '测试机器人' },
  } as never);
  return { tools, reviews };
}

describe('WorkReviewTools', () => {
  it('查询与上传只能使用当前机器人身份', async () => {
    const { tools, reviews } = buildTools();

    await tools.get('list_my_reviews')!({
      page: 2,
      pageSize: 10,
      from: '2026-11-01T00:00:00Z',
    });
    expect(reviews.list).toHaveBeenCalledWith(1001, {
      page: 2,
      pageSize: 10,
      from: '2026-11-01T00:00:00Z',
      to: undefined,
    });
    expect(reviews.renderListMarkdown).toHaveBeenCalledWith(
      { items: [] },
      { scope: 'mine', readTool: 'read_my_review' },
    );

    await tools.get('create_my_review')!({
      title: '本周复盘',
      content: '## 经验',
    });
    expect(reviews.create).toHaveBeenCalledWith(1001, {
      title: '本周复盘',
      content: '## 经验',
    });
  });

  it('读取与修改只传当前机器人 ID 与复盘名称', async () => {
    const { tools, reviews } = buildTools();

    await tools.get('read_my_review')!({ name: '20261126003005' });
    expect(reviews.read).toHaveBeenCalledWith(1001, '20261126003005');

    await tools.get('update_my_review')!({
      name: '20261126003005',
      content: '更新',
    });
    expect(reviews.update).toHaveBeenCalledWith(1001, '20261126003005', {
      title: undefined,
      content: '更新',
    });
  });

  it('没有机器人身份时拒绝上传', async () => {
    const reviews = { create: jest.fn() };
    const tools = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, _meta: unknown, handler: Handler) => {
        tools.set(name, handler);
      },
    } as unknown as McpServer;
    new WorkReviewTools(reviews as never).register(server, {
      user: { id: 1, name: '公共 Agent' },
    } as never);

    const result = await tools.get('create_my_review')!({ content: '经验' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('仅接受机器人身份');
    expect(reviews.create).not.toHaveBeenCalled();
  });
});
