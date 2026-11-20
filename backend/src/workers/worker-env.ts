/**
 * 工位凭据文件写入助手（初始化与派发共用）。
 * 全部走 ExecutorClient 结构化文件方法（ensureDir / writeSecretFile / upsertEnvFile），
 * opencode 适配器内部经 shell 实现、bridge 走原生文件端点，平台不再拼 shell。
 * 令牌只经服务端下发落盘，不进入 Prompt、SSE 进度或日志。
 */
import type { ExecutorClient } from '../executors/executor-client';

/** opencode V2 的单个 MCP 服务配置（remote / local） */
export interface OpencodeMcpServerConfig {
  type: 'remote' | 'local';
  url?: string;
  command?: string[];
  oauth?: false;
  headers?: Record<string, string>;
  environment?: Record<string, string>;
}

/** 幂等建立工位骨架目录（workdir + skills/rules/docs） */
export async function ensureWorkerSkeleton(
  client: ExecutorClient,
  workdir: string,
): Promise<void> {
  await client.ensureDir(workdir);
  await client.ensureDir(`${workdir}/.opencode/skills`);
  await client.ensureDir(`${workdir}/.opencode/rules`);
  await client.ensureDir(`${workdir}/.opencode/docs`);
}

/** 写入工位 .opencode/agent-token（权限 600，幂等） */
export async function writeAgentTokenFile(
  client: ExecutorClient,
  workdir: string,
  token: string,
): Promise<void> {
  await client.ensureDir(`${workdir}/.opencode`);
  await client.writeSecretFile(workdir, '.opencode/agent-token', token);
}

/**
 * 更新工位 .opencode/.env 的指定键（保留其他键，权限 600；文件不存在时创建）。
 * 工位 .env 固定注入三个令牌：
 * - LITA_WORK_TOKEN：机器人工作令牌（新名，优先使用），访问项目平台 .md 接口；
 *   个人 AGENT 使用其主人真人机器人的令牌
 * - LITA_PROJECT_TOKEN：同一工作令牌的兼容旧名
 * - LITA_USER_TOKEN：Lita 用户令牌，供 lita-api 等技能使用
 */
export async function upsertWorkerEnv(
  client: ExecutorClient,
  workdir: string,
  entries: Record<string, string>,
): Promise<void> {
  await client.upsertEnvFile(workdir, '.opencode/.env', entries);
}

/**
 * 工作区边界权限（平台强制）：opencode 会话禁止读写工位（Location）之外的任何路径。
 * `external_directory` 在 read/edit 规则之前拦截工位外路径（含 write/patch 与 shell 扫描推断），
 * `deny` 不会被客户端「允许」答复或已保存的 allow 规则覆盖。
 */
export const WORKER_BOUNDARY_PERMISSIONS = [
  { action: 'external_directory', resource: '*', effect: 'deny' },
] as const;

/**
 * 止血开关：环境变量 WORKER_DENY_EXTERNAL_DIRECTORY 显式为 false/0/no/off 时
 * 关闭工作区边界权限注入，缺省（含未配置）开启。
 */
export function shouldDenyExternalDirectory(
  raw: string | null | undefined,
): boolean {
  const value = raw?.trim().toLowerCase();
  return (
    value !== 'false' && value !== '0' && value !== 'no' && value !== 'off'
  );
}

/** writeOpencodeConfigFile 选项 */
export interface WriteOpencodeConfigOptions {
  /** 是否注入工作区边界权限（默认 true） */
  denyExternalDirectory?: boolean;
}

/**
 * 写入工位 .opencode/opencode.json（权限 600）：
 * - `mcp.servers`：平台 lita-work + 机器人勾选的自定义 MCP（由调用方统一生成）；
 * - `permissions`：工作区边界（禁止会话读写工位之外的路径），可用
 *   WORKER_DENY_EXTERNAL_DIRECTORY=false 止血关闭。
 * 本地包含令牌时只经服务端结构化写入，不进入日志与 Prompt。
 */
export async function writeOpencodeConfigFile(
  client: ExecutorClient,
  workdir: string,
  servers: Record<string, OpencodeMcpServerConfig>,
  options: WriteOpencodeConfigOptions = {},
): Promise<void> {
  const denyExternalDirectory = options.denyExternalDirectory ?? true;
  const config = JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      ...(denyExternalDirectory
        ? { permissions: WORKER_BOUNDARY_PERMISSIONS }
        : {}),
      mcp: { servers },
    },
    null,
    2,
  );
  await client.writeSecretFile(workdir, '.opencode/opencode.json', config);
}
