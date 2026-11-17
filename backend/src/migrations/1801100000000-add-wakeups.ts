import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 机器人定时唤醒表：任务会话（kind=task）与「我的 AI」会话（kind=agent）共用。
 * 每任务 / 每用户会话范围只保留一条 scheduled（部分唯一索引兜底），
 * 到期由扫描器投递；任务结束只记录不再唤醒。
 */
export class AddWakeups1801100000000 implements MigrationInterface {
  name = 'AddWakeups1801100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "wakeups" (
        "id" SERIAL PRIMARY KEY,
        "kind" varchar(10) NOT NULL,
        "taskId" integer,
        "userId" integer,
        "scope" varchar(120),
        "workerId" integer NOT NULL,
        "note" text,
        "wakeAt" timestamptz NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'scheduled',
        "attempts" integer NOT NULL DEFAULT 0,
        "lastAttemptAt" timestamptz,
        "nextRetryAt" timestamptz,
        "lastError" text,
        "deliveredAt" timestamptz,
        "canceledAt" timestamptz,
        "canceledReason" varchar(200),
        "processedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wakeups_task_scheduled"
      ON "wakeups" ("taskId")
      WHERE "kind" = 'task' AND "status" = 'scheduled'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wakeups_agent_scheduled"
      ON "wakeups" ("userId", "scope")
      WHERE "kind" = 'agent' AND "status" = 'scheduled'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wakeups_due"
      ON "wakeups" ("status", "wakeAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wakeups_taskId"
      ON "wakeups" ("taskId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "wakeups"`);
  }
}
