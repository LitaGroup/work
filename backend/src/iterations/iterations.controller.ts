import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth.guard';
import {
  BacklogStatus,
  IterationStatus,
  IterationType,
  UserRole,
} from '../common/enums';
import { BacklogsService } from './backlogs.service';
import { IterationsService } from './iterations.service';
import {
  BacklogMemberInput,
  CreateBacklogItemInput,
  CreateBacklogTaskInput,
  CreateIterationInput,
  IterationActor,
  UpdateIterationInput,
} from './iteration.types';
import { Backlog } from './backlog.entity';
import { Iteration } from './iteration.entity';

/** 迭代网页操作必须携带真人登录身份 */
function iterationActor(req: AuthedRequest): IterationActor {
  const user = req.user;
  if (!user) {
    throw new ForbiddenException('迭代操作需要真人登录身份');
  }
  return {
    userId: user.id,
    userName: user.name,
    isAdmin: user.role === UserRole.ADMIN,
    // 真人机器人令牌经 .md/机器人通道命中时带上；网页通常为空
    workerId: req.worker?.id ?? null,
  };
}

class CreateIterationDto implements CreateIterationInput {
  /** 类型：T7 每周通道 / Tx 特殊通道（T0 不可创建） */
  type: IterationType;
  /** 开始日期 YYYY-MM-DD */
  startAt?: string | null;
  /** 结束日期 YYYY-MM-DD */
  endAt?: string | null;
}

class UpdateIterationDto implements UpdateIterationInput {
  startAt?: string | null;
  endAt?: string | null;
  /** 进行中 / 已结束 */
  status?: IterationStatus;
  /** 描述（可空；最长 200 字，传 null 清空） */
  description?: string | null;
}

class CreateBacklogItemDto implements CreateBacklogItemInput {
  /** 原始需求（projects.id） */
  projectId: number;
  /** 负责人机器人（workers.id，AI 或真人）；可空表示暂不指定 */
  ownerWorkerId?: number | null;
  /** 成员：角色 + 平台用户 */
  members?: BacklogMemberInput[];
}

class CreateBacklogsDto {
  items: CreateBacklogItemDto[];
}

class UpdateBacklogStatusDto {
  /** 等待 / 执行 / 测试 / 发布 / 完成 / 取消 */
  status: BacklogStatus;
  /** 备注（可空；写入迭代项事件流） */
  remark?: string;
}

class UpdateBacklogDto {
  /** 预期上线时间（ISO 字符串，到小时；传 null 清空） */
  expectedOnlineAt?: string | null;
  /** 负责人机器人（workers.id）：管理员指定/改派，改派时取消旧交付任务并按新负责人重建 */
  ownerWorkerId?: number;
}

class MoveBacklogDto {
  /** 目标迭代（iterations.id） */
  iterationId: number;
}

class UpdateBacklogMembersDto {
  members: BacklogMemberInput[];
}

class CreateBacklogTaskDto implements CreateBacklogTaskInput {
  /** 标题（可空，缺省按描述首行生成；交付任务缺省用「迭代任务-{需求名}」） */
  title?: string;
  /** 任务描述（Markdown） */
  description?: string | null;
  /** 任务定义（可空；交付任务缺省用系统「迭代-Backlog交付」） */
  templateId?: number | null;
  /** 执行机器人（可空；无交付任务时作为负责人，必填） */
  agentId?: number | null;
}

class CreateBacklogReleaseTicketDto {
  /** 工单标题（缺省自动生成「提测-{code} {标题}」） */
  title?: string;
  /** 补充说明（Markdown，可空；拼入工单描述） */
  supplement?: string;
}

@Controller('iterations')
export class IterationsController {
  constructor(
    private readonly iterationsService: IterationsService,
    private readonly backlogsService: BacklogsService,
  ) {}

  /** 迭代列表（T0 置顶，其余按开始日期倒序），含 backlog 进度 */
  @Get()
  list(
    @Query('type') type?: IterationType,
    @Query('status') status?: IterationStatus,
  ): ReturnType<IterationsService['list']> {
    return this.iterationsService.list({ type, status });
  }

  /** 创建 T7 每周通道 / Tx 特殊通道（仅管理员；标识自动生成） */
  @Post()
  create(
    @Body() dto: CreateIterationDto,
    @Req() req: AuthedRequest,
  ): Promise<Iteration> {
    return this.iterationsService.create(dto, iterationActor(req));
  }

  /** Markdown 详情视图（须声明在 :id 之前） */
  @Get(':id.md')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  findOneMarkdown(@Param('id', ParseIntPipe) id: number): Promise<string> {
    return this.iterationsService.findOneMarkdown(id);
  }

  /** 迭代详情：迭代信息 + 迭代项列表 */
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.iterationsService.findOne(id);
  }

  /** 更新迭代：起止日期 / 结束或重开（仅管理员；T7 改开始日期重算标识） */
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateIterationDto,
    @Req() req: AuthedRequest,
  ): Promise<Iteration> {
    return this.iterationsService.update(id, dto, iterationActor(req));
  }

  /** 批量转入：选中需求转为该迭代的 backlog（每条必填负责人） */
  @Post(':id/backlogs')
  createBacklogs(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateBacklogsDto,
    @Req() req: AuthedRequest,
  ): Promise<Backlog[]> {
    return this.backlogsService.createBatch(
      id,
      dto.items ?? [],
      iterationActor(req),
    );
  }
}

/** GET /api/iterations.md：迭代清单 Markdown 视图 */
@Controller('iterations.md')
export class IterationsMarkdownController {
  constructor(private readonly iterationsService: IterationsService) {}

  @Get()
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  listMarkdown(
    @Query('type') type?: IterationType,
    @Query('status') status?: IterationStatus,
  ): Promise<string> {
    return this.iterationsService.listMarkdown({ type, status });
  }
}

@Controller('backlogs')
export class BacklogsController {
  constructor(private readonly backlogsService: BacklogsService) {}

  /**
   * 迭代项轻量列表：默认仅未取消（含各迭代），供选择器过滤已进入迭代的需求。
   * 支持 iterationId / projectId / status / includeCanceled 过滤，上限 1000 条。
   */
  @Get()
  list(
    @Query('iterationId') iterationId?: string,
    @Query('projectId') projectId?: string,
    @Query('status') status?: BacklogStatus,
    @Query('includeCanceled') includeCanceled?: string,
  ): ReturnType<BacklogsService['list']> {
    const parseId = (value?: string): number | undefined => {
      if (value === undefined || value === '') return undefined;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new BadRequestException('过滤 ID 非法');
      }
      return parsed;
    };
    if (
      status !== undefined &&
      !Object.values(BacklogStatus).includes(status)
    ) {
      throw new BadRequestException('迭代项状态非法');
    }
    return this.backlogsService.list({
      iterationId: parseId(iterationId),
      projectId: parseId(projectId),
      status,
      includeCanceled: includeCanceled === 'true' || includeCanceled === '1',
    });
  }

  /** Markdown 详情视图（须声明在 :id 之前） */
  @Get(':id.md')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  findOneMarkdown(@Param('id', ParseIntPipe) id: number): Promise<string> {
    return this.backlogsService.findOneMarkdown(id);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: AuthedRequest,
  ): ReturnType<BacklogsService['getDetail']> {
    return this.backlogsService.getDetail(
      id,
      req.user ? iterationActor(req) : undefined,
    );
  }

  /** 状态流转（成员或管理员）：备注可空，写入事件流 */
  @Post(':id/status')
  updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBacklogStatusDto,
    @Req() req: AuthedRequest,
  ): Promise<Backlog> {
    return this.backlogsService.updateStatus(
      id,
      dto.status,
      iterationActor(req),
      dto.remark,
    );
  }

  /** 更新迭代项属性（预期上线时间）；成员或管理员 */
  @Patch(':id')
  updateBacklog(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBacklogDto,
    @Req() req: AuthedRequest,
  ): Promise<Backlog> {
    return this.backlogsService.updateBacklog(id, dto, iterationActor(req));
  }

  /** 关联文档列表（不含正文大字段） */
  @Get(':id/documents')
  listDocuments(
    @Param('id', ParseIntPipe) id: number,
  ): ReturnType<BacklogsService['listDocuments']> {
    return this.backlogsService.listDocuments(id);
  }

  /** 事件流（倒序，最近 100 条） */
  @Get(':id/events')
  listEvents(
    @Param('id', ParseIntPipe) id: number,
  ): ReturnType<BacklogsService['listEvents']> {
    return this.backlogsService.listEvents(id);
  }

  /** 任务与工单面板：交付任务树（含子任务）+ 相关工单 */
  @Get(':id/tasks')
  relatedRecords(
    @Param('id', ParseIntPipe) id: number,
  ): ReturnType<BacklogsService['relatedRecords']> {
    return this.backlogsService.relatedRecords(id);
  }

  /**
   * 新建任务：已有交付任务时创建其子任务（成员或管理员）；
   * 无交付任务时按执行机器人创建交付任务并登记负责人（仅管理员）。
   */
  @Post(':id/tasks')
  createTask(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateBacklogTaskDto,
    @Req() req: AuthedRequest,
  ): ReturnType<BacklogsService['createTask']> {
    return this.backlogsService.createTask(id, dto ?? {}, iterationActor(req));
  }

  /** 发起提测（创建提测工单，自动填入迭代项上下文）；成员或管理员 */
  @Post(':id/release-ticket')
  createReleaseTicket(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateBacklogReleaseTicketDto,
    @Req() req: AuthedRequest,
  ) {
    return this.backlogsService.createReleaseTicket(
      id,
      dto ?? {},
      iterationActor(req),
      { user: req.user, worker: req.worker },
    );
  }

  /** 移动迭代项到另一个迭代（不重建交付任务与沟通群） */
  @Post(':id/move')
  move(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MoveBacklogDto,
    @Req() req: AuthedRequest,
  ): Promise<Backlog> {
    return this.backlogsService.move(id, dto.iterationId, iterationActor(req));
  }

  /** 手动创建/重试飞书沟通群（成员或管理员；已建成的群返回现有状态） */
  @Post(':id/feishu-chat')
  createFeishuChat(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: AuthedRequest,
  ): ReturnType<BacklogsService['createFeishuChat']> {
    return this.backlogsService.createFeishuChat(id, iterationActor(req));
  }

  /** 更新成员（仅管理员） */
  @Patch(':id/members')
  updateMembers(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBacklogMembersDto,
    @Req() req: AuthedRequest,
  ): Promise<Backlog> {
    return this.backlogsService.updateMembers(
      id,
      dto.members ?? [],
      iterationActor(req),
    );
  }
}
