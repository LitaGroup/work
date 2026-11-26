import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApipostModule } from '../apipost/apipost.module';
import { FeishuModule } from '../feishu/feishu.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { BacklogDocument } from '../iterations/backlog-document.entity';
import { Document } from './document.entity';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { ProjectSummaryModule } from '../projects/project-summary.module';
import { Project } from '../projects/project.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Document, BacklogDocument, Project]),
    FeishuModule,
    ApipostModule,
    KnowledgeModule,
    ProjectSummaryModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
