import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../auth/user.entity';
import { FeishuBotModule } from '../feishu-bot/feishu-bot.module';
import { Task } from '../tasks/task.entity';
import { Worker } from '../workers/worker.entity';
import { WorkersModule } from '../workers/workers.module';
import { TaskTrace, TaskTraceAccess } from './task-trace.entity';
import { TraceService } from './trace.service';
import { TraceController } from './trace.controller';
import { TraceMdInterceptor } from './trace-md.interceptor';
import { WorkerOwnerService } from './worker-owner.service';

/**
 * 执行记录（TECH_DESIGN 12）：平台侧采集、归属、截断脱敏、本地 JSONL 存储、
 * 到期清理、读取 API 与权限（所有者=绑定真人的上级 / 管理员）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TaskTrace, TaskTraceAccess, Worker, Task, User]),
    WorkersModule,
    FeishuBotModule,
  ],
  controllers: [TraceController],
  providers: [TraceService, WorkerOwnerService, TraceMdInterceptor],
  exports: [TraceService, WorkerOwnerService, TraceMdInterceptor],
})
export class TraceModule {}
