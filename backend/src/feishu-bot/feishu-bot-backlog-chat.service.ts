import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { In, Repository } from 'typeorm';
import { User } from '../auth/user.entity';
import { BacklogStatus, WorkerRuntime } from '../common/enums';
import { Backlog } from '../iterations/backlog.entity';
import { Worker } from '../workers/worker.entity';
import { FeishuBotClientService } from './feishu-bot-client.service';
import type {
  FeishuBotConfig,
  FeishuBotSecrets,
} from './feishu-bot-config.entity';
import { FeishuBotConfigService } from './feishu-bot-config.service';
import { FeishuBotIdentityService } from './feishu-bot-identity.service';
import { markdownCard } from './feishu-bot-message.service';
import {
  FeishuBotBacklogChat,
  FeishuBotBacklogChatState,
} from './feishu-bot-backlog-chat.entity';

/** backlog 终态后保留沟通群的时间 */
const DISSOLVE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

/** 建群失败重试上限（每分钟一轮） */
const CREATE_MAX_ATTEMPTS = 30;

/** 飞书建群单次最多邀请的用户数 */
const MAX_CHAT_MEMBERS = 50;

/** 飞书群机器人数量上限（建群与补拉均受此约束） */
const MAX_BOT_MEMBERS = 5;

/** 群名总长度上限 */
const CHAT_NAME_LIMIT = 80;

/** 飞书错误码：chat_id 无效（群不存在或已永久解散） */
const CHAT_MISSING_ERROR_CODE = 'code=232006';

/** 终态：完成 / 取消 */
export function isBacklogTerminal(status: BacklogStatus): boolean {
  return (
    status === BacklogStatus.COMPLETED || status === BacklogStatus.CANCELED
  );
}

/** backlog 沟通群名称：保留固定前后缀，仅截断标题 */
export function backlogChatName(title: string): string {
  const prefix = 'LitaWork-迭代-';
  const suffix = ' 沟通群';
  const name = title.trim() || '未命名迭代项';
  const available = Math.max(
    1,
    CHAT_NAME_LIMIT - prefix.length - suffix.length,
  );
  return `${prefix}${name.slice(0, available)}${suffix}`;
}

/** 单个成员在飞书群中的落地目标：真人用 open_id，AI 机器人用其飞书应用 app_id */
interface MemberTarget {
  workerId: number;
  kind: 'user' | 'bot';
  /** open_id（user）或 app_id（bot） */
  id: string;
  name: string;
  /** 真人绑定的 users.id（仅 user） */
  userId?: number;
}

interface ResolvedMembers {
  targets: MemberTarget[];
  users: User[];
  openIds: string[];
  botAppIds: string[];
  memberNames: string[];
  missingNames: string[];
}

/** 迭代项沟通群状态（供迭代项详情页展示建群/打开群入口） */
export interface BacklogChatInfo {
  state: FeishuBotBacklogChatState;
  chatId: string | null;
  /** 最近一次建群/通知/解散错误（供前端提示失败原因） */
  lastError: string | null;
}

/**
 * 迭代项（Backlog）沟通群：由成员/管理员在迭代项详情页手动建群（不再自动创建）。
 * - 拉入 backlog 成员（产品/业务/项目/技术）与负责人机器人绑定的飞书应用；
 * - 无法匹配平台用户/未登录过平台的成员跳过并在建群卡片标注；
 * - 状态变化推送卡片，完成/取消后保留 7 天自动解散；
 * - 定时对账重试失败的建群、补拉负责人机器人、补偿终态与解散，建群失败不阻断业务操作。
 */
@Injectable()
export class FeishuBotBacklogChatService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(FeishuBotBacklogChatService.name);
  private readonly locks = new Map<string, Promise<void>>();
  private reconciling = false;

  constructor(
    private readonly configs: FeishuBotConfigService,
    private readonly client: FeishuBotClientService,
    private readonly identities: FeishuBotIdentityService,
    @InjectRepository(FeishuBotBacklogChat)
    private readonly chats: Repository<FeishuBotBacklogChat>,
    @InjectRepository(Backlog)
    private readonly backlogs: Repository<Backlog>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Worker)
    private readonly workers: Repository<Worker>,
  ) {}

  onModuleInit(): void {
    // 启动后对账一次，补偿重启期间错过的终态计时/解散/补拉机器人
    void this.reconcile().catch((error: Error) => {
      this.logger.warn(`迭代沟通群启动对账失败: ${error.message}`);
    });
  }

  onModuleDestroy(): void {
    this.locks.clear();
  }

  /** 当前绑定行状态：未绑定或已解散返回 null */
  async describe(backlogId: number): Promise<BacklogChatInfo | null> {
    const row = await this.chats.findOne({ where: { backlogId } });
    if (!row || row.state === 'destroyed') return null;
    return { state: row.state, chatId: row.chatId, lastError: row.lastError };
  }

  /**
   * 手动建群（迭代项详情页「飞书建群」）：成员或管理员触发，
   * 重置重试计数后立即尝试；已建成的群直接返回现有状态。
   * 失败保留绑定并置 error，由每分钟对账按上限继续重试。
   */
  async createForBacklog(backlogId: number): Promise<BacklogChatInfo | null> {
    const [backlog, official] = await Promise.all([
      this.backlogs.findOne({ where: { id: backlogId } }),
      this.configs.loadEnabledOfficial(),
    ]);
    if (!backlog) throw new NotFoundException(`Backlog ${backlogId} not found`);
    if (isBacklogTerminal(backlog.status)) {
      throw new BadRequestException('迭代项已结束，不再创建沟通群');
    }
    if (!official) {
      throw new BadRequestException('平台官方机器人未配置，暂不能创建飞书群');
    }

    let row = await this.chats.findOne({ where: { backlogId } });
    if (!row) {
      await this.chats
        .createQueryBuilder()
        .insert()
        .into(FeishuBotBacklogChat)
        .values({
          backlogId,
          officialConfigId: official.id,
          chatId: null,
          state: 'creating',
          name: backlogChatName(backlog.title),
          backlogTitle: backlog.title,
          memberUserIds: [],
          memberWorkerIds: [],
          memberNames: [],
          botIds: [],
          lastStatus: null,
          finishedAt: null,
          finishedNotified: false,
          destroyAfter: null,
          attempts: 0,
          lastError: null,
        })
        .orIgnore()
        .execute();
      row = await this.chats.findOne({ where: { backlogId } });
    }
    if (!row) return null;
    if (row.state === 'active' && row.chatId) {
      return { state: row.state, chatId: row.chatId, lastError: null };
    }

    // 重置为可创建状态：允许用户重试历史上失败/被解散的绑定
    await this.chats.update(row.id, {
      officialConfigId: official.id,
      state: 'creating',
      chatId: null,
      name: backlogChatName(backlog.title),
      backlogTitle: backlog.title,
      lastStatus: null,
      finishedAt: null,
      finishedNotified: false,
      destroyAfter: null,
      attempts: 0,
      lastError: null,
    });

    await this.withLock(`backlog-chat:${row.id}`, async () => {
      const fresh = await this.chats.findOne({ where: { id: row.id } });
      if (!fresh || fresh.state === 'destroyed' || fresh.chatId) return;
      await this.createGroupChat(
        fresh,
        official,
        this.configs.secretsOf(official),
        backlog,
      );
    });
    return this.describe(backlogId);
  }

  /** backlog 状态变化后调用：终态发结果卡片 + 计时解散；其余发状态卡片 */
  async notifyBacklog(backlogId: number): Promise<void> {
    const backlog = await this.backlogs.findOne({ where: { id: backlogId } });
    if (!backlog) return;
    const row = await this.chats.findOne({ where: { backlogId } });
    if (!row || row.state !== 'active' || !row.chatId) return;
    if (row.lastStatus === backlog.status) return;
    const official = await this.configs.loadEnabledWithSecrets(
      row.officialConfigId,
    );
    if (!official) return;
    const secrets = this.configs.secretsOf(official);
    await this.withLock(`backlog-chat:${row.id}`, async () => {
      const fresh = await this.chats.findOne({ where: { id: row.id } });
      if (!fresh || fresh.state !== 'active' || !fresh.chatId) return;
      if (fresh.lastStatus === backlog.status) return;
      await this.sendStatusCard(fresh, backlog, official, secrets);
    });
  }

  /** 每分钟对账：重试建群 / 补拉机器人 / 终态计时 / 到期解散 */
  @Cron('25 * * * * *')
  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      await this.reconcileOnce();
    } catch (error) {
      this.logger.warn(`迭代沟通群对账失败: ${(error as Error).message}`);
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileOnce(): Promise<void> {
    const official = await this.configs.loadEnabledOfficial();
    const rows = await this.chats.find();
    const backlogIds = rows.map((row) => row.backlogId);
    const backlogs = backlogIds.length
      ? await this.backlogs.find({ where: { id: In(backlogIds) } })
      : ([] as Backlog[]);
    const backlogMap = new Map(backlogs.map((b) => [b.id, b]));

    for (const row of rows) {
      if (row.state === 'destroyed') continue;
      const backlog = backlogMap.get(row.backlogId);
      if (!backlog) {
        await this.destroyMissingGroup(row);
        continue;
      }
      if (!official || official.id !== row.officialConfigId) continue;
      const secrets = this.configs.secretsOf(official);

      await this.withLock(`backlog-chat:${row.id}`, async () => {
        const fresh = await this.chats.findOne({ where: { id: row.id } });
        if (!fresh || fresh.state === 'destroyed') return;
        if (
          (!fresh.chatId ||
            fresh.state === 'creating' ||
            fresh.state === 'error') &&
          fresh.attempts < CREATE_MAX_ATTEMPTS
        ) {
          await this.createGroupChat(fresh, official, secrets, backlog);
          return;
        }
        if (fresh.state !== 'active' || !fresh.chatId) return;
        if (!(await this.ensureChatAlive(fresh, secrets))) return;

        if (!isBacklogTerminal(backlog.status)) {
          await this.syncMembersInternal(fresh, backlog, official, secrets);
        }
        await this.markFinished(fresh, backlog);
        if (fresh.lastStatus !== backlog.status) {
          await this.sendStatusCard(fresh, backlog, official, secrets);
        }
        if (fresh.destroyAfter && fresh.destroyAfter.getTime() <= Date.now()) {
          await this.dissolve(fresh, secrets);
        }
      });
    }
  }

  /** 建群：成员（真人 open_id + AI 机器人 app_id）；机器人拉入失败时降级为仅拉真人 */
  private async createGroupChat(
    row: FeishuBotBacklogChat,
    official: FeishuBotConfig,
    secrets: FeishuBotSecrets,
    backlog: Backlog,
  ): Promise<void> {
    const resolved = await this.resolveMembers(official, backlog);
    const botAppIds = resolved.botAppIds;
    try {
      let chatId: string;
      let botsAdded = botAppIds.length > 0;
      try {
        chatId = await this.client.createChat(
          official.id,
          secrets,
          row.name,
          `迭代项沟通群（${backlog.code}，需求 #${backlog.projectId}）`,
          resolved.openIds,
          { botIds: botAppIds, idempotencyKey: `backlog-chat-${row.id}` },
        );
      } catch (error) {
        if (botAppIds.length === 0) throw error;
        this.logger.warn(
          `迭代沟通群拉入机器人失败，降级为仅拉真人（${backlog.code}）: ${(error as Error).message}`,
        );
        botsAdded = false;
        chatId = await this.client.createChat(
          official.id,
          secrets,
          row.name,
          `迭代项沟通群（${backlog.code}，需求 #${backlog.projectId}）`,
          resolved.openIds,
          { idempotencyKey: `backlog-chat-${row.id}` },
        );
      }
      const addedBotIds = botsAdded ? botAppIds : [];
      const memberWorkerIds = resolved.targets
        .filter((target) => target.kind === 'user' || botsAdded)
        .map((target) => target.workerId);
      const memberUserIds = resolved.users.map((user) => user.id);
      const memberNames = resolved.memberNames;
      await this.chats.update(row.id, {
        chatId,
        state: 'active',
        officialConfigId: official.id,
        memberUserIds,
        memberWorkerIds,
        memberNames,
        botIds: addedBotIds,
        lastStatus: backlog.status,
        lastError: null,
      });
      Object.assign(row, {
        chatId,
        state: 'active',
        memberUserIds,
        memberWorkerIds,
        memberNames,
        botIds: addedBotIds,
        lastStatus: backlog.status,
      });
      try {
        await this.client.sendCard(
          official.id,
          secrets,
          'chat_id',
          chatId,
          markdownCard(
            [
              '**[迭代沟通群已创建]**',
              '',
              `- **迭代项**：${backlog.code} ${backlog.title}`,
              `- **需求**：#${backlog.projectId}`,
              `- **负责人**：${backlog.ownerName ?? '未指定'}`,
              `- **状态**：${backlog.status}`,
              `- **成员**：${
                row.memberNames.length ? row.memberNames.join('、') : '暂无'
              }`,
              ...(resolved.missingNames.length
                ? [
                    `- **未加入**：${resolved.missingNames.join('、')}（未匹配平台用户或未登录过平台）`,
                  ]
                : []),
              `- **迭代项链接**：${this.client.appUrl}/backlogs/${backlog.id}`,
              '',
              '本群会自动同步迭代项状态；完成或取消后保留 7 天并自动解散。',
            ].join('\n'),
          ),
        );
      } catch (error) {
        this.logger.warn(
          `迭代沟通群创建卡片发送失败（${backlog.code}）: ${(error as Error).message}`,
        );
      }
      this.logger.log(
        `迭代沟通群已创建：${backlog.code} → chat ${chatId}（${resolved.openIds.length} 人，${addedBotIds.length} 个机器人）`,
      );
    } catch (error) {
      const message = (error as Error).message;
      await this.chats.increment({ id: row.id }, 'attempts', 1);
      await this.chats.update(row.id, { state: 'error', lastError: message });
      this.logger.warn(`迭代沟通群创建失败（${backlog.code}）: ${message}`);
    }
  }

  /**
   * backlog 成员（统一为机器人）解析为飞书落地目标：
   * 真人机器人 → 绑定真人的 open_id；AI 机器人 → 其绑定的独立飞书应用 app_id。
   * 无法解析的成员计入 missingNames。
   */
  private async resolveMembers(
    official: FeishuBotConfig,
    backlog: Backlog,
  ): Promise<ResolvedMembers> {
    const members = backlog.members ?? [];
    if (members.length === 0) {
      return {
        targets: [],
        users: [],
        openIds: [],
        botAppIds: [],
        memberNames: [],
        missingNames: [],
      };
    }
    const workerIds = [...new Set(members.map((m) => m.workerId))];
    const workers = await this.workers.find({
      where: { id: In(workerIds) },
    });
    const workerById = new Map(workers.map((worker) => [worker.id, worker]));
    const humanUserIds = [
      ...new Set(
        workers
          .filter((worker) => worker.runtime === WorkerRuntime.HUMAN)
          .map((worker) => worker.humanUserId)
          .filter((id): id is number => id !== null),
      ),
    ];
    const users = humanUserIds.length
      ? await this.users.find({ where: { id: In(humanUserIds) } })
      : [];
    const userById = new Map(users.map((user) => [user.id, user]));

    const targets: MemberTarget[] = [];
    const memberUsers: User[] = [];
    const missingNames: string[] = [];
    const seenWorker = new Set<number>();
    const seenOpenIds = new Set<string>();
    const seenAppIds = new Set<string>();
    let userCount = 0;
    let botCount = 0;

    for (const member of members) {
      if (seenWorker.has(member.workerId)) continue;
      seenWorker.add(member.workerId);
      const worker = workerById.get(member.workerId);
      if (!worker) {
        missingNames.push(member.name);
        continue;
      }
      if (worker.runtime === WorkerRuntime.HUMAN) {
        const userId = worker.humanUserId;
        const user = userId !== null ? userById.get(userId) : undefined;
        if (!user || userCount >= MAX_CHAT_MEMBERS) {
          missingNames.push(member.name);
          continue;
        }
        const openId =
          (await this.identities.openIdFor(official.id, user.id)) ??
          user.feishuOpenId;
        if (!openId || seenOpenIds.has(openId)) {
          missingNames.push(member.name);
          continue;
        }
        seenOpenIds.add(openId);
        userCount += 1;
        memberUsers.push(user);
        targets.push({
          workerId: worker.id,
          kind: 'user',
          id: openId,
          name: user.name,
          userId: user.id,
        });
        continue;
      }

      // AI 机器人：绑定独立飞书应用才可拉入群（排除官方应用自身）
      const config = await this.configs.findEnabledWorkerConfig(worker.id);
      if (
        !config ||
        config.appId === official.appId ||
        seenAppIds.has(config.appId) ||
        botCount >= MAX_BOT_MEMBERS
      ) {
        continue;
      }
      seenAppIds.add(config.appId);
      botCount += 1;
      targets.push({
        workerId: worker.id,
        kind: 'bot',
        id: config.appId,
        name: worker.name,
      });
    }

    return {
      targets,
      users: memberUsers,
      openIds: targets
        .filter((target) => target.kind === 'user')
        .map((target) => target.id),
      botAppIds: targets
        .filter((target) => target.kind === 'bot')
        .map((target) => target.id),
      memberNames: targets.map((target) => target.name),
      missingNames,
    };
  }

  /**
   * 群存活校验：飞书侧已解散（chat_status=dissolved / dissolved_save）或 chat_id 失效时
   * 重置绑定，让详情页重新提供「飞书建群」入口；其它错误仅告警并保持现状。
   */
  private async ensureChatAlive(
    row: FeishuBotBacklogChat,
    secrets: FeishuBotSecrets,
  ): Promise<boolean> {
    if (!row.chatId) return false;
    try {
      const info = await this.client.getChatInfo(
        row.officialConfigId,
        secrets,
        row.chatId,
      );
      if (
        info.chatStatus === 'dissolved' ||
        info.chatStatus === 'dissolved_save'
      ) {
        await this.resetChat(row, '飞书群已在飞书侧解散，可重新建群');
        return false;
      }
      return true;
    } catch (error) {
      const message = (error as Error).message;
      if (isChatMissingError(message)) {
        await this.resetChat(row, '飞书群已不存在，可重新建群');
        return false;
      }
      this.logger.warn(
        `迭代沟通群存活校验失败（backlog#${row.backlogId}）: ${message}`,
      );
      return true;
    }
  }

  /** 群已不可用：置为 destroyed 并记录原因，下次「飞书建群」会重建绑定 */
  private async resetChat(
    row: FeishuBotBacklogChat,
    lastError: string,
  ): Promise<void> {
    await this.chats.update(row.id, { state: 'destroyed', lastError });
    row.state = 'destroyed';
    this.logger.warn(
      `迭代沟通群在飞书侧不可用，重置绑定（chat ${row.chatId}）: ${lastError}`,
    );
  }

  /**
   * 成员变化后把新增成员拉进已有群（只加不减）。
   * 由迭代项成员保存 / 负责人变化 / 需求方联动触发；无群或终态时直接返回。
   */
  async syncMembers(backlogId: number): Promise<void> {
    const [backlog, row] = await Promise.all([
      this.backlogs.findOne({ where: { id: backlogId } }),
      this.chats.findOne({ where: { backlogId } }),
    ]);
    if (!backlog || !row || row.state !== 'active' || !row.chatId) return;
    if (isBacklogTerminal(backlog.status)) return;
    const official = await this.configs.loadEnabledWithSecrets(
      row.officialConfigId,
    );
    if (!official) return;
    const secrets = this.configs.secretsOf(official);
    await this.withLock(`backlog-chat:${row.id}`, async () => {
      const fresh = await this.chats.findOne({ where: { id: row.id } });
      if (!fresh || fresh.state !== 'active' || !fresh.chatId) return;
      const current = await this.backlogs.findOne({ where: { id: backlogId } });
      if (!current) return;
      await this.syncMembersInternal(fresh, current, official, secrets);
    });
  }

  /**
   * 增量同步群成员：与已跟踪的机器人集合求差集后只补加缺失成员。
   * 升级前的存量群没有跟踪记录（memberWorkerIds 为空），此时按全部当前成员补拉：
   * 旧版本建群后从不补拉真人成员，不能假定他们已在群内；
   * 飞书拉人接口 succeed_type=1 会忽略已入群/非法成员，重复调用是安全的。
   */
  private async syncMembersInternal(
    row: FeishuBotBacklogChat,
    backlog: Backlog,
    official: FeishuBotConfig,
    secrets: FeishuBotSecrets,
  ): Promise<void> {
    if (!row.chatId) return;
    const resolved = await this.resolveMembers(official, backlog);
    const added = new Set(row.memberWorkerIds ?? []);
    const newTargets = resolved.targets.filter(
      (target) => !added.has(target.workerId),
    );
    if (newTargets.length === 0) return;

    const addedWorkerIds = new Set(added);
    const newNames = new Set(row.memberNames ?? []);
    const newUserIds = new Set(row.memberUserIds ?? []);
    const newBotIds = new Set(row.botIds ?? []);

    const userTargets = newTargets.filter((target) => target.kind === 'user');
    if (userTargets.length > 0) {
      try {
        await this.client.addChatUsers(
          row.officialConfigId,
          secrets,
          row.chatId,
          userTargets.map((target) => target.id),
        );
        for (const target of userTargets) {
          addedWorkerIds.add(target.workerId);
          newNames.add(target.name);
          if (target.userId) newUserIds.add(target.userId);
        }
      } catch (error) {
        this.logger.warn(
          `迭代沟通群补拉成员失败（${backlog.code}）: ${(error as Error).message}`,
        );
      }
    }

    const botTargets = newTargets.filter((target) => target.kind === 'bot');
    if (botTargets.length > 0) {
      try {
        await this.client.addChatMembers(
          row.officialConfigId,
          secrets,
          row.chatId,
          botTargets.map((target) => target.id),
        );
        for (const target of botTargets) {
          addedWorkerIds.add(target.workerId);
          newNames.add(target.name);
          newBotIds.add(target.id);
        }
      } catch (error) {
        this.logger.warn(
          `迭代沟通群补拉机器人失败（${backlog.code}）: ${(error as Error).message}`,
        );
      }
    }

    const memberWorkerIds = [...addedWorkerIds];
    const memberNames = [...newNames];
    const memberUserIds = [...newUserIds];
    const botIds = [...newBotIds];
    await this.chats.update(row.id, {
      memberWorkerIds,
      memberNames,
      memberUserIds,
      botIds,
      lastError: null,
    });
    Object.assign(row, {
      memberWorkerIds,
      memberNames,
      memberUserIds,
      botIds,
    });
  }

  /** 终态固定解散时间，所有终态统一保留 7 天 */
  private async markFinished(
    row: FeishuBotBacklogChat,
    backlog: Backlog,
  ): Promise<void> {
    if (!isBacklogTerminal(backlog.status) || row.finishedAt) return;
    const finishedAt =
      backlog.completedAt ?? backlog.canceledAt ?? backlog.updatedAt;
    const destroyAfter = new Date(finishedAt.getTime() + DISSOLVE_DELAY_MS);
    await this.chats.update(row.id, { finishedAt, destroyAfter });
    row.finishedAt = finishedAt;
    row.destroyAfter = destroyAfter;
  }

  private async sendStatusCard(
    row: FeishuBotBacklogChat,
    backlog: Backlog,
    official: FeishuBotConfig,
    secrets: FeishuBotSecrets,
  ): Promise<void> {
    if (!row.chatId || row.state !== 'active') return;
    const terminal = isBacklogTerminal(backlog.status);
    if (terminal && row.finishedNotified) return;
    try {
      await this.client.sendCard(
        row.officialConfigId,
        secrets,
        'chat_id',
        row.chatId,
        markdownCard(
          terminal
            ? [
                `**[迭代项已${backlog.status}]** ${backlog.code}`,
                `- **迭代项**：${backlog.title}`,
                `- **需求**：#${backlog.projectId}`,
                `- **负责人**：${backlog.ownerName ?? '未指定'}`,
                `- **状态**：${
                  row.lastStatus ? `${row.lastStatus} → ` : ''
                }${backlog.status}`,
                `- **迭代项链接**：${this.client.appUrl}/backlogs/${backlog.id}`,
                '',
                row.destroyAfter
                  ? `该群将于 **${formatBeijing(row.destroyAfter)}** 自动解散，迭代项记录与交付文档不受影响。`
                  : '该群将在终态后 7 天自动解散，迭代项记录与交付文档不受影响。',
              ].join('\n')
            : [
                `**[迭代项状态更新]** ${backlog.code}`,
                `- **迭代项**：${backlog.title}`,
                `- **需求**：#${backlog.projectId}`,
                `- **状态**：${
                  row.lastStatus ? `${row.lastStatus} → ` : ''
                }${backlog.status}`,
                `- **负责人**：${backlog.ownerName ?? '未指定'}`,
                `- **迭代项链接**：${this.client.appUrl}/backlogs/${backlog.id}`,
              ].join('\n'),
        ),
      );
      await this.chats.update(row.id, {
        lastStatus: backlog.status,
        finishedNotified: terminal ? true : row.finishedNotified,
        lastError: null,
      });
      row.lastStatus = backlog.status;
      if (terminal) row.finishedNotified = true;
    } catch (error) {
      const message = (error as Error).message;
      await this.chats.update(row.id, { lastError: message });
      this.logger.warn(`迭代沟通群状态推送失败（${backlog.code}）: ${message}`);
    }
  }

  /** backlog 删除后尽力解散；官方机器人不可用时保留绑定等待恢复后重试 */
  private async destroyMissingGroup(row: FeishuBotBacklogChat): Promise<void> {
    if (row.state === 'destroyed') return;
    await this.withLock(`backlog-chat:${row.id}`, async () => {
      const fresh = await this.chats.findOne({ where: { id: row.id } });
      if (!fresh || fresh.state === 'destroyed') return;
      if (!fresh.chatId) {
        await this.chats.update(fresh.id, {
          state: 'destroyed',
          lastError: '迭代项已删除',
        });
        return;
      }
      const official = await this.configs.loadEnabledWithSecrets(
        fresh.officialConfigId,
      );
      if (!official) {
        await this.chats.update(fresh.id, {
          lastError: '迭代项已删除，但官方机器人不可用，暂无法解散群',
        });
        return;
      }
      await this.dissolve(fresh, this.configs.secretsOf(official));
    });
  }

  private async dissolve(
    row: FeishuBotBacklogChat,
    secrets: FeishuBotSecrets,
  ): Promise<void> {
    if (!row.chatId) {
      await this.chats.update(row.id, { state: 'destroyed' });
      return;
    }
    try {
      await this.client.dissolveChat(row.officialConfigId, secrets, row.chatId);
      await this.chats.update(row.id, {
        state: 'destroyed',
        lastError: null,
      });
      this.logger.log(`迭代沟通群已解散：chat ${row.chatId}`);
    } catch (error) {
      const message = (error as Error).message;
      if (isChatMissingError(message)) {
        await this.chats.update(row.id, {
          state: 'destroyed',
          lastError: null,
        });
        this.logger.log(`迭代沟通群已不存在：chat ${row.chatId}`);
        return;
      }
      await this.chats.update(row.id, { lastError: message });
      this.logger.warn(`迭代沟通群解散失败（chat ${row.chatId}）: ${message}`);
    }
  }

  /** 同一群串行处理，避免重复卡片和重复建群 */
  private async withLock(key: string, run: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous;
    try {
      await run();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

/** 飞书接口错误是否表示群已不存在（232006：chat_id 无效） */
function isChatMissingError(message: string): boolean {
  return message.includes(CHAT_MISSING_ERROR_CODE);
}

function formatBeijing(value: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}
