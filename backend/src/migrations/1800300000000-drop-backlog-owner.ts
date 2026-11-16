import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 需求方改为实时引用需求（projects.owner），迭代项不再存储快照：
 * 删除 backlogs.owner（若上一迁移已执行则一并清理）。
 */
export class DropBacklogOwner1800300000000 implements MigrationInterface {
  name = 'DropBacklogOwner1800300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backlogs" DROP COLUMN IF EXISTS "owner"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backlogs" ADD COLUMN IF NOT EXISTS "owner" character varying(200)`,
    );
  }
}
