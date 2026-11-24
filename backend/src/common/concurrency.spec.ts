import { runWithConcurrency } from './concurrency';

describe('runWithConcurrency（有限并发）', () => {
  it('不超过并发上限并完成全部任务', async () => {
    let active = 0;
    let peak = 0;
    const finished: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished.push(item);
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(finished.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('并发上限大于任务数时按任务数执行', async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2], 10, (item) => {
      seen.push(item);
      return Promise.resolve();
    });
    expect(seen).toEqual([1, 2]);
  });

  it('空数组直接返回', async () => {
    const task = jest.fn();
    await runWithConcurrency([], 3, task);
    expect(task).not.toHaveBeenCalled();
  });

  it('任务抛错时整体拒绝', async () => {
    await expect(
      runWithConcurrency([1, 2, 3], 2, (item) =>
        item === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(),
      ),
    ).rejects.toThrow('boom');
  });
});
