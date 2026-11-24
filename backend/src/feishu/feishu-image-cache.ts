import { promises as fs } from 'fs';
import * as path from 'path';

/** 图片缓存根目录（相对 images webroot），对外经 /images 访问 */
const CACHE_SUBDIR = 'feishu';

/** 文件名 → 图片 token（去掉扩展名；无扩展名时返回 null） */
export function imageTokenFromFile(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return null;
  return fileName.slice(0, dot);
}

/**
 * token + 扩展名 → 缓存相对路径 `feishu/{前两位}/{token}{ext}`。
 * 前两位分桶避免单目录堆积文件；非常规前缀（非 [A-Za-z0-9]）归到 xx。
 */
export function imageCacheRelPath(token: string, ext: string): string {
  const head = token.slice(0, 2);
  const prefix = /^[A-Za-z0-9]{2}$/.test(head) ? head : 'xx';
  return path.posix.join(CACHE_SUBDIR, prefix, `${token}${ext}`);
}

/**
 * 飞书图片磁盘缓存：token → /images 链接。
 * 飞书图片 token 内容寻址（内容变化即换 token），因此命中即可复用，避免每次同步全量重下。
 * 索引在首次使用时懒加载一次，扫描 feishu 下一层子目录——兼容历史按日期落盘的素材。
 */
export class FeishuImageCache {
  private readonly index = new Map<string, string>();
  private loaded = false;

  constructor(private readonly webroot: () => string) {}

  /** 懒加载索引（只扫描一层子目录：日期目录 / token 前缀目录，均为平铺文件） */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const root = path.join(this.webroot(), CACHE_SUBDIR);
    let dirs: string[];
    try {
      dirs = await fs.readdir(root);
    } catch {
      return; // 目录不存在：首次下载时按需创建
    }
    for (const dir of dirs) {
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(path.join(root, dir), {
          withFileTypes: true,
        });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const token = imageTokenFromFile(entry.name);
        if (!token || this.index.has(token)) continue;
        this.index.set(
          token,
          `/images/${path.posix.join(CACHE_SUBDIR, dir, entry.name)}`,
        );
      }
    }
  }

  get(token: string): string | undefined {
    return this.index.get(token);
  }

  /** 原子落盘（临时文件 + rename）并登记索引，返回 /images 链接 */
  async save(token: string, ext: string, buffer: Buffer): Promise<string> {
    const relPath = imageCacheRelPath(token, ext);
    const absPath = path.join(this.webroot(), relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmpPath, buffer);
    await fs.rename(tmpPath, absPath);
    const url = `/images/${relPath}`;
    this.index.set(token, url);
    return url;
  }
}
