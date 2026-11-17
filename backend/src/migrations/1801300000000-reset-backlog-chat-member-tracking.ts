import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 重置迭代项沟通群的成员跟踪：
 * - 旧版本建群后从不补拉真人成员，新增成员从未真正入群；
 * - 1801200000000 之后的首次对账又把当前成员直接记为「已入群」（只写跟踪、不拉人），
 *   导致这些成员被永久跳过，飞书群打开失败。
 *
 * 清空成员跟踪后，由每分钟对账按当前成员实际补拉（飞书拉人接口忽略已入群成员，
 * 重复调用是安全的），已有群的成员会在上线后自动补齐。
 */
export class ResetBacklogChatMemberTracking1801300000000 implements MigrationInterface {
  name = 'ResetBacklogChatMemberTracking1801300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "feishu_bot_backlog_chats" SET "memberWorkerIds" = '[]'`,
    );
  }

  public async down(): Promise<void> {
    // 派生的跟踪数据无需恢复：对账会按实际群成员重新写入
  }
}
