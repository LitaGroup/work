import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../auth/user.entity';
import { Document } from '../documents/document.entity';
import { FeishuBotModule } from '../feishu-bot/feishu-bot.module';
import { ModelConfigModule } from '../model-config/model-config.module';
import { Project } from '../projects/project.entity';
import { ReleasesModule } from '../releases/releases.module';
import { Task } from '../tasks/task.entity';
import { TasksModule } from '../tasks/tasks.module';
import { Ticket } from '../tickets/ticket.entity';
import { TicketWorkflowRun } from '../tickets/ticket-workflow-run.entity';
import { TicketsModule } from '../tickets/tickets.module';
import { Worker } from '../workers/worker.entity';
import { WorkflowDefinition } from '../workflows/workflow-definition.entity';
import { WorkflowDefinitionVersion } from '../workflows/workflow-definition-version.entity';
import { Topic } from '../topics/topic.entity';
import { Backlog } from './backlog.entity';
import { BacklogDocument } from './backlog-document.entity';
import { BacklogEvent } from './backlog-event.entity';
import { BacklogsService } from './backlogs.service';
import { Iteration } from './iteration.entity';
import {
  BacklogsController,
  IterationsController,
  IterationsMarkdownController,
} from './iterations.controller';
import { IterationsService } from './iterations.service';

/**
 * 迭代：T0 常驻快速通道 + T7 每周通道 + Tx 特殊通道。
 * 迭代项从需求转入，指定负责人机器人后自动创建交付任务并建立飞书沟通群；
 * 转入时迁移需求文档、异步生成迭代项标题，状态流转记录事件流。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Iteration,
      Backlog,
      BacklogDocument,
      BacklogEvent,
      Project,
      Worker,
      User,
      Document,
      Task,
      Ticket,
      TicketWorkflowRun,
      WorkflowDefinition,
      WorkflowDefinitionVersion,
      Topic,
    ]),
    TasksModule,
    TicketsModule,
    FeishuBotModule,
    ModelConfigModule,
    ReleasesModule,
  ],
  controllers: [
    IterationsController,
    IterationsMarkdownController,
    BacklogsController,
  ],
  providers: [IterationsService, BacklogsService],
  exports: [IterationsService, BacklogsService],
})
export class IterationsModule {}
