import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document } from '../documents/document.entity';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ModelConfigModule } from '../model-config/model-config.module';
import { Project } from './project.entity';
import { ProjectDescriptionService } from './project-description.service';
import { ProjectSummaryService } from './project-summary.service';

/**
 * 需求 AI 内容自动生成（独立模块，避免 ProjectsModule ↔ DocumentsModule 相互依赖成环）：
 * 需求创建/同步、需求类文档变更时触发摘要与描述生成；模型场景未配置则跳过，且绝不覆盖/清空已有内容。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Project, Document]),
    ModelConfigModule,
    KnowledgeModule,
  ],
  providers: [ProjectSummaryService, ProjectDescriptionService],
  exports: [ProjectSummaryService, ProjectDescriptionService],
})
export class ProjectSummaryModule {}
