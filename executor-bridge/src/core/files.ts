/**
 * 结构化文件端点：令牌 / MCP 配置写入的唯一通道（bridge 不提供 shell）。
 * 路径安全：所有写入必须位于 BRIDGE_ROOT 内，拒绝越界。
 */
import { cp, mkdir, readFile, rm, writeFile, chmod } from 'fs/promises';
import { dirname, relative, resolve, sep } from 'path';
import { HttpError } from './sessions.js';

export interface EnsureDirInput {
  directory: string;
}

export interface WriteFileInput {
  directory: string;
  /** 相对 directory 的路径（或 root 内绝对路径） */
  path: string;
  contentBase64: string;
  /** 可选权限位（如 384 = 0o600） */
  mode?: number;
}

export interface UpsertEnvInput {
  directory: string;
  path: string;
  entries: Record<string, string>;
}

export interface CopyDirInput {
  /** 源目录（评估沙箱构建时为被测机器人真实工位） */
  source: string;
  /** 目标目录（不存在时创建） */
  target: string;
  /** 相对 source 的排除项（文件或目录，按整项前缀匹配），不进入目标目录 */
  exclude?: string[];
}

export interface RemoveDirInput {
  directory: string;
}

export class FileOps {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  directory(): string {
    return this.root;
  }

  async ensureDir(input: EnsureDirInput): Promise<{ directory: string }> {
    const directory = this.within(input.directory);
    await mkdir(directory, { recursive: true });
    return { directory };
  }

  async writeFile(input: WriteFileInput): Promise<{ path: string }> {
    const directory = this.within(input.directory);
    const full = this.within(resolve(directory, input.path));
    await mkdir(dirname(full), { recursive: true });
    const data = Buffer.from(input.contentBase64, 'base64');
    if (data.length === 0 && input.contentBase64 !== '') {
      throw new HttpError(400, 'contentBase64 不是合法的 base64');
    }
    await writeFile(full, data);
    if (typeof input.mode === 'number') {
      await chmod(full, input.mode);
    }
    return { path: full };
  }

  /** 按 key 更新 env 文件（保留其他键，权限 600；文件不存在时创建） */
  async upsertEnv(input: UpsertEnvInput): Promise<{ path: string }> {
    const keys = Object.keys(input.entries ?? {});
    if (keys.length === 0) throw new HttpError(400, 'entries 不能为空');
    const directory = this.within(input.directory);
    const full = this.within(resolve(directory, input.path));
    let existing = '';
    try {
      existing = await readFile(full, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const keySet = new Set(keys);
    const kept = existing
      .split('\n')
      .filter((line) => line !== '')
      .filter((line) => {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
        return !(match && keySet.has(match[1] ?? ''));
      });
    const appended = Object.entries(input.entries).map(
      ([key, value]) => `${key}=${value}`,
    );
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, `${[...kept, ...appended].join('\n')}\n`, 'utf8');
    await chmod(full, 0o600);
    return { path: full };
  }

  /**
   * 递归复制目录（bridge 无 shell，替代 cp -a）：
   * - source/target 均须位于 BRIDGE_ROOT 内，target 不得位于 source 内；
   * - exclude 按相对 source 的路径整项匹配（目录为前缀），命中的文件/目录不进入 target。
   * 评估沙箱构建使用：复制真实工位时剔除 docs/ 与真实凭据。
   */
  async copyDir(input: CopyDirInput): Promise<{ target: string }> {
    const source = this.within(input.source);
    const target = this.within(input.target);
    if (target === source || target.startsWith(source + '/')) {
      throw new HttpError(400, 'target 不能位于 source 内');
    }
    const exclude = (input.exclude ?? [])
      .map((item) => item.replace(/^\.?\//, '').replace(/\/+$/, ''))
      .filter((item) => item !== '' && item !== '.');
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, {
      recursive: true,
      filter: (src) => {
        const rel = relative(source, src).split(sep).join('/');
        if (!rel) return true;
        return !exclude.some(
          (item) => rel === item || rel.startsWith(`${item}/`),
        );
      },
    });
    return { target };
  }

  /** 递归删除目录（bridge 无 shell，替代 rm -rf）；禁止删除 BRIDGE_ROOT 本身 */
  async removeDir(input: RemoveDirInput): Promise<{ directory: string }> {
    const directory = this.within(input.directory);
    if (directory === this.root) {
      throw new HttpError(400, '不允许删除 bridge 根目录');
    }
    await rm(directory, { recursive: true, force: true });
    return { directory };
  }

  /** 解析并校验路径必须位于 root 内 */
  private within(target: string): string {
    const full = resolve(target);
    if (full !== this.root && !full.startsWith(this.root + '/')) {
      throw new HttpError(403, `路径越界（须位于 ${this.root} 内）`);
    }
    return full;
  }
}
