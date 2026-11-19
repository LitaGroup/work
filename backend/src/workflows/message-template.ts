import { BadRequestException } from '@nestjs/common';
import Handlebars from 'handlebars';

/** 消息模板渲染上下文中的工单信息 */
export interface TicketMessageTemplateTicket {
  id: number;
  /** 工单编号（WO-0001） */
  code: string;
  title: string;
  description: string | null;
  category: string;
  /** 发起人（真人姓名或机器人名称快照） */
  initiator: string;
  /** 创建时间（北京时间展示文本） */
  createdAt: string;
  /** 平台内工单链接 */
  url: string;
}

/** 消息模板中的人员：姓名 + 飞书 @ 文本（真人取绑定真人 open_id，AI 机器人取绑定的飞书应用机器人 open_id；都没有时回退姓名） */
export interface TicketMessageTemplatePerson {
  name: string;
  /** 可直接插入卡片的 @ 文本：`<at id=ou_xxx></at>`；无法解析时为姓名 */
  mention: string;
}

/** 消息模板中的关联迭代项（提测内容循环用） */
export interface TicketMessageTemplateBacklog {
  id: number;
  /** 迭代项编号（BL-0001） */
  code: string;
  /** 迭代项标题 */
  title: string;
  /** 需求标题（projects.name） */
  requirementTitle: string;
  /** 需求类型（projects.type） */
  requirementType: string;
  /** 需求（projects）在平台内的链接，可直接用作 Markdown 链接地址 */
  requirementUrl: string;
  /** 所属迭代标识（如 2026W47）；无迭代时为空串 */
  iterationCode: string;
  /** 所属迭代在平台内的链接；无迭代时为空串 */
  iterationUrl: string;
  /** 迭代项状态 */
  status: string;
  /** 迭代项在平台内的链接，可直接用作 Markdown 链接地址 */
  url: string;
}

/** Handlebars 模板上下文：ticket / initiator / 成员 / 迭代项 / values / node */
export interface TicketMessageTemplateContext {
  ticket: TicketMessageTemplateTicket;
  /** 实际发起工单的机器人（真人机器人解析其绑定真人的 @；AI 机器人回退名称） */
  initiator: TicketMessageTemplatePerson;
  /** 关联迭代项成员按角色汇总（已去重）：测试人员 */
  testers: TicketMessageTemplatePerson[];
  /** 前端 / 后端 / 客户端成员 */
  developers: TicketMessageTemplatePerson[];
  /** 需求方成员（迭代项自动列入的需求方行） */
  demanders: TicketMessageTemplatePerson[];
  /** 关联迭代项（起始字段选择的迭代，或工单关联的迭代项） */
  backlogs: TicketMessageTemplateBacklog[];
  /** 起始节点输入字段（key → 展示文本；迭代字段已转为迭代标识） */
  values: Record<string, string>;
  /** 当前飞书群消息节点 */
  node: { name: string };
}

/** 模板数量上限（编译缓存，避免无限增长） */
const TEMPLATE_CACHE_LIMIT = 200;

/** 编译缓存：同一模板在多次通知中复用 */
const compiled = new Map<string, HandlebarsTemplateDelegate>();

/** 编译模板（失败抛 BadRequestException）；noEscape 保证 Markdown 正文不被 HTML 转义 */
function compileTemplate(template: string): HandlebarsTemplateDelegate {
  const cached = compiled.get(template);
  if (cached) return cached;
  let render: HandlebarsTemplateDelegate;
  try {
    render = Handlebars.compile(template, {
      noEscape: true,
      strict: false,
    });
  } catch (error) {
    throw new BadRequestException(
      `消息模板语法错误：${(error as Error).message}`,
    );
  }
  if (compiled.size >= TEMPLATE_CACHE_LIMIT) {
    compiled.clear();
  }
  compiled.set(template, render);
  return render;
}

/** 校验模板语法（发布前调用，避免运行期才暴露配置错误） */
export function validateMessageTemplate(template: string): void {
  // Handlebars 的编译是惰性的：未闭合块/标签错误在首次执行时才抛出，这里用空上下文试渲染一次
  const render = compileTemplate(template);
  try {
    render({
      ticket: {
        id: 0,
        code: '',
        title: '',
        description: '',
        category: '',
        initiator: '',
        createdAt: '',
        url: '',
      },
      initiator: { name: '', mention: '' },
      testers: [],
      developers: [],
      demanders: [],
      backlogs: [],
      values: {},
      node: { name: '' },
    });
  } catch (error) {
    throw new BadRequestException(
      `消息模板语法错误：${(error as Error).message}`,
    );
  }
}

/** 渲染消息模板；未提供的变量渲染为空串 */
export function renderMessageTemplate(
  template: string,
  context: TicketMessageTemplateContext,
): string {
  return compileTemplate(template)(context).trim();
}
