import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 需求备注：projects 增加可空 remark（平台内维护，不随飞书同步），
 * 供需求详情编辑与迭代项信息区展示。
 */
export class AddProjectRemark1800400000000 implements MigrationInterface {
  name = 'AddProjectRemark1800400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "remark" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" DROP COLUMN IF EXISTS "remark"`,
    );
  }
}