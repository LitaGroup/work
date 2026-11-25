import { ForbiddenException } from '@nestjs/common';
import { UserRole, WorkerAccessLevel } from '../common/enums';

/**
 * 权限判定所需的最小身份结构：AuthedRequest（`.md` 接口）与
 * McpWorkPrincipal（MCP 工具）都满足该结构。
 */
export interface AccessIdentity {
  user?: { role?: UserRole | string | null } | null;
  worker?: {
    humanUserId?: number | null;
    personalAgentUserId?: number | null;
    accessLevel?: WorkerAccessLevel | null;
  } | null;
}

/**
 * 解析平台访问级别：
 * - 登录真人 / 公共 Agent 为管理员 → 管理员；
 * - 真人机器人、个人 AGENT → 跟随绑定真人（成员为普通，不存在「无权限」）；
 * - 纯 AI 机器人 → 自身 accessLevel（默认普通）。
 */
export function resolveAccessLevel(
  identity: AccessIdentity,
): WorkerAccessLevel {
  if (identity.user?.role === UserRole.ADMIN) {
    return WorkerAccessLevel.ADMIN;
  }
  const worker = identity.worker;
  if (
    worker &&
    (worker.humanUserId != null || worker.personalAgentUserId != null)
  ) {
    return WorkerAccessLevel.NORMAL;
  }
  return worker?.accessLevel ?? WorkerAccessLevel.NORMAL;
}

/** MCP 调用前置校验：「无权限」机器人禁止调用全部 MCP 端点 */
export function assertMcpAccess(identity: AccessIdentity): void {
  if (resolveAccessLevel(identity) === WorkerAccessLevel.NONE) {
    throw new ForbiddenException(
      '该机器人平台访问级别为「无权限」，禁止调用 MCP（可在机器人配置页调整）',
    );
  }
}
