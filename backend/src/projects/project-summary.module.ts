import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document } from '../documents/document.entity';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ModelConfigModule } from '../model-config/model-config.module';
import { Project } from './project.entity';
import { ProjectSummaryService } from './project-summary.service';

/**
 * 需求摘要自动生成（独立模块，避免 ProjectsModule ↔ DocumentsModule 相互依赖成环）：
 * 需求创建/同步、需求类文档变更时触发，模型场景未配置则不生成。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Project, Document]),
    ModelConfigModule,
    KnowledgeModule,
  ],
  providers: [ProjectSummaryService],
  exports: [ProjectSummaryService],
})
export class ProjectSummaryModule {}
