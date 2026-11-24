import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../auth/user.entity';
import { UserRole } from '../common/enums';
import { FeishuBotClientService } from '../feishu-bot/feishu-bot-client.service';
import { FeishuBotConfigService } from '../feishu-bot/feishu-bot-config.service';
import { Worker } from '../workers/worker.entity';

/** 上级解析缓存时长（1 小时，自动跟随组织变化） */
const LEADER_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * 机器人所有者（需求确认：owner = 绑定真人的上级）。
 * - 真人机器人：所有者为其绑定真人在飞书通讯录的直属上级（leader），映射回平台用户；
 * - AI 机器人（无绑定真人）：无所有者，仅管理员；
 * - 解析不到上级（未配置、不在平台、通讯录权限缺失）：仅管理员。
 * 不落库，实时查询 + 进程内缓存。
 */
@Injectable()
export class WorkerOwnerService {
  private readonly logger = new Logger(WorkerOwnerService.name);
  /** openId → { leaderOpenId | null, expireAt } */
  private readonly leaderCache = new Map<
    string,
    { leaderOpenId: string | null; expireAt: number }
  >();

  constructor(
    @InjectRepository(Worker)
    private readonly workers: Repository<Worker>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly feishuConfigs: FeishuBotConfigService,
    private readonly feishuClient: FeishuBotClientService,
  ) {}

  /** 机器人所有者用户 id（上级）；无所有者返回 null */
  async ownerUserIdOf(worker: Worker): Promise<number | null> {
    if (!worker.humanUserId) return null;
    const bound = await this.users.findOne({
      where: { id: worker.humanUserId },
      select: { id: true, feishuOpenId: true },
    });
    if (!bound?.feishuOpenId) return null;
    const leaderOpenId = await this.leaderOpenIdOf(bound.feishuOpenId);
    if (!leaderOpenId) return null;
    const leader = await this.users.findOne({
      where: { feishuOpenId: leaderOpenId },
      select: { id: true },
    });
    return leader?.id ?? null;
  }

  /** 当前用户是否是该机器人的所有者（上级）或管理员 */
  async canManageWorker(user: User, worker: Worker): Promise<boolean> {
    if (user.role === UserRole.ADMIN) return true;
    const ownerId = await this.ownerUserIdOf(worker);
    return ownerId !== null && ownerId === user.id;
  }

  /** 断言可管理（12.8 执行记录/开关等） */
  async assertCanManageWorker(user: User, worker: Worker): Promise<void> {
    if (!(await this.canManageWorker(user, worker))) {
      throw new ForbiddenException(
        '仅机器人所有者（绑定真人的上级）或管理员可以执行该操作',
      );
    }
  }

  /** 读取用户直属上级 open_id（飞书通讯录；结果缓存；失败降级 null） */
  private async leaderOpenIdOf(openId: string): Promise<string | null> {
    const cached = this.leaderCache.get(openId);
    if (cached && cached.expireAt > Date.now()) return cached.leaderOpenId;
    let leaderOpenId: string | null = null;
    try {
      const config = await this.feishuConfigs.loadEnabledOfficial();
      if (!config) {
        throw new BadRequestException('平台官方机器人未配置');
      }
      const secrets = this.feishuConfigs.secretsOf(config);
      leaderOpenId = await this.feishuClient.contactLeaderOpenId(
        config.id,
        secrets,
        openId,
      );
    } catch (error) {
      this.logger.warn(
        `解析飞书直属上级失败（${openId}）：${(error as Error).message}`,
      );
    }
    this.leaderCache.set(openId, {
      leaderOpenId,
      expireAt: Date.now() + LEADER_CACHE_TTL_MS,
    });
    return leaderOpenId;
  }
}

void Worker;
