import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../auth/user.entity';
import { Executor } from '../executors/executor.entity';
import { TasksModule } from '../tasks/tasks.module';
import { Task } from '../tasks/task.entity';
import { TaskEvent } from '../tasks/task-event.entity';
import { TaskMessage } from '../tasks/task-message.entity';
import { WorkersModule } from '../workers/workers.module';
import { Worker } from '../workers/worker.entity';
import { EvalSuite, EvalCase, EvalCasePoint } from './eval-suite.entity';
import { EvalWorkerSnapshot } from './eval-worker-snapshot.entity';
import { EvalRun } from './eval-run.entity';
import { EvalRunItem } from './eval-run-item.entity';
import { EvalEvent, EvalJudgement } from './eval-judgement.entity';
import { EvalController } from './eval.controller';
import { EvalSuiteService } from './eval-suite.service';
import { EvalSandboxService } from './eval-sandbox.service';
import { EvalTokenService } from './eval-token.service';
import { EvalJudgeService } from './eval-judge.service';
import { EvalEngineService } from './eval-engine.service';
import { EvalShieldService } from './eval-shield.service';
import { EvalMdInterceptor } from './eval-md.interceptor';
import { EvalProgressService } from './eval-progress.service';

/**
 * 机器人任务能力评估体系（TECH_DESIGN v1.2 第一期）：
 * 测试集 / 用例 / 要点、配置快照、评估批次与评估项、评估令牌与权限策略、
 * 评估引擎（沙箱执行、规则答复、判定、返工、算分）与报告 API。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      EvalSuite,
      EvalCase,
      EvalCasePoint,
      EvalWorkerSnapshot,
      EvalRun,
      EvalRunItem,
      EvalEvent,
      EvalJudgement,
      Worker,
      Executor,
      Task,
      TaskEvent,
      TaskMessage,
      User,
    ]),
    forwardRef(() => TasksModule),
    WorkersModule,
  ],
  controllers: [EvalController],
  providers: [
    EvalSuiteService,
    EvalSandboxService,
    EvalTokenService,
    EvalJudgeService,
    EvalEngineService,
    EvalProgressService,
    EvalShieldService,
    EvalMdInterceptor,
  ],
  exports: [
    EvalTokenService,
    EvalEngineService,
    EvalJudgeService,
    EvalShieldService,
    EvalSuiteService,
    EvalProgressService,
    EvalMdInterceptor,
  ],
})
export class EvalModule {}
