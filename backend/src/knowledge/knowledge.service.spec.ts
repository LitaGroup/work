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
    resolvePathAlias: jest.Mock;
    updateSystemDirectoryTitle: jest.Mock;
    listChildren: jest.Mock;
    createNode: jest.Mock;
    ensureSystemDirectory: jest.Mock;
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
      resolvePathAlias: jest.fn().mockResolvedValue(null),
      updateSystemDirectoryTitle: jest.fn(),
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
      ensureSystemDirectory: jest.fn().mockResolvedValue(undefined),
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
        titleCustomized: false,
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

  it('按机器人 ID 幂等创建专属知识工作区', async () => {
    await service.ensureWorkerWorkspace({ id: 1001 });

    expect(store.ensureSystemDirectory).toHaveBeenCalledWith(
      '/95-workspace/1001',
      '机器人 #1001 工作区',
    );
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

  it('搜索可将系统设计目录从词法与向量候选中排除', async () => {
    await service.search({
      query: '部署',
      excludePaths: ['/99-system'],
    });

    expect(store.search).toHaveBeenCalledWith(
      expect.objectContaining({ excludePaths: ['/99-system'] }),
    );
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

  it('平台内部归档可在新任务目录创建文章，公开创建仍由 guard 拦截', async () => {
    await expect(
      service.createArticleAtPath({
        path: '/98-tasks/20261126/42/API',
        title: '接口文档',
        content: '# API',
      }),
    ).resolves.toBeDefined();
    expect(store.createNode).toHaveBeenCalledWith({
      kind: 'article',
      path: '/98-tasks/20261126/42/API',
      title: '接口文档',
      content: '# API',
    });
  });

  it('旧系统路径通过迁移别名读取当前节点', async () => {
    const current = {
      id: 'n-current',
      kind: 'article',
      path: '/98-tasks/20261028/1/HANDOFF',
      title: '交付文档',
    };
    store.getByPath.mockResolvedValueOnce(null).mockResolvedValueOnce(current);
    store.resolvePathAlias.mockResolvedValue('/98-tasks/20261028/1/HANDOFF');

    const article = await service.readArticle('/task/20261028/TK-0001/HANDOFF');

    expect(store.resolvePathAlias).toHaveBeenCalledWith(
      '/task/20261028/TK-0001/HANDOFF',
    );
    expect(article).toBe(current);
  });

  it('系统级目录只能改名称，不能改名、移动或删除', async () => {
    const root = {
      id: 'sys-task',
      kind: 'directory',
      path: '/98-tasks',
      source: 'system',
      title: '任务记录',
    };
    store.getById.mockResolvedValue(root);
    store.updateSystemDirectoryTitle.mockResolvedValue({
      ...root,
      title: '任务归档',
    });

    await expect(
      service.update(root.id, { title: '任务归档' }),
    ).resolves.toEqual(expect.objectContaining({ title: '任务归档' }));
    await expect(service.update(root.id, { name: 'tasks' })).rejects.toThrow(
      '只能修改名称',
    );
    await expect(service.remove(root.id)).rejects.toThrow('不能删除');
  });

  it('目录浏览可隐藏指定的系统目录', async () => {
    store.getByPath.mockResolvedValueOnce({
      kind: 'directory',
      path: '/',
      title: '知识库',
    });
    store.listChildren.mockResolvedValueOnce({
      path: '/',
      title: '知识库',
      parentPath: null,
      directories: [
        { path: '/99-system', name: '99-system', kind: 'directory' },
        { path: '/guides', name: 'guides', kind: 'directory' },
      ],
      articles: [{ path: '/note', name: 'note', kind: 'article' }],
    });

    const directory = await service.readDirectory('/', {
      excludePaths: ['/99-system'],
    });

    expect(directory.directories.map((node) => node.path)).toEqual(['/guides']);
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
        titleCustomized: boolean;
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
      titleCustomized: false,
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
      titleCustomized: false,
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
      path: '/guides/legacy-summary',
      title: '任务总结',
      content: '# 总结',
    });

    expect(store.createNode).toHaveBeenCalledWith({
      kind: 'article',
      path: '/guides/legacy-summary',
      title: '任务总结',
      content: '# 总结',
    });
    expect(node.id).toBe('n2');
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
      titleCustomized: false,
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
