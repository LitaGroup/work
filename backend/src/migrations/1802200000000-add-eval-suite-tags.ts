import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 测试集标签：eval_suites 增加 tags（字符串数组），
 * 用于管理区「机器人评估 · 测试集」的人工分类展示，不参与评估计分。
 */
export class AddEvalSuiteTags1802200000000 implements MigrationInterface {
  name = 'AddEvalSuiteTags1802200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "eval_suites" ADD COLUMN IF NOT EXISTS "tags" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "eval_suites" DROP COLUMN IF EXISTS "tags"`,
    );
  }
}
