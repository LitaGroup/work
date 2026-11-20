/**
 * 内核 CLI 版本探测：执行 `<cli> --version` 并提取版本号。
 * 各 CLI 输出形态不同（如 `kiro-cli 3.5.0` / `devin 3000.14.30821 (hash)` / `1.16.0`），
 * 统一取首个 x.y[.z...] 形态的 token；失败返回 'unknown'（健康检查不因探测失败而中断）。
 * 结果按 CLI 路径缓存 10 分钟（CLI 自更新后自动刷新）。
 */
import { execFile } from 'child_process';

const VERSION_PATTERN = /\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?/;
const VERSION_CACHE_MS = 10 * 60 * 1000;

const cache = new Map<string, { at: number; value: string }>();

export async function probeCliVersion(
  cli: string,
  args: string[] = ['--version'],
): Promise<string> {
  const key = `${cli}\u0000${args.join('\u0000')}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < VERSION_CACHE_MS) {
    return cached.value;
  }
  let value = 'unknown';
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        cli,
        args,
        { timeout: 20_000, maxBuffer: 1024 * 1024, env: process.env },
        (error, out) => {
          if (error) reject(error);
          else resolve(out);
        },
      );
    });
    value = VERSION_PATTERN.exec(stdout)?.[0] ?? 'unknown';
  } catch {
    value = 'unknown';
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}