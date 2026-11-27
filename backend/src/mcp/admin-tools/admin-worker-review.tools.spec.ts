import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AdminWorkerReviewTools } from './admin-worker-review.tools';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function buildTools(): {
  tools: Map<string, Handler>;
  reviews: {
    list: jest.Mock;
    read: jest.Mock;
    renderListMarkdown: jest.Mock;
    renderDetailMarkdown: jest.Mock;
  };
} {
  const reviews = {
    list: jest.fn().mockResolvedValue({ items: [] }),
    read: jest.fn().mockResolvedValue({ content: '正文' }),
    renderListMarkdown: jest.fn().mockReturnValue('# 机器人复盘'),
    renderDetailMarkdown: jest.fn().mockReturnValue('# 复盘详情'),
  };
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: Handler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  new AdminWorkerReviewTools(reviews as never).register(server, {
    user: { id: 1, name: '管理员' },
  } as never);
  return { tools, reviews };
}

describe('AdminWorkerReviewTools', () => {
  it('按 workerId 查询指定机器人的复盘清单', async () => {
    const { tools, reviews } = buildTools();

    await tools.get('list_worker_reviews')!({
      workerId: 1002,
      page: 1,
      pageSize: 20,
    });

    expect(reviews.list).toHaveBeenCalledWith(1002, {
      page: 1,
      pageSize: 20,
      from: undefined,
      to: undefined,
    });
    expect(reviews.renderListMarkdown).toHaveBeenCalledWith(
      { items: [] },
      { scope: 'admin', readTool: 'read_worker_review' },
    );
  });

  it('按 workerId 读取指定机器人的复盘全文', async () => {
    const { tools, reviews } = buildTools();

    await tools.get('read_worker_review')!({
      workerId: 1002,
      name: '20261126003005',
    });

    expect(reviews.read).toHaveBeenCalledWith(1002, '20261126003005');
  });
});
