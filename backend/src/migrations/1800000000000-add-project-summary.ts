import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 需求摘要：projects 增加可空 summary（模型根据需求描述与「需求」类文档生成，≤200 字），
 * 人工可编辑；为空的既有需求在下次创建/同步或需求类文档变更时自动生成。
 */
export class AddProjectSummary1800000000000 implements MigrationInterface {
  name = 'AddProjectSummary1800000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "summary" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" DROP COLUMN IF EXISTS "summary"`,
    );
  }
}
