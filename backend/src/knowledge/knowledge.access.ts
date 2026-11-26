import { ForbiddenException } from '@nestjs/common';
import type { AccessIdentity } from '../auth/worker-access';
import { resolveAccessLevel } from '../auth/worker-access';
import { WorkerAccessLevel } from '../common/enums';
import { isKnowledgePathWithin } from './knowledge.path';

/** 系统设计与配置镜像仅管理员可读；普通知识仍对所有登录身份开放 */
export const SYSTEM_KNOWLEDGE_ACL_ROOT = '/99-system';

export function isSystemKnowledgeAdmin(identity: AccessIdentity): boolean {
  return resolveAccessLevel(identity) === WorkerAccessLevel.ADMIN;
}

export function assertCanReadSystemKnowledge(
  identity: AccessIdentity,
  path: string,
): void {
  if (
    isKnowledgePathWithin(path, SYSTEM_KNOWLEDGE_ACL_ROOT) &&
    !isSystemKnowledgeAdmin(identity)
  ) {
    throw new ForbiddenException('系统设计知识仅管理员可访问');
  }
}

export function assertCanManageSystemKnowledge(
  identity: AccessIdentity,
  path: string | undefined,
): void {
  if (!path?.trim()) return;
  if (
    isKnowledgePathWithin(path, SYSTEM_KNOWLEDGE_ACL_ROOT) &&
    !isSystemKnowledgeAdmin(identity)
  ) {
    throw new ForbiddenException('系统设计知识仅管理员可维护');
  }
}

/** 非管理员浏览、搜索时隐藏整个系统设计目录 */
export function knowledgeSearchExcludes(identity: AccessIdentity): string[] {
  return isSystemKnowledgeAdmin(identity) ? [] : [SYSTEM_KNOWLEDGE_ACL_ROOT];
}
