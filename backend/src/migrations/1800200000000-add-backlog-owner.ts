import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 迭代项需求方：backlogs 增加可空 owner（转入时取自原始需求 projects.owner 的快照），
 * 与负责人 ownerWorkerId/ownerName（执行机器人）语义不同。
 */
export class AddBacklogOwner1800200000000 implements MigrationInterface {
  name = 'AddBacklogOwner1800200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backlogs" ADD COLUMN IF NOT EXISTS "owner" character varying(200)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "backlogs" DROP COLUMN IF EXISTS "owner"`,
    );
  }
}
