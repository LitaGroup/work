import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Sse,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import type { AuthedRequest } from '../auth/auth.guard';
import { UserRole, EvalSuitePurpose, EvalSuiteStatus } from '../common/enums';
import { EvalSuiteService, type CaseInput } from './eval-suite.service';
import type { EvalSuiteExport } from './eval-suite.service';
import {
  type CreateEvalRunInput,
  EvalEngineService,
} from './eval-engine.service';
import { EvalProgressService } from './eval-progress.service';
import type { EvalMcpPolicy } from './eval-worker-snapshot.entity';

/**
 * 评估体系 JSON API（TECH_DESIGN 14.1）。
 * 权限（14.5）：测试集维护=创建人/管理员；发起评估与查看报告=管理员
 * （被测对象是 AI 机器人，无绑定真人，因此无机器人所有者）。
 */
@Controller('eval')
export class EvalController {
  constructor(
    private readonly suites: EvalSuiteService,
    private readonly engine: EvalEngineService,
    private readonly progress: EvalProgressService,
  ) {}

  // ---- 测试集 ----

  @Get('suites')
  listSuites(@Req() req: AuthedRequest) {
    this.requireAdmin(req);
    return this.suites.list();
  }

  @Post('suites')
  createSuite(
    @Req() req: AuthedRequest,
    @Body()
    body: {
      name: string;
      description?: string | null;
      purpose?: EvalSuitePurpose;
      passThreshold?: number;
      defaultTimeoutSec?: number;
      maxQuestions?: number;
    },
  ) {
    const user = this.requireAdmin(req);
    return this.suites.create({ ...body, ownerId: user.id });
  }

  @Get('suites/:suiteId')
  getSuite(
    @Req() req: AuthedRequest,
    @Param('suiteId', ParseIntPipe) suiteId: number,
  ) {
    this.requireAdmin(req);
    return this.suites.detail(suiteId);
  }

  @Put('suites/:suiteId')
  updateSuite(
    @Req() req: AuthedRequest,
    @Param('suiteId', ParseIntPipe) suiteId: number,
    @Body()
    body: {
      name?: string;
      description?: string | null;
      purpose?: EvalSuitePurpose;
      passThreshold?: number;
      defaultTimeoutSec?: number;
      maxQuestions?: number;
      status?: EvalSuiteStatus;
    },
  ) {
    this.requireAdmin(req);
    return this.suites.update(suiteId, body);
  }

  @Put('suites/:suiteId/tags')
  updateSuiteTags(
    @Req() req: AuthedRequest,
    @Param('suiteId', ParseIntPipe) suiteId: number,
    @Body() body: { tags?: string[] },
  ) {
    this.requireAdmin(req);
    return this.suites.updateTags(suiteId, body.tags);
  }

  @Post('suites/:suiteId/archive')
  archiveSuite(
    @Req() req: AuthedRequest,
    @Param('suiteId', ParseIntPipe) suiteId: number,
  ) {
    this.requireAdmin(req);
    return this.suites.archive(suiteId);
  }

  @Post('suites/:suiteId/cases')
  addCase(
    @Req() req: AuthedRequest,
    @Param('suiteId', ParseIntPipe) suiteId: number,
    @Body() body: CaseInput,
  ) {
    this.requireAdmin(req);
    return this.suites.addCase(suiteId, body);
  }

  @Put('suites/:suiteId/cases/:caseId')
  updateCase(
    @Req() req: AuthedRequest,
    @Param('suiteId', ParseIntPipe) suiteId: number,
    @Param('caseId', ParseIntPipe) caseId: number,
    @Body() body: CaseInput,
  ) {
    this.requireAdmin(req);
    return this.suites.updateCase(suiteId, caseId, body);
  }

  @Delete('suites/:suiteId/cases/:caseId')
  deleteCase(
    @Req() req: AuthedRequest,
    @Param('suiteId', ParseIntPipe) suiteId: number,
    @Param('caseId', ParseIntPipe) caseId: number,
  ) {
    this.requireAdmin(req);
    return this.suites.deleteCase(suiteId, caseId);
  }

  @Post('suites/:suiteId/import')
  importSuite(
    @Req() req: AuthedRequest,
    @Param('suiteId', ParseIntPipe) suiteId: number,
    @Body() body: EvalSuiteExport,
  ) {
    this.requireAdmin(req);
    return this.suites.import(suiteId, body);
  }

  @Get('suites/:suiteId/export')
  @Header('Content-Type', 'application/json; charset=utf-8')
  exportSuite(
    @Req() req: AuthedRequest,
    @Param('suiteId', ParseIntPipe) suiteId: number,
  ) {
    this.requireAdmin(req);
    return this.suites.export(suiteId);
  }

  // ---- 评估批次 ----

  @Get('runs')
  listRuns(
    @Req() req: AuthedRequest,
    @Query('suiteId') suiteId?: string,
    @Query('targetWorkerId') targetWorkerId?: string,
  ) {
    this.requireAdmin(req);
    return this.engine.listRuns({
      ...(suiteId ? { suiteId: Number(suiteId) } : {}),
      ...(targetWorkerId ? { targetWorkerId: Number(targetWorkerId) } : {}),
    });
  }

  @Post('runs')
  createRun(
    @Req() req: AuthedRequest,
    @Body()
    body: Omit<CreateEvalRunInput, 'createdById' | 'createdByName'> & {
      mcpPolicy?: EvalMcpPolicy | null;
    },
  ) {
    const user = this.requireAdmin(req);
    return this.engine.createRun({
      ...body,
      createdById: user.id,
      createdByName: user.name ?? null,
    });
  }

  @Get('runs/:runId')
  getRun(
    @Req() req: AuthedRequest,
    @Param('runId', ParseIntPipe) runId: number,
  ) {
    this.requireAdmin(req);
    return this.engine.findRun(runId);
  }

  @Get('runs/:runId/items')
  getRunItems(
    @Req() req: AuthedRequest,
    @Param('runId', ParseIntPipe) runId: number,
  ) {
    this.requireAdmin(req);
    return this.engine.listItems(runId);
  }

  @Post('runs/:runId/cancel')
  cancelRun(
    @Req() req: AuthedRequest,
    @Param('runId', ParseIntPipe) runId: number,
  ) {
    this.requireAdmin(req);
    return this.engine.cancelRun(runId);
  }

  /** 批次实时进度：先推快照，评估项变化时再推（客户端直接使用快照数据） */
  @Sse('runs/:runId/stream')
  streamRun(
    @Req() req: AuthedRequest,
    @Param('runId', ParseIntPipe) runId: number,
  ): Observable<MessageEvent> {
    this.requireAdmin(req);
    const subject = new Subject<MessageEvent>();
    let closed = false;
    const push = async () => {
      if (closed) return;
      try {
        const [run, items] = await Promise.all([
          this.engine.findRun(runId),
          this.engine.listItems(runId),
        ]);
        subject.next({
          data: { run, items },
        });
      } catch {
        subject.next({
          data: { error: '评估批次不存在' },
        });
      }
    };
    void push();
    const unsubscribe = this.progress.onRun(runId, () => {
      void push();
    });
    const timer = setInterval(() => {
      if (!closed) subject.next({ type: 'ping', data: '' });
    }, 15_000);
    timer.unref();
    return new Observable<MessageEvent>((subscriber) => {
      const subscription = subject.subscribe(subscriber);
      return () => {
        closed = true;
        subscription.unsubscribe();
        unsubscribe();
        clearInterval(timer);
      };
    });
  }

  // ---- 评估项 ----

  @Get('items/:itemId')
  getItem(
    @Req() req: AuthedRequest,
    @Param('itemId', ParseIntPipe) itemId: number,
  ) {
    this.requireAdmin(req);
    return this.engine.findItem(itemId);
  }

  @Get('items/:itemId/events')
  getItemEvents(
    @Req() req: AuthedRequest,
    @Param('itemId', ParseIntPipe) itemId: number,
  ) {
    this.requireAdmin(req);
    return this.engine.listEvents(itemId);
  }

  @Get('items/:itemId/judgements')
  getItemJudgements(
    @Req() req: AuthedRequest,
    @Param('itemId', ParseIntPipe) itemId: number,
  ) {
    this.requireAdmin(req);
    return this.engine.listJudgements(itemId);
  }

  @Post('items/:itemId/rerun')
  rerunItem(
    @Req() req: AuthedRequest,
    @Param('itemId', ParseIntPipe) itemId: number,
  ) {
    this.requireAdmin(req);
    return this.engine.rerunItem(itemId);
  }

  @Post('items/:itemId/rejudge')
  rejudgeItem(
    @Req() req: AuthedRequest,
    @Param('itemId', ParseIntPipe) itemId: number,
  ) {
    this.requireAdmin(req);
    return this.engine.rejudgeItem(itemId);
  }

  /** 管理员校验（14.5 一期：评估体系整体仅管理员） */
  private requireAdmin(req: AuthedRequest): NonNullable<AuthedRequest['user']> {
    const user = req.user;
    if (!user || user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('评估体系仅管理员可操作');
    }
    return user;
  }
}
