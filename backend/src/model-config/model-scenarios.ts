/**
 * 固定模型场景注册表：管理区「模型配置」列表按此定义展示，后续新增场景在此追加。
 * 场景标识一经上线不得改名（配置按标识落库）；新增场景无需迁移，列表自动出现「未配置」。
 */
export interface ModelScenarioDefinition {
  /** 场景标识（落库键，禁止改名） */
  scenario: string;
  /** 展示名称 */
  name: string;
  /** 用途说明 */
  description: string;
}

/** 工单与任务标题命名场景（「T-{id}」标题异步生成） */
export const MODEL_SCENARIO_TITLE_NAMING = 'title-naming';

/** 需求摘要场景（需求创建/同步或需求类文档更新后，摘要为空时自动生成 ≤200 字摘要） */
export const MODEL_SCENARIO_REQUIREMENT_SUMMARY = 'requirement-summary';

/** 需求描述场景（需求创建/同步或需求类文档更新后，描述为空时自动生成结构化需求描述） */
export const MODEL_SCENARIO_REQUIREMENT_DESCRIPTION = 'requirement-description';

export const MODEL_SCENARIOS: ModelScenarioDefinition[] = [
  {
    scenario: MODEL_SCENARIO_TITLE_NAMING,
    name: '工单和任务标题命名',
    description:
      '创建工单或根任务后，异步调用模型生成简洁标题，统一为「T-{id}」+ 生成内容；失败不影响创建与流程流转。',
  },
  {
    scenario: MODEL_SCENARIO_REQUIREMENT_SUMMARY,
    name: '需求摘要',
    description:
      '需求创建/同步或「需求」类文档新增/更新后，摘要为空时自动生成 200 字以内的需求摘要；未配置时跳过，失败不影响主流程。',
  },
  {
    scenario: MODEL_SCENARIO_REQUIREMENT_DESCRIPTION,
    name: '需求描述',
    description:
      '需求创建/同步或「需求」类文档新增/更新后，需求描述为空时自动生成结构化 Markdown 描述；已有描述不会被清空或覆盖，未配置时跳过。',
  },
];

/** 按标识查找固定场景定义 */
export function findModelScenario(
  scenario: string,
): ModelScenarioDefinition | null {
  return MODEL_SCENARIOS.find((item) => item.scenario === scenario) ?? null;
}
