import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LlmService } from '../model-config/llm.service';
import { Project } from './project.entity';
import { ProjectSummaryService } from './project-summary.service';

/**
 * 需求描述自动生成：需求创建/同步、或「需求」类文档新增/更新后，
 * 若需求描述为空且无进行中的生成，调用模型生成结构化 Markdown 描述并落库。
 *
 * 设计要点：
 * - 只补空值：需求描述已存在（人工或此前生成）时跳过，同步也不会清空；
 * - 乐观条件更新（仍为空才写入），生成期间被人工填写则不覆盖；
 * - 模型未配置 / 空输出 / 失败时一律保留原描述，只告警；
 * - 进行中去重靠进程内集合，结束/失败即释放，下次触发可重试。
 */
@Injectable()
export class ProjectDescriptionService {
  private readonly logger = new Logger(ProjectDescriptionService.name);
  /** 生成中的需求 ID：同一需求同时只跑一个生成任务 */
  private readonly generating = new Set<number>();

  constructor(
    @InjectRepository(Project)
    private readonly projects: Repository<Project>,
    private readonly material: ProjectSummaryService,
    private readonly llm: LlmService,
  ) {}

  /**
   * 触发入口（fire-and-forget）：需求创建/同步、需求类文档变更后调用。
   * 描述非空、生成中或无有效素材时直接跳过；失败只告警。
   */
  maybeGenerateDescription(projectId: number): void {
    void this.generate(projectId).catch((error: unknown) => {
      this.logger.warn(
        `需求 #${projectId} 描述生成失败：${
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
        select: { id: true, name: true, description: true },
      });
      if (!project || project.description?.trim()) return;
      const material = await this.material.buildMaterial(project);
      if (!material) return; // 无有效素材：等下一次触发
      const description = await this.llm.generateDescription(material);
      if (!description) return; // 场景未配置或模型空输出：不清空
      // 乐观条件更新：生成期间人工填写了描述则不覆盖
      const result = await this.projects
        .createQueryBuilder()
        .update(Project)
        .set({ description })
        .where(`id = :id AND (description IS NULL OR description = '')`, {
          id: projectId,
        })
        .execute();
      if (result.affected) {
        this.logger.log(
          `需求 #${projectId} 描述已生成（${description.length} 字）`,
        );
      }
    } finally {
      this.generating.delete(projectId);
    }
  }
}
