import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 机器人任务能力评估体系（TECH_DESIGN v1.2）第一期：
 * 评估数据（eval_suites / eval_cases / eval_case_points / eval_worker_snapshots /
 * eval_runs / eval_run_items / eval_events / eval_judgements）、
 * 执行记录（task_traces / task_trace_accesses）、
 * 任务评估标记（tasks.is_eval / tasks.eval_item_id）、
 * 机器人采集开关（workers.trace_enabled / workers.optimizer_readable）。
 */
export class BotEval1802100000000 implements MigrationInterface {
  name = 'BotEval1802100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "eval_suites" (
        "id" SERIAL PRIMARY KEY,
        "name" varchar(128) NOT NULL,
        "description" text,
        "purpose" varchar(16) NOT NULL DEFAULT '验证',
        "passThreshold" integer NOT NULL DEFAULT 80,
        "defaultTimeoutSec" integer NOT NULL DEFAULT 1800,
        "maxQuestions" integer NOT NULL DEFAULT 3,
        "version" integer NOT NULL DEFAULT 1,
        "ownerId" integer,
        "status" varchar(16) NOT NULL DEFAULT '启用',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_eval_suites_name" ON "eval_suites" ("name")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "eval_cases" (
        "id" SERIAL PRIMARY KEY,
        "suiteId" integer NOT NULL,
        "caseKey" varchar(64) NOT NULL,
        "seq" integer NOT NULL DEFAULT 0,
        "title" varchar(256) NOT NULL,
        "prompt" text NOT NULL,
        "clarify" text,
        "passThreshold" integer,
        "timeoutSec" integer,
        "enabled" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_eval_cases_suite_key" ON "eval_cases" ("suiteId", "caseKey")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "eval_case_points" (
        "id" SERIAL PRIMARY KEY,
        "caseId" integer NOT NULL,
        "seq" integer NOT NULL,
        "point" text NOT NULL,
        "required" boolean NOT NULL DEFAULT false,
        "weight" numeric(5,2) NOT NULL DEFAULT 1,
        "hint" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_eval_case_points_caseId" ON "eval_case_points" ("caseId")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "eval_worker_snapshots" (
        "id" SERIAL PRIMARY KEY,
        "workerId" integer NOT NULL,
        "source" varchar(16) NOT NULL DEFAULT '当前配置',
        "proposalId" integer,
        "kernel" varchar(32),
        "model" varchar(64),
        "agentsMdHash" char(64),
        "skillsHash" char(64),
        "rulesHash" char(64),
        "mcpServers" json,
        "packageUri" varchar(512),
        "configDigest" char(64),
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_eval_worker_snapshots_workerId" ON "eval_worker_snapshots" ("workerId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_eval_worker_snapshots_digest" ON "eval_worker_snapshots" ("configDigest")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "eval_runs" (
        "id" SERIAL PRIMARY KEY,
        "suiteId" integer NOT NULL,
        "suiteVersion" integer NOT NULL,
        "suiteSnapshot" json NOT NULL,
        "targetWorkerId" integer NOT NULL,
        "targetWorkerName" varchar(100) NOT NULL,
        "evaluatorWorkerId" integer NOT NULL,
        "snapshotId" integer NOT NULL,
        "proposalId" integer,
        "role" varchar(16) NOT NULL DEFAULT '普通',
        "repeatCount" integer NOT NULL DEFAULT 3,
        "concurrency" integer NOT NULL DEFAULT 3,
        "mcpPolicy" json,
        "status" varchar(16) NOT NULL DEFAULT '排队',
        "summary" json,
        "createdById" integer,
        "createdByName" varchar(100),
        "error" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "startedAt" timestamptz,
        "finishedAt" timestamptz,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_eval_runs_suiteId" ON "eval_runs" ("suiteId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_eval_runs_targetWorker" ON "eval_runs" ("targetWorkerId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_eval_runs_status" ON "eval_runs" ("status")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "eval_run_items" (
        "id" SERIAL PRIMARY KEY,
        "runId" integer NOT NULL,
        "caseId" integer NOT NULL,
        "repeatIndex" integer NOT NULL,
        "attempt" integer NOT NULL DEFAULT 1,
        "superseded" boolean NOT NULL DEFAULT false,
        "taskId" integer,
        "sandboxId" varchar(64),
        "status" varchar(24) NOT NULL DEFAULT '排队',
        "result" varchar(24),
        "firstScore" integer,
        "finalScore" integer,
        "questionCount" integer NOT NULL DEFAULT 0,
        "reworkCount" integer NOT NULL DEFAULT 0,
        "humanCount" integer NOT NULL DEFAULT 0,
        "interventionCount" integer NOT NULL DEFAULT 0,
        "acceptedAt" timestamptz,
        "firstApplyAt" timestamptz,
        "finalApplyAt" timestamptz,
        "endedAt" timestamptz,
        "waitAnswerMs" bigint,
        "netExecMs" bigint,
        "firstNetExecMs" bigint,
        "blockedWriteCount" integer NOT NULL DEFAULT 0,
        "errorMessage" varchar(1024),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_eval_run_items_runId" ON "eval_run_items" ("runId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_eval_run_items_taskId" ON "eval_run_items" ("taskId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_eval_run_items_status" ON "eval_run_items" ("status")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "eval_events" (
        "id" SERIAL PRIMARY KEY,
        "itemId" integer NOT NULL,
        "type" varchar(32) NOT NULL,
        "at" timestamptz(3) NOT NULL,
        "payload" json,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_eval_events_itemId" ON "eval_events" ("itemId")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "eval_judgements" (
        "id" SERIAL PRIMARY KEY,
        "itemId" integer NOT NULL,
        "round" integer NOT NULL,
        "attempt" integer NOT NULL DEFAULT 1,
        "model" varchar(64),
        "inputDigest" char(64),
        "rawOutput" text,
        "pointsResult" json,
        "score" integer,
        "pass" boolean,
        "reason" text,
        "truncated" boolean NOT NULL DEFAULT false,
        "effective" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_eval_judgements_itemId" ON "eval_judgements" ("itemId")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "task_traces" (
        "id" varchar(36) PRIMARY KEY,
        "taskId" integer,
        "workerId" integer NOT NULL,
        "kernel" varchar(32),
        "model" varchar(64),
        "configDigests" json,
        "isEval" boolean NOT NULL DEFAULT false,
        "evalItemId" integer,
        "role" varchar(16) NOT NULL DEFAULT '执行方',
        "status" varchar(16) NOT NULL DEFAULT '采集中',
        "outcome" text,
        "turnCount" integer NOT NULL DEFAULT 0,
        "stepCount" integer NOT NULL DEFAULT 0,
        "callCount" integer NOT NULL DEFAULT 0,
        "callErrorCount" integer NOT NULL DEFAULT 0,
        "blockedCount" integer NOT NULL DEFAULT 0,
        "windowAttributedCount" integer NOT NULL DEFAULT 0,
        "unattributedCount" integer NOT NULL DEFAULT 0,
        "questionCount" integer NOT NULL DEFAULT 0,
        "reworkCount" integer NOT NULL DEFAULT 0,
        "redactionCount" integer NOT NULL DEFAULT 0,
        "sizeBytes" bigint NOT NULL DEFAULT 0,
        "storageUri" varchar(512) NOT NULL,
        "startedAt" timestamptz(3) NOT NULL,
        "endedAt" timestamptz(3),
        "expireAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_task_traces_taskId" ON "task_traces" ("taskId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_task_traces_workerId" ON "task_traces" ("workerId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_task_traces_expireAt" ON "task_traces" ("expireAt")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "task_trace_accesses" (
        "id" SERIAL PRIMARY KEY,
        "traceId" varchar(36) NOT NULL,
        "readerName" varchar(100) NOT NULL,
        "readerKind" varchar(32),
        "readerId" integer,
        "action" varchar(32) NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_task_trace_accesses_traceId" ON "task_trace_accesses" ("traceId")
    `);

    await queryRunner.query(`
      ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "isEval" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "evalItemId" integer
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_tasks_isEval" ON "tasks" ("isEval")
    `);

    await queryRunner.query(`
      ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "traceEnabled" boolean NOT NULL DEFAULT true
    `);
    await queryRunner.query(`
      ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "optimizerReadable" boolean NOT NULL DEFAULT true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "eval_judgements"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "eval_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "eval_run_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "eval_runs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "eval_worker_snapshots"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "eval_case_points"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "eval_cases"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "eval_suites"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "task_trace_accesses"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "task_traces"`);
    await queryRunner.query(
      `ALTER TABLE "tasks" DROP COLUMN IF EXISTS "evalItemId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks" DROP COLUMN IF EXISTS "isEval"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workers" DROP COLUMN IF EXISTS "traceEnabled"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workers" DROP COLUMN IF EXISTS "optimizerReadable"`,
    );
  }
}
