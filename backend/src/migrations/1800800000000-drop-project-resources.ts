import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 需求成员下线：需求只保留需求方（projects.owner），人员/成员改由迭代项（backlogs.members）维护。
 * - 删除 projects.resources（{frontend, backend, qa, product, client}）列；
 * - 飞书同步不再写入人员字段，存量数据随后续同步与本次迁移一并清理。
 */
export class DropProjectResources1800800000000 implements MigrationInterface {
  name = 'DropProjectResources1800800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" DROP COLUMN IF EXISTS "resources"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "resources" json`,
    );
  }
}
