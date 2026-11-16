import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 需求方：projects 增加可空 owner（飞书「需求方」人员字段单向同步，多姓名顿号连接），
 * 平台内可编辑（校验用户系统内），下次飞书同步会被源数据覆盖。
 */
export class AddProjectOwner1800100000000 implements MigrationInterface {
  name = 'AddProjectOwner1800100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "owner" character varying(200)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" DROP COLUMN IF EXISTS "owner"`,
    );
  }
}
