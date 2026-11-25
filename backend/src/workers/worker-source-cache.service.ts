import { Injectable, Logger } from '@nestjs/common';

interface CachedSource {
  bytes: Uint8Array;
  expiresAt: number;
}

/** 源文件缓存上限（技能与规范仓库文件通常较小；超限淘汰最旧条目） */
const MAX_ENTRIES = 2000;
/** 缓存有效期；分支更新通过 tree SHA 触发重新同步，正文缓存只做短期加速 */
const TTL_MS = 5 * 60_000;
/** 单文件下载超时与重试 */
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_ATTEMPTS = 2;

/**
 * 技能/规范源文件缓存：多个机器人选择同一技能或规范目录时共享正文下载。
 * 同一 URL 并发请求合并为一次（singleflight），避免初始化并发时重复打 Gitea。
 */
@Injectable()
export class WorkerSourceCacheService {
  private readonly logger = new Logger(WorkerSourceCacheService.name);
  private readonly cache = new Map<string, CachedSource>();
  private readonly loading = new Map<string, Promise<Uint8Array>>();

  async get(url: string, cacheKey = url): Promise<Uint8Array> {
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.bytes;

    const pending = this.loading.get(cacheKey);
    if (pending) return pending;

    const request = this.fetchWithRetry(url)
      .then((bytes) => {
        this.put(cacheKey, bytes);
        return bytes;
      })
      .finally(() => {
        this.loading.delete(cacheKey);
      });
    this.loading.set(cacheKey, request);
    return request;
  }

  private put(url: string, bytes: Uint8Array): void {
    if (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(url, {
      bytes,
      expiresAt: Date.now() + TTL_MS,
    });
  }

  private async fetchWithRetry(url: string): Promise<Uint8Array> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        lastError = error as Error;
        if (attempt < FETCH_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        }
      }
    }
    this.logger.warn(
      `源文件下载失败 ${url}: ${lastError?.message ?? '未知错误'}`,
    );
    throw new Error(`源文件下载失败：${lastError?.message ?? url}`);
  }
}
