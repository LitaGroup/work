import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * 多执行器接入第一步（执行器抽象层阶段 B）：
 * - executors.type / workers.runtime 枚举增加 kiro（Kiro 经 kiro-cli 接入，bridge 待建）；
 * - executors 增加 capabilitiesCache（健康检查时缓存执行器能力上报）。
 *
 * 注意：PostgreSQL 12+ 允许事务内 ADD VALUE，但新值需提交后才可使用——
 * 本迁移只新增枚举值，不写入任何 kiro 数据（与 1794400000000 同策略）。
 * executors 表由早期 synchronize 建立、无建表迁移可考，故先查 pg_type 再动 enum。
 */
export class ExecutorKiroCapabilities1801900000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.addEnumValue(queryRunner, 'executors_type_enum', 'kiro');
    await this.addEnumValue(queryRunner, 'workers_runtime_enum', 'kiro');

    if (!(await queryRunner.hasColumn('executors', 'capabilitiesCache'))) {
      await queryRunner.addColumn(
        'executors',
        new TableColumn({
          name: 'capabilitiesCache',
          type: 'simple-json',
          isNullable: true,
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('executors', 'capabilitiesCache')) {
      await queryRunner.dropColumn('executors', 'capabilitiesCache');
    }
    // PostgreSQL 不支持移除枚举值：kiro 保留为兼容历史（与既有迁移同约定）。
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
