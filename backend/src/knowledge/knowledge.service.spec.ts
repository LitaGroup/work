import type { KnowledgeEmbeddingService } from './knowledge-embedding.service';
import { KnowledgeService } from './knowledge.service';
import type { KnowledgeStore } from './knowledge.store';
import type { KnowledgeRetrieval } from './knowledge.types';

function retrieval(over: Partial<KnowledgeRetrieval> = {}): KnowledgeRetrieval {
  return {
    query: '部署',
    path: '/',
    mode: 'fulltext',
    hasMore: false,
    results: [
      {
        nodeId: 'n1',
        title: '部署',
        path: '/guides/deploy',
        headingPath: '部署',
        content: '# 部署',
        score: 0.01,
        relevance: 1,
        vectorSimilarity: null,
        matchedBy: 'fulltext',
        updatedAt: new Date(),
      },
    ],
    ...over,
  };
}

describe('KnowledgeService.search', () => {
  let service: KnowledgeService;
  let store: {
    isEnabled: boolean;
    unavailableMessage: string;
    search: jest.Mock;
    getByPath: jest.Mock;
    getById: jest.Mock;
    listChildren: jest.Mock;
    createNode: jest.Mock;
    findExternalNode: jest.Mock;
    createExternalNode: jest.Mock;
    updateExternalNode: jest.Mock;
  };

  beforeEach(() => {
    store = {
      isEnabled: true,
      unavailableMessage: '知识库不可用',
      search: jest.fn().mockResolvedValue(retrieval()),
      getByPath: jest.fn().mockResolvedValue({
        kind: 'directory',
        source: 'native',
        title: 'guides',
      }),
      getById: jest.fn(),
      findExternalNode: jest.fn().mockResolvedValue(null),
      createExternalNode: jest.fn().mockResolvedValue({ id: 'external-1' }),
      updateExternalNode: jest.fn(),
      listChildren: jest.fn().mockResolvedValue({
        path: '/guides',
        title: 'guides',
        parentPath: '/',
        directories: [],
        articles: [],
      }),
      createNode: jest.fn().mockResolvedValue({
        id: 'n2',
        kind: 'article',
        path: '/task/handoff/20261028/TK-0001/0',
        parentPath: '/task/handoff/20261028/TK-0001',
        name: '0.md',
        title: '任务总结',
        content: '# 总结',
        source: 'native',
        sourceDocumentId: null,
        sourceKey: null,
        sourceUrl: null,
        documentType: null,
        description: null,
        contentHash: 'h',
        indexStatus: 'pending',
        indexError: null,
        indexAttempts: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    };
    service = new KnowledgeService(
      store as unknown as KnowledgeStore,
      { configured: false } as unknown as KnowledgeEmbeddingService,
    );
  });

  it('默认搜站内并按 page/pageSize 计算 offset', async () => {
    const result = await service.search({
      query: '部署',
      page: 3,
      pageSize: 10,
    });
    expect(store.search).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 20, limit: 10 }),
    );
    expect(result.project.results).toHaveLength(1);
    expect(result.results).toEqual(result.project.results);
    expect(result.source).toBe('project');
  });

  it('飞书数据源已下线，source=feishu/all 直接报错', async () => {
    await expect(
      service.search({ query: '部署', source: 'feishu' as never }),
    ).rejects.toThrow('飞书云文档搜索已下线');
    await expect(
      service.search({ query: '部署', source: 'all' as never }),
    ).rejects.toThrow('飞书云文档搜索已下线');
    expect(store.search).not.toHaveBeenCalled();
  });

  it('知识库不可用时返回 503', async () => {
    store.isEnabled = false;
    await expect(service.search({ query: '部署' })).rejects.toThrow(
      '知识库不可用',
    );
    expect(store.search).not.toHaveBeenCalled();
  });

  it('搜索目录不存在时报错', async () => {
    store.getByPath.mockResolvedValueOnce(null);
    await expect(
      service.search({ query: '部署', path: '/missing' }),
    ).rejects.toThrow('搜索目录 /missing 不存在');
  });

  it('目录详情使用节点已保存的名称而不是路径段', async () => {
    store.getByPath.mockResolvedValueOnce({
      kind: 'directory',
      title: '研发指引',
    });

    const directory = await service.readDirectory('/guides');

    expect(store.listChildren).toHaveBeenCalledWith('/guides');
    expect(directory.title).toBe('研发指引');
  });

  it('导入外部文档时生成稳定且不冲突的路径', async () => {
    const node = await service.importExternal({
      parentPath: '/guides',
      source: 'feishu',
      sourceKey: 'docx:doc-1',
      sourceUrl: 'https://example.feishu.cn/docx/doc-1',
      title: '飞书部署文档',
      content: '# 部署',
      documentType: '技术',
      description: '部署资料',
    });

    expect(node).toEqual({ id: 'external-1' });
    const createCall = store.createExternalNode.mock.calls[0] as unknown as [
      {
        path: string;
        source: string;
        sourceKey: string;
        sourceUrl: string;
        title: string;
        content: string;
        documentType: string;
        description: string;
      },
    ];
    const { path, ...created } = createCall[0];
    expect(path).toMatch(/^\/guides\/feishu-[a-f0-9]{20}$/);
    expect(created).toEqual({
      source: 'feishu',
      sourceKey: 'docx:doc-1',
      sourceUrl: 'https://example.feishu.cn/docx/doc-1',
      title: '飞书部署文档',
      content: '# 部署',
      documentType: '技术',
      description: '部署资料',
    });
  });

  it('同目录同来源重复导入时覆盖原文章，不新建节点', async () => {
    store.findExternalNode.mockResolvedValueOnce({
      id: 'existing-1',
      source: 'apipost',
    });
    store.updateExternalNode.mockResolvedValueOnce({ id: 'existing-1' });

    await service.importExternal({
      parentPath: '/guides',
      source: 'apipost',
      sourceKey: 'https://docs.apipost.net/docs/detail/1',
      sourceUrl: 'https://docs.apipost.net/docs/detail/1',
      title: '接口文档',
      content: '# 接口',
      documentType: '接口',
    });

    expect(store.updateExternalNode).toHaveBeenCalledWith('existing-1', {
      title: '接口文档',
      content: '# 接口',
      sourceUrl: 'https://docs.apipost.net/docs/detail/1',
      documentType: '接口',
      description: undefined,
    });
    expect(store.createExternalNode).not.toHaveBeenCalled();
  });

  it('更新同步只更新外部导入文档', async () => {
    store.getById
      .mockResolvedValueOnce({ id: 'external-1', source: 'feishu' })
      .mockResolvedValueOnce({ id: 'native-1', source: 'native' });
    store.updateExternalNode.mockResolvedValueOnce({ id: 'external-1' });

    await service.syncExternal('external-1', {
      title: '新标题',
      content: '# 新正文',
    });
    expect(store.updateExternalNode).toHaveBeenCalledWith('external-1', {
      title: '新标题',
      content: '# 新正文',
    });

    await expect(
      service.syncExternal('native-1', { title: 'x', content: 'y' }),
    ).rejects.toThrow('当前知识节点不是外部导入文档');
  });

  it('按完整路径创建文章时自动交给存储层创建父目录', async () => {
    const node = await service.createArticleAtPath({
      path: '/task/handoff/20261028/TK-0001/0.md',
      title: '任务总结',
      content: '# 总结',
    });

    expect(store.createNode).toHaveBeenCalledWith({
      kind: 'article',
      path: '/task/handoff/20261028/TK-0001/0.md',
      title: '任务总结',
      content: '# 总结',
    });
    expect(node.path).toContain('/task/handoff/');
  });

  it('文章自带 Frontmatter 时不再重复前置平台元信息', () => {
    const content =
      '---\nupdate: "2026-11-02 10:00:00"\ndocument: "HANDOFF"\nversion: "3"\n---\n\n# 交付';
    const markdown = service.renderArticleMarkdown({
      id: 'n3',
      kind: 'article',
      path: '/task/20261102/TK-0001/HANDOFF',
      parentPath: '/task/20261102/TK-0001',
      name: 'HANDOFF',
      title: '任务交付文档',
      content,
      source: 'native',
      sourceDocumentId: null,
      sourceKey: null,
      sourceUrl: null,
      documentType: null,
      description: null,
      contentHash: 'h',
      indexStatus: 'ready',
      indexError: null,
      indexAttempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(markdown).toBe(`${content}\n`);
    expect(markdown.match(/^---$/gm)).toHaveLength(2);
  });

  it('pageSize 最大 100，关键词最多 500 字', async () => {
    await expect(
      service.search({ query: '部署', pageSize: 101 }),
    ).rejects.toThrow('1..100');
    await expect(service.search({ query: 'a'.repeat(501) })).rejects.toThrow(
      '500 字',
    );
  });
});
