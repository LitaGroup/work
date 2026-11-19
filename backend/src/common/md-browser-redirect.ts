import { Logger } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { DataSource } from 'typeorm';

/**
 * Agent 视图（`.md`，text/markdown）与人类网页视图是两套 URL。
 * AI 写作时会把它读到的 `.md` 链接带进交付文档，人通过浏览器点开看到的是原始
 * Markdown 而不是网页。这里在“浏览器导航”场景把 `.md` 地址 302 到对应的网页
 * 路由；Agent 请求（带机器人令牌，或没有浏览器导航特征）保持原文返回。
 *
 * 判定规则（全部满足才重定向）：
 * - GET / HEAD，且 `/api/` 下路径以 `.md` 结尾；
 * - 不带 `X-Worker-Token` / `X-Agent-Token` / `?token=`（带令牌一律按 Agent 处理）；
 * - `Sec-Fetch-Mode: navigate`（只有浏览器地址栏与链接点击会发；fetch/curl/
 *   undici/supertest 都不发该值）；老浏览器没有 Sec-Fetch 头时回退
 *   `Accept` 含 `text/html`。
 */

export type MdWebTarget =
  | { kind: 'static'; path: string }
  | { kind: 'defect'; defectId: number }
  | { kind: 'run'; entity: 'checks' | 'tests' | 'exports'; runId: number }
  | { kind: 'task-ticket'; taskId: number; documentsTab: boolean };

/** 需要查库才能拼出网页地址的动态目标（缺陷要项目、运行要脚本、任务要工单） */
export interface MdWebLookup {
  defectProjectId(defectId: number): Promise<number | null>;
  runLocation(
    entity: 'checks' | 'tests' | 'exports',
    runId: number,
  ): Promise<{ projectId: number; scriptId: number } | null>;
  taskTicketId(taskId: number): Promise<number | null>;
}

type HeaderBag = Record<string, string | string[] | undefined>;

function headerValue(headers: HeaderBag, name: string): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** 带机器人/Agent 令牌的请求永不重定向（显式令牌即 Agent 身份） */
export function hasAgentCredentials(
  headers: HeaderBag,
  query: URLSearchParams,
): boolean {
  if (headerValue(headers, 'x-worker-token')) return true;
  if (headerValue(headers, 'x-agent-token')) return true;
  return Boolean(query.get('token'));
}

/** 是否为浏览器导航（地址栏输入或链接点击），而非脚本抓取 */
export function isBrowserNavigation(headers: HeaderBag): boolean {
  const mode = headerValue(headers, 'sec-fetch-mode');
  const dest = headerValue(headers, 'sec-fetch-dest');
  if (mode || dest) return mode === 'navigate' || dest === 'document';
  // 老浏览器（无 Sec-Fetch 头）回退：浏览器导航的 Accept 一定包含 text/html
  return (headerValue(headers, 'accept') ?? '').includes('text/html');
}

function staticTarget(path: string): MdWebTarget {
  return { kind: 'static', path };
}

function positiveInt(value: string): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

const MD_WEB_RULES: Array<{
  pattern: RegExp;
  target: (match: RegExpMatchArray) => MdWebTarget | null;
}> = [
  {
    pattern: /^\/api\/documents\/(\d+)\.md$/,
    target: (m) => staticTarget(`/documents/${m[1]}`),
  },
  {
    pattern: /^\/api\/requirements\/(\d+)\.md$/,
    target: (m) => staticTarget(`/requirements/${m[1]}`),
  },
  {
    pattern: /^\/api\/iterations\/(\d+)\.md$/,
    target: (m) => staticTarget(`/iterations/${m[1]}`),
  },
  {
    pattern: /^\/api\/backlogs\/(\d+)\.md$/,
    target: (m) => staticTarget(`/backlogs/${m[1]}`),
  },
  {
    pattern: /^\/api\/ideas\/(\d+)\.md$/,
    target: (m) => staticTarget(`/ideas/${m[1]}`),
  },
  {
    pattern: /^\/api\/feedbacks\/(\d+)\.md$/,
    target: (m) => staticTarget(`/feedback/${m[1]}`),
  },
  {
    pattern: /^\/api\/topics\/(\d+)\.md$/,
    target: (m) => staticTarget(`/topics/${m[1]}`),
  },
  {
    pattern: /^\/api\/workers\/(\d+)\.md$/,
    target: (m) => staticTarget(`/admin/workers/${m[1]}`),
  },
  {
    pattern: /^\/api\/resources\/(\d+)\.md$/,
    target: () => staticTarget('/resources'),
  },
  {
    pattern: /^\/api\/task-templates\/(\d+)\.md$/,
    target: (m) => staticTarget(`/tasks/definitions/${m[1]}`),
  },
  {
    pattern: /^\/api\/tickets\/(\d+)\.md$/,
    target: (m) => staticTarget(`/tickets/${m[1]}`),
  },
  {
    pattern: /^\/api\/tasks\/(\d+)\.md$/,
    target: (m) => staticTarget(`/tasks/${m[1]}`),
  },
  {
    pattern: /^\/api\/tasks\/(\d+)\/handoff\.md$/,
    target: (m) => staticTarget(`/tasks/${m[1]}#handoff`),
  },
  {
    pattern: /^\/api\/tasks\/(\d+)\/documents\.md$/,
    target: (m) => staticTarget(`/tasks/${m[1]}#documents`),
  },
  {
    pattern: /^\/api\/tasks\/(\d+)\/ticket\.md$/,
    target: (m) => {
      const taskId = positiveInt(m[1]);
      return taskId
        ? { kind: 'task-ticket', taskId, documentsTab: false }
        : null;
    },
  },
  {
    pattern: /^\/api\/tasks\/(\d+)\/ticket-documents(?:\/\d+)?\.md$/,
    target: (m) => {
      const taskId = positiveInt(m[1]);
      return taskId
        ? { kind: 'task-ticket', taskId, documentsTab: true }
        : null;
    },
  },
  {
    pattern: /^\/api\/defects\/(\d+)\.md$/,
    target: (m) => {
      const defectId = positiveInt(m[1]);
      return defectId ? { kind: 'defect', defectId } : null;
    },
  },
  {
    pattern: /^\/api\/checks\/runs\/(\d+)\.md$/,
    target: (m) => {
      const runId = positiveInt(m[1]);
      return runId ? { kind: 'run', entity: 'checks', runId } : null;
    },
  },
  {
    pattern: /^\/api\/tests\/runs\/(\d+)\.md$/,
    target: (m) => {
      const runId = positiveInt(m[1]);
      return runId ? { kind: 'run', entity: 'tests', runId } : null;
    },
  },
  {
    pattern: /^\/api\/exports\/runs\/(\d+)\.md$/,
    target: (m) => {
      const runId = positiveInt(m[1]);
      return runId ? { kind: 'run', entity: 'exports', runId } : null;
    },
  },
];

/**
 * 把 Agent `.md` 地址映射为网页地址（未命中返回 null，保持 Markdown 原样）。
 * 工具型端点（`search.md` / `defines.md` / 各类清单 `*.md` 等）不映射。
 */
export function matchMdWebTarget(pathname: string): MdWebTarget | null {
  // 知识库：/api/docs/detail{path}.md → /docs/detail{path}；
  // 目录视图 /api/docs/detail{path}/.md → /docs/detail{path}/
  if (
    pathname === '/api/docs/detail' ||
    pathname.startsWith('/api/docs/detail/')
  ) {
    if (!pathname.endsWith('.md')) return null;
    const rest = pathname.slice('/api/docs/detail'.length);
    if (rest.endsWith('/.md')) {
      return staticTarget(`/docs/detail${rest.slice(0, -4)}/`);
    }
    return staticTarget(`/docs/detail${rest.slice(0, -3)}`);
  }

  for (const rule of MD_WEB_RULES) {
    const match = rule.pattern.exec(pathname);
    if (match) return rule.target(match);
  }
  return null;
}

/** 结合查库结果解析最终网页地址；目标不存在时返回 null（回退原始 Markdown） */
export async function resolveMdWebPath(
  pathname: string,
  lookup: MdWebLookup,
): Promise<string | null> {
  const target = matchMdWebTarget(pathname);
  if (!target) return null;
  if (target.kind === 'static') return target.path;

  if (target.kind === 'defect') {
    const projectId = await lookup.defectProjectId(target.defectId);
    return projectId
      ? `/projects/${projectId}/defects/${target.defectId}`
      : null;
  }

  if (target.kind === 'run') {
    const located = await lookup.runLocation(target.entity, target.runId);
    return located
      ? `/projects/${located.projectId}/${target.entity}/${located.scriptId}`
      : null;
  }

  const ticketId = await lookup.taskTicketId(target.taskId);
  if (ticketId) {
    return `/tickets/${ticketId}${target.documentsTab ? '#documents' : ''}`;
  }
  return `/tasks/${target.taskId}${target.documentsTab ? '#documents' : ''}`;
}

/** 运行时查库实现：只为缺陷 / 运行记录 / 任务工单三类动态目标发一次轻量查询 */
export function createMdWebLookup(dataSource: DataSource): MdWebLookup {
  return {
    async defectProjectId(defectId: number): Promise<number | null> {
      const rows: Array<{ projectId: number }> = await dataSource.query(
        'select "projectId" from defects where id = $1',
        [defectId],
      );
      return rows[0] ? Number(rows[0].projectId) : null;
    },

    async runLocation(
      entity: 'checks' | 'tests' | 'exports',
      runId: number,
    ): Promise<{ projectId: number; scriptId: number } | null> {
      const config = {
        checks: { runTable: 'check_runs', fk: 'checkId', parent: 'checks' },
        tests: { runTable: 'test_runs', fk: 'testId', parent: 'tests' },
        exports: {
          runTable: 'export_runs',
          fk: 'exportId',
          parent: 'exports',
        },
      }[entity];
      const rows: Array<{ scriptId: number; projectId: number }> =
        await dataSource.query(
          `select r."${config.fk}" as "scriptId", p."projectId" as "projectId"
           from ${config.runTable} r
           join ${config.parent} p on p.id = r."${config.fk}"
          where r.id = $1`,
          [runId],
        );
      const row = rows[0];
      return row
        ? { projectId: Number(row.projectId), scriptId: Number(row.scriptId) }
        : null;
    },

    async taskTicketId(taskId: number): Promise<number | null> {
      const direct: Array<{ id: number }> = await dataSource.query(
        'select id from tickets where "taskId" = $1 limit 1',
        [taskId],
      );
      if (direct[0]) return Number(direct[0].id);

      const runs: Array<{ ticketId: number }> = await dataSource.query(
        'select "ticketId" from ticket_workflow_runs where "taskId" = $1 order by id desc limit 1',
        [taskId],
      );
      return runs[0] ? Number(runs[0].ticketId) : null;
    },
  };
}

/** 中间件主体（与 Express 解耦的版本，便于单测） */
export function createMdBrowserRedirectHandler(
  lookup: MdWebLookup,
): RequestHandler {
  const logger = new Logger('MdBrowserRedirect');

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const url = req.originalUrl ?? req.url ?? '';
    const queryIndex = url.indexOf('?');
    const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
    const search = queryIndex === -1 ? '' : url.slice(queryIndex + 1);

    if (!pathname.startsWith('/api/') || !pathname.endsWith('.md')) {
      next();
      return;
    }
    if (hasAgentCredentials(req.headers, new URLSearchParams(search))) {
      next();
      return;
    }
    if (!isBrowserNavigation(req.headers)) {
      next();
      return;
    }

    resolveMdWebPath(pathname, lookup)
      .then((target) => {
        if (!target) {
          next();
          return;
        }
        // 丢弃原查询串（避免令牌进入地址栏/历史记录），并禁止缓存重定向
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(302, target);
      })
      .catch((error: unknown) => {
        logger.warn(
          `.md 网页重定向失败，回退原始 Markdown：${pathname} ${String(error)}`,
        );
        next();
      });
  };
}

/** main.ts 注册用：把查库能力注入中间件 */
export function createMdBrowserRedirectMiddleware(
  dataSource: DataSource,
): RequestHandler {
  return createMdBrowserRedirectHandler(createMdWebLookup(dataSource));
}
