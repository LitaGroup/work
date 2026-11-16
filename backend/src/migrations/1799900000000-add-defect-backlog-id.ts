import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 缺陷关联迭代项：defects 增加可空 backlogId（应用层软引用 backlogs.id，无物理外键），
 * 支持在迭代项详情页按迭代维度维护与查看缺陷。
 * 历史缺陷保持为空，仍按项目维度可查，不影响既有数据。
 */
export class AddDefectBacklogId1799900000000 implements MigrationInterface {
  name = 'AddDefectBacklogId1799900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "defects" ADD COLUMN IF NOT EXISTS "backlogId" integer`,
    );
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_defects_backlogId"
      ON "defects" ("backlogId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_defects_backlogId"`);
    await queryRunner.query(
      `ALTER TABLE "defects" DROP COLUMN IF EXISTS "backlogId"`,
    );
  }
}
