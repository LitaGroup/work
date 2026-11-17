import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 迭代描述：iterations 增加可空 description（平台内维护，默认空），
 * 用于迭代列表与详情页在起止日期前展示，并支持管理员就地编辑。
 */
export class AddIterationDescription1801400000000 implements MigrationInterface {
  name = 'AddIterationDescription1801400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "iterations" ADD COLUMN IF NOT EXISTS "description" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "iterations" DROP COLUMN IF EXISTS "description"`,
    );
  }
}
