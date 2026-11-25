import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '../common/enums';
import type { AuthedRequest } from './auth.guard';

/**
 * 管理接口鉴权：仅管理员可执行。
 * 公共 Agent 虚拟用户 role=管理员；机器人令牌需绑定真人且该真人 role=管理员
 * （AI 机器人令牌没有 user，一律拒绝）。
 */
export function requireAdmin(req: AuthedRequest): void {
  if (req.user?.role !== UserRole.ADMIN) {
    throw new ForbiddenException('仅管理员可执行该操作');
  }
}
