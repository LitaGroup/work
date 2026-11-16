import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 迭代项文档默认全量绑定：把未取消迭代项的原始需求文档补登到 backlog_documents。
 * 此后文档新增/导入时由应用层自动绑定（幂等）。
 */
export class LinkProjectDocumentsToBacklogs1800600000000 implements MigrationInterface {
  name = 'LinkProjectDocumentsToBacklogs1800600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "backlog_documents" ("backlogId", "documentId")
      SELECT b."id", d."id"
      FROM "backlogs" b
      JOIN "documents" d ON d."projectId" = b."projectId"
      WHERE b."status" <> '取消'
      ON CONFLICT ("backlogId", "documentId") DO NOTHING
    `);
  }

  public async down(): Promise<void> {
    // 关联为业务数据，回滚迁移不删除
  }
}
