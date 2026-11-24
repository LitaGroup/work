import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { AuthedRequest } from '../auth/auth.guard';
import { EvalShieldService } from './eval-shield.service';

/**
 * 评估模式 .md 端点拦截：请求挂载 evalContext 时按 9.4 权限策略分类，
 * 写操作（创建/更新/删除、子任务、对外发送等）直接拒绝。
 */
@Injectable()
export class EvalMdInterceptor implements NestInterceptor {
  constructor(private readonly shield: EvalShieldService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const ctx = req.evalContext;
    if (ctx) {
      const pathname = (req.originalUrl ?? req.url ?? '').split('?')[0];
      if (pathname.endsWith('.md')) {
        const result = this.shield.checkMd(ctx, req.method, pathname);
        if (result.blocked) {
          throw new ForbiddenException(
            result.reason || '评估模式下不允许此操作',
          );
        }
      }
    }
    return next.handle();
  }
}
