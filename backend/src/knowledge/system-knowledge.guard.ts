import { ForbiddenException } from '@nestjs/common';
import {
  isSystemKnowledgeRoot,
  isSystemManagedKnowledgePath,
} from './knowledge.path';

/**
 * 系统知识路径由对应业务模块维护：
 * - `/98-tasks/**` 任务交付、复盘与任务文档走任务中心；
 * - `/01-backlogs/**` 需求文档走文档模块；
 * - `/99-system/workers|task-definitions|evaluations/**` 为配置只读镜像；
 * - `/task/**`、`/project/**` 为旧路径，保留只读与重定向，禁止重新写入。
 */
export function assertSystemKnowledgeWritable(
  ...paths: Array<string | undefined>
): void {
  for (const raw of paths) {
    if (!raw?.trim()) continue;
    if (!isSystemManagedKnowledgePath(raw)) continue;
    throw new ForbiddenException(
      '系统知识目录由对应业务流程维护，请通过任务、需求文档或管理页面修改',
    );
  }
}

/** 兼容旧调用点：任务文档保护规则已统一为系统知识保护 */
export function assertTaskDocumentWritable(
  ...paths: Array<string | undefined>
): void {
  assertSystemKnowledgeWritable(...paths);
}

/** 系统根目录只允许改标题，禁止改名、移动、改正文和删除 */
export function assertSystemRootMetadataChange(input: {
  path: string;
  title?: string;
  content?: string;
  name?: string;
  parentPath?: string;
}): void {
  if (!isSystemKnowledgeRoot(input.path)) return;
  if (
    input.content !== undefined ||
    input.name !== undefined ||
    input.parentPath !== undefined
  ) {
    throw new ForbiddenException(
      '系统级目录路径固定，只能修改名称（title），不能移动、改名或编辑正文',
    );
  }
}

export function assertSystemRootRemovable(path: string): void {
  if (isSystemKnowledgeRoot(path)) {
    throw new ForbiddenException('系统级目录不能删除');
  }
}
