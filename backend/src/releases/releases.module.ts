import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../auth/user.entity';
import { FeishuBotModule } from '../feishu-bot/feishu-bot.module';
import { Project } from '../projects/project.entity';
import { Task } from '../tasks/task.entity';
import { TasksModule } from '../tasks/tasks.module';
import { ProjectRelease } from './project-release.entity';
import { ReleaseNotifyService } from './release-notify.service';
import {
  ReleaseRecordsController,
  ReleasesController,
  ReleasesMarkdownController,
} from './releases.controller';
import { ReleasesService } from './releases.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ProjectRelease, Project, User, Task]),
    FeishuBotModule,
    TasksModule,
  ],
  controllers: [
    ReleasesController,
    ReleasesMarkdownController,
    ReleaseRecordsController,
  ],
  providers: [ReleasesService, ReleaseNotifyService],
  exports: [ReleasesService],
})
export class ReleasesModule {}
