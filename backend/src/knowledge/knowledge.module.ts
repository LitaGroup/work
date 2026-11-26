import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EvalJudgement } from '../eval/eval-judgement.entity';
import { EvalRunItem } from '../eval/eval-run-item.entity';
import { EvalRun } from '../eval/eval-run.entity';
import { EvalCase, EvalCasePoint, EvalSuite } from '../eval/eval-suite.entity';
import { McpServer } from '../mcp-servers/mcp-server.entity';
import { TaskTemplate } from '../tasks/task-template.entity';
import { Worker } from '../workers/worker.entity';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeEmbeddingService } from './knowledge-embedding.service';
import { KnowledgeIndexService } from './knowledge-index.service';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeStore } from './knowledge.store';
import { SystemKnowledgeService } from './system-knowledge.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Worker,
      McpServer,
      TaskTemplate,
      EvalSuite,
      EvalCase,
      EvalCasePoint,
      EvalRun,
      EvalRunItem,
      EvalJudgement,
    ]),
  ],
  controllers: [KnowledgeController],
  providers: [
    KnowledgeStore,
    KnowledgeEmbeddingService,
    KnowledgeIndexService,
    KnowledgeService,
    SystemKnowledgeService,
  ],
  exports: [KnowledgeService, SystemKnowledgeService],
})
export class KnowledgeModule {}
