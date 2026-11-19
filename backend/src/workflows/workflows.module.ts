import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TaskTemplate } from '../tasks/task-template.entity';
import { Worker } from '../workers/worker.entity';
import { Iteration } from '../iterations/iteration.entity';
import { Backlog } from '../iterations/backlog.entity';
import { FeishuBotModule } from '../feishu-bot/feishu-bot.module';
import { WorkflowDefinitionVersion } from './workflow-definition-version.entity';
import { WorkflowDefinition } from './workflow-definition.entity';
import { WorkflowDefinitionsController } from './workflow-definitions.controller';
import { WorkflowDefinitionsService } from './workflow-definitions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WorkflowDefinition,
      WorkflowDefinitionVersion,
      TaskTemplate,
      Worker,
      Iteration,
      Backlog,
    ]),
    // 飞书群消息节点：配置页读取平台官方机器人所在群
    FeishuBotModule,
  ],
  controllers: [WorkflowDefinitionsController],
  providers: [WorkflowDefinitionsService],
  exports: [WorkflowDefinitionsService],
})
export class WorkflowsModule {}
