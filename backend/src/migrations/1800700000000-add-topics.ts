import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 全局话题（Topic）：
 * - topics：挂在迭代项/缺陷/任务/工单/需求下的讨论串，标题异步 AI 生成「TP-{id}」；
 *   subjectType + subjectId 为应用层软引用（不建物理外键）；
 * - topic_posts：平铺楼层 + 引用回复，平台与飞书群来源共用，(topicId, sourceMessageId) 唯一去重；
 * - topic_follows：关注关系；
 * - topic_worker_inbox：@ AI 机器人的待答复队列，LOOP 按 2/10/30 分钟退避重试。
 * 枚举类型命名遵循 {table}_{column}_enum，与 TypeORM 实体 `type: 'enum'` 推导一致。
 */
export class AddTopics1800700000000 implements MigrationInterface {
  name = 'AddTopics1800700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'topics_subjecttype_enum'
        ) THEN
          CREATE TYPE "topics_subjecttype_enum" AS ENUM ('迭代项', '缺陷', '任务', '工单', '需求');
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'topics_priority_enum'
        ) THEN
          CREATE TYPE "topics_priority_enum" AS ENUM ('高', '中', '低');
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'topics_status_enum'
        ) THEN
          CREATE TYPE "topics_status_enum" AS ENUM ('开放', '已解决', '已关闭');
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'topic_posts_source_enum'
        ) THEN
          CREATE TYPE "topic_posts_source_enum" AS ENUM ('平台', '飞书群');
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "topics" (
        "id" SERIAL PRIMARY KEY,
        "subjectType" "topics_subjecttype_enum" NOT NULL,
        "subjectId" integer NOT NULL,
        "subjectTitle" varchar(200) NOT NULL,
        "title" varchar(200) NOT NULL,
        "priority" "topics_priority_enum" NOT NULL DEFAULT '中',
        "status" "topics_status_enum" NOT NULL DEFAULT '开放',
        "tags" json,
        "content" text NOT NULL,
        "creatorUserId" integer,
        "creatorWorkerId" integer,
        "creatorName" varchar(120) NOT NULL,
        "mentions" json,
        "feishuChatId" varchar(100),
        "feishuRootMessageId" varchar(100),
        "feishuThreadId" varchar(100),
        "postCount" integer NOT NULL DEFAULT 0,
        "lastPostAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_topics_subject"
      ON "topics" ("subjectType", "subjectId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_topics_status"
      ON "topics" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_topics_creatorUserId"
      ON "topics" ("creatorUserId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_topics_feishuChatId"
      ON "topics" ("feishuChatId")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "topic_posts" (
        "id" SERIAL PRIMARY KEY,
        "topicId" integer NOT NULL,
        "replyToPostId" integer,
        "authorUserId" integer,
        "authorWorkerId" integer,
        "authorName" varchar(120) NOT NULL,
        "content" text NOT NULL,
        "mentions" json,
        "source" "topic_posts_source_enum" NOT NULL DEFAULT '平台',
        "sourceMessageId" varchar(100),
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_topic_posts_topic"
      ON "topic_posts" ("topicId", "id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_topic_posts_worker"
      ON "topic_posts" ("authorWorkerId")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_topic_posts_topic_message"
      ON "topic_posts" ("topicId", "sourceMessageId")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "topic_follows" (
        "id" SERIAL PRIMARY KEY,
        "topicId" integer NOT NULL,
        "userId" integer NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_topic_follows_topicId"
      ON "topic_follows" ("topicId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_topic_follows_userId"
      ON "topic_follows" ("userId")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_topic_follows_topic_user"
      ON "topic_follows" ("topicId", "userId")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "topic_worker_inbox" (
        "id" SERIAL PRIMARY KEY,
        "topicId" integer NOT NULL,
        "postId" integer NOT NULL,
        "workerId" integer NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "attempts" integer NOT NULL DEFAULT 0,
        "lastAttemptAt" timestamptz,
        "nextRetryAt" timestamptz,
        "lastError" text,
        "deliveredAt" timestamptz,
        "processedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_topic_worker_inbox_workerId_status"
      ON "topic_worker_inbox" ("workerId", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_topic_worker_inbox_topicId_status"
      ON "topic_worker_inbox" ("topicId", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_topic_worker_inbox_postId"
      ON "topic_worker_inbox" ("postId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "topic_worker_inbox"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "topic_follows"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "topic_posts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "topics"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "topic_posts_source_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "topics_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "topics_priority_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "topics_subjecttype_enum"`);
  }
}
