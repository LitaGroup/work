import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 需求涉及方：projects 增加可空 involvedParties（字符串数组），
 * 由飞书「涉及方」多选字段单向同步，供需求详情编辑与迭代项信息区展示。
 */
export class AddProjectInvolvedParties1800900000000 implements MigrationInterface {
  name = 'AddProjectInvolvedParties1800900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "involvedParties" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" DROP COLUMN IF EXISTS "involvedParties"`,
    );
  }
}
