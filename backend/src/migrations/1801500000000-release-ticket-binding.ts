import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 提测记录与提测工单绑定：
 * - project_releases.ends：提测端（APP / H5 / 后端，至少 1 个）；
 * - project_releases.ticketId / ticketCode：迭代项提测创建工单后回写关联；
 * - ticketId 索引：提测记录列表与工单反查。
 */
export class ReleaseTicketBinding1801500000000 implements MigrationInterface {
  name = 'ReleaseTicketBinding1801500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "project_releases"
      ADD COLUMN IF NOT EXISTS "ends" text
    `);
    await queryRunner.query(`
      ALTER TABLE "project_releases"
      ADD COLUMN IF NOT EXISTS "ticketId" integer
    `);
    await queryRunner.query(`
      ALTER TABLE "project_releases"
      ADD COLUMN IF NOT EXISTS "ticketCode" character varying(30)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_project_releases_ticketId"
      ON "project_releases" ("ticketId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_project_releases_ticketId"
    `);
    await queryRunner.query(`
      ALTER TABLE "project_releases"
      DROP COLUMN IF EXISTS "ticketCode"
    `);
    await queryRunner.query(`
      ALTER TABLE "project_releases"
      DROP COLUMN IF EXISTS "ticketId"
    `);
    await queryRunner.query(`
      ALTER TABLE "project_releases"
      DROP COLUMN IF EXISTS "ends"
    `);
  }
}
