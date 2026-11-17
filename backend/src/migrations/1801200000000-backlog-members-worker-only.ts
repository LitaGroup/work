import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 迭代项成员机器人化：
 * - backlogs.members 由「角色 + userId」改为「角色 + workerId」：存量 userId 经
 *   workers.humanUserId 映射为真人机器人（真人用真人机器人表示）；无法映射的成员丢弃。
 * - feishu_bot_backlog_chats 增加 memberWorkerIds：跟踪已入群的机器人，用于只加不减的增量同步。
 */
export class BacklogMembersWorkerOnly1801200000000 implements MigrationInterface {
  name = 'BacklogMembersWorkerOnly1801200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "feishu_bot_backlog_chats" ADD COLUMN IF NOT EXISTS "memberWorkerIds" json NOT NULL DEFAULT '[]'`,
    );

    await queryRunner.query(`
      UPDATE "backlogs" AS b
      SET "members" = sub."members"
      FROM (
        SELECT
          b2."id",
          jsonb_agg(
            jsonb_build_object(
              'role', elem.value->>'role',
              'workerId', w."id",
              'name', w."name"
            )
            ORDER BY elem.ord
          ) AS "members"
        FROM "backlogs" b2
        CROSS JOIN LATERAL jsonb_array_elements(b2."members"::jsonb)
          WITH ORDINALITY AS elem(value, ord)
        JOIN "workers" w ON w."humanUserId" = (elem.value->>'userId')::int
        WHERE b2."members" IS NOT NULL
          AND jsonb_typeof(b2."members"::jsonb) = 'array'
          AND elem.value ? 'userId'
        GROUP BY b2."id"
      ) AS sub
      WHERE b."id" = sub."id"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "backlogs" AS b
      SET "members" = sub."members"
      FROM (
        SELECT
          b2."id",
          jsonb_agg(
            jsonb_build_object(
              'role', elem.value->>'role',
              'userId', w."humanUserId",
              'name', w."name"
            )
            ORDER BY elem.ord
          ) AS "members"
        FROM "backlogs" b2
        CROSS JOIN LATERAL jsonb_array_elements(b2."members"::jsonb)
          WITH ORDINALITY AS elem(value, ord)
        JOIN "workers" w ON w."id" = (elem.value->>'workerId')::int
        WHERE b2."members" IS NOT NULL
          AND jsonb_typeof(b2."members"::jsonb) = 'array'
          AND elem.value ? 'workerId'
          AND w."humanUserId" IS NOT NULL
        GROUP BY b2."id"
      ) AS sub
      WHERE b."id" = sub."id"
    `);

    await queryRunner.query(
      `ALTER TABLE "feishu_bot_backlog_chats" DROP COLUMN IF EXISTS "memberWorkerIds"`,
    );
  }
}
