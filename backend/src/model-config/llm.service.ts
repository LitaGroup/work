import { Injectable } from '@nestjs/common';
import { ModelThinkingLevel } from '../common/enums';
import { ModelConfigService } from './model-config.service';
import {
  MODEL_SCENARIO_REQUIREMENT_DESCRIPTION,
  MODEL_SCENARIO_REQUIREMENT_SUMMARY,
  MODEL_SCENARIO_TITLE_NAMING,
} from './model-scenarios';

/** 单次请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 20_000;
/** 全局同时进行的模型请求上限（标题命名等后台任务，避免批量创建打满） */
const MAX_CONCURRENT = 3;
/** 生成标题的最大长度（完整标题还会拼「T-{id}」前缀，远小于 title 列 200） */
const TITLE_MAX_CHARS = 60;

const TITLE_SYSTEM_PROMPT =
  '你是标题生成助手。只输出一个简洁、准确的中文标题，不超过 30 个字；' +
  '不要输出解释、引号、书名号、编号或 Markdown 标记。';

/** 需求摘要最大字数（需求摘要场景硬上限） */
export const SUMMARY_MAX_CHARS = 200;

/** 需求摘要素材最大字符数（需求描述 + 需求类文档合计，控制在单次请求超时内） */
const SUMMARY_MATERIAL_LIMIT = 12_000;

const SUMMARY_SYSTEM_PROMPT =
  '你是需求摘要助手。根据需求信息和需求文档，输出一段不超过 200 字的中文摘要，' +
  '概括需求的目标、范围与关键点；不要输出标题、列表标记、Markdown 格式或任何解释。';

/** 需求描述最大字符数（text 列无硬限制，控制单次生成规模） */
export const DESCRIPTION_MAX_CHARS = 4000;

const DESCRIPTION_SYSTEM_PROMPT =
  '你是需求描述助手。根据需求信息和需求文档，输出一份结构化的中文需求描述（Markdown），' +
  '涵盖背景与目标、范围与关键规则、交付/验收要点；只输出描述正文，不要输出无关解释，控制在 1200 字以内。';

export interface LlmAskInput {
  /** 系统提示词 */
  system?: string;
  /** 用户提示词 */
  prompt: string;
  /** 最大输出 token，默认 256 */
  maxTokens?: number;
  /** 采样温度，默认 0.3 */
  temperature?: number;
}

/** 思考等级 → OpenAI 兼容请求参数；不支持的字段会在 400 时自动去掉重试 */
export function thinkingExtras(
  level: ModelThinkingLevel,
): Record<string, unknown> {
  switch (level) {
    case ModelThinkingLevel.OFF:
      // 最低档：关闭思考（智谱 thinking.type）+ 最低推理强度（OpenAI reasoning_effort）
      return {
        thinking: { type: 'disabled' },
        reasoning_effort: 'minimal',
      };
    case ModelThinkingLevel.MEDIUM:
      return { reasoning_effort: 'medium' };
    case ModelThinkingLevel.HIGH:
      return { reasoning_effort: 'high' };
    default:
      return { reasoning_effort: 'low' };
  }
}

/** 从 Chat Completions 响应中取出文本（兼容 content 为字符串或分段数组） */
export function extractContent(payload: unknown): string {
  const choices = (payload as { choices?: unknown })?.choices;
  const first = Array.isArray(choices)
    ? (choices[0] as {
        message?: { content?: unknown };
        text?: unknown;
      })
    : undefined;
  const content = first?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('')
      .trim();
  }
  if (typeof first?.text === 'string') return first.text.trim();
  return '';
}

/** 清洗模型输出为单行标题：去 Markdown 前缀、包裹引号、回显的 T-{id} 前缀 */
export function sanitizeTitle(raw: string): string | null {
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? '';
  let text = firstLine
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*•]\s*/, '')
    .trim();
  for (let i = 0; i < 3; i += 1) {
    const next = text
      .replace(/^[「『"'“”‘’《〈（(]+/, '')
      .replace(/[」』"'“”‘’》〉）)]+$/, '')
      .trim();
    if (next === text) break;
    text = next;
  }
  text = text.replace(/^T[-\s]?\d+[」』\s:：、-]*/i, '').trim();
  if (!text) return null;
  return text.slice(0, TITLE_MAX_CHARS);
}

/** 清洗模型输出为单段摘要：去 Markdown 标记、压缩空白、硬截断到 200 字 */
export function sanitizeSummary(raw: string): string | null {
  let text = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^#{1,6}\s*/, '')
        .replace(/^[-*•]\s+/, '')
        .replace(/^>\s?/, '')
        .trim(),
    )
    .filter(Boolean)
    .join(' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 3; i += 1) {
    const next = text
      .replace(/^[「『"'“”‘’《〈（(]+/, '')
      .replace(/[」』"'“”‘’》〉）)]+$/, '')
      .trim();
    if (next === text) break;
    text = next;
  }
  if (!text) return null;
  return text.slice(0, SUMMARY_MAX_CHARS);
}

/** 清洗模型输出的描述：去掉包裹的代码围栏与首尾空白，保留 Markdown 正文 */
export function sanitizeDescription(raw: string): string | null {
  const text = raw
    .replace(/^\s*```(?:markdown|md)?[^\S\n]*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
  if (!text) return null;
  return text.slice(0, DESCRIPTION_MAX_CHARS);
}

/**
 * 通用单次大模型调用：按管理区「模型配置」的场景取连接信息，
 * 非流式、带超时与全局并发上限。未配置返回 null；请求失败抛错，
 * 由调用方记录并降级（后台标题命名等场景不得影响主流程）。
 */
@Injectable()
export class LlmService {
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly config: ModelConfigService) {}

  /** 单次问答；场景未配置返回 null */
  async ask(scenario: string, input: LlmAskInput): Promise<string | null> {
    const resolved = await this.config.resolve(scenario);
    if (!resolved) return null;
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (input.system?.trim()) {
      messages.push({ role: 'system', content: input.system.trim() });
    }
    messages.push({ role: 'user', content: input.prompt });
    const baseBody: Record<string, unknown> = {
      model: resolved.model,
      messages,
      max_tokens: input.maxTokens ?? 256,
      temperature: input.temperature ?? 0.3,
      stream: false,
    };
    const extras = thinkingExtras(resolved.thinking);
    const content = await this.withSlot(async () => {
      let response = await this.post(resolved, { ...baseBody, ...extras });
      if (response.status === 400 && Object.keys(extras).length > 0) {
        // 部分 OpenAI 兼容服务不认识思考参数：去掉后重试一次
        response = await this.post(resolved, baseBody);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `模型请求失败（HTTP ${response.status}）${text ? `：${text.slice(0, 300)}` : ''}`,
        );
      }
      const payload = (await response.json().catch(() => null)) as unknown;
      return extractContent(payload);
    });
    return content || null;
  }

  /**
   * 生成单行标题（通用方法，供工单/任务/灵感等场景复用）：
   * 使用 title-naming 场景；场景未配置返回 null。
   */
  async generateTitle(material: string): Promise<string | null> {
    const trimmed = material.trim();
    if (!trimmed) return null;
    const content = await this.ask(MODEL_SCENARIO_TITLE_NAMING, {
      system: TITLE_SYSTEM_PROMPT,
      prompt: `根据下面的信息，生成一个能概括核心诉求的中文标题。只输出标题本身。\n\n${trimmed.slice(0, 4000)}`,
      maxTokens: 256,
      temperature: 0.2,
    });
    if (!content) return null;
    return sanitizeTitle(content);
  }

  /**
   * 生成需求摘要（200 字以内）：素材为需求名称 + 描述 + 需求类文档正文，超长截断。
   * 使用 requirement-summary 场景；场景未配置或素材为空返回 null。
   */
  async generateSummary(material: string): Promise<string | null> {
    const trimmed = material.trim();
    if (!trimmed) return null;
    const content = await this.ask(MODEL_SCENARIO_REQUIREMENT_SUMMARY, {
      system: SUMMARY_SYSTEM_PROMPT,
      prompt: `根据下面的需求信息与文档，写一份 200 字以内的需求摘要。只输出摘要正文。\n\n${trimmed.slice(0, SUMMARY_MATERIAL_LIMIT)}`,
      maxTokens: 400,
      temperature: 0.3,
    });
    if (!content) return null;
    return sanitizeSummary(content);
  }

  /**
   * 生成结构化需求描述（Markdown）：素材为需求名称 + 需求类文档正文，超长截断。
   * 使用 requirement-description 场景；场景未配置或素材为空返回 null。
   */
  async generateDescription(material: string): Promise<string | null> {
    const trimmed = material.trim();
    if (!trimmed) return null;
    const content = await this.ask(MODEL_SCENARIO_REQUIREMENT_DESCRIPTION, {
      system: DESCRIPTION_SYSTEM_PROMPT,
      prompt: `根据下面的需求信息与文档，写一份结构化的中文需求描述（Markdown）。\n\n${trimmed.slice(0, SUMMARY_MATERIAL_LIMIT)}`,
      maxTokens: 2000,
      temperature: 0.3,
    });
    if (!content) return null;
    return sanitizeDescription(content);
  }

  private post(
    resolved: { baseUrl: string; apiKey: string | null },
    body: Record<string, unknown>,
  ): Promise<Response> {
    return fetch(`${resolved.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(resolved.apiKey
          ? { Authorization: `Bearer ${resolved.apiKey}` }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  /** 全局并发闸门：超出上限的请求排队 */
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.running += 1;
    try {
      return await fn();
    } finally {
      this.running -= 1;
      this.waiters.shift()?.();
    }
  }
}
