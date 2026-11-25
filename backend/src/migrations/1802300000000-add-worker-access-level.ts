import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 机器人平台访问级别：无权限 / 普通（默认）/ 管理员。
 * 仅 AI 机器人使用该字段；真人机器人与个人 AGENT 动态跟随绑定真人的 UserRole。
 * 存量机器人默认「普通」，行为与升级前一致（不可调用管理面）。
 */
export class AddWorkerAccessLevel1802300000000 implements MigrationInterface {
  name = 'AddWorkerAccessLevel1802300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'workers_accessLevel_enum'
        ) THEN
          CREATE TYPE "workers_accessLevel_enum" AS ENUM ('无权限', '普通', '管理员');
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      ALTER TABLE "workers"
      ADD COLUMN IF NOT EXISTS "accessLevel"
      "workers_accessLevel_enum" NOT NULL DEFAULT '普通'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workers" DROP COLUMN IF EXISTS "accessLevel"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "workers_accessLevel_enum"`);
  }
}
