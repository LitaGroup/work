import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 需求状态改为读时推导（是否进入迭代 + 创建时间），并退役「测试中」「暂停中」：
 * - 待分配：无未取消迭代项 且 创建不超过 30 天；
 * - 开发中：有未取消迭代项 且 迭代项未完成；
 * - 已发布：有未取消迭代项 且 迭代项已完成（优先于开发中）；
 * - 已关闭：无未取消迭代项 且 创建超过 30 天。
 *
 * 读接口不依赖 projects.status，本迁移只回填落库快照保持数据一致（含存量「测试中」/「暂停中」）。
 * PostgreSQL 不支持删除枚举值，projects_status_enum 继续保留两个旧标签，应用侧已不再写入。
 */
export class ProjectStatusDerived1799700000000 implements MigrationInterface {
  name = 'ProjectStatusDerived1799700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1) 有未取消迭代项且迭代项均未完成 → 开发中
    await queryRunner.query(`
      UPDATE "projects" p SET "status" = '开发中'
      WHERE EXISTS (
          SELECT 1 FROM "backlogs" b
          WHERE b."projectId" = p."id" AND b."status" <> '取消'
        )
        AND NOT EXISTS (
          SELECT 1 FROM "backlogs" b
          WHERE b."projectId" = p."id" AND b."status" = '完成'
        )
    `);

    // 2) 存在已完成的迭代项 → 已发布（覆盖上一步，完成优先）
    await queryRunner.query(`
      UPDATE "projects" p SET "status" = '已发布'
      WHERE EXISTS (
        SELECT 1 FROM "backlogs" b
        WHERE b."projectId" = p."id" AND b."status" = '完成'
      )
    `);

    // 3) 无未取消迭代项且创建不超过 30 天 → 待分配
    await queryRunner.query(`
      UPDATE "projects" p SET "status" = '待分配'
      WHERE NOT EXISTS (
          SELECT 1 FROM "backlogs" b
          WHERE b."projectId" = p."id" AND b."status" <> '取消'
        )
        AND p."createdAt" >= now() - interval '30 days'
    `);

    // 4) 无未取消迭代项且创建超过 30 天 → 已关闭
    await queryRunner.query(`
      UPDATE "projects" p SET "status" = '已关闭'
      WHERE NOT EXISTS (
          SELECT 1 FROM "backlogs" b
          WHERE b."projectId" = p."id" AND b."status" <> '取消'
        )
        AND p."createdAt" < now() - interval '30 days'
    `);
  }

  public async down(): Promise<void> {
    // 状态为读时推导值，历史落库状态不可还原，回退不处理数据
  }
}
