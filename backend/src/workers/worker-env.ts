/**
 * 工位凭据与内核配置文件写入助手（初始化与派发共用）。
 * 全部走 ExecutorClient 结构化文件方法（ensureDir / writeSecretFile / upsertEnvFile），
 * opencode 适配器内部经 shell 实现、bridge 走原生文件端点，平台不再拼 shell。
 * 令牌只经服务端下发落盘，不进入 Prompt、SSE 进度或日志。
 *
 * 工位目录约定（内核无关）：
 * - AGENTS.md             机器人角色定义与平台固定协同协议
 * - .agents/skills/       技能源目录（opencode、devin 原生发现）
 * - .agents/rules/        规范源目录（.standards-manifest.json 受管清单）
 * - .agents/.env          平台注入的令牌与地址（权限 600）
 * - .agents/mcp.json      内核无关 MCP 声明（权限 600，只读参考）
 * - docs/                 机器人自行维护的知识文档
 * 内核适配物由平台按执行器类型生成（均为平台受管，机器人不得改写）：
 * - opencode：.opencode/opencode.json（MCP + 工作区边界权限）+ .opencode/rules 镜像
 * - kiro：.kiro/settings/mcp.json + .kiro/skills、.kiro/steering 镜像
 * - devin：.devin/mcp_config.json（技能走 .agents/skills 原生发现）
 * - droid：.factory/mcp.json + .factory/skills、.factory/rules 镜像
 */
import { ExecutorType } from '../common/enums';
import type { ExecutorClient } from '../executors/executor-client';

/** 通用 Agent 目录（内核无关的技能、规范、环境变量与 MCP 声明） */
export const WORKER_AGENTS_DIR = '.agents';
/** 工位环境变量文件（相对工位根，权限 600） */
export const WORKER_ENV_PATH = `${WORKER_AGENTS_DIR}/.env`;
/** 技能源目录（opencode、devin 原生发现） */
export const WORKER_SKILLS_PATH = `${WORKER_AGENTS_DIR}/skills`;
/** 规范源目录（受管清单位于 .standards-manifest.json） */
export const WORKER_RULES_PATH = `${WORKER_AGENTS_DIR}/rules`;
/** 内核无关 MCP 声明（源 + 审计） */
export const WORKER_MCP_SOURCE_PATH = `${WORKER_AGENTS_DIR}/mcp.json`;
/** 机器人自行维护的文档目录 */
export const WORKER_DOCS_PATH = 'docs';

/**
 * 提示词模板读取工位令牌的 shell 片段：
 * 先 source 工位环境变量，再取兼容变量名。模板中「先 source、再赋值 TOKEN」两行成对使用。
 */
export const WORKER_ENV_SOURCE_COMMAND = `set -a; . ${WORKER_ENV_PATH}; set +a`;
/** 令牌变量赋值（LITA_WORK_TOKEN 优先，LITA_PROJECT_TOKEN 兼容旧名） */
export const WORKER_TOKEN_SHELL_ASSIGN =
  'TOKEN=${LITA_WORK_TOKEN:-$LITA_PROJECT_TOKEN}';

/** opencode V2 的单个 MCP 服务配置（remote / local） */
export interface OpencodeMcpServerConfig {
  type: 'remote' | 'local';
  url?: string;
  command?: string[];
  oauth?: false;
  headers?: Record<string, string>;
  environment?: Record<string, string>;
}

/** 幂等建立工位骨架目录（workdir + 技能/规范/文档/opencode 配置目录） */
export async function ensureWorkerSkeleton(
  client: ExecutorClient,
  workdir: string,
): Promise<void> {
  await client.ensureDir(workdir);
  await client.ensureDir(`${workdir}/${WORKER_SKILLS_PATH}`);
  await client.ensureDir(`${workdir}/${WORKER_RULES_PATH}`);
  await client.ensureDir(`${workdir}/${WORKER_DOCS_PATH}`);
  // opencode 适配物目录（opencode.json）；其它内核不使用，保持存在无副作用
  await client.ensureDir(`${workdir}/.opencode`);
}

/**
 * 更新工位 .agents/.env 的指定键（保留其他键，权限 600；文件不存在时创建）。
 * 固定注入的键：
 * - LITA_WORK_TOKEN：机器人工作令牌（新名，优先使用），访问项目平台 .md 接口；
 *   个人 AGENT 使用其主人真人机器人的令牌
 * - LITA_PROJECT_TOKEN：同一工作令牌的兼容旧名
 * - LITA_USER_TOKEN：Lita 用户令牌，供 lita-api 等技能使用
 * - LITA_APP_URL：平台访问地址（http(s) 协议以值本身为准，供 .md 回退拼接）
 */
export async function upsertWorkerEnv(
  client: ExecutorClient,
  workdir: string,
  entries: Record<string, string>,
): Promise<void> {
  // 幂等建目录：opencode 适配器按 shell 重定向写文件，父目录需先存在
  await client.ensureDir(`${workdir}/${WORKER_AGENTS_DIR}`);
  await client.upsertEnvFile(workdir, WORKER_ENV_PATH, entries);
}

/**
 * 工作区边界权限（平台强制）：opencode 会话禁止读写工位（Location）之外的任何路径。
 * `external_directory` 在 read/edit 规则之前拦截工位外路径（含 write/patch 与 shell 扫描推断），
 * `deny` 不会被客户端「允许」答复或已保存的 allow 规则覆盖。
 * 注意：当前仅 opencode 内核支持该强制边界；bridge 内核（kiro/devin/droid）以 AGENTS.md 协议约束为准。
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

/** kiro 的 mcpServers 条目（.kiro/settings/mcp.json） */
type KiroMcpServerConfig =
  | { url: string; headers?: Record<string, string> }
  | { command: string; args?: string[]; env?: Record<string, string> };

/** devin 的 mcpServers 条目（.devin/mcp_config.json） */
type DevinMcpServerConfig =
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { command: string; args?: string[]; env?: Record<string, string> };

/** droid 的 mcpServers 条目（.factory/mcp.json） */
type DroidMcpServerConfig =
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
      oauth: false;
    }
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

/** 拆分 stdio 命令（exe + 其余参数），空命令返回 null */
function splitCommand(
  command: string[] | undefined,
): { command: string; args?: string[] } | null {
  const [exe, ...args] = command ?? [];
  if (!exe) return null;
  return { command: exe, ...(args.length ? { args } : {}) };
}

/**
 * opencode 风格 MCP 配置 → kiro mcpServers（remote 用 url+headers；local 用 command/args/env）。
 * 无法表示的条目（如 local 空命令）直接跳过。
 */
function toKiroServers(
  servers: Record<string, OpencodeMcpServerConfig>,
): Record<string, KiroMcpServerConfig> {
  const result: Record<string, KiroMcpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.type === 'local') {
      const split = splitCommand(server.command);
      if (!split) continue;
      result[name] = {
        ...split,
        ...(server.environment ? { env: server.environment } : {}),
      };
    } else {
      result[name] = {
        url: server.url ?? '',
        ...(server.headers ? { headers: server.headers } : {}),
      };
    }
  }
  return result;
}

/**
 * opencode 风格 MCP 配置 → devin mcpServers（http 用 type+url+headers；stdio 用 command/args/env）。
 * 无法表示的条目直接跳过。
 */
function toDevinServers(
  servers: Record<string, OpencodeMcpServerConfig>,
): Record<string, DevinMcpServerConfig> {
  const result: Record<string, DevinMcpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.type === 'local') {
      const split = splitCommand(server.command);
      if (!split) continue;
      result[name] = {
        ...split,
        ...(server.environment ? { env: server.environment } : {}),
      };
    } else {
      result[name] = {
        type: 'http',
        url: server.url ?? '',
        ...(server.headers ? { headers: server.headers } : {}),
      };
    }
  }
  return result;
}

/**
 * opencode 风格 MCP 配置 → droid mcpServers（http 用 type+url+headers+oauth:false；
 * stdio 用 type+command/args/env）。无法表示的条目直接跳过。
 */
function toDroidServers(
  servers: Record<string, OpencodeMcpServerConfig>,
): Record<string, DroidMcpServerConfig> {
  const result: Record<string, DroidMcpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.type === 'local') {
      const split = splitCommand(server.command);
      if (!split) continue;
      result[name] = {
        type: 'stdio',
        ...split,
        ...(server.environment ? { env: server.environment } : {}),
      };
    } else {
      result[name] = {
        type: 'http',
        url: server.url ?? '',
        ...(server.headers ? { headers: server.headers } : {}),
        // 机器人令牌走请求头鉴权：显式关闭 OAuth，避免内核发起登录流程
        oauth: false,
      };
    }
  }
  return result;
}

/**
 * 按执行器内核写入 MCP 配置（初始化/派发时幂等调用）：
 * - 始终写内核无关声明 .agents/mcp.json（源 + 审计）；
 * - opencode：.opencode/opencode.json（含工作区边界权限）；
 * - kiro：.kiro/settings/mcp.json；
 * - devin：.devin/mcp_config.json；
 * - droid：.factory/mcp.json；
 * - 其它（codex / claude-code 规划中）：仅写通用声明，接入时补内核适配。
 * 令牌明文落盘（权限 600），只经服务端结构化写入，不进入日志与 Prompt。
 */
export async function writeKernelMcpConfig(
  client: ExecutorClient,
  workdir: string,
  executorType: ExecutorType | null | undefined,
  servers: Record<string, OpencodeMcpServerConfig>,
  options: WriteOpencodeConfigOptions = {},
): Promise<void> {
  const kernel = executorType ?? ExecutorType.OPENCODE;
  await client.ensureDir(`${workdir}/${WORKER_AGENTS_DIR}`);
  await client.writeSecretFile(
    workdir,
    WORKER_MCP_SOURCE_PATH,
    JSON.stringify({ version: 1, kernel, servers }, null, 2),
  );
  switch (kernel) {
    case ExecutorType.OPENCODE:
      await writeOpencodeConfigFile(client, workdir, servers, options);
      return;
    case ExecutorType.KIRO:
      await client.ensureDir(`${workdir}/.kiro/settings`);
      await client.writeSecretFile(
        workdir,
        '.kiro/settings/mcp.json',
        JSON.stringify({ mcpServers: toKiroServers(servers) }, null, 2),
      );
      return;
    case ExecutorType.DEVIN:
      await client.ensureDir(`${workdir}/.devin`);
      await client.writeSecretFile(
        workdir,
        '.devin/mcp_config.json',
        JSON.stringify({ mcpServers: toDevinServers(servers) }, null, 2),
      );
      return;
    case ExecutorType.DROID:
      await client.ensureDir(`${workdir}/.factory`);
      await client.writeSecretFile(
        workdir,
        '.factory/mcp.json',
        JSON.stringify({ mcpServers: toDroidServers(servers) }, null, 2),
      );
      return;
    default:
      return;
  }
}
