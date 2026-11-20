import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 多执行器接入：executors.type / workers.runtime 枚举增加 devin 与 droid
 * （Devin CLI 与 Factory Droid CLI 经 executor-bridge 接入，见 docs/EXECUTOR_PROTOCOL.md）。
 *
 * 注意：PostgreSQL 12+ 允许事务内 ADD VALUE，但新值需提交后才可使用——
 * 本迁移只新增枚举值，不写入任何 devin / droid 数据（与 1801900000000 同策略）。
 */
export class ExecutorDevinDroidEnums1802000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const typeName of ['executors_type_enum', 'workers_runtime_enum']) {
      for (const value of ['devin', 'droid']) {
        await this.addEnumValue(queryRunner, typeName, value);
      }
    }
  }

  public async down(): Promise<void> {
    // PostgreSQL 不支持移除枚举值：devin / droid 保留为兼容历史（与既有迁移同约定）。
  }

  /** enum 类型存在时追加值（IF NOT EXISTS 幂等）；不存在说明该列并非 PG enum，跳过 */
  private async addEnumValue(
    queryRunner: QueryRunner,
    typeName: string,
    value: string,
  ): Promise<void> {
    const rows: unknown[] = await queryRunner.manager.query(
      `SELECT 1 FROM pg_type WHERE typname = $1 LIMIT 1`,
      [typeName],
    );
    if (rows.length === 0) return;
    await queryRunner.query(
      `ALTER TYPE "${typeName}" ADD VALUE IF NOT EXISTS '${value}'`,
    );
  }
}
