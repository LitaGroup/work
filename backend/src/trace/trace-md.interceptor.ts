import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { AuthedRequest } from '../auth/auth.guard';
import { TraceService } from './trace.service';

/**
 * .md 端点执行记录拦截（TECH_DESIGN 12.4，channel=md）：
 * 机器人令牌请求且命中任务窗口时记录一次 platform_call（工具=方法+路径，返回=Markdown 正文）。
 * 评估令牌的 taskId 从 evalContext 明确归属。
 */
@Injectable()
export class TraceMdInterceptor implements NestInterceptor {
  constructor(private readonly trace: TraceService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const worker = req.worker;
    const pathname = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (!worker || !pathname.endsWith('.md')) return next.handle();
    // 评估判定会话不采集（12.2 判定会话只对管理员可见的可选采集，阶段一暂不采集）
    if (req.evalContext?.judge) return next.handle();
    const startedAt = Date.now();
    const record = (status: 'ok' | 'error', content: string) => {
      void this.trace
        .recordPlatformCall({
          workerId: worker.id,
          channel: 'md',
          tool: `${req.method} ${pathname}`,
          args: bodyOf(req),
          status,
          content,
          durationMs: Date.now() - startedAt,
          evalItemId: req.evalContext?.evalItemId ?? null,
          evalTaskId: req.evalContext?.taskId ?? null,
          taskId: taskIdOfPath(pathname) ?? taskIdOfBody(req),
        })
        .catch(() => {});
    };
    return next.handle().pipe(
      tap({
        next: (value) => {
          if (typeof value === 'string') {
            record('ok', value);
          } else {
            record('ok', '');
          }
        },
        error: (error: unknown) => {
          record(
            'error',
            error instanceof Error ? error.message : String(error),
          );
        },
      }),
    );
  }
}

/** 请求体（JSON 或空） */
function bodyOf(req: AuthedRequest): unknown {
  const body = (req as unknown as { body?: unknown }).body;
  return body ?? null;
}

/** 路径中的任务 ID：/api/tasks/{id}... */
function taskIdOfPath(pathname: string): number | null {
  const match = /^\/api\/tasks\/(\d+)(?:\/|\.md|$)/.exec(pathname);
  return match ? Number(match[1]) : null;
}

/** 请求体中的 taskId */
function taskIdOfBody(req: AuthedRequest): number | null {
  const body = (req as unknown as { body?: Record<string, unknown> }).body;
  const value = body?.taskId;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}
