import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  MessageEvent,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Sse,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import type { AuthedRequest } from '../auth/auth.guard';
import {
  TopicPriority,
  TopicStatus,
  TopicSubjectType,
  UserRole,
} from '../common/enums';
import { TopicPost } from './topic-post.entity';
import { Topic } from './topic.entity';
import {
  type CreateTopicInput,
  type CreateTopicPostInput,
  type TopicActor,
  type TopicPostView,
  TopicsService,
  type UpdateTopicInput,
} from './topics.service';

class CreateTopicDto implements CreateTopicInput {
  /** 主体类型：迭代项/缺陷/任务/工单/需求 */
  subjectType: TopicSubjectType;
  /** 主体 ID */
  subjectId: number;
  /** 标题（可省略：用正文首行兜底并异步由模型生成「TP-{id}」标题） */
  title?: string;
  /** 首楼正文（Markdown，必填） */
  content: string;
  /** 优先级：高/中/低（默认中） */
  priority?: TopicPriority;
  /** 标签（自由输入，最多 10 个） */
  tags?: string[];
  /** @ 的机器人（workers.id） */
  mentions?: number[];
}

class UpdateTopicDto implements UpdateTopicInput {
  title?: string;
  content?: string;
  priority?: TopicPriority;
  tags?: string[];
  status?: TopicStatus;
}

class CreateTopicPostDto {
  /** 正文（Markdown，必填） */
  content: string;
  /** 引用的帖子（同话题内） */
  replyToPostId?: number | null;
  /** @ 的机器人（workers.id） */
  mentions?: number[];
}

/** 操作人：网页真人或机器人令牌（普通机器人以自身身份参与讨论） */
function topicActor(req: AuthedRequest): TopicActor {
  const user = req.user;
  const worker = req.worker;
  if (!user && !worker) {
    throw new ForbiddenException('话题操作需要真人登录身份或机器人令牌');
  }
  return {
    userId: user?.id ?? null,
    workerId: worker?.id ?? null,
    userName: worker?.name ?? user?.name ?? '公共 Agent',
    isAdmin: user?.role === UserRole.ADMIN,
  };
}

/** 关注等真人动作必须携带登录用户 */
function requireUser(req: AuthedRequest): number {
  if (!req.user) throw new ForbiddenException('该操作需要真人登录身份');
  return req.user.id;
}

@Controller('topics')
export class TopicsController {
  constructor(private readonly topicsService: TopicsService) {}

  /** 话题列表：subjectType/subjectId/status/priority/tag/q/following */
  @Get()
  list(
    @Req() req: AuthedRequest,
    @Query('subjectType') subjectType?: TopicSubjectType,
    @Query('subjectId') subjectId?: string,
    @Query('status') status?: TopicStatus,
    @Query('priority') priority?: TopicPriority,
    @Query('tag') tag?: string,
    @Query('q') q?: string,
    @Query('following') following?: string,
  ): Promise<Topic[]> {
    const followingUserId =
      following === '1' || following === 'true' ? req.user?.id : undefined;
    return this.topicsService.list({
      subjectType,
      subjectId: subjectId ? Number(subjectId) : undefined,
      status,
      priority,
      tag: tag?.trim() || undefined,
      q: q?.trim() || undefined,
      followingUserId,
    });
  }

  /** 标签建议（最近话题出现过的标签） */
  @Get('tags')
  listTags(): Promise<string[]> {
    return this.topicsService.listTags();
  }

  /** 我关注的话题 */
  @Get('following')
  listFollowing(@Req() req: AuthedRequest): Promise<Topic[]> {
    return this.topicsService.listFollowed(requireUser(req));
  }

  /** 创建话题（任何登录用户 / 机器人经 MCP） */
  @Post()
  create(
    @Body() dto: CreateTopicDto,
    @Req() req: AuthedRequest,
  ): Promise<Topic> {
    return this.topicsService.create(dto, topicActor(req));
  }

  /** Markdown 详情视图（须声明在 :id 之前） */
  @Get(':id.md')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  findOneMarkdown(@Param('id', ParseIntPipe) id: number): Promise<string> {
    return this.topicsService.findOneMarkdown(id);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number): Promise<Topic> {
    return this.topicsService.findOne(id);
  }

  /** 帖子列表（平铺楼层 + 引用摘要） */
  @Get(':id/posts')
  listPosts(@Param('id', ParseIntPipe) id: number): Promise<TopicPostView[]> {
    return this.topicsService.listPosts(id);
  }

  /** 话题实时流：先快照后增量（新帖/状态变化），机器人答复即时可见 */
  @Sse(':id/stream')
  stream(@Param('id', ParseIntPipe) id: number): Observable<MessageEvent> {
    return this.topicsService.stream(id);
  }

  /** 是否已关注当前用户 */
  @Get(':id/follow')
  async followed(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: AuthedRequest,
  ): Promise<{ following: boolean }> {
    return {
      following: await this.topicsService.isFollowing(id, req.user?.id ?? null),
    };
  }

  /** 更新话题（创建人或管理员）：标题/正文/优先级/标签/状态 */
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTopicDto,
    @Req() req: AuthedRequest,
  ): Promise<Topic> {
    return this.topicsService.update(id, dto, topicActor(req));
  }

  /** 删除话题（仅管理员） */
  @Delete(':id')
  @HttpCode(204)
  remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    return this.topicsService.remove(id, topicActor(req));
  }

  /** 发帖（任何登录用户 / 机器人） */
  @Post(':id/posts')
  createPost(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateTopicPostDto,
    @Req() req: AuthedRequest,
  ): Promise<TopicPost> {
    const input: CreateTopicPostInput = dto;
    return this.topicsService.createPost(id, input, topicActor(req));
  }

  /** 删除帖子（仅管理员） */
  @Delete(':id/posts/:postId')
  @HttpCode(204)
  removePost(
    @Param('id', ParseIntPipe) id: number,
    @Param('postId', ParseIntPipe) postId: number,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    return this.topicsService.removePost(id, postId, topicActor(req));
  }

  /** 关注话题（真人登录） */
  @Post(':id/follow')
  @HttpCode(204)
  follow(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    return this.topicsService.follow(id, requireUser(req));
  }

  /** 取消关注 */
  @Delete(':id/follow')
  @HttpCode(204)
  unfollow(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    return this.topicsService.unfollow(id, requireUser(req));
  }

  /**
   * 机器人回帖（.md 端点，X-Worker-Token）：返回 Markdown 回执。
   * 供 @ AI 机器人的一次性会话调用；回帖成功后自动关闭对应收件箱条目。
   */
  @Post(':id/posts.md')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  async createPostMarkdown(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateTopicPostDto,
    @Req() req: AuthedRequest,
  ): Promise<string> {
    const post = await this.topicsService.createPost(
      id,
      { ...dto },
      topicActor(req),
    );
    return `# 回帖成功\n\n- 帖子 ID：${post.id}\n- 话题：GET /api/topics/${id}.md\n`;
  }
}

/** GET /api/topics.md：话题清单 Markdown 视图（独立控制器避开 :id 路由） */
@Controller('topics.md')
export class TopicsMarkdownController {
  constructor(private readonly topicsService: TopicsService) {}

  @Get()
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  listMarkdown(
    @Query('subjectType') subjectType?: TopicSubjectType,
    @Query('subjectId') subjectId?: string,
    @Query('status') status?: TopicStatus,
    @Query('priority') priority?: TopicPriority,
    @Query('tag') tag?: string,
    @Query('q') q?: string,
  ): Promise<string> {
    return this.topicsService.listMarkdown({
      subjectType,
      subjectId: subjectId ? Number(subjectId) : undefined,
      status,
      priority,
      tag: tag?.trim() || undefined,
      q: q?.trim() || undefined,
    });
  }
}
