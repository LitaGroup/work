import { ForbiddenException } from '@nestjs/common';
import { WorkerAccessLevel } from '../common/enums';
import type { AuthedRequest } from './auth.guard';
import { resolveAccessLevel } from './worker-access';

/**
 * 管理接口鉴权：仅管理员可执行。
 * 权限来源：公共 Agent / 管理员真人机器人 / AI 机器人 accessLevel=管理员。
 */
export function requireAdmin(req: AuthedRequest): void {
  if (resolveAccessLevel(req) !== WorkerAccessLevel.ADMIN) {
    throw new ForbiddenException('仅管理员可执行该操作');
  }
}
