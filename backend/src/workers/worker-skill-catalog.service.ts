import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetchFullTree } from './gitea-tree';
import type { WorkerSkill } from './worker.entity';
import { isDeprecatedSkill } from './worker-skill-deprecation';

/** 初始化时解析出的受管技能文件集合（整个技能目录，含脚本/模板） */
export interface ManagedSkillFiles {
  branch: string;
  rawBase: string;
  directories: string[];
  files: string[];
  entries: Array<{ path: string; sha: string }>;
}

/** 技能目录条目（供机器人表单选择） */
export interface SkillCatalogItem {
  /** 展示名（frontmatter name，缺失时取目录名） */
  name: string;
  /** 描述（frontmatter description） */
  description: string | null;
  /** 版本（frontmatter version） */
  version: string | null;
  /** 仓库内 SKILL.md 相对路径 */
  path: string;
  /** 原始文件下载地址（raw） */
  url: string;
  /** Gitea 页面地址（查看原文） */
  sourceUrl: string;
}

const DEFAULT_REPO_URL = 'http://gitea.cinta.team/docs/skills';
const CACHE_TTL_MS = 5 * 60_000;

/**
 * 技能库目录服务：读取 Gitea docs/skills 仓库中的全部 SKILL.md。
 * 机器人保存时只保存技能引用，不保存技能正文；正文由平台初始化同步器安装到工位。
 */
@Injectable()
export class WorkerSkillCatalogService {
  private readonly logger = new Logger(WorkerSkillCatalogService.name);

  /** 技能库仓库地址（浏览器可访问地址，不含结尾 /） */
  readonly repoUrl: string;

  private cache: SkillCatalogItem[] | null = null;
  private cacheLoadedAt = 0;
  private loading: Promise<SkillCatalogItem[]> | null = null;
  /** 默认分支与目录树短期缓存：连续保存/初始化不重复请求 Gitea */
  private defaultBranchCache: { branch: string; expiresAt: number } | null =
    null;
  private readonly treeCache = new Map<
    string,
    { entries: Awaited<ReturnType<typeof fetchFullTree>>; expiresAt: number }
  >();
  private readonly treeLoading = new Map<
    string,
    Promise<Awaited<ReturnType<typeof fetchFullTree>>>
  >();

  constructor(config: ConfigService) {
    this.repoUrl =
      config.get<string>('WORKER_SKILL_REPO_URL')?.trim().replace(/\/+$/, '') ||
      DEFAULT_REPO_URL;
  }

  /** 列出全部技能；q 匹配 名称/描述/路径（大小写不敏感） */
  async search(q?: string): Promise<SkillCatalogItem[]> {
    const items = await this.list();
    const keyword = q?.trim().toLowerCase();
    if (!keyword) return items;
    return items.filter((item) =>
      [item.name, item.description ?? '', item.path]
        .join('\n')
        .toLowerCase()
        .includes(keyword),
    );
  }

  /** 拉取并解析全部 SKILL.md（成功结果缓存 5 分钟） */
  async list(force = false): Promise<SkillCatalogItem[]> {
    if (
      !force &&
      this.cache &&
      Date.now() - this.cacheLoadedAt < CACHE_TTL_MS
    ) {
      return this.cache;
    }
    this.loading ??= this.load().catch((e: Error) => {
      // 失败不留陈旧缓存；下一次请求重新拉取
      this.cache = null;
      this.cacheLoadedAt = 0;
      throw e;
    });
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /** 校验并规范化机器人保存的技能引用：必须是本技能库的 SKILL.md */
  normalizeSkill(input: unknown): SkillCatalogItem {
    const raw = (input ?? {}) as Partial<SkillCatalogItem> & {
      content?: unknown;
    };
    if (!raw.url || typeof raw.url !== 'string') {
      throw new BadRequestException('技能链接不能为空');
    }
    let url: URL;
    try {
      url = new URL(raw.url);
    } catch {
      throw new BadRequestException(`技能链接非法：${raw.url}`);
    }
    const repo = new URL(this.repoUrl);
    const rawPrefix = `${repo.pathname}/raw/branch/`.replace('//', '/');
    const srcPrefix = `${repo.pathname}/src/branch/`.replace('//', '/');
    if (url.origin !== repo.origin) {
      throw new BadRequestException('技能必须来自技能库仓库');
    }
    const isRaw = url.pathname.startsWith(rawPrefix);
    const isSrc = url.pathname.startsWith(srcPrefix);
    if (!isRaw && !isSrc) {
      throw new BadRequestException('技能必须指向技能库中的 SKILL.md');
    }
    // 输入包含 path 时按 path 剥离分支；仅传链接时默认按单段分支名处理
    const suffix = decodeURIComponent(
      url.pathname.slice((isRaw ? rawPrefix : srcPrefix).length),
    );
    const inputPath =
      typeof raw.path === 'string' &&
      raw.path.endsWith('/SKILL.md') &&
      !raw.path.includes('..')
        ? raw.path
        : null;
    if (
      inputPath &&
      !(suffix === inputPath || suffix.endsWith(`/${inputPath}`))
    ) {
      throw new BadRequestException('技能链接与技能路径不一致');
    }
    const relative =
      inputPath ??
      (suffix.includes('/') ? suffix.slice(suffix.indexOf('/') + 1) : suffix);
    if (
      !relative ||
      relative.includes('..') ||
      !relative.endsWith('/SKILL.md')
    ) {
      throw new BadRequestException('技能必须指向技能库中的 SKILL.md');
    }
    const branch = suffix
      .slice(0, suffix.length - relative.length)
      .replace(/\/+$/, '');
    if (!branch) {
      throw new BadRequestException('技能必须指定技能库分支');
    }
    const encodedPath = relative.split('/').map(encodeURIComponent).join('/');
    const encodedBranch = branch.split('/').map(encodeURIComponent).join('/');
    const normalized: SkillCatalogItem = {
      name:
        String(raw.name ?? '').trim() || relative.slice(0, -'/SKILL.md'.length),
      path: relative,
      url: `${repo.origin}${rawPrefix}${encodedBranch}/${encodedPath}`,
      description:
        typeof raw.description === 'string' && raw.description.trim()
          ? raw.description.trim()
          : null,
      version:
        typeof raw.version === 'string' && raw.version.trim()
          ? raw.version.trim()
          : null,
      sourceUrl: `${repo.origin}${srcPrefix}${encodedBranch}/${encodedPath}`,
    };
    if (raw.content !== undefined) {
      throw new BadRequestException(
        '技能已改为仓库引用，旧内联技能请重新从技能库选择',
      );
    }
    return normalized;
  }

  /**
   * 解析选中技能所在目录下的全部文件。
   * SKILL.md 只是入口，脚本、模板等附属资源必须一并同步到工位。
   */
  async resolveManagedFiles(
    skills?: WorkerSkill[] | null,
  ): Promise<ManagedSkillFiles> {
    const directories = [
      ...new Set(
        (skills ?? [])
          .map((skill) => String(skill?.path ?? ''))
          .filter((path) => path.endsWith('/SKILL.md') && !path.includes('..'))
          .map((path) => path.slice(0, -'/SKILL.md'.length)),
      ),
    ].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    if (!directories.length) {
      return {
        branch: '',
        rawBase: '',
        directories: [],
        files: [],
        entries: [],
      };
    }
    const repo = new URL(this.repoUrl);
    const apiRepo = `${repo.origin}/api/v1/repos${repo.pathname}`;
    const selectedBranch = this.selectedBranch(skills);
    const branch = selectedBranch || (await this.defaultBranch(apiRepo));
    const tree = await this.treeOf(apiRepo, branch);
    const selected = tree
      .filter((item) => {
        if (item.type !== 'blob' || !item.path) return false;
        if (item.path.split('/').pop() === '.DS_Store') return false;
        return directories.some(
          (directory) =>
            item.path === directory || item.path!.startsWith(`${directory}/`),
        );
      })
      .sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '', 'zh-Hans-CN'));
    const encodedBranch = branch.split('/').map(encodeURIComponent).join('/');
    return {
      branch,
      rawBase: `${repo.origin}${repo.pathname}/raw/branch/${encodedBranch}`,
      directories,
      files: selected.map((item) => item.path!),
      entries: selected.map((item) => ({
        path: item.path!,
        sha: item.sha ?? '',
      })),
    };
  }

  /** 批量规范化并按 path 去重；undefined 表示本次未提交该字段 */
  normalizeSkills(
    input?: Array<unknown> | null,
  ): SkillCatalogItem[] | null | undefined {
    if (input === undefined) return undefined;
    if (!input?.length) return null;
    const byPath = new Map<string, SkillCatalogItem>();
    for (const item of input) {
      const skill = this.normalizeSkill(item);
      // 已下线的平台能力技能（lita-work / knowledge-search / file-upload 等）静默丢弃
      if (isDeprecatedSkill(skill)) continue;
      byPath.set(skill.path, skill);
    }
    return byPath.size ? [...byPath.values()] : null;
  }

  /**
   * 解析已保存技能引用的分支：引用 URL 自带分支时优先使用，
   * 避免技能库默认分支漂移后同步到错误版本。
   */
  private selectedBranch(skills?: WorkerSkill[] | null): string | null {
    const repo = new URL(this.repoUrl);
    const marker = `${repo.pathname}/raw/branch/`;
    const branches = (skills ?? [])
      .map((item) => {
        const path = String(item?.path ?? '');
        if (!path.endsWith('/SKILL.md') || path.includes('..')) return null;
        try {
          const url = new URL(String(item?.url ?? ''));
          if (url.origin !== repo.origin || !url.pathname.startsWith(marker)) {
            return null;
          }
          const suffix = decodeURIComponent(url.pathname.slice(marker.length));
          if (!(suffix === path || suffix.endsWith(`/${path}`))) return null;
          return (
            suffix.slice(0, suffix.length - path.length).replace(/\/+$/, '') ||
            null
          );
        } catch {
          return null;
        }
      })
      .filter((branch): branch is string => Boolean(branch));
    const unique = [...new Set(branches)];
    if (unique.length > 1) {
      throw new BadRequestException('选中的技能必须来自技能库同一分支');
    }
    return unique[0] ?? null;
  }

  /** 拉取仓库默认分支 + 递归目录树，并读取全部 SKILL.md 元数据 */
  private async load(): Promise<SkillCatalogItem[]> {
    const repo = new URL(this.repoUrl);
    const apiRepo = `${repo.origin}/api/v1/repos${repo.pathname}`;
    const branch = await this.defaultBranch(apiRepo);
    const tree = await this.treeOf(apiRepo, branch);
    const paths = tree
      .filter(
        (item) => item.type === 'blob' && item.path?.endsWith('/SKILL.md'),
      )
      .map((item) => item.path!)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    const items = (
      await Promise.all(paths.map((path) => this.loadItem(branch, path)))
    ).filter((item) => !isDeprecatedSkill(item));
    this.cache = items;
    this.cacheLoadedAt = Date.now();
    return items;
  }

  /** 读取单个 SKILL.md 并解析 frontmatter 元数据 */
  private async loadItem(
    branch: string,
    path: string,
  ): Promise<SkillCatalogItem> {
    const repo = new URL(this.repoUrl);
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const rawUrl = `${repo.origin}${repo.pathname}/raw/branch/${encodeURIComponent(
      branch,
    )}/${encodedPath}`;
    const sourceUrl = `${repo.origin}${repo.pathname}/src/branch/${encodeURIComponent(
      branch,
    )}/${encodedPath}`;
    let content = '';
    try {
      const res = await fetch(rawUrl, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      content = await res.text();
    } catch (e) {
      this.logger.warn(`技能元数据读取失败 ${path}: ${(e as Error).message}`);
    }
    const meta = this.parseFrontmatter(content);
    const directory = path.slice(0, -'/SKILL.md'.length);
    return {
      name: meta.name || directory,
      description: meta.description || null,
      version: meta.version || null,
      path,
      url: rawUrl,
      sourceUrl,
    };
  }

  /** 解析 frontmatter 中的 name/description/version（不做完整 YAML 解析） */
  private parseFrontmatter(content: string): {
    name?: string;
    description?: string;
    version?: string;
  } {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
    if (!match) return {};
    const result: Record<string, string> = {};
    for (const line of match[1].split(/\r?\n/)) {
      const item = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (!item) continue;
      const [, key, rawValue] = item;
      const value = rawValue
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .trim();
      if (value) result[key] = value;
    }
    return {
      name: result.name,
      description: result.description,
      version: result.version,
    };
  }

  /** 默认分支短期缓存 */
  private async defaultBranch(apiRepo: string): Promise<string> {
    if (
      this.defaultBranchCache &&
      this.defaultBranchCache.expiresAt > Date.now()
    ) {
      return this.defaultBranchCache.branch;
    }
    const repoInfo = await this.requestJson<{ default_branch?: string }>(
      apiRepo,
    );
    const branch = repoInfo.default_branch?.trim() || 'main';
    this.defaultBranchCache = {
      branch,
      expiresAt: Date.now() + 5 * 60_000,
    };
    return branch;
  }

  /** 递归目录树短期缓存（60 秒），连续初始化/保存共享结果 */
  private async treeOf(
    apiRepo: string,
    branch: string,
  ): Promise<Awaited<ReturnType<typeof fetchFullTree>>> {
    const key = `${apiRepo}@${branch}`;
    const cached = this.treeCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.entries;
    const pending = this.treeLoading.get(key);
    if (pending) return pending;
    const request = fetchFullTree(
      (url) => this.requestJson<unknown>(url),
      apiRepo,
      branch,
    )
      .then((entries) => {
        this.treeCache.set(key, {
          entries,
          expiresAt: Date.now() + 60_000,
        });
        return entries;
      })
      .finally(() => this.treeLoading.delete(key));
    this.treeLoading.set(key, request);
    return request;
  }

  /** JSON GET（Gitea API） */
  private async requestJson<T>(url: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw new BadRequestException(`技能库连接失败：${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new BadRequestException(`技能库请求失败：HTTP ${res.status}`);
    }
    return (await res.json().catch(() => null)) as T;
  }
}
