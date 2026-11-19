import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 工单工作流节点运行说明：
 * - ticket_workflow_runs.note：飞书群消息节点发送结果（失败原因等）与其它节点运行说明；
 *   失败不阻断流程，仅记录供工单详情展示与排查。
 */
export class AddTicketRunNote1801600000000 implements MigrationInterface {
  name = 'AddTicketRunNote1801600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ticket_workflow_runs"
      ADD COLUMN IF NOT EXISTS "note" character varying(500)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ticket_workflow_runs"
      DROP COLUMN IF EXISTS "note"
    `);
  }
}
