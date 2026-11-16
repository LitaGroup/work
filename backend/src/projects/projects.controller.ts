import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth.guard';
import { ProjectStatus, ProjectType } from '../common/enums';
import { Project } from './project.entity';
import { ProjectSyncService, SyncProjectsResult } from './project-sync.service';
import {
  IterationGroup,
  ProjectPage,
  ProjectPageQuery,
  ProjectsService,
} from './projects.service';

class CreateProjectDto {
  name: string;
  type?: ProjectType;
  /** ISO 日期，如 2026-09-01 */
  expectedReleaseAt?: string;
  description?: string;
}

class UpdateProjectDto {
  /** 项目类型 */
  type?: ProjectType;
  /** 优先级（如 S0/P0），空串清除 */
  priority?: string;
  /** 计划周(w)（如 "w281：08/19 - 08/25"，飞书 w 字段），空串清除 */
  iterationCycle?: string;
  /** 预期发布时间（YYYY-MM-DD），空串清除 */
  expectedReleaseAt?: string;
  /** 需求方（姓名，多个顿号连接；须在用户系统内），空串清除 */
  owner?: string;
  /** 备注（飞书「排期优先级」+「排期备注」同步合成；平台内可编辑，下次同步覆盖），空串清除 */
  remark?: string;
  /** 脚本目录：相对 CHECK_SCRIPTS_DIR 的路径，空串清除 */
  scriptsPath?: string;
  /** 项目描述（Markdown），空串清除 */
  description?: string;
  /** 需求摘要（≤200 字），空串清除；清空后会在需求或需求类文档变更时重新自动生成 */
  summary?: string;
}

/** AI 用更新 DTO 已随需求视图迁至 RequirementsController（/api/requirements/:id/update.md） */

class SyncFeishuDto {
  /** true 时忽略时间窗口，全量扫描同步 */
  full?: boolean;
}

@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly projectSyncService: ProjectSyncService,
  ) {}

  @Get()
  findAll(): Promise<Project[]> {
    return this.projectsService.findAll();
  }

  /** Markdown 模糊搜索已迁至需求视图：GET /api/requirements/search.md */

  /** 项目表格分页（须声明在 :id 之前）：page/pageSize/q/iteration/status/type/priority/view */
  @Get('page')
  findPage(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('q') q?: string,
    @Query('iteration') iteration?: string,
    @Query('status') status?: ProjectStatus,
    @Query('type') type?: ProjectType,
    @Query('priority') priority?: string,
    @Query('view') view?: string,
  ): Promise<ProjectPage> {
    const query: ProjectPageQuery = {};
    if (page) query.page = +page;
    if (pageSize) query.pageSize = +pageSize;
    if (q) query.q = q;
    if (iteration) query.iteration = iteration;
    if (status) query.status = status;
    if (type) query.type = type;
    if (priority) query.priority = priority;
    if (view === 'unscheduled' || view === 'scheduled' || view === 'expired') {
      query.view = view;
    }
    return this.projectsService.findPage(query);
  }

  /** 迭代分组视图（须声明在 :id 之前）：需求按迭代周期聚合 + 状态计数，业务分区「迭代」栏目用 */
  @Get('iterations')
  groupIterations(): Promise<IterationGroup[]> {
    return this.projectsService.groupIterations();
  }

  /** 从飞书多维表格同步项目（手动固定取近 15 天有更新的记录；full=true 全量） */
  @Post('sync-feishu')
  syncFromFeishu(@Body() dto?: SyncFeishuDto): Promise<SyncProjectsResult> {
    return this.projectSyncService.syncFromFeishu(!!dto?.full, true);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number): Promise<Project> {
    return this.projectsService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateProjectDto): Promise<Project> {
    return this.projectsService.create(dto);
  }

  /** 幂等创建项目开发交付任务，并返回任务进展快照 */
  @Post(':id/delivery-task')
  ensureDeliveryTask(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: AuthedRequest,
  ) {
    return this.projectsService.ensureProjectDeliveryTask(
      id,
      req.user ? { userId: req.user.id, userName: req.user.name } : undefined,
    );
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProjectDto,
  ): Promise<Project> {
    return this.projectsService.update(id, dto);
  }

  /** AI 更新已迁至需求视图：POST /api/requirements/:id/update.md */

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.projectsService.remove(id);
  }
}
