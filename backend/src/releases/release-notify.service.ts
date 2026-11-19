import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User } from '../auth/user.entity';
import { beijingTime } from '../common/frontmatter';
import { FeishuBotConfigService } from '../feishu-bot/feishu-bot-config.service';
import { feishuGroupSendPaused } from '../feishu-bot/feishu-bot-group-pause';
import { FeishuBotIdentityService } from '../feishu-bot/feishu-bot-identity.service';
import {
  FeishuBotOfficialMessageService,
  type FeishuOfficialMessageSender,
} from '../feishu-bot/feishu-bot-official-message.service';
import type { ReleaseBranch } from './project-release.entity';

/** 批量提测消息里的单个迭代项 */
export interface ReleaseNoticeItem {
  code: string;
  title: string;
  content: string | null;
}

/** 批量提测飞书群通知上下文 */
export interface ReleaseNoticeInput {
  /** 提测标题（多个迭代项时为「xxx 等x个迭代」） */
  title: string;
  /** 提测端（APP / H5 / 后端） */
  ends: string[];
  operator: string | null;
  testers: string[];
  /** 需求方（各迭代项原始需求 projects.owner 去重） */
  demanders: string[];
  /** 开发人员（前端 / 后端 / 客户端成员去重） */
  developers: string[];
  branches: ReleaseBranch[];
  urls: string[];
  items: ReleaseNoticeItem[];
  createdAt: Date;
  /** 平台名义消息审计的发送方（网页用户 / 机器人） */
  sender: FeishuOfficialMessageSender;
}

/**
 * 提测群通知：统一以「平台官方机器人」身份发送 Markdown 卡片。
 * - 群 chat_id 由 RELEASE_FEISHU_CHAT_ID 配置（开发/生产各配各的提测群）；
 * - 人员按姓名解析飞书 open_id 做 @（官方应用映射优先，回退登录 openId，解析不到降级纯文本）；
 * - 受 FEISHU_GROUP_SEND_PAUSED 止血开关约束，发送失败只告警不阻断提测。
 */
@Injectable()
export class ReleaseNotifyService {
  private readonly logger = new Logger(ReleaseNotifyService.name);
  private readonly chatId: string;

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly botConfigs: FeishuBotConfigService,
    private readonly identities: FeishuBotIdentityService,
    private readonly official: FeishuBotOfficialMessageService,
    config: ConfigService,
  ) {
    this.chatId = (config.get<string>('RELEASE_FEISHU_CHAT_ID') ?? '').trim();
  }

  /** 发送提测群消息；未配置群 / 暂停 / 发送失败时返回 false（只告警） */
  async notify(input: ReleaseNoticeInput): Promise<boolean> {
    if (!this.chatId) {
      this.logger.debug(
        `提测群消息未发送：未配置 RELEASE_FEISHU_CHAT_ID（${input.title}）`,
      );
      return false;
    }
    if (feishuGroupSendPaused()) {
      this.logger.debug(
        `提测群消息已暂停（FEISHU_GROUP_SEND_PAUSED）：${input.title}`,
      );
      return false;
    }
    try {
      const content = await this.render(input);
      await this.official.send({ chatId: this.chatId, content }, input.sender);
      return true;
    } catch (e) {
      this.logger.warn(`提测群消息发送失败：${(e as Error).message}`);
      return false;
    }
  }

  /** 按模板渲染消息正文（@ 人员按飞书 open_id 解析，解析不到降级姓名） */
  async render(input: ReleaseNoticeInput): Promise<string> {
    const [operator, demanders, testers, developers] = await Promise.all([
      this.mentionNames(input.operator ? [input.operator] : []),
      this.mentionNames(input.demanders),
      this.mentionNames(input.testers),
      this.mentionNames(input.developers),
    ]);
    const lines = [
      `【提测】${input.title}`,
      `提测端：${input.ends.join(' / ')}`,
      `提测人：${operator}`,
      `需求方：${demanders}`,
      `测试人员：${testers}`,
      `开发人员：${developers}`,
      `提测时间：${beijingTime(input.createdAt)}`,
      `代码分支：${
        input.branches.length
          ? input.branches
              .map((row) => `${row.repo} @ ${row.branch}`)
              .join('、')
          : '—'
      }`,
      `访问地址：${input.urls.length ? input.urls.join('\n') : '—'}`,
      '提测内容：',
    ];
    if (input.items.length === 1) {
      lines.push(input.items[0].content?.trim() || '（无提测内容）');
    } else {
      input.items.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.code} ${item.title}`);
        const content = item.content?.trim();
        lines.push(content || '（无提测内容）');
      });
    }
    return lines.join('\n');
  }

  /** 姓名列表 → @ 文本；空列表返回「—」，查不到 open_id 的保留姓名 */
  private async mentionNames(names: string[]): Promise<string> {
    const unique = [
      ...new Set(names.map((name) => name.trim()).filter(Boolean)),
    ];
    if (!unique.length) return '—';
    let users: User[] = [];
    try {
      users = await this.users.find({
        where: { name: In(unique) },
        select: { id: true, name: true, feishuOpenId: true },
      });
    } catch (e) {
      this.logger.warn(`提测群 @ 人员查询失败：${(e as Error).message}`);
    }
    const byName = new Map<string, User>();
    for (const user of users) {
      if (!byName.has(user.name)) byName.set(user.name, user);
    }
    const config = await this.botConfigs
      .loadEnabledOfficial()
      .catch(() => null);
    const parts: string[] = [];
    for (const name of unique) {
      const user = byName.get(name);
      let openId: string | null = null;
      if (user) {
        openId = config
          ? await this.identities
              .openIdFor(config.id, user.id)
              .catch(() => null)
          : null;
        openId = openId ?? user.feishuOpenId;
      }
      parts.push(openId ? `<at id=${openId}></at>` : name);
    }
    return parts.join(' ');
  }
}
