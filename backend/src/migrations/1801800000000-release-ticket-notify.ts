import { MigrationInterface, QueryRunner } from 'typeorm';
import { RELEASE_TICKET_WORKFLOW } from '../workflows/system-workflows';

interface ParsedDefinition {
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** 解析数据库中的工作流定义（jsonb 可能返回对象或字符串） */
function parseDefinition(value: unknown): ParsedDefinition | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as ParsedDefinition;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' ? (value as ParsedDefinition) : null;
}

/** 代码预置的规范定义中各节点（用于补齐/对齐） */
function canonicalParts() {
  const canonical =
    RELEASE_TICKET_WORKFLOW.definition as unknown as ParsedDefinition;
  const nodes = canonical.nodes ?? [];
  return {
    canonical,
    startFields: nodes.find((node) => node.kind === 'start')?.inputFields ?? [],
    notifyNode: nodes.find((node) => node.kind === 'feishu-message') ?? null,
  };
}

/** 将提测群通知节点的目标群替换为指定 chat_id（配置为空时保留原值） */
function withChatId(
  definition: ParsedDefinition,
  chatId: string | null,
): ParsedDefinition {
  if (!chatId) return definition;
  return {
    ...definition,
    nodes: (definition.nodes ?? []).map((node) =>
      node.kind === 'feishu-message' ? { ...node, feishuChatId: chatId } : node,
    ),
  };
}

/**
 * 在既有已发布定义上升级：
 * - 起始节点字段以规范定义为准（标题 / 补充描述 / 迭代项 / 提测端）；
 * - 保留其它节点的任务定义、负责机器人等运营配置；
 * - 缺少「提测群通知」节点时插入到起始节点之后（start → notify → 原后续节点）。
 */
function buildUpgradedDefinition(
  existing: ParsedDefinition | null,
  chatId: string | null,
): ParsedDefinition {
  const { canonical, startFields, notifyNode } = canonicalParts();
  if (!existing?.nodes?.length) return withChatId(canonical, chatId);

  const nodes = existing.nodes.map((node) =>
    node.kind === 'start' ? { ...node, inputFields: startFields } : node,
  );
  const edges = Array.isArray(existing.edges) ? [...existing.edges] : [];
  const notifyIndex = nodes.findIndex((node) => node.kind === 'feishu-message');

  if (notifyIndex >= 0) {
    // 已含通知节点：保留人工配置，仅补齐缺失的模板与目标群
    const current = nodes[notifyIndex];
    nodes[notifyIndex] = {
      ...notifyNode,
      ...current,
      messageTemplate:
        typeof current.messageTemplate === 'string' &&
        current.messageTemplate.trim()
          ? current.messageTemplate
          : notifyNode?.messageTemplate,
      feishuChatId: current.feishuChatId || chatId,
    };
    return { ...existing, nodes, edges };
  }

  const startEdgeIndex = edges.findIndex((edge) => edge.from === 'start');
  if (!notifyNode || startEdgeIndex < 0) {
    return withChatId(canonical, chatId);
  }
  const target = edges[startEdgeIndex].to;
  edges.splice(
    startEdgeIndex,
    1,
    { from: 'start', to: 'notify', outcome: null, label: '发送提测通知' },
    { from: 'notify', to: target, outcome: null, label: '开始处理' },
  );
  const startIndex = nodes.findIndex((node) => node.kind === 'start');
  nodes.splice(startIndex + 1, 0, { ...notifyNode, feishuChatId: chatId });
  return { ...existing, nodes, edges };
}

/**
 * 提测工单精简：起始字段收敛为 标题 / 补充描述 / 迭代项 / 提测端，
 * 并新增「提测群通知」飞书群消息节点（平台官方机器人，发送失败不阻断流程）。
 *
 * - 已发布环境（v1 旧字段）：按规范发布下一版本，保留节点任务定义与机器人配置；
 *   目标群取 RELEASE_FEISHU_CHAT_ID（未配置时节点保留空群，运行期只记录失败）。
 * - 全新环境按当前代码预置的 v1 已含通知节点：不重复发布，
 *   仅在配置了提测群时补齐节点目标群。
 */
export class ReleaseTicketNotify1801800000000 implements MigrationInterface {
  name = 'ReleaseTicketNotify1801800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const chatId = (process.env.RELEASE_FEISHU_CHAT_ID ?? '').trim() || null;
    const rows = (await queryRunner.query(
      `SELECT "id", "latestPublishedVersion" FROM "workflow_definitions" WHERE "code" = $1 LIMIT 1`,
      [RELEASE_TICKET_WORKFLOW.code],
    )) as Array<{ id: number; latestPublishedVersion: number }>;
    // 未预置定义时由启动兜底按代码规范预置（无已发布版本）
    if (rows.length === 0) return;
    const definitionId = rows[0].id;
    const latest = rows[0].latestPublishedVersion ?? 0;

    const published =
      latest > 0
        ? ((await queryRunner.query(
            `SELECT "definition" FROM "workflow_definition_versions"
             WHERE "definitionId" = $1 AND "version" = $2 LIMIT 1`,
            [definitionId, latest],
          )) as Array<{ definition: unknown }>)
        : [];
    const publishedDefinition = parseDefinition(published[0]?.definition);
    const hasNotifyNode = Boolean(
      publishedDefinition?.nodes?.some(
        (node) => node.kind === 'feishu-message',
      ),
    );

    if (latest > 0 && hasNotifyNode) {
      // 已是新规范：仅在配置了提测群时补齐已发布版本与草稿的节点目标群
      if (chatId) {
        await queryRunner.query(
          `UPDATE "workflow_definition_versions" SET "definition" = $1
           WHERE "definitionId" = $2 AND "version" = $3`,
          [
            JSON.stringify(withChatId(publishedDefinition!, chatId)),
            definitionId,
            latest,
          ],
        );
        await queryRunner.query(
          `UPDATE "workflow_definitions" SET "draftDefinition" = $1,
             "draftUpdatedAt" = now()
           WHERE "id" = $2 AND "latestPublishedVersion" = $3`,
          [
            JSON.stringify(withChatId(publishedDefinition!, chatId)),
            definitionId,
            latest,
          ],
        );
      }
      return;
    }

    const definition = buildUpgradedDefinition(publishedDefinition, chatId);
    const version = latest + 1;
    await queryRunner.query(
      `INSERT INTO "workflow_definition_versions"
        ("definitionId", "version", "name", "description", "definition")
       VALUES ($1, $2, $3, $4, $5)`,
      [
        definitionId,
        version,
        RELEASE_TICKET_WORKFLOW.name,
        RELEASE_TICKET_WORKFLOW.description,
        JSON.stringify(definition),
      ],
    );
    await queryRunner.query(
      `UPDATE "workflow_definitions"
       SET "name" = $1, "description" = $2, "draftDefinition" = $3,
         "draftUpdatedAt" = now(), "latestPublishedVersion" = $4,
         "latestPublishedAt" = now(), "enabled" = true
       WHERE "id" = $5`,
      [
        RELEASE_TICKET_WORKFLOW.name,
        RELEASE_TICKET_WORKFLOW.description,
        JSON.stringify(definition),
        version,
        definitionId,
      ],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT "id", "latestPublishedVersion" FROM "workflow_definitions" WHERE "code" = $1 LIMIT 1`,
      [RELEASE_TICKET_WORKFLOW.code],
    )) as Array<{ id: number; latestPublishedVersion: number }>;
    if (rows.length === 0) return;
    const definitionId = rows[0].id;
    const latest = rows[0].latestPublishedVersion ?? 0;
    // v1 不属于本迁移发布（全新环境按代码预置），回退时保持不动
    if (latest <= 1) return;
    const previous =
      (
        (await queryRunner.query(
          `SELECT "definition" FROM "workflow_definition_versions"
         WHERE "definitionId" = $1 AND "version" = $2 LIMIT 1`,
          [definitionId, latest - 1],
        )) as Array<{ definition: unknown }>
      )[0]?.definition ?? null;
    await queryRunner.query(
      `DELETE FROM "workflow_definition_versions"
       WHERE "definitionId" = $1 AND "version" = $2`,
      [definitionId, latest],
    );
    await queryRunner.query(
      `UPDATE "workflow_definitions"
       SET "draftDefinition" = $1, "latestPublishedVersion" = $2,
         "latestPublishedAt" = now()
       WHERE "id" = $3`,
      [previous ? JSON.stringify(previous) : null, latest - 1, definitionId],
    );
  }
}
