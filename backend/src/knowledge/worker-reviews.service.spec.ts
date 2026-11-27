import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import type { Worker } from '../workers/worker.entity';
import type { KnowledgeService } from './knowledge.service';
import type { KnowledgeNode } from './knowledge.types';
import type { KnowledgeStore } from './knowledge.store';
import { WorkerReviewsService } from './worker-reviews.service';

function node(over: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id: 'n1',
    kind: 'article',
    path: '/95-workspace/1001/reviews/20261126003005',
    parentPath: '/95-workspace/1001/reviews',
    name: '20261126003005',
    title: '复盘 2026-11-26 00:30:05',
    content: '## 经验\n\n先确认接口版本。',
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
    createdAt: new Date('2026-11-25T16:30:05Z'),
    updatedAt: new Date('2026-11-25T16:30:05Z'),
    ...over,
  };
}

function buildService(config: Record<string, string> = {}): {
  service: WorkerReviewsService;
  knowledge: {
    ensureWorkerWorkspace: jest.Mock;
    createArticleAtPath: jest.Mock;
    readArticle: jest.Mock;
    update: jest.Mock;
    isEnabled: boolean;
  };
  store: {
    listWorkerReviewSummaries: jest.Mock;
    removeExpiredWorkerReviewArticles: jest.Mock;
    isEnabled: boolean;
  };
  workers: { findOne: jest.Mock };
} {
  const knowledge = {
    ensureWorkerWorkspace: jest.fn().mockResolvedValue(undefined),
    createArticleAtPath: jest.fn().mockResolvedValue(node()),
    readArticle: jest.fn().mockResolvedValue(node()),
    update: jest.fn().mockResolvedValue(node({ title: '新标题' })),
    isEnabled: true,
  };
  const store = {
    listWorkerReviewSummaries: jest.fn().mockResolvedValue([]),
    removeExpiredWorkerReviewArticles: jest.fn().mockResolvedValue(0),
    isEnabled: true,
  };
  const workers = {
    findOne: jest.fn().mockResolvedValue({ id: 1001, name: '测试机器人' }),
  };
  const service = new WorkerReviewsService(
    {
      get: jest.fn(
        (key: string) =>
          config[
            key as
              'WORKER_REVIEWS_CLEANUP_ENABLED' | 'WORKER_REVIEWS_RETENTION_DAYS'
          ],
      ),
    } as unknown as ConfigService,
    knowledge as unknown as KnowledgeService,
    store as unknown as KnowledgeStore,
    workers as unknown as Repository<Worker>,
  );
  return { service, knowledge, store, workers };
}

describe('WorkerReviewsService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('按北京时间生成 14 位名称并保存到机器人 reviews 目录', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-25T16:30:05Z'));
    const { service, knowledge } = buildService();

    const created = await service.create(1001, {
      content: '## 经验\n\n先确认接口版本。',
    });

    expect(knowledge.ensureWorkerWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1001 }),
    );
    expect(knowledge.createArticleAtPath).toHaveBeenCalledWith({
      path: '/95-workspace/1001/reviews/20261126003005',
      title: '复盘 2026-11-26 00:30:05',
      content: '## 经验\n\n先确认接口版本。',
    });
    expect(created.name).toBe('20261126003005');
    expect(created.readUrl).toBe(
      '/api/docs/detail/95-workspace/1001/reviews/20261126003005.md',
    );
    expect(created.webUrl).toBe(
      '/docs/detail/95-workspace/1001/reviews/20261126003005',
    );
  });

  it('同一秒路径冲突时顺延到下一可用秒，不覆盖已有复盘', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-25T16:30:05Z'));
    const { service, knowledge } = buildService();
    knowledge.createArticleAtPath
      .mockRejectedValueOnce(
        new BadRequestException(
          '路径 /95-workspace/1001/reviews/20261126003005 已存在',
        ),
      )
      .mockResolvedValueOnce(
        node({
          path: '/95-workspace/1001/reviews/20261126003006',
          name: '20261126003006',
          title: '复盘 2026-11-26 00:30:06',
        }),
      );

    const created = await service.create(1001, { content: '经验' });

    expect(created.name).toBe('20261126003006');
    expect(knowledge.createArticleAtPath).toHaveBeenCalledTimes(2);
    const calls = knowledge.createArticleAtPath.mock.calls as Array<
      [{ path: string }]
    >;
    expect(calls[1][0].path).toBe('/95-workspace/1001/reviews/20261126003006');
  });

  it('清单分页多取一条判断 hasMore，并把时间范围传给存储层', async () => {
    const { service, store } = buildService();
    store.listWorkerReviewSummaries.mockResolvedValue([
      node({ name: '20261126003005' }),
      node({ name: '20261126003004' }),
      node({ name: '20261126003003' }),
    ]);

    const page = await service.list(1001, {
      page: 2,
      pageSize: 2,
      from: '2026-11-01T00:00:00Z',
      to: '2026-12-01T00:00:00Z',
    });

    expect(store.listWorkerReviewSummaries).toHaveBeenCalledWith({
      workerId: 1001,
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-12-01T00:00:00Z'),
      offset: 2,
      limit: 3,
    });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });

  it('读取与修改只接受合法时间戳和目标机器人的复盘路径', async () => {
    const { service, knowledge } = buildService();

    await expect(service.read(1001, '../other')).rejects.toThrow(
      '复盘名称必须是 14 位时间戳',
    );
    knowledge.readArticle.mockResolvedValueOnce(
      node({ path: '/95-workspace/1002/reviews/20261126003005' }),
    );
    await expect(service.read(1001, '20261126003005')).rejects.toThrow(
      '不能通过复盘接口操作',
    );

    await service.update(1001, '20261126003005', { content: '更新后的正文' });
    expect(knowledge.update).toHaveBeenCalledWith('n1', {
      title: undefined,
      content: '更新后的正文',
    });
  });

  it('默认不执行到期清理', async () => {
    const { service, store } = buildService();

    await service.cleanupExpired();

    expect(store.removeExpiredWorkerReviewArticles).not.toHaveBeenCalled();
  });

  it('开启清理后按 365 天边界分批删除', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-27T00:00:00Z'));
    const { service, store } = buildService({
      WORKER_REVIEWS_CLEANUP_ENABLED: 'true',
      WORKER_REVIEWS_RETENTION_DAYS: '365',
    });

    await service.cleanupExpired();

    expect(store.removeExpiredWorkerReviewArticles).toHaveBeenCalledWith(
      new Date('2025-11-27T00:00:00Z'),
      200,
    );
  });
});
