import { Module } from '@nestjs/common';
import { ApipostModule } from '../apipost/apipost.module';
import { FeishuModule } from '../feishu/feishu.module';
import { KnowledgeImportController } from './knowledge-import.controller';
import { KnowledgeImportService } from './knowledge-import.service';
import { KnowledgeModule } from './knowledge.module';

@Module({
  imports: [KnowledgeModule, FeishuModule, ApipostModule],
  controllers: [KnowledgeImportController],
  providers: [KnowledgeImportService],
})
export class KnowledgeImportModule {}
