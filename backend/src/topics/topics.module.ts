import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Subject } from 'rxjs';
import { User } from '../auth/user.entity';
import { Defect } from '../defects/defect.entity';
import { Executor } from '../executors/executor.entity';
import { FeishuBotBacklogChat } from '../feishu-bot/feishu-bot-backlog-chat.entity';
import { FeishuBotConfig } from '../feishu-bot/feishu-bot-config.entity';
import { FeishuBotModule } from '../feishu-bot/feishu-bot.module';
import { FeishuBotProjectChat } from '../feishu-bot/feishu-bot-project-chat.entity';
import { FeishuBotTaskChat } from '../feishu-bot/feishu-bot-task-chat.entity';
import { ModelConfigModule } from '../model-config/model-config.module';
import { Backlog } from '../iterations/backlog.entity';
import { Project } from '../projects/project.entity';
import { Task } from '../tasks/task.entity';
import { TasksModule } from '../tasks/tasks.module';
import { Ticket } from '../tickets/ticket.entity';
import { Worker } from '../workers/worker.entity';
import { WorkersModule } from '../workers/workers.module';
import { TopicFollow } from './topic-follow.entity';
import { TopicPost } from './topic-post.entity';
import { TopicWorkerInbox } from './topic-worker-inbox.entity';
import { Topic } from './topic.entity';
import { TOPIC_EVENT_BUS } from './topic-events';
import { TopicFeishuService } from './topic-feishu.service';
import { TopicLoopService } from './topic-loop.service';
import { TopicNotifyService } from './topic-notify.service';
import { TopicReplyService } from './topic-reply.service';
import {
  TopicsController,
  TopicsMarkdownController,
} from './topics.controller';
import { TopicsService } from './topics.service';

/**
 * 话题（Topic）：挂在迭代项/缺陷/任务/工单/需求下的讨论串。
 * - 标题异步 AI 生成、优先级/标签/状态、关注与飞书双向同步；
 * - @ 真人机器人 → 飞书私聊；@ AI 机器人 → 收件箱 + 一次性会话回帖；
 * - 飞书同步与关注通知经 TOPIC_EVENT_BUS 解耦，避免循环依赖。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Topic,
      TopicPost,
      TopicFollow,
      TopicWorkerInbox,
      Worker,
      User,
      Backlog,
      Defect,
      Task,
      Ticket,
      Project,
      FeishuBotBacklogChat,
      FeishuBotTaskChat,
      FeishuBotProjectChat,
      FeishuBotConfig,
      Executor,
    ]),
    ModelConfigModule,
    WorkersModule,
    forwardRef(() => FeishuBotModule),
    forwardRef(() => TasksModule),
  ],
  controllers: [TopicsController, TopicsMarkdownController],
  providers: [
    TopicsService,
    TopicNotifyService,
    TopicFeishuService,
    TopicReplyService,
    TopicLoopService,
    { provide: TOPIC_EVENT_BUS, useValue: new Subject() },
  ],
  exports: [TopicsService, TopicFeishuService],
})
export class TopicsModule {}
