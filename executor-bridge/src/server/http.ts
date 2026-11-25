/**
 * HTTP + SSE 服务：协议端点路由（见 docs/EXECUTOR_PROTOCOL.md）。
 * - 鉴权：Bearer BRIDGE_TOKEN（未配置令牌时跳过，仅限本机回环场景）。
 * - SSE：/events 全执行器单连接经 EventBus 广播 + 心跳注释行。
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http';
import type { Kernel } from '../kernels/kernel.js';
import { HttpError, SessionManager } from '../core/sessions.js';
import { FileOps } from '../core/files.js';
import { EventBus } from './bus.js';

const PROTOCOL_VERSION = 1;
const BODY_LIMIT = 32 * 1024 * 1024;
/** bridge 自身版本（与内核/Agent 版本分开上报） */
const BRIDGE_VERSION = 'executor-bridge/0.1';

export interface BridgeServerOptions {
  port: number;
  token: string | null;
  kernel: Kernel;
  sessions: SessionManager;
  files: FileOps;
  bus: EventBus;
}

export function startBridgeServer(options: BridgeServerOptions): Server {
  const { port, token, kernel, sessions, files, bus } = options;
  bus.startHeartbeat();

  const server = createServer((req, res) => {
    handle(req, res, { token, kernel, sessions, files, bus }).catch(
      (error) => {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { message: error.message });
          return;
        }
        sendJson(res, 500, {
          message: (error as Error)?.message ?? 'internal error',
        });
      },
    );
  });

  server.listen(port, () => {
    process.stdout.write(
      `[executor-bridge] kernel=${kernel.name} protocol=${PROTOCOL_VERSION} listening on :${port}\n`,
    );
  });
  return server;
}

interface HandlerContext {
  token: string | null;
  kernel: Kernel;
  sessions: SessionManager;
  files: FileOps;
  bus: EventBus;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'GET' && path === '/events') {
    authorize(req, ctx);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const unsubscribe = ctx.bus.subscribe((chunk) => res.write(chunk));
    res.write(': connected\n\n');
    res.on('close', unsubscribe);
    return;
  }

  authorize(req, ctx);

  if (method === 'GET' && path === '/health') {
    sendJson(res, 200, {
      // version 为内核（Agent CLI）自身版本，平台执行器「版本」展示它
      version: await ctx.kernel.version(),
      bridgeVersion: BRIDGE_VERSION,
      protocol: PROTOCOL_VERSION,
      kernel: ctx.kernel.name,
      pid: process.pid,
      urls: [],
      // 并发回合上限由 bridge 统一执行（内核实现不感知），上报实际生效值
      capabilities: {
        ...ctx.kernel.capabilities(),
        maxSessions: ctx.sessions.maxTurns,
      },
    });
    return;
  }
  if (method === 'GET' && path === '/location') {
    sendJson(res, 200, await ctx.kernel.location());
    return;
  }
  if (method === 'GET' && path === '/providers') {
    sendJson(res, 200, await ctx.kernel.providers());
    return;
  }
  if (method === 'GET' && path === '/models') {
    sendJson(res, 200, await ctx.kernel.models());
    return;
  }
  if (method === 'POST' && path === '/sessions') {
    const body = (await readJson(req)) as Record<string, unknown>;
    sendJson(
      res,
      200,
      ctx.sessions.create({
        title: str(body.title),
        model: isModelRef(body.model) ? body.model : undefined,
        agent: str(body.agent),
        location: body.location as { directory: string } | undefined,
      }),
    );
    return;
  }
  if (method === 'GET' && path === '/sessions/active') {
    sendJson(res, 200, ctx.sessions.activeSessions());
    return;
  }

  const sessionMatch = path.match(/^\/sessions\/([^/]+)(?:\/(.*))?$/);
  if (sessionMatch) {
    await handleSession(
      req,
      res,
      ctx,
      decodeURIComponent(sessionMatch[1] ?? ''),
      sessionMatch[2] ?? '',
      url,
      method,
    );
    return;
  }

  if (method === 'POST' && path === '/fs/ensure-dir') {
    const body = (await readJson(req)) as { directory?: string };
    if (!body.directory) throw new HttpError(400, 'directory 不能为空');
    sendJson(res, 200, await ctx.files.ensureDir({ directory: body.directory }));
    return;
  }
  if (method === 'POST' && path === '/fs/write-file') {
    const body = (await readJson(req)) as {
      directory?: string;
      path?: string;
      contentBase64?: string;
      mode?: number;
    };
    if (!body.directory || !body.path || body.contentBase64 === undefined) {
      throw new HttpError(400, 'directory/path/contentBase64 不能为空');
    }
    sendJson(res, 200, await ctx.files.writeFile({
      directory: body.directory,
      path: body.path,
      contentBase64: body.contentBase64,
      mode: body.mode,
    }));
    return;
  }

  if (method === 'POST' && path === '/fs/read-file') {
    const body = (await readJson(req)) as {
      directory?: string;
      path?: string;
    };
    if (!body.directory || !body.path) {
      throw new HttpError(400, 'directory/path 不能为空');
    }
    const result = await ctx.files.readFile({
      directory: body.directory,
      path: body.path,
    });
    if (!result) throw new HttpError(404, 'file not found');
    sendJson(res, 200, result);
    return;
  }

  if (method === 'POST' && path === '/fs/remove-files') {
    const body = (await readJson(req)) as {
      directory?: string;
      paths?: string[];
    };
    if (!body.directory || !Array.isArray(body.paths)) {
      throw new HttpError(400, 'directory/paths 不能为空');
    }
    sendJson(res, 200, await ctx.files.removeFiles({
      directory: body.directory,
      paths: body.paths.map(String),
    }));
    return;
  }

  if (method === 'POST' && path === '/fs/upsert-env') {
    const body = (await readJson(req)) as {
      directory?: string;
      path?: string;
      entries?: Record<string, string>;
    };
    if (!body.directory || !body.path || !body.entries) {
      throw new HttpError(400, 'directory/path/entries 不能为空');
    }
    sendJson(res, 200, await ctx.files.upsertEnv({
      directory: body.directory,
      path: body.path,
      entries: body.entries,
    }));
    return;
  }

  if (method === 'POST' && path === '/fs/copy-dir') {
    const body = (await readJson(req)) as {
      source?: string;
      target?: string;
      exclude?: string[];
    };
    if (!body.source || !body.target) {
      throw new HttpError(400, 'source/target 不能为空');
    }
    sendJson(res, 200, await ctx.files.copyDir({
      source: body.source,
      target: body.target,
      exclude: Array.isArray(body.exclude) ? body.exclude.map(String) : undefined,
    }));
    return;
  }

  if (method === 'POST' && path === '/fs/rm-dir') {
    const body = (await readJson(req)) as { directory?: string };
    if (!body.directory) throw new HttpError(400, 'directory 不能为空');
    sendJson(res, 200, await ctx.files.removeDir({
      directory: body.directory,
    }));
    return;
  }

  throw new HttpError(404, `not found: ${method} ${path}`);
}

async function handleSession(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
  sessionId: string,
  rest: string,
  url: URL,
  method: string,
): Promise<void> {
  if (rest === '' && method === 'GET') {
    sendJson(res, 200, ctx.sessions.state(sessionId));
    return;
  }
  if (rest === '' && method === 'DELETE') {
    ctx.sessions.delete(sessionId);
    ctx.bus.publish('session.deleted', { sessionID: sessionId });
    sendJson(res, 200, { ok: true });
    return;
  }
  if (rest === 'prompt' && method === 'POST') {
    const body = (await readJson(req)) as { text?: string };
    if (!body.text) throw new HttpError(400, 'text 不能为空');
    sendJson(res, 200, ctx.sessions.prompt(sessionId, body.text));
    return;
  }
  if (rest === 'interrupt' && method === 'POST') {
    ctx.sessions.interrupt(sessionId);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (rest === 'wait' && method === 'POST') {
    const timeoutMs = Number(url.searchParams.get('timeoutMs') ?? 30000);
    await ctx.sessions.waitForIdle(sessionId, timeoutMs);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (rest === 'model' && method === 'POST') {
    const body = (await readJson(req)) as { model?: unknown };
    if (!isModelRef(body.model)) throw new HttpError(400, 'model 无效');
    ctx.sessions.setModel(sessionId, body.model);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (rest === 'agent' && method === 'POST') {
    const body = (await readJson(req)) as { agent?: string };
    if (body.agent) ctx.sessions.setAgent(sessionId, body.agent);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (rest === 'questions' && method === 'GET') {
    // v1：内核不支持提问，恒为空（幂等）
    sendJson(res, 200, []);
    return;
  }
  if (/^questions\/[^/]+\/(reply|reject)$/.test(rest) && method === 'POST') {
    await readJson(req);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (/^permission\/[^/]+\/reply$/.test(rest) && method === 'POST') {
    await readJson(req);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (rest === 'messages' && method === 'GET') {
    sendJson(res, 200, ctx.sessions.messages(sessionId));
    return;
  }
  const messageMatch = rest.match(/^messages\/([^/]+)$/);
  if (messageMatch && method === 'GET') {
    sendJson(
      res,
      200,
      ctx.sessions.messageDetail(
        sessionId,
        decodeURIComponent(messageMatch[1] ?? ''),
      ),
    );
    return;
  }
  throw new HttpError(404, `not found: ${method} /sessions/${sessionId}/${rest}`);
}

function authorize(req: IncomingMessage, ctx: HandlerContext): void {
  if (!ctx.token) return;
  const header = req.headers.authorization ?? '';
  if (header !== `Bearer ${ctx.token}`) throw new HttpError(401, 'unauthorized');
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body 不是合法 JSON');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function isModelRef(
  value: unknown,
): value is { id: string; providerID: string; variant?: string } {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.id === 'string' && typeof ref.providerID === 'string';
}
