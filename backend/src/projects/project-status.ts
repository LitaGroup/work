import { BacklogStatus, ProjectStatus } from '../common/enums';

/** 需求池「未排期」保鲜期：创建不超过 30 天为「待分配」，超过为「已关闭」 */
export const UNSCHEDULED_FRESH_DAYS = 30;

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 需求状态推导（读时计算，唯一口径；与飞书「需求状态」字段无关）：
 * - 有未取消迭代项：已完成 → 已发布；其余（等待/执行/测试/发布）→ 开发中；
 * - 无未取消迭代项：创建不超过 30 天 → 待分配；超过 → 已关闭。
 * 迭代项取消后（即使曾完成），按创建时间回到待分配/已关闭。
 */
export function deriveProjectStatus(
  activeBacklogStatus: BacklogStatus | null | undefined,
  createdAt: Date,
  now: Date = new Date(),
): ProjectStatus {
  if (activeBacklogStatus) {
    return activeBacklogStatus === BacklogStatus.COMPLETED
      ? ProjectStatus.PUBLISHED
      : ProjectStatus.IN_PROGRESS;
  }
  return createdAt.getTime() >= now.getTime() - UNSCHEDULED_FRESH_DAYS * DAY_MS
    ? ProjectStatus.PLANNED
    : ProjectStatus.FINISHED;
}
