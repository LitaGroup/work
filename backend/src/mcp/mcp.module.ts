import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { ChecksModule } from '../checks/checks.module';
import { DefectsModule } from '../defects/defects.module';
import { DocumentsModule } from '../documents/documents.module';
import { ExportsModule } from '../exports/exports.module';
import { FeedbacksModule } from '../feedbacks/feedbacks.module';
import { FeishuModule } from '../feishu/feishu.module';
import { FeishuBotGroup } from '../feishu-bot/feishu-bot-group.entity';
import { FeishuBotModule } from '../feishu-bot/feishu-bot.module';
import { FilesModule } from '../files/files.module';
import { GithubModule } from '../github/github.module';
import { IdeasModule } from '../ideas/ideas.module';
import { Iteration } from '../iterations/iteration.entity';
import { Backlog } from '../iterations/backlog.entity';
import { IterationsModule } from '../iterations/iterations.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ProjectsModule } from '../projects/projects.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { ScriptsModule } from '../scripts/scripts.module';
import { SettingsModule } from '../settings/settings.module';
import { TasksModule } from '../tasks/tasks.module';
import { TestsModule } from '../tests/tests.module';
import { TicketsModule } from '../tickets/tickets.module';
import { TopicsModule } from '../topics/topics.module';
import { WakeupsModule } from '../wakeups/wakeups.module';
import { WorkersModule } from '../workers/workers.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { McpCallLog } from './mcp-log.entity';
import { McpController } from './mcp.controller';
import { McpLogsController } from './mcp-logs.controller';
import { McpLogsService } from './mcp-logs.service';
import { McpService } from './mcp.service';
import { McpWorkController } from './mcp-work.controller';
import { McpWorkService } from './mcp-work.service';
import { McpAdminController } from './mcp-admin.controller';
import { McpAdminService } from './mcp-admin.service';
import { WorkDefectTools } from './work-tools/work-defect.tools';
import { WorkFeedbackTools } from './work-tools/work-feedback.tools';
import { WorkFeishuTools } from './work-tools/work-feishu.tools';
import { WorkFileTools } from './work-tools/work-file.tools';
import { WorkGithubTools } from './work-tools/work-github.tools';
import { WorkIdeaTools } from './work-tools/work-idea.tools';
import { WorkKnowledgeTools } from './work-tools/work-knowledge.tools';
import { WorkReviewTools } from './work-tools/work-review.tools';
import { WorkProjectTools } from './work-tools/work-project.tools';
import { WorkRunTools } from './work-tools/work-run.tools';
import { WorkTaskTools } from './work-tools/work-task.tools';
import { WorkTicketTools } from './work-tools/work-ticket.tools';
import { WorkTopicTools } from './work-tools/work-topic.tools';
import { WorkAgentTools } from './work-tools/work-agent.tools';
import { WorkIterationTools } from './work-tools/work-iteration.tools';
import { WorkWakeupTools } from './work-tools/work-wakeup.tools';
import { WorkEvalTools } from './work-tools/work-eval.tools';
import { WorkTraceTools } from './work-tools/work-trace.tools';
import { AdminEvalTools } from './admin-tools/admin-eval.tools';
import { AdminRunTools } from './admin-tools/admin-run.tools';
import { AdminTaskDefinesTools } from './admin-tools/admin-task-defines.tools';
import { AdminWorkerReviewTools } from './admin-tools/admin-worker-review.tools';
import { EvalModule } from '../eval/eval.module';
import { TraceModule } from '../trace/trace.module';
/**
 * MCP 开放：
 * - POST /api/mcp/bots：lita-bots，外部 Agent 把平台机器人当子 Agent 调用；
 * - POST /api/mcp/work：lita-work，平台基础业务工具（需求/迭代项/任务/工单/知识/运行等）；
 * - POST /api/mcp/work-admin：lita-work-admin，管理面工具（机器人/任务定义/
 *   测试集与评估/执行记录/平台设置），仅管理员可用。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([McpCallLog, FeishuBotGroup, Iteration, Backlog]),
    AuthModule,
    WorkersModule,
    ProjectsModule,
    DocumentsModule,
    ChecksModule,
    TestsModule,
    ExportsModule,
    SchedulesModule,
    KnowledgeModule,
    FilesModule,
    DefectsModule,
    FeedbacksModule,
    IdeasModule,
    SettingsModule,
    ScriptsModule,
    FeishuModule,
    FeishuBotModule,
    GithubModule,
    TasksModule,
    TicketsModule,
    WorkflowsModule,
    TopicsModule,
    IterationsModule,
    WakeupsModule,
    EvalModule,
    TraceModule,
  ],
  controllers: [
    McpController,
    McpWorkController,
    McpAdminController,
    McpLogsController,
  ],
  providers: [
    McpService,
    McpWorkService,
    McpAdminService,
    McpLogsService,
    WorkProjectTools,
    WorkRunTools,
    WorkKnowledgeTools,
    WorkReviewTools,
    WorkDefectTools,
    WorkFeedbackTools,
    WorkIdeaTools,
    WorkGithubTools,
    WorkFileTools,
    WorkTaskTools,
    WorkTicketTools,
    WorkTopicTools,
    WorkAgentTools,
    WorkFeishuTools,
    WorkIterationTools,
    WorkWakeupTools,
    WorkEvalTools,
    WorkTraceTools,
    AdminEvalTools,
    AdminRunTools,
    AdminTaskDefinesTools,
    AdminWorkerReviewTools,
  ],
})
export class McpModule {}
