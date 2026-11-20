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
 * 写入工位 .opencode/opencode.json 的 MCP 配置（权限 600）：
 * `mcp.servers` 由调用方统一生成（平台 lita-work + 机器人勾选的自定义 MCP），
 * 本地包含令牌时只经服务端结构化写入，不进入日志与 Prompt。
 */
export async function writeMcpConfigFile(
  client: ExecutorClient,
  workdir: string,
  servers: Record<string, OpencodeMcpServerConfig>,
): Promise<void> {
  const config = JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      mcp: { servers },
    },
    null,
    2,
  );
  await client.writeSecretFile(workdir, '.opencode/opencode.json', config);
}
