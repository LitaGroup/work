import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { beijingTime, mdFrontmatter } from '../common/frontmatter';
import { Worker } from '../workers/worker.entity';
import {
  beijingDateTimeStamp,
  encodeKnowledgePath,
  workerReviewPath,
  workerReviewsRootPath,
} from './knowledge.path';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeStore } from './knowledge.store';
import type { KnowledgeNode, KnowledgeNodeSummary } from './knowledge.types';

/** 复盘文件名为北京时间 yyyyMMddHHmmss */
const REVIEW_NAME_PATTERN = /^\d{14}$/;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_RETENTION_DAYS = 365;
const CLEANUP_BATCH_SIZE = 200;
const CLEANUP_MAX_BATCHES = 50;
/** 同一秒内的并发/连续上传自动顺延到下一个可用秒 */
const CREATE_MAX_ATTEMPTS = 120;

export interface WorkerReviewSummary {
  name: string;
  title: string;
  path: string;
  readUrl: string;
  webUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkerReviewDetail extends WorkerReviewSummary {
  workerId: number;
  workerName: string;
  content: string;
}

export interface WorkerReviewPage {
  workerId: number;
  workerName: string;
  page: number;
  pageSize: number;
  hasMore: boolean;
  items: WorkerReviewSummary[];
}

export interface WorkerReviewQuery {
  page?: number;
  pageSize?: number;
  /** ISO 8601，按复盘创建时间过滤 */
  from?: string;
  /** ISO 8601，不含边界 */
  to?: string;
}

export interface WorkerReviewWriteInput {
  title?: string;
  content?: string;
}

/**
 * 机器人个人会话复盘：
 * - 存储在机器人工作区 /95-workspace/{id}/reviews/{yyyyMMddHHmmss}；
 * - 由机器人通过 lita-work 写入自己的复盘，管理员经 lita-work-admin 只读查询；
 * - 复用知识库文章、全文与向量索引，不新增业务表；
 * - 默认不自动删除；显式开启清理后按创建时间保留一年。
 */
@Injectable()
export class WorkerReviewsService {
  private readonly logger = new Logger(WorkerReviewsService.name);
  private readonly cleanupEnabled: boolean;
  private readonly retentionDays: number;

  constructor(
    config: ConfigService,
    private readonly knowledge: KnowledgeService,
    private readonly store: KnowledgeStore,
    @InjectRepository(Worker)
    private readonly workers: Repository<Worker>,
  ) {
    const enabled = String(
      config.get<string>('WORKER_REVIEWS_CLEANUP_ENABLED') ?? '',
    )
      .trim()
      .toLowerCase();
    this.cleanupEnabled = ['true', '1', 'on', 'yes'].includes(enabled);

    const rawRetention = String(
      config.get<string>('WORKER_REVIEWS_RETENTION_DAYS') ?? '',
    ).trim();
    const retention = Number(rawRetention || DEFAULT_RETENTION_DAYS);
    if (!Number.isInteger(retention) || retention <= 0) {
      this.logger.warn(
        `机器人复盘保留天数 ${rawRetention || '(空)'} 非法，回退为 ${DEFAULT_RETENTION_DAYS} 天`,
      );
      this.retentionDays = DEFAULT_RETENTION_DAYS;
    } else {
      this.retentionDays = retention;
    }
  }

  async list(
    workerId: number,
    query: WorkerReviewQuery = {},
  ): Promise<WorkerReviewPage> {
    const worker = await this.requireWorker(workerId);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(page) || page < 1) {
      throw new BadRequestException('page 必须是大于等于 1 的整数');
    }
    if (
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > MAX_PAGE_SIZE
    ) {
      throw new BadRequestException(
        `pageSize 必须是 1..${MAX_PAGE_SIZE} 的整数`,
      );
    }
    const from = this.parseQueryDate(query.from, 'from');
    const to = this.parseQueryDate(query.to, 'to');
    if (from && to && from >= to) {
      throw new BadRequestException('from 必须早于 to');
    }
    const rows = await this.store.listWorkerReviewSummaries({
      workerId,
      from,
      to,
      offset: (page - 1) * pageSize,
      limit: pageSize + 1,
    });
    const hasMore = rows.length > pageSize;
    return {
      workerId,
      workerName: worker.name,
      page,
      pageSize,
      hasMore,
      items: rows.slice(0, pageSize).map((row) => this.toSummary(row)),
    };
  }

  async read(workerId: number, name: string): Promise<WorkerReviewDetail> {
    const worker = await this.requireWorker(workerId);
    const normalizedName = this.normalizeName(name);
    const path = workerReviewPath(workerId, normalizedName);
    const node = await this.knowledge.readArticle(path);
    this.assertReviewNode(node, path);
    return {
      ...this.toSummary(node),
      workerId,
      workerName: worker.name,
      content: node.content ?? '',
    };
  }

  async create(
    workerId: number,
    input: { title?: string; content: string },
  ): Promise<WorkerReviewDetail> {
    const worker = await this.requireWorker(workerId);
    const content = input.content ?? '';
    if (!content.trim()) {
      throw new BadRequestException('复盘正文不能为空');
    }
    await this.knowledge.ensureWorkerWorkspace(worker);

    const now = Date.now();
    let created: KnowledgeNode | null = null;
    for (let attempt = 0; attempt < CREATE_MAX_ATTEMPTS; attempt += 1) {
      const name = beijingDateTimeStamp(new Date(now + attempt * 1000));
      const path = workerReviewPath(workerId, name);
      try {
        created = await this.knowledge.createArticleAtPath({
          path,
          title: input.title?.trim() || this.defaultTitle(name),
          content,
        });
        break;
      } catch (error) {
        // 同一秒只允许一篇复盘；路径已被占用时顺延，不覆盖其他人的内容
        if (
          error instanceof BadRequestException &&
          error.message.includes('已存在')
        ) {
          continue;
        }
        throw error;
      }
    }
    if (!created) {
      throw new ConflictException('复盘创建过于频繁，请稍后重试');
    }
    return {
      ...this.toSummary(created),
      workerId,
      workerName: worker.name,
      content,
    };
  }

  async update(
    workerId: number,
    name: string,
    input: WorkerReviewWriteInput,
  ): Promise<WorkerReviewDetail> {
    const worker = await this.requireWorker(workerId);
    if (input.title === undefined && input.content === undefined) {
      throw new BadRequestException('至少提供 title 或 content');
    }
    if (input.content !== undefined && !input.content.trim()) {
      throw new BadRequestException('复盘正文不能为空');
    }
    const normalizedName = this.normalizeName(name);
    const path = workerReviewPath(workerId, normalizedName);
    const node = await this.knowledge.readArticle(path);
    this.assertReviewNode(node, path);
    const updated = await this.knowledge.update(node.id, {
      title: input.title,
      content: input.content,
    });
    return {
      ...this.toSummary(updated),
      workerId,
      workerName: worker.name,
      content: updated.content ?? '',
    };
  }

  /** 每日 04:45 到期清理；默认关闭，避免误删长期复盘的机器人经验 */
  @Cron('0 45 4 * * *')
  async cleanupExpired(): Promise<void> {
    if (!this.cleanupEnabled || !this.knowledge.isEnabled) return;
    if (!this.store.isEnabled) return;
    const cutoff = new Date(
      Date.now() - this.retentionDays * 24 * 60 * 60 * 1000,
    );
    let total = 0;
    for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch += 1) {
      const removed = await this.store.removeExpiredWorkerReviewArticles(
        cutoff,
        CLEANUP_BATCH_SIZE,
      );
      total += removed;
      if (removed < CLEANUP_BATCH_SIZE) break;
    }
    if (total > 0) {
      this.logger.log(
        `机器人复盘到期清理：${total} 篇（保留 ${this.retentionDays} 天）`,
      );
    }
  }

  renderListMarkdown(
    result: WorkerReviewPage,
    options: { scope: 'mine' | 'admin'; readTool: string },
  ): string {
    const isMine = options.scope === 'mine';
    const title = isMine ? '我的复盘' : `机器人复盘：${result.workerName}`;
    const lines = [
      mdFrontmatter({
        update: new Date(),
        title,
        type: 'review-list',
        workerId: result.workerId,
        workerName: result.workerName,
      }),
      `# ${title}`,
      '',
      `- 机器人：#${result.workerId} ${result.workerName}`,
      `- 知识目录：${workerReviewsRootPath(result.workerId)}/`,
      `- 分页：第 ${result.page} 页，每页 ${result.pageSize} 条`,
      '',
      '## 复盘清单',
      '',
      ...(result.items.length
        ? [
            '| 创建时间（北京时间） | 标题 | 名称 |',
            '|---|---|---|',
            ...result.items.map(
              (item) =>
                `| ${this.escapeCell(beijingTime(item.createdAt))} | ${this.escapeCell(item.title)} | ${item.name} |`,
            ),
          ]
        : ['（暂无复盘）']),
      '',
      ...(result.hasMore ? ['> 还有更多复盘，请增大 page 查询。', ''] : []),
      '> 读取全文请调用 `' +
        options.readTool +
        '`（传入上表“名称”）；复盘按创建时间倒序排列。',
      '',
    ];
    return lines.join('\n');
  }

  renderDetailMarkdown(review: WorkerReviewDetail): string {
    return [
      mdFrontmatter({
        update: review.updatedAt,
        title: review.title,
        path: review.path,
        type: 'review',
        workerId: review.workerId,
        workerName: review.workerName,
      }),
      `# ${review.title}`,
      '',
      `- 机器人：#${review.workerId} ${review.workerName}`,
      `- 名称：${review.name}`,
      `- 知识路径：${review.path}`,
      `- 创建时间：${beijingTime(review.createdAt)}`,
      `- 更新时间：${beijingTime(review.updatedAt)}`,
      `- 读取：GET ${review.readUrl}`,
      `- 网页：${review.webUrl}`,
      '',
      '## 复盘正文',
      '',
      review.content,
      '',
    ].join('\n');
  }

  renderCreatedMarkdown(review: WorkerReviewDetail): string {
    return [
      mdFrontmatter({
        update: review.createdAt,
        title: '机器人复盘已保存',
        path: review.path,
        type: 'review',
        workerId: review.workerId,
      }),
      '# 机器人复盘已保存',
      '',
      `- 机器人：#${review.workerId} ${review.workerName}`,
      `- 名称：${review.name}`,
      `- 标题：${review.title}`,
      `- 知识路径：${review.path}`,
      `- 读取：GET ${review.readUrl}`,
      `- 网页：${review.webUrl}`,
      '',
    ].join('\n');
  }

  renderUpdatedMarkdown(review: WorkerReviewDetail): string {
    return [
      mdFrontmatter({
        update: review.updatedAt,
        title: '机器人复盘已更新',
        path: review.path,
        type: 'review',
        workerId: review.workerId,
      }),
      '# 机器人复盘已更新',
      '',
      `- 机器人：#${review.workerId} ${review.workerName}`,
      `- 名称：${review.name}`,
      `- 标题：${review.title}`,
      `- 知识路径：${review.path}`,
      `- 读取：GET ${review.readUrl}`,
      `- 网页：${review.webUrl}`,
      '',
    ].join('\n');
  }

  private async requireWorker(
    workerId: number,
  ): Promise<Pick<Worker, 'id' | 'name'>> {
    if (!Number.isInteger(workerId) || workerId <= 0) {
      throw new BadRequestException('机器人 ID 必须是正整数');
    }
    const worker = await this.workers.findOne({
      where: { id: workerId },
      select: { id: true, name: true },
    });
    if (!worker) throw new NotFoundException(`机器人 ${workerId} 不存在`);
    return worker;
  }

  private normalizeName(name: string): string {
    const normalized = name?.trim();
    if (!normalized || !REVIEW_NAME_PATTERN.test(normalized)) {
      throw new BadRequestException(
        '复盘名称必须是 14 位时间戳 yyyyMMddHHmmss',
      );
    }
    return normalized;
  }

  private assertReviewNode(node: KnowledgeNode, expectedPath: string): void {
    if (
      node.path !== expectedPath ||
      node.kind !== 'article' ||
      node.source !== 'native'
    ) {
      throw new ForbiddenException(
        '该知识不是机器人复盘，不能通过复盘接口操作',
      );
    }
  }

  private parseQueryDate(
    raw: string | undefined,
    field: 'from' | 'to',
  ): Date | undefined {
    if (!raw?.trim()) return undefined;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${field} 必须是合法的 ISO 8601 时间`);
    }
    return date;
  }

  private defaultTitle(name: string): string {
    return `复盘 ${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(
      6,
      8,
    )} ${name.slice(8, 10)}:${name.slice(10, 12)}:${name.slice(12, 14)}`;
  }

  private toSummary(
    node: KnowledgeNodeSummary | KnowledgeNode,
  ): WorkerReviewSummary {
    const encoded = encodeKnowledgePath(node.path);
    return {
      name: node.name,
      title: node.title,
      path: node.path,
      readUrl: `/api/docs/detail/${encoded}.md`,
      webUrl: `/docs/detail/${encoded}`,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    };
  }

  private escapeCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  }
}
