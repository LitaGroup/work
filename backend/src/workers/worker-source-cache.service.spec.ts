import { WorkerSourceCacheService } from './worker-source-cache.service';

const okResponse = (content: string): Promise<Response> =>
  Promise.resolve(
    new Response(Buffer.from(content, 'utf8'), {
      status: 200,
    }),
  );

describe('WorkerSourceCacheService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('同一 URL 命中缓存，并发请求只下载一次', async () => {
    const service = new WorkerSourceCacheService();
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => okResponse('content'));
    const [first, second] = await Promise.all([
      service.get('http://gitea/skill.md', 'http://gitea/skill.md@sha1'),
      service.get('http://gitea/skill.md', 'http://gitea/skill.md@sha1'),
    ]);
    expect(Buffer.from(first).toString()).toBe('content');
    expect(Buffer.from(second).toString()).toBe('content');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await service.get('http://gitea/skill.md', 'http://gitea/skill.md@sha1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('同一分支正文更新后按新 blob SHA 重新下载', async () => {
    const service = new WorkerSourceCacheService();
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => okResponse('v1'))
      .mockImplementationOnce(() => okResponse('v2'));
    const first = await service.get(
      'http://gitea/skill.md',
      'http://gitea/skill.md@sha1',
    );
    const second = await service.get(
      'http://gitea/skill.md',
      'http://gitea/skill.md@sha2',
    );
    expect(Buffer.from(first).toString()).toBe('v1');
    expect(Buffer.from(second).toString()).toBe('v2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
