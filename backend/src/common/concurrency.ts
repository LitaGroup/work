/**
 * 有限并发执行：最多同时运行 limit 个任务，全部完成后返回。
 * 任一任务抛错时 Promise 立即拒绝；已启动的任务会跑完，不再启动新任务。
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await task(items[index], index);
    }
  });
  await Promise.all(workers);
}
