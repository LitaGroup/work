import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 取消迭代项自动建群：清理从未建成群的绑定（chat_id 为空）。
 * 这些记录原本由自动建群流程写入，上线后会被对账继续补建；
 * 手动建群会按需重新建立绑定，已建成的群不受影响。
 */
export class DropPendingBacklogChats1801000000000 implements MigrationInterface {
  name = 'DropPendingBacklogChats1801000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "feishu_bot_backlog_chats" WHERE "chatId" IS NULL`,
    );
  }

  public async down(): Promise<void> {
    // 已删除的未建成绑定无需恢复：手动建群会重新写入
  }
}
