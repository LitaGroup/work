import { ExecutorType } from '../common/enums';
import type { ExecutorClient } from '../executors/executor-client';
import {
  ensureWorkerSkeleton,
  shouldDenyExternalDirectory,
  upsertWorkerEnv,
  writeKernelMcpConfig,
  writeOpencodeConfigFile,
} from './worker-env';

/** 记录结构化文件调用的假客户端 */
function recordingClient() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client = {
    ensureDir: (directory: string) => {
      calls.push({ method: 'ensureDir', args: [directory] });
      return Promise.resolve();
    },
    writeSecretFile: (directory: string, path: string, content: string) => {
      calls.push({
        method: 'writeSecretFile',
        args: [directory, path, content],
      });
      return Promise.resolve();
    },
    upsertEnvFile: (
      directory: string,
      path: string,
      entries: Record<string, string>,
    ) => {
      calls.push({ method: 'upsertEnvFile', args: [directory, path, entries] });
      return Promise.resolve();
    },
  };
  return { client: client as unknown as ExecutorClient, calls };
}

const workdir = '/srv/work/worker/7';
const litaWork = {
  'lita-work': {
    type: 'remote' as const,
    url: 'http://work.cinta.team/api/mcp/work',
    oauth: false as const,
    headers: { 'X-Worker-Token': 'token-123' },
  },
};

describe('worker-env 结构化文件助手', () => {
  it('writeOpencodeConfigFile 写入 opencode V2 mcp.servers 配置与工作区边界权限', async () => {
    const { client, calls } = recordingClient();
    await writeOpencodeConfigFile(client, workdir, {
      ...litaWork,
      'custom-sse': {
        type: 'local',
        command: ['npx', '-y', 'mcp-remote', 'https://example.com/sse'],
        environment: { MCP_API_KEY: '{env:MCP_API_KEY}' },
      },
    });
    const call = calls.find((c) => c.method === 'writeSecretFile');
    expect(call?.args[0]).toBe(workdir);
    expect(call?.args[1]).toBe('.opencode/opencode.json');
    const content = call?.args[2] as string;
    expect(content).toContain('https://opencode.ai/config.json');
    // 工作区边界：禁止会话读写工位之外的路径（缺省注入）
    expect(content).toContain('"permissions"');
    expect(content).toContain('"action": "external_directory"');
    expect(content).toContain('"resource": "*"');
    expect(content).toContain('"effect": "deny"');
    expect(content).toContain('"lita-work"');
    expect(content).toContain('"type": "remote"');
    expect(content).toContain('"url": "http://work.cinta.team/api/mcp/work"');
    expect(content).toContain('"oauth": false');
    expect(content).toContain('"X-Worker-Token": "token-123"');
    expect(content).toContain('"custom-sse"');
    expect(content).toContain('"type": "local"');
    expect(content).toContain('"MCP_API_KEY": "{env:MCP_API_KEY}"');
  });

  it('writeOpencodeConfigFile 止血开关关闭时不注入 permissions', async () => {
    const { client, calls } = recordingClient();
    await writeOpencodeConfigFile(client, workdir, litaWork, {
      denyExternalDirectory: false,
    });
    const content = calls.find((c) => c.method === 'writeSecretFile')
      ?.args[2] as string;
    expect(content).not.toContain('permissions');
    expect(content).toContain('"lita-work"');
  });

  it('shouldDenyExternalDirectory 缺省开启，显式关闭值返回 false', () => {
    expect(shouldDenyExternalDirectory(undefined)).toBe(true);
    expect(shouldDenyExternalDirectory(null)).toBe(true);
    expect(shouldDenyExternalDirectory('')).toBe(true);
    expect(shouldDenyExternalDirectory('true')).toBe(true);
    expect(shouldDenyExternalDirectory('1')).toBe(true);
    expect(shouldDenyExternalDirectory('false')).toBe(false);
    expect(shouldDenyExternalDirectory('FALSE')).toBe(false);
    expect(shouldDenyExternalDirectory('0')).toBe(false);
    expect(shouldDenyExternalDirectory('no')).toBe(false);
    expect(shouldDenyExternalDirectory(' off ')).toBe(false);
  });

  it('upsertWorkerEnv 写入工位 .agents/.env 指定键', async () => {
    const { client, calls } = recordingClient();
    await upsertWorkerEnv(client, workdir, {
      LITA_WORK_TOKEN: 't1',
      LITA_PROJECT_TOKEN: 't1',
      LITA_APP_URL: 'http://work.cinta.team',
    });
    expect(calls.map((c) => c.method)).toEqual(['ensureDir', 'upsertEnvFile']);
    expect(calls[0]?.args[0]).toBe(`${workdir}/.agents`);
    expect(calls[1]?.args).toEqual([
      workdir,
      '.agents/.env',
      {
        LITA_WORK_TOKEN: 't1',
        LITA_PROJECT_TOKEN: 't1',
        LITA_APP_URL: 'http://work.cinta.team',
      },
    ]);
  });

  it('ensureWorkerSkeleton 幂等建立内核无关工位骨架目录', async () => {
    const { client, calls } = recordingClient();
    await ensureWorkerSkeleton(client, workdir);
    expect(calls.map((c) => c.args[0])).toEqual([
      workdir,
      `${workdir}/.agents/skills`,
      `${workdir}/.agents/rules`,
      `${workdir}/docs`,
      `${workdir}/.opencode`,
    ]);
  });

  it('writeKernelMcpConfig 始终写内核无关声明与 opencode 配置', async () => {
    const { client, calls } = recordingClient();
    await writeKernelMcpConfig(
      client,
      workdir,
      ExecutorType.OPENCODE,
      litaWork,
    );
    const paths = calls
      .filter((c) => c.method === 'writeSecretFile')
      .map((c) => c.args[1]);
    expect(paths).toEqual(['.agents/mcp.json', '.opencode/opencode.json']);
    const source = calls.find(
      (c) => c.method === 'writeSecretFile' && c.args[1] === '.agents/mcp.json',
    )?.args[2] as string;
    expect(source).toContain('"kernel": "opencode"');
    expect(source).toContain('"lita-work"');
  });

  it('writeKernelMcpConfig 为 kiro 生成 .kiro/settings/mcp.json（url + headers）', async () => {
    const { client, calls } = recordingClient();
    await writeKernelMcpConfig(client, workdir, ExecutorType.KIRO, {
      ...litaWork,
      custom: {
        type: 'local',
        command: ['npx', '-y', 'demo-mcp'],
        environment: { API_KEY: 'k1' },
      },
    });
    expect(calls.some((c) => c.args[0] === `${workdir}/.kiro/settings`)).toBe(
      true,
    );
    const content = calls.find(
      (c) =>
        c.method === 'writeSecretFile' &&
        c.args[1] === '.kiro/settings/mcp.json',
    )?.args[2] as string;
    expect(content).toContain('"mcpServers"');
    expect(content).toContain('"url": "http://work.cinta.team/api/mcp/work"');
    expect(content).toContain('"X-Worker-Token": "token-123"');
    // kiro 不接受 opencode 的 oauth 字段
    expect(content).not.toContain('"type": "remote"');
    // local 拆成 command + args + env
    expect(content).toContain('"command": "npx"');
    expect(content).toContain('"-y"');
    expect(content).toContain('"env"');
    expect(content).toContain('"API_KEY": "k1"');
  });

  it('writeKernelMcpConfig 为 devin 生成 .devin/mcp_config.json（http + headers）', async () => {
    const { client, calls } = recordingClient();
    await writeKernelMcpConfig(client, workdir, ExecutorType.DEVIN, litaWork);
    expect(calls.some((c) => c.args[0] === `${workdir}/.devin`)).toBe(true);
    const content = calls.find(
      (c) =>
        c.method === 'writeSecretFile' &&
        c.args[1] === '.devin/mcp_config.json',
    )?.args[2] as string;
    expect(content).toContain('"mcpServers"');
    expect(content).toContain('"type": "http"');
    expect(content).toContain('"url": "http://work.cinta.team/api/mcp/work"');
    expect(content).toContain('"X-Worker-Token": "token-123"');
  });

  it('writeKernelMcpConfig 为 droid 生成 .factory/mcp.json（http + oauth:false）', async () => {
    const { client, calls } = recordingClient();
    await writeKernelMcpConfig(client, workdir, ExecutorType.DROID, {
      ...litaWork,
      custom: { type: 'local', command: ['node', 'server.js'] },
    });
    expect(calls.some((c) => c.args[0] === `${workdir}/.factory`)).toBe(true);
    const content = calls.find(
      (c) =>
        c.method === 'writeSecretFile' && c.args[1] === '.factory/mcp.json',
    )?.args[2] as string;
    expect(content).toContain('"mcpServers"');
    expect(content).toContain('"type": "http"');
    expect(content).toContain('"oauth": false');
    expect(content).toContain('"X-Worker-Token": "token-123"');
    expect(content).toContain('"type": "stdio"');
    expect(content).toContain('"command": "node"');
  });

  it('writeKernelMcpConfig 规划中内核只写通用声明', async () => {
    const { client, calls } = recordingClient();
    await writeKernelMcpConfig(client, workdir, ExecutorType.CODEX, litaWork);
    const paths = calls
      .filter((c) => c.method === 'writeSecretFile')
      .map((c) => c.args[1]);
    expect(paths).toEqual(['.agents/mcp.json']);
  });
});
