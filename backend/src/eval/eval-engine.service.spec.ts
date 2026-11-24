import {
  EVAL_GLOBAL_CONCURRENCY,
  EvalEngineService,
} from './eval-engine.service';
import type { EvalRun } from './eval-run.entity';
import { EvalItemStatus, EvalRunStatus } from '../common/enums';

/** 仅实现 slotAvailable 依赖的 items.count 桩（识别 TypeORM In 运算符） */
function engineWithItems(
  rows: Array<{ runId: number; status: EvalItemStatus; superseded: boolean }>,
): EvalEngineService {
  const service = Object.create(
    EvalEngineService.prototype,
  ) as EvalEngineService;
  const statusesOf = (status: unknown): EvalItemStatus[] => {
    const op = status as { value?: unknown[] };
    const list = Array.isArray(status)
      ? (status as unknown[])
      : (op?.value ?? []);
    return list.filter((s): s is EvalItemStatus => typeof s === 'string');
  };
  (
    service as unknown as { items: { count(query: unknown): Promise<number> } }
  ).items = {
    count: (query: unknown) => {
      const where = (
        query as {
          where: { runId?: number; status: unknown; superseded: boolean };
        }
      ).where;
      const statuses = statusesOf(where.status);
      return Promise.resolve(
        rows.filter(
          (r) =>
            r.superseded === where.superseded &&
            statuses.includes(r.status) &&
            (where.runId === undefined || r.runId === where.runId),
        ).length,
      );
    },
  };
  return service;
}

async function slotAvailable(
  service: EvalEngineService,
  run: Pick<EvalRun, 'id' | 'concurrency'>,
  currentActive: number,
): Promise<boolean> {
  return (
    service as unknown as {
      slotAvailable(
        run: Pick<EvalRun, 'id' | 'concurrency'>,
        currentActive: number,
      ): Promise<boolean>;
    }
  ).slotAvailable(run, currentActive);
}

describe('EvalEngineService 平台重启恢复（TECH_DESIGN 16）', () => {
  it('排队项重启后继续排队，有任务/沙箱在途的项才标异常', async () => {
    const service = Object.create(
      EvalEngineService.prototype,
    ) as EvalEngineService;
    const errors: Array<{ id: number; message: string }> = [];
    (
      service as unknown as {
        markItemError(id: number, message: string): Promise<void>;
      }
    ).markItemError = (id, message) => {
      errors.push({ id, message });
      return Promise.resolve();
    };
    (
      service as unknown as {
        items: { find(query: unknown): Promise<unknown[]> };
      }
    ).items = {
      find: () =>
        Promise.resolve([
          {
            id: 2,
            status: EvalItemStatus.PENDING,
            taskId: null,
            superseded: false,
          },
          {
            id: 3,
            status: EvalItemStatus.INVITED,
            taskId: null,
            superseded: false,
          },
          {
            id: 4,
            status: EvalItemStatus.RUNNING,
            taskId: 9,
            superseded: false,
          },
        ]),
    };
    (
      service as unknown as {
        tasks: { findOne(query: unknown): Promise<unknown> };
      }
    ).tasks = { findOne: () => Promise.resolve(null) };

    await service.onApplicationBootstrap();
    expect(errors).toEqual([
      { id: 3, message: '平台重启导致评估中断（任务未创建）' },
      { id: 4, message: '评估任务丢失' },
    ]);
  });
});

describe('EvalEngineService 并发槽位调度（TECH_DESIGN 15.3）', () => {
  const run = (id: number, concurrency: number) => ({
    id,
    concurrency,
    status: EvalRunStatus.RUNNING,
  });

  it('仅有排队项且项数 ≥ 批次并发时应有空槽（排队不占槽，回归：批次永久排队死锁）', async () => {
    // 本次事故场景：1 个 PENDING 项 + concurrency=1
    const one = engineWithItems([
      { runId: 1, status: EvalItemStatus.PENDING, superseded: false },
    ]);
    await expect(slotAvailable(one, run(1, 1), 1)).resolves.toBe(true);
    // 6 个 PENDING 项 + concurrency=3：全局占用态为 0（排队不计入全局槽位）
    const six = engineWithItems(
      Array.from({ length: 6 }, () => ({
        runId: 1,
        status: EvalItemStatus.PENDING,
        superseded: false,
      })),
    );
    await expect(slotAvailable(six, run(1, 3), 0)).resolves.toBe(true);
  });

  it('占用态项达到批次并发上限时无空槽', async () => {
    const service = engineWithItems([
      { runId: 1, status: EvalItemStatus.RUNNING, superseded: false },
      { runId: 1, status: EvalItemStatus.JUDGING, superseded: false },
      { runId: 1, status: EvalItemStatus.PENDING, superseded: false },
    ]);
    await expect(slotAvailable(service, run(1, 2), 3)).resolves.toBe(false);
  });

  it('全局占用达到上限时无空槽（即使批次内有空位）', async () => {
    const service = engineWithItems([
      { runId: 1, status: EvalItemStatus.PENDING, superseded: false },
    ]);
    await expect(
      slotAvailable(service, run(1, 3), EVAL_GLOBAL_CONCURRENCY),
    ).resolves.toBe(false);
  });

  it('占用态计数排除排队与被替代项', async () => {
    const service = engineWithItems([
      { runId: 1, status: EvalItemStatus.PENDING, superseded: false },
      { runId: 1, status: EvalItemStatus.PENDING, superseded: true },
      { runId: 1, status: EvalItemStatus.DONE, superseded: false },
      { runId: 2, status: EvalItemStatus.RUNNING, superseded: false },
    ]);
    // 本批次无占用态项 → 有空槽；其它批次的占用项不计入 runId 过滤
    await expect(slotAvailable(service, run(1, 1), 1)).resolves.toBe(true);
  });
});
