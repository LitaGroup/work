import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 迭代类型调整与去名称：
 * - 迭代类型 W1 → T7（每周通道），新增 Tx（特殊通道）；
 * - 删除 iterations.name，唯一标识改由开始日期自动生成（T7：{yyyy}W{ww}，Tx：{yyyy}Tx{nn}）；
 * - 存量 W1 迭代保留并迁移为 T7。
 * 枚举类型命名遵循 {table}_{column}_enum。
 * 注意：PostgreSQL 的 ADD VALUE 不能在同一事务内立即使用，本迁移只新增不使用。
 */
export class IterationTypeT7Tx1799600000000 implements MigrationInterface {
  name = 'IterationTypeT7Tx1799600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'iterations_type_enum' AND e.enumlabel = 'W1'
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'iterations_type_enum' AND e.enumlabel = 'T7'
        ) THEN
          ALTER TYPE "iterations_type_enum" RENAME VALUE 'W1' TO 'T7';
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'iterations_type_enum' AND e.enumlabel = 'Tx'
        ) THEN
          ALTER TYPE "iterations_type_enum" ADD VALUE 'Tx';
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      ALTER TABLE "iterations" ALTER COLUMN "type" SET DEFAULT 'T7'
    `);
    await queryRunner.query(`
      ALTER TABLE "iterations" DROP COLUMN IF EXISTS "name"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 名称仅能回填标识作为兜底，原名称数据已随列删除
    await queryRunner.query(`
      ALTER TABLE "iterations" ADD COLUMN IF NOT EXISTS "name" varchar(200)
    `);
    await queryRunner.query(`
      UPDATE "iterations" SET "name" = "code" WHERE "name" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "iterations" ALTER COLUMN "name" SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "iterations" ALTER COLUMN "type" DROP DEFAULT
    `);
    await queryRunner.query(`
      UPDATE "iterations" SET "type" = 'T7' WHERE "type" = 'Tx'
    `);
    await queryRunner.query(`
      ALTER TYPE "iterations_type_enum" RENAME VALUE 'T7' TO 'W1'
    `);
    // 移除 Tx 枚举值须重建类型
    await queryRunner.query(`
      CREATE TYPE "iterations_type_enum_old" AS ENUM ('T0', 'W1')
    `);
    await queryRunner.query(`
      ALTER TABLE "iterations"
      ALTER COLUMN "type" TYPE "iterations_type_enum_old"
      USING "type"::text::"iterations_type_enum_old"
    `);
    await queryRunner.query(`DROP TYPE "iterations_type_enum"`);
    await queryRunner.query(`
      ALTER TYPE "iterations_type_enum_old" RENAME TO "iterations_type_enum"
    `);
    await queryRunner.query(`
      ALTER TABLE "iterations" ALTER COLUMN "type" SET DEFAULT 'W1'
    `);
  }
}
