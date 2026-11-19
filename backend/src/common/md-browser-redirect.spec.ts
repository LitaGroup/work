import type { Request, Response } from 'express';
import {
  createMdBrowserRedirectHandler,
  hasAgentCredentials,
  isBrowserNavigation,
  matchMdWebTarget,
  resolveMdWebPath,
  type MdWebLookup,
} from './md-browser-redirect';

describe('isBrowserNavigation', () => {
  it('Sec-Fetch-Mode: navigate 视为浏览器导航', () => {
    expect(isBrowserNavigation({ 'sec-fetch-mode': 'navigate' })).toBe(true);
  });

  it('脚本抓取（cors / no-cors / same-origin）不视为浏览器导航', () => {
    expect(isBrowserNavigation({ 'sec-fetch-mode': 'cors' })).toBe(false);
    expect(isBrowserNavigation({ 'sec-fetch-mode': 'no-cors' })).toBe(false);
    expect(isBrowserNavigation({ 'sec-fetch-mode': 'same-origin' })).toBe(
      false,
    );
  });

  it('仅有 Sec-Fetch-Dest 时按 document 判定', () => {
    expect(isBrowserNavigation({ 'sec-fetch-dest': 'document' })).toBe(true);
    expect(isBrowserNavigation({ 'sec-fetch-dest': 'empty' })).toBe(false);
  });

  it('老浏览器无 Sec-Fetch 头时回退 Accept', () => {
    expect(
      isBrowserNavigation({
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }),
    ).toBe(true);
    expect(isBrowserNavigation({ accept: '*/*' })).toBe(false);
    expect(isBrowserNavigation({})).toBe(false);
  });
});

describe('hasAgentCredentials', () => {
  it('机器人 / Agent 令牌头均视为 Agent 请求', () => {
    expect(
      hasAgentCredentials({ 'x-worker-token': 'w1' }, new URLSearchParams()),
    ).toBe(true);
    expect(
      hasAgentCredentials({ 'x-agent-token': 'a1' }, new URLSearchParams()),
    ).toBe(true);
  });

  it('?token= 视为 Agent 请求', () => {
    expect(hasAgentCredentials({}, new URLSearchParams('token=t1'))).toBe(true);
  });

  it('无令牌时不是 Agent 请求', () => {
    expect(hasAgentCredentials({}, new URLSearchParams())).toBe(false);
    expect(hasAgentCredentials({}, new URLSearchParams('a=1'))).toBe(false);
  });
});

describe('matchMdWebTarget', () => {
  it.each([
    ['/api/documents/12.md', '/documents/12'],
    ['/api/requirements/7.md', '/requirements/7'],
    ['/api/iterations/3.md', '/iterations/3'],
    ['/api/backlogs/9.md', '/backlogs/9'],
    ['/api/ideas/5.md', '/ideas/5'],
    ['/api/feedbacks/8.md', '/feedback/8'],
    ['/api/topics/15.md', '/topics/15'],
    ['/api/workers/1001.md', '/admin/workers/1001'],
    ['/api/resources/4.md', '/resources'],
    ['/api/task-templates/6.md', '/tasks/definitions/6'],
    ['/api/tickets/21.md', '/tickets/21'],
    ['/api/tasks/30.md', '/tasks/30'],
    ['/api/tasks/30/handoff.md', '/tasks/30#handoff'],
    ['/api/tasks/30/documents.md', '/tasks/30#documents'],
  ])('%s → %s', (pathname, expected) => {
    const target = matchMdWebTarget(pathname);
    expect(target).toEqual({ kind: 'static', path: expected });
  });

  it('知识库文章与目录映射到网页浏览地址', () => {
    expect(
      matchMdWebTarget('/api/docs/detail/task/20261119/TK-0410/API.md'),
    ).toEqual({
      kind: 'static',
      path: '/docs/detail/task/20261119/TK-0410/API',
    });
    expect(
      matchMdWebTarget('/api/docs/detail/task/20261119/TK-0410/.md'),
    ).toEqual({ kind: 'static', path: '/docs/detail/task/20261119/TK-0410/' });
    expect(matchMdWebTarget('/api/docs/detail/.md')).toEqual({
      kind: 'static',
      path: '/docs/detail/',
    });
  });

  it('动态目标（缺陷 / 运行记录 / 任务工单视图）', () => {
    expect(matchMdWebTarget('/api/defects/11.md')).toEqual({
      kind: 'defect',
      defectId: 11,
    });
    expect(matchMdWebTarget('/api/checks/runs/5.md')).toEqual({
      kind: 'run',
      entity: 'checks',
      runId: 5,
    });
    expect(matchMdWebTarget('/api/tests/runs/6.md')).toEqual({
      kind: 'run',
      entity: 'tests',
      runId: 6,
    });
    expect(matchMdWebTarget('/api/exports/runs/7.md')).toEqual({
      kind: 'run',
      entity: 'exports',
      runId: 7,
    });
    expect(matchMdWebTarget('/api/tasks/30/ticket.md')).toEqual({
      kind: 'task-ticket',
      taskId: 30,
      documentsTab: false,
    });
    expect(matchMdWebTarget('/api/tasks/30/ticket-documents/2.md')).toEqual({
      kind: 'task-ticket',
      taskId: 30,
      documentsTab: true,
    });
  });

  it('工具型端点与清单视图不映射', () => {
    expect(matchMdWebTarget('/api/docs/search.md')).toBeNull();
    expect(matchMdWebTarget('/api/tasks/defines.md')).toBeNull();
    expect(matchMdWebTarget('/api/tasks/30/recognize.md')).toBeNull();
    expect(matchMdWebTarget('/api/requirements/search.md')).toBeNull();
    expect(matchMdWebTarget('/api/tasks.md')).toBeNull();
    expect(matchMdWebTarget('/api/defects.md')).toBeNull();
    expect(matchMdWebTarget('/api/workers.md')).toBeNull();
    expect(matchMdWebTarget('/api/settings.md')).toBeNull();
    expect(matchMdWebTarget('/api/feishu/read.md')).toBeNull();
    expect(matchMdWebTarget('/api/documents/abc.md')).toBeNull();
    expect(matchMdWebTarget('/api/documents/12')).toBeNull();
  });
});

describe('resolveMdWebPath', () => {
  const lookup: MdWebLookup = {
    defectProjectId: jest.fn((id: number) =>
      Promise.resolve(id === 11 ? 22 : null),
    ),
    runLocation: jest.fn((_entity, id: number) =>
      Promise.resolve(id === 5 ? { projectId: 22, scriptId: 33 } : null),
    ),
    taskTicketId: jest.fn((id: number) =>
      Promise.resolve(id === 30 ? 44 : null),
    ),
  };

  it('静态目标直接返回网页地址', async () => {
    await expect(
      resolveMdWebPath('/api/tasks/30/handoff.md', lookup),
    ).resolves.toBe('/tasks/30#handoff');
  });

  it('缺陷解析到项目缺陷详情', async () => {
    await expect(resolveMdWebPath('/api/defects/11.md', lookup)).resolves.toBe(
      '/projects/22/defects/11',
    );
    await expect(
      resolveMdWebPath('/api/defects/99.md', lookup),
    ).resolves.toBeNull();
  });

  it('运行记录解析到项目运行页', async () => {
    await expect(
      resolveMdWebPath('/api/checks/runs/5.md', lookup),
    ).resolves.toBe('/projects/22/checks/33');
    await expect(
      resolveMdWebPath('/api/tests/runs/6.md', lookup),
    ).resolves.toBeNull();
  });

  it('任务工单视图优先跳工单详情，无工单回退任务详情', async () => {
    await expect(
      resolveMdWebPath('/api/tasks/30/ticket.md', lookup),
    ).resolves.toBe('/tickets/44');
    await expect(
      resolveMdWebPath('/api/tasks/30/ticket-documents.md', lookup),
    ).resolves.toBe('/tickets/44#documents');
    await expect(
      resolveMdWebPath('/api/tasks/31/ticket-documents.md', lookup),
    ).resolves.toBe('/tasks/31#documents');
  });

  it('未映射路径返回 null', async () => {
    await expect(resolveMdWebPath('/api/tasks.md', lookup)).resolves.toBeNull();
  });
});

describe('createMdBrowserRedirectHandler', () => {
  const lookup: MdWebLookup = {
    defectProjectId: () => Promise.resolve(22),
    runLocation: () => Promise.resolve({ projectId: 22, scriptId: 33 }),
    taskTicketId: () => Promise.resolve(44),
  };

  function run(
    headers: Record<string, string>,
    url: string,
    method = 'GET',
  ): { redirect: jest.Mock; next: jest.Mock; setHeader: jest.Mock } {
    const handler = createMdBrowserRedirectHandler(lookup);
    const redirect = jest.fn();
    const setHeader = jest.fn();
    const next = jest.fn();
    handler(
      { method, originalUrl: url, url, headers } as unknown as Request,
      { redirect, setHeader } as unknown as Response,
      next,
    );
    return { redirect, next, setHeader };
  }

  // 等待中间件内部的异步解析完成
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('浏览器导航打开 .md 时 302 到网页视图，并禁止缓存', async () => {
    const { redirect, next, setHeader } = run(
      { 'sec-fetch-mode': 'navigate' },
      '/api/tasks/30/handoff.md',
    );
    await flush();
    expect(redirect).toHaveBeenCalledWith(302, '/tasks/30#handoff');
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(next).not.toHaveBeenCalled();
  });

  it('带机器人令牌的请求保持原始 Markdown', async () => {
    const { redirect, next } = run(
      { 'sec-fetch-mode': 'navigate', 'x-worker-token': 'w1' },
      '/api/tasks/30.md',
    );
    await flush();
    expect(redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('?token= 的请求保持原始 Markdown', async () => {
    const { redirect, next } = run(
      { 'sec-fetch-mode': 'navigate' },
      '/api/docs/detail/task/20261119/TK-0410/API.md?token=abc',
    );
    await flush();
    expect(redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('脚本抓取（非浏览器导航）不重定向', async () => {
    const { redirect, next } = run({ accept: '*/*' }, '/api/tasks/30.md');
    await flush();
    expect(redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('非 GET/HEAD 与未映射路径直接放行', async () => {
    expect(
      run({ 'sec-fetch-mode': 'navigate' }, '/api/tasks/30.md', 'POST')
        .redirect,
    ).not.toHaveBeenCalled();
    const { redirect, next } = run(
      { 'sec-fetch-mode': 'navigate' },
      '/api/tasks.md',
    );
    await flush();
    expect(redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('动态目标查询失败时回退原始 Markdown', async () => {
    const handler = createMdBrowserRedirectHandler({
      defectProjectId: () => Promise.reject(new Error('db down')),
      runLocation: () => Promise.resolve(null),
      taskTicketId: () => Promise.resolve(null),
    });
    const redirect = jest.fn();
    const next = jest.fn();
    handler(
      {
        method: 'GET',
        originalUrl: '/api/defects/11.md',
        url: '/api/defects/11.md',
        headers: { 'sec-fetch-mode': 'navigate' },
      } as unknown as Request,
      { redirect, setHeader: jest.fn() } as unknown as Response,
      next,
    );
    await flush();
    expect(redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
