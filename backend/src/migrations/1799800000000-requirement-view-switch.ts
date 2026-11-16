import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  DEVELOPMENT_OPERATION_GUIDE,
  SYSTEM_BACKLOG_DELIVERY_TASK_TEMPLATE_DESCRIPTION,
  SYSTEM_PROJECT_DELIVERY_TASK_TEMPLATE_DESCRIPTION,
} from '../tasks/system-task-templates';

/**
 * 需求详情 .md 视图切换（/api/projects/{id}.md → /api/requirements/{id}.md）：
 * - 需求详情只保留基本信息 / 对应迭代 / 文档资料，研发操作指南改由任务定义说明下发；
 * - 同步存量系统任务定义（ID=7 技术-项目开发交付、ID=9 迭代-Backlog交付）说明；
 * - 同步「技术-项目经理」系统机器人 PROMPT 中的读取地址；
 * - 管理员自定义过的内容只做地址替换并补齐研发操作指南，不整段覆盖。
 */
const OLD_PROJECT_DELIVERY_DESCRIPTION = [
  '承接项目详情页发起的项目实施与开发交付。',
  '',
  '## 任务范围',
  '',
  '- 读取项目 Markdown 上下文（`GET /api/projects/{projectId}.md`），确认项目目标、范围、资料和代码分支。',
  '- 梳理实施计划，完成开发、配置和必要的技术文档交付。',
  '- 按任务流程更新 HANDOFF，并在完成后申请验收。',
  '',
  '## 默认处理机器人',
  '',
  '由系统机器人「技术-项目经理」作为首位处理机器人，负责读取项目上下文、拆分并分派子任务、验收交付和整合结果；管理员可追加其它机器人作为兜底。',
].join('\n');

const OLD_BACKLOG_DELIVERY_DESCRIPTION = [
  '承接迭代项（Backlog）转入后自动创建的开发交付任务。',
  '',
  '## 任务范围',
  '',
  '- 读取原始需求的 Markdown 上下文（任务描述中包含需求地址），确认目标、范围与资料。',
  '- 按需求完成开发、配置和必要的技术文档交付，并在 HANDOFF 中记录实施过程。',
  '- 完成后显式申请验收；验收通过后交付内容供迭代项流转到「测试/发布/完成」参考。',
  '',
  '## 负责人',
  '',
  '任务创建时已明确指派给该迭代项的负责人机器人（AI 或真人），无需再经任务定义默认机器人分配。',
].join('\n');

/** 「技术-项目经理」PROMPT 中的旧读取句子（只替换该句，保留其它自定义内容） */
const OLD_MANAGER_SENTENCE =
  '- 从任务描述「项目ID：{projectId} 的实施交付」识别项目，接受任务后先读取项目上下文 `GET /api/projects/{projectId}.md` 与任务详情，确认项目范围、资料、代码分支和验收要求。';

const NEW_MANAGER_SENTENCE =
  '- 从任务描述「项目ID：{projectId} 的实施交付」识别需求，接受任务后先读取需求上下文 `GET /api/requirements/{projectId}.md`、任务定义说明（含研发操作指南）与任务详情，确认需求范围、资料、代码分支和验收要求。';

export class RequirementViewSwitch1799800000000 implements MigrationInterface {
  name = 'RequirementViewSwitch1799800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('task_templates')) {
      // 仍是平台默认内容时整段替换（保持与代码常量一致）
      await queryRunner.query(
        'UPDATE "task_templates" SET "description" = $1 WHERE "id" = 7 AND "description" = $2',
        [
          SYSTEM_PROJECT_DELIVERY_TASK_TEMPLATE_DESCRIPTION,
          OLD_PROJECT_DELIVERY_DESCRIPTION,
        ],
      );
      await queryRunner.query(
        'UPDATE "task_templates" SET "description" = $1 WHERE "id" = 9 AND "description" = $2',
        [
          SYSTEM_BACKLOG_DELIVERY_TASK_TEMPLATE_DESCRIPTION,
          OLD_BACKLOG_DELIVERY_DESCRIPTION,
        ],
      );
      // 管理员自定义过的描述：只切换需求地址，并补齐研发操作指南小节
      await queryRunner.query(
        `UPDATE "task_templates"
         SET "description" = replace("description", '/api/projects/{projectId}.md', '/api/requirements/{projectId}.md')
         WHERE "id" IN (7, 9) AND "description" LIKE '%/api/projects/{projectId}.md%'`,
      );
      await queryRunner.query(
        `UPDATE "task_templates"
         SET "description" = "description" || E'\\n\\n' || $1
         WHERE "id" IN (7, 9)
           AND "description" IS NOT NULL
           AND "description" <> ''
           AND "description" NOT LIKE '%## 研发操作指南%'`,
        [DEVELOPMENT_OPERATION_GUIDE],
      );
    }

    if (await queryRunner.hasTable('workers')) {
      await queryRunner.query(
        `UPDATE "workers" SET "prompt" = replace("prompt", $1, $2)
         WHERE "systemKey" = 'project-manager' AND "prompt" LIKE $3`,
        [
          OLD_MANAGER_SENTENCE,
          NEW_MANAGER_SENTENCE,
          `%${OLD_MANAGER_SENTENCE}%`,
        ],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('task_templates')) {
      await queryRunner.query(
        'UPDATE "task_templates" SET "description" = $1 WHERE "id" = 7 AND "description" = $2',
        [
          OLD_PROJECT_DELIVERY_DESCRIPTION,
          SYSTEM_PROJECT_DELIVERY_TASK_TEMPLATE_DESCRIPTION,
        ],
      );
      await queryRunner.query(
        'UPDATE "task_templates" SET "description" = $1 WHERE "id" = 9 AND "description" = $2',
        [
          OLD_BACKLOG_DELIVERY_DESCRIPTION,
          SYSTEM_BACKLOG_DELIVERY_TASK_TEMPLATE_DESCRIPTION,
        ],
      );
      // 其余情况撤掉追加的研发操作指南并还原地址
      await queryRunner.query(
        `UPDATE "task_templates"
         SET "description" = replace("description", E'\\n\\n' || $1, '')
         WHERE "id" IN (7, 9) AND "description" LIKE '%## 研发操作指南%'`,
        [DEVELOPMENT_OPERATION_GUIDE],
      );
      await queryRunner.query(
        `UPDATE "task_templates"
         SET "description" = replace("description", '/api/requirements/{projectId}.md', '/api/projects/{projectId}.md')
         WHERE "id" IN (7, 9) AND "description" LIKE '%/api/requirements/{projectId}.md%'`,
      );
    }

    if (await queryRunner.hasTable('workers')) {
      await queryRunner.query(
        `UPDATE "workers" SET "prompt" = replace("prompt", $1, $2)
         WHERE "systemKey" = 'project-manager' AND "prompt" LIKE $3`,
        [
          NEW_MANAGER_SENTENCE,
          OLD_MANAGER_SENTENCE,
          `%${NEW_MANAGER_SENTENCE}%`,
        ],
      );
    }
  }
}
