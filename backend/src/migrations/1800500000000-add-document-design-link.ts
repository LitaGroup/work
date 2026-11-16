import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 链接型文档：documents 增加 url（type=设计，链接型不存正文），
 * documents_type_enum 增加「设计」值。
 * PostgreSQL 12+ 允许在事务内 ADD VALUE（同一事务不使用该值即可）。
 */
export class AddDocumentDesignLink1800500000000
  implements MigrationInterface
{
  name = 'AddDocumentDesignLink1800500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "url" character varying(500)`,
    );
    await queryRunner.query(
      `ALTER TYPE "documents_type_enum" ADD VALUE IF NOT EXISTS '设计'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN IF EXISTS "url"`,
    );
    // PostgreSQL 不支持删除枚举值，「设计」保留
  }
}