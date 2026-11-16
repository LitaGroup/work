import { BacklogStatus, ProjectStatus } from '../common/enums';
import {
  DAY_MS,
  UNSCHEDULED_FRESH_DAYS,
  deriveProjectStatus,
} from './project-status';

describe('deriveProjectStatus（需求状态推导）', () => {
  const now = new Date('2026-11-16T12:00:00+08:00');
  const fresh = new Date(now.getTime() - 10 * DAY_MS);
  const exact = new Date(now.getTime() - UNSCHEDULED_FRESH_DAYS * DAY_MS);
  const stale = new Date(
    now.getTime() - (UNSCHEDULED_FRESH_DAYS * DAY_MS + 1000),
  );

  it('无迭代项：创建不超过 30 天 → 待分配（恰好 30 天仍算待分配）', () => {
    expect(deriveProjectStatus(null, fresh, now)).toBe(ProjectStatus.PLANNED);
    expect(deriveProjectStatus(undefined, exact, now)).toBe(
      ProjectStatus.PLANNED,
    );
  });

  it('无迭代项且创建超过 30 天 → 已关闭', () => {
    expect(deriveProjectStatus(null, stale, now)).toBe(ProjectStatus.FINISHED);
  });

  it('有未取消迭代项且已完成 → 已发布（与创建时间无关）', () => {
    expect(deriveProjectStatus(BacklogStatus.COMPLETED, stale, now)).toBe(
      ProjectStatus.PUBLISHED,
    );
    expect(deriveProjectStatus(BacklogStatus.COMPLETED, fresh, now)).toBe(
      ProjectStatus.PUBLISHED,
    );
  });

  it('有未取消迭代项但未完成 → 开发中', () => {
    for (const status of [
      BacklogStatus.WAITING,
      BacklogStatus.EXECUTING,
      BacklogStatus.TESTING,
      BacklogStatus.RELEASING,
    ]) {
      expect(deriveProjectStatus(status, stale, now)).toBe(
        ProjectStatus.IN_PROGRESS,
      );
    }
  });
});
