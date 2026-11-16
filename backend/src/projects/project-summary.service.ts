import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentSource, DocumentType } from '../common/enums';
import {
  swaggerToMarkdown,
  type SwaggerSpec,
} from '../apipost/apipost-markdown';
import { Document } from '../documents/document.entity';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { LlmService } from '../model-config/llm.service';
import { Project } from './project.entity';

/** 单篇需求类文档纳入素材的最大字符数 */
const DOC_MATERIAL_LIMIT = 4_000;
/** 全部素材（需求描述 + 文档正文）合计最大字符数 */
const MATERIAL_LIMIT = 12_000;

/**
 * 需求摘要自动生成：需求创建/同步、或「需求」类文档新增/更新后，
 * 若需求摘要为空且无进行中的生成，调用模型生成 200 字以内摘要并落库（失败只告警）。
 *
 * 设计要点：
 * - 不落库生成状态；进行中去重靠进程内集合（即「没有摘要任务」的判定），结束/失败即释放，下次触发可重试；
 * - 乐观条件更新（仅在摘要仍为空时写入），不覆盖生成期间的人工填写；
 * - 模型场景未配置时直接跳过，不影响主流程。
 */
@Injectable()
export class ProjectSummaryService {
  private readonly logger = new Logger(ProjectSummaryService.name);
  /** 生成中的需求 ID：同一需求同时只跑一个生成任务 */
  private readonly generating = new Set<number>();

  constructor(
    @InjectRepository(Project)
    private readonly projects: Repository<Project>,
    @InjectRepository(Document)
    private readonly documents: Repository<Document>,
    private readonly knowledge: KnowledgeService,
    private readonly llm: LlmService,
  ) {}

  /**
   * 触发入口（fire-and-forget）：需求创建/同步、需求类文档变更后调用。
   * 摘要非空、生成中或无有效素材时直接跳过；失败只告警。
   */
  maybeGenerateSummary(projectId: number): void {
    void this.generate(projectId).catch((error: unknown) => {
      this.logger.warn(
        `需求 #${projectId} 摘要生成失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private async generate(projectId: number): Promise<void> {
    if (this.generating.has(projectId)) return;
    this.generating.add(projectId);
    try {
      const project = await this.projects.findOne({
        where: { id: projectId },
        select: { id: true, name: true, description: true, summary: true },
      });
      if (!project || project.summary?.trim()) return;
      const material = await this.buildMaterial(project);
      if (!material) return; // 无有效素材：等下一次触发
      const summary = await this.llm.generateSummary(material);
      if (!summary) return; // 场景未配置或模型空输出
      // 乐观条件更新：生成期间人工填写了摘要则不覆盖
      const result = await this.projects
        .createQueryBuilder()
        .update(Project)
        .set({ summary })
        .where(`id = :id AND (summary IS NULL OR summary = '')`, {
          id: projectId,
        })
        .execute();
      if (result.affected) {
        this.logger.log(
          `需求 #${projectId} 摘要已生成（${summary.length} 字）`,
        );
      }
    } finally {
      this.generating.delete(projectId);
    }
  }

  /** 组织素材：需求名称 + 描述 + 全部「需求」类文档正文（按更新时间升序）；供摘要/描述生成复用 */
  async buildMaterial(
    project: Pick<Project, 'id' | 'name' | 'description'>,
  ): Promise<string> {
    const parts: string[] = [`# 需求：${project.name}`];
    if (project.description?.trim()) {
      parts.push(`## 需求描述\n${project.description.trim()}`);
    }
    const docs = await this.documents.find({
      where: { projectId: project.id, type: DocumentType.REQUIREMENT },
      select: {
        id: true,
        title: true,
        content: true,
        knowledgeId: true,
        source: true,
        projectId: true,
      },
      order: { updatedAt: 'ASC', id: 'ASC' },
    });
    for (const doc of docs) {
      const body = await this.documentBody(doc);
      if (!body.trim()) continue;
      parts.push(`## 文档：${doc.title}\n${body.slice(0, DOC_MATERIAL_LIMIT)}`);
    }
    // 只有名称（无描述且无文档正文）不算有效素材
    if (parts.length === 1) return '';
    return parts.join('\n\n').trim().slice(0, MATERIAL_LIMIT);
  }

  /** 文档正文：普通文档可能只存知识库；apipost 来源为原始 JSON，转 Markdown 后取用 */
  private async documentBody(doc: Document): Promise<string> {
    let content = doc.content;
    if (!content && doc.knowledgeId) {
      try {
        const node = await this.knowledge.getProjectDocument(
          doc.projectId,
          doc.id,
        );
        content = node?.content ?? null;
      } catch (error) {
        this.logger.warn(
          `需求 #${doc.projectId} 文档 #${doc.id} 知识库正文读取失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (!content) return '';
    if (doc.source === DocumentSource.APIPOST) {
      try {
        return swaggerToMarkdown(JSON.parse(content) as SwaggerSpec);
      } catch {
        return content;
      }
    }
    return content;
  }
}
