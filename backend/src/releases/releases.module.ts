import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../auth/user.entity';
import { FeishuModule } from '../feishu/feishu.module';
import { Backlog } from '../iterations/backlog.entity';
import { Project } from '../projects/project.entity';
import { Task } from '../tasks/task.entity';
import { TasksModule } from '../tasks/tasks.module';
import { ProjectRelease } from './project-release.entity';
import {
  ReleaseRecordsController,
  ReleasesController,
  ReleasesMarkdownController,
} from './releases.controller';
import { ReleasesService } from './releases.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ProjectRelease, Project, User, Task, Backlog]),
    FeishuModule,
    TasksModule,
  ],
  controllers: [
    ReleasesController,
    ReleasesMarkdownController,
    ReleaseRecordsController,
  ],
  providers: [ReleasesService],
  exports: [ReleasesService],
})
export class ReleasesModule {}
