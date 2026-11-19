import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 修复迭代项成员历史数据：补齐/清理缺少 workerId 的成员行。
 *
 * 上一版迁移 `1801200000000-backlog-members-worker-only` 用内连接把 `userId` 映射为
 * 真人机器人，只有「至少一个成员映射成功」的迭代项才会被重写；全部成员都映射不到
 * 真人机器人时旧数组原样保留（`{role, userId, name}` 无 workerId），导致前端整体
 * 回传成员时报「成员「xxx」须提供 workerId、userId 或 name」。
 *
 * 本次按成员行逐一处理：
 * - 已有合法 workerId 的行原样保留（名称缺省回填快照姓名）；
 * - 缺少 workerId 的行重试 `userId → workers.humanUserId` 映射（用户可能在之后才补建
 *   真人机器人）；
 * - 仍映射不到的行丢弃（与「成员统一以机器人表示」的约定一致）；
 * - 清理后没有成员的迭代项置为 NULL。
 */
export class BacklogMembersRetryMapping1801700000000 implements MigrationInterface {
  name = 'BacklogMembersRetryMapping1801700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH expanded AS (
        SELECT
          b."id" AS backlog_id,
          x.ord,
          x.value,
          CASE
            WHEN x.value->>'workerId' ~ '^[0-9]+$'
              THEN (x.value->>'workerId')::int
            ELSE NULL
          END AS stored_worker_id,
          CASE
            WHEN x.value->>'userId' ~ '^[0-9]+$'
              THEN (x.value->>'userId')::int
            ELSE NULL
          END AS stored_user_id
        FROM "backlogs" b
        CROSS JOIN LATERAL jsonb_array_elements(b."members"::jsonb)
          WITH ORDINALITY AS x(value, ord)
        WHERE b."members" IS NOT NULL
          AND jsonb_typeof(b."members"::jsonb) = 'array'
      ),
      mapped AS (
        SELECT
          e.backlog_id,
          e.ord,
          e.value,
          COALESCE(e.stored_worker_id, human."id") AS worker_id,
          COALESCE(e.value->>'name', human."name", stored."name") AS worker_name
        FROM expanded e
        LEFT JOIN "workers" human ON human."humanUserId" = e.stored_user_id
        LEFT JOIN "workers" stored ON stored."id" = e.stored_worker_id
      ),
      repaired AS (
        SELECT
          a.backlog_id,
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'role', m.value->>'role',
                'workerId', m.worker_id,
                'name', m.worker_name
              )
              ORDER BY m.ord
            )
            FROM mapped m
            WHERE m.backlog_id = a.backlog_id
              AND m.worker_id IS NOT NULL
              AND m.value ? 'role'
          ) AS "members"
        FROM (SELECT DISTINCT backlog_id FROM expanded) a
      )
      UPDATE "backlogs" b
      SET "members" = r."members"
      FROM repaired r
      WHERE b."id" = r.backlog_id
    `);
  }

  public async down(): Promise<void> {
    // 已丢弃的无法映射成员没有原始数据可还原，且补齐的 workerId 是新的正确形态，无需回滚
  }
}
