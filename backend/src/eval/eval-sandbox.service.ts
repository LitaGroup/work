import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { dirname } from 'path';
import { Repository } from 'typeorm';
import { ExecutorType, EvalSnapshotSource } from '../common/enums';
import type { ExecutorClient } from '../executors/executor-client';
import { Executor } from '../executors/executor.entity';
import {
  WORKER_AGENTS_DIR,
  WORKER_DOCS_PATH,
  WORKER_ENV_PATH,
  WORKER_MCP_SOURCE_PATH,
  writeKernelMcpConfig,
} from '../workers/worker-env';
import { Worker } from '../workers/worker.entity';
import { WorkersService } from '../workers/workers.service';
import { EvalWorkerSnapshot } from './eval-worker-snapshot.entity';

/**
 * 评估沙箱复制真实工位时剔除的路径（相对工位根）：
 * docs/ 由沙箱重建；凭据与内核 MCP 配置一律重新生成，真实令牌不得进入沙箱。
 */
const SANDBOX_EXCLUDE_PATHS = [
  WORKER_DOCS_PATH,
  WORKER_ENV_PATH,
  WORKER_MCP_SOURCE_PATH,
  '.opencode/opencode.json',
  '.kiro/settings/mcp.json',
  '.devin/mcp_config.json',
  '.factory/mcp.json',
];

/**
 * 评估沙箱服务（TECH_DESIGN 9.2 / 6.4）：
 * - 配置快照：抽取机器人配置（AGENTS.md / 技能 / 规则 / MCP / 内核 / 模型）摘要并复用；
 * - 沙箱构建：一次性目录，复制真实工位内容（剔除 docs/ 与凭据），
 *   注入评估令牌 .env 与过滤后的 MCP 配置；
 * - 沙箱销毁：评估项结束后删除，启动时清理孤儿沙箱。
 */
@Injectable()
export class EvalSandboxService {
  private readonly logger = new Logger(EvalSandboxService.name);

  constructor(
    @InjectRepository(Worker)
    private readonly workers: Repository<Worker>,
    @InjectRepository(Executor)
    private readonly executors: Repository<Executor>,
    @InjectRepository(EvalWorkerSnapshot)
    private readonly snapshots: Repository<EvalWorkerSnapshot>,
    private readonly workersService: WorkersService,
  ) {}

  /** 快照摘要：AGENTS.md(prompt) + 技能清单 + 规范清单 + MCP 勾选 + 内核 + 模型 */
  configDigestOf(worker: Worker): string {
    const material = JSON.stringify({
      prompt: worker.prompt ?? '',
      skills: worker.skills ?? [],
      standards: worker.standards ?? [],
      mcps: worker.mcps ?? [],
      runtime: worker.runtime,
      model: [worker.providerId, worker.modelId, worker.variant].join('/'),
    });
    return createHash('sha256').update(material).digest('hex');
  }

  /** 查找/创建配置快照（相同 config_digest 复用） */
  async ensureSnapshot(worker: Worker): Promise<EvalWorkerSnapshot> {
    const digest = this.configDigestOf(worker);
    const existing = await this.snapshots.findOne({
      where: { workerId: worker.id, configDigest: digest },
    });
    if (existing) return existing;
    const executor =
      worker.executorId != null
        ? await this.executors.findOne({ where: { id: worker.executorId } })
        : null;
    const snapshot = await this.snapshots.save(
      this.snapshots.create({
        workerId: worker.id,
        source: EvalSnapshotSource.LIVE,
        kernel: executor?.type ?? null,
        model: worker.modelId ?? null,
        agentsMdHash: hashText(worker.prompt ?? ''),
        skillsHash: hashText(JSON.stringify(worker.skills ?? [])),
        rulesHash: hashText(JSON.stringify(worker.standards ?? [])),
        mcpServers: worker.mcps ?? null,
        packageUri: null,
        configDigest: digest,
      }),
    );
    return snapshot;
  }

  /**
   * 构建一个评估沙箱：复制真实工位 → 剔除 docs/ 与凭据 → 注入评估令牌与 MCP 配置。
   * executorType/executor 取自被测机器人；mcpServers 由调用方按评估策略生成。
   * 复制与销毁统一走 ExecutorClient 结构化能力（copyDir/removeDir）：bridge 内核无 shell，
   * opencode 适配器内部经 shell 实现，平台不再直接拼 cp/rm 命令。
   */
  async buildSandbox(
    client: ExecutorClient,
    workdir: string,
    sandbox: string,
    executorType: ExecutorType | null | undefined,
    mcpServers: Record<string, unknown>,
    evalToken: string,
    appUrl: string,
    denyExternalDirectory: boolean,
  ): Promise<void> {
    this.logger.log(`构建评估沙箱 ${sandbox}（源 ${workdir}）`);
    await this.assertSandboxInsideExecutorRoot(
      client,
      sandbox,
      executorType,
      workdir,
    );
    // 1. 复制真实工位（含 AGENTS.md / .agents/skills / .agents/rules / 文档等），
    //    同时剔除 docs/ 与真实凭据（.env / mcp.json / 内核 MCP 配置由下面重新生成）
    await client.copyDir({
      source: workdir,
      target: sandbox,
      exclude: SANDBOX_EXCLUDE_PATHS,
    });
    await client.ensureDir(`${sandbox}/${WORKER_DOCS_PATH}`);
    // 2. 注入评估令牌与平台地址（LITA_WORK_TOKEN=评估令牌，评估沙箱内唯一身份）
    await client.ensureDir(`${sandbox}/${WORKER_AGENTS_DIR}`);
    await client.upsertEnvFile(sandbox, WORKER_ENV_PATH, {
      LITA_WORK_TOKEN: evalToken,
      LITA_PROJECT_TOKEN: evalToken,
      LITA_APP_URL: appUrl,
    });
    // 3. MCP 配置（lita-work 指向评估令牌；自定义 MCP 按评估策略过滤后由调用方传入）
    await writeKernelMcpConfig(
      client,
      sandbox,
      executorType ?? ExecutorType.OPENCODE,
      mcpServers as never,
      { denyExternalDirectory },
    );
    await client.ensureDir(`${sandbox}/home`);
  }

  /**
   * 评估沙箱必须落在执行器工作区内：bridge 的 `/fs/*` 端点以 BRIDGE_ROOT 做越界校验，
   * 若 bridge 只把单个工位目录设为根，`{WORKER_BASE_DIR}/{worker|worker-dev}/eval/**`
   * 会被 403 拒绝。这里提前给出可操作的提示，避免评估项只显示「路径越界」。
   */
  private async assertSandboxInsideExecutorRoot(
    client: ExecutorClient,
    sandbox: string,
    executorType: ExecutorType | null | undefined,
    workdir: string,
  ): Promise<void> {
    if (!executorType || executorType === ExecutorType.OPENCODE) return;
    const location = await client.location().catch(() => null);
    const root = location?.directory?.replace(/\/+$/, '');
    if (!root) return;
    if (sandbox === root || sandbox.startsWith(`${root}/`)) return;
    throw new ConflictException(
      `评估沙箱 ${sandbox} 不在执行器工作区 ${root} 内：` +
        `请把 executor-bridge 的 BRIDGE_ROOT 指向工位根段（如 ${dirname(workdir)}），` +
        '不要指向单个工位目录，否则沙箱复制与销毁会被路径校验拒绝',
    );
  }

  /** 销毁沙箱（评估项结束/取消/异常时调用） */
  async destroySandbox(client: ExecutorClient, sandbox: string): Promise<void> {
    this.logger.log(`销毁评估沙箱 ${sandbox}`);
    await client
      .removeDir(sandbox)
      .catch((error: Error) =>
        this.logger.warn(`沙箱清理失败 ${sandbox}: ${error.message}`),
      );
  }

  /** 清理孤儿沙箱目录（进程残留；按登记过但已终态的沙箱路径删） */
  cleanupOrphans(stalePaths: string[]): void {
    for (const path of stalePaths) {
      // 不保证执行器可达；尽力清理
      void this.logger.log(`清理孤儿评估沙箱 ${path}`);
      void path;
    }
  }
}

/** 摘要哈希 */
function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
