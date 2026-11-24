import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Query,
  Req,
} from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth.guard';
import { BadRequestException } from '@nestjs/common';
import { TraceService } from './trace.service';
import { WorkerOwnerService } from './worker-owner.service';
import { WorkersService } from '../workers/workers.service';

/**
 * 执行记录 JSON API（TECH_DESIGN 14.3）：
 * - GET /api/tasks/{taskId}/trace —— 任务的执行记录；
 * - GET /api/traces/{traceId} —— 头信息与统计；
 * - GET /api/traces/{traceId}/steps —— 分页读取步骤；
 * - GET /api/workers/{workerId}/trace-stats —— 机器人维度聚合统计。
 * 权限（12.8）：机器人所有者（绑定真人的上级）或管理员；执行机器人自身、判决令牌、
 * 任务需求方（人）不可读。每次读取写访问日志。
 */
@Controller()
export class TraceController {
  constructor(
    private readonly trace: TraceService,
    private readonly owners: WorkerOwnerService,
    private readonly workers: WorkersService,
  ) {}

  @Get('tasks/:taskId/trace')
  async taskTrace(
    @Req() req: AuthedRequest,
    @Param('taskId', ParseIntPipe) taskId: number,
  ) {
    const user = this.requireUser(req);
    const trace = await this.trace.findByTask(taskId);
    if (!trace) return null;
    await this.assertReadable(user, trace.workerId);
    await this.trace.logAccess({
      traceId: trace.id,
      readerName: user.name,
      readerKind: 'user',
      readerId: user.id,
      action: 'read',
    });
    return trace;
  }

  @Get('traces/:traceId')
  async traceDetail(
    @Req() req: AuthedRequest,
    @Param('traceId') traceId: string,
  ) {
    const user = this.requireUser(req);
    const trace = await this.trace.findById(traceId);
    if (!trace) throw new BadRequestException('执行记录不存在');
    await this.assertReadable(user, trace.workerId);
    await this.trace.logAccess({
      traceId: trace.id,
      readerName: user.name,
      readerKind: 'user',
      readerId: user.id,
      action: 'read',
    });
    return trace;
  }

  @Get('traces/:traceId/steps')
  async traceSteps(
    @Req() req: AuthedRequest,
    @Param('traceId') traceId: string,
    @Query('fromSeq') fromSeq?: string,
    @Query('limit') limit?: string,
    @Query('types') types?: string,
    @Query('turn') turn?: string,
  ) {
    const user = this.requireUser(req);
    const trace = await this.trace.findById(traceId);
    if (!trace) throw new BadRequestException('执行记录不存在');
    await this.assertReadable(user, trace.workerId);
    await this.trace.logAccess({
      traceId: trace.id,
      readerName: user.name,
      readerKind: 'user',
      readerId: user.id,
      action: 'read',
    });
    return this.trace.readSteps(traceId, {
      fromSeq: fromSeq ? Number(fromSeq) : undefined,
      limit: limit ? Number(limit) : undefined,
      types: types
        ? types
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined,
      turn: turn ? Number(turn) : undefined,
    });
  }

  @Get('workers/:workerId/trace-stats')
  async workerStats(
    @Req() req: AuthedRequest,
    @Param('workerId', ParseIntPipe) workerId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const user = this.requireUser(req);
    await this.assertReadable(user, workerId);
    return this.trace.stats({
      workerId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  private requireUser(req: AuthedRequest): NonNullable<AuthedRequest['user']> {
    if (!req.user) throw new ForbiddenException('执行记录需要登录用户身份');
    return req.user;
  }

  /** 12.8 权限：机器人所有者（上级）或管理员 */
  private async assertReadable(
    user: NonNullable<AuthedRequest['user']>,
    workerId: number,
  ): Promise<void> {
    const worker = await this.workers.findOne(workerId).catch(() => null);
    if (!worker) throw new BadRequestException('机器人不存在');
    await this.owners.assertCanManageWorker(user, worker);
  }
}
