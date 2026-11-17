import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../auth/user.entity';
import { Task } from '../tasks/task.entity';
import { TasksModule } from '../tasks/tasks.module';
import { WorkersModule } from '../workers/workers.module';
import { Wakeup } from './wakeup.entity';
import { WakeupsService } from './wakeups.service';

/**
 * 机器人定时唤醒：任务会话与「我的 AI」会话共用的到期投递服务。
 * 仅被 MCP 工具与内部调用使用，任务/机器人模块不反向依赖本模块。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Wakeup, Task, User]),
    TasksModule,
    WorkersModule,
  ],
  providers: [WakeupsService],
  exports: [WakeupsService],
})
export class WakeupsModule {}
