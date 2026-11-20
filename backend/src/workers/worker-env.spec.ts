import type { ExecutorClient } from '../executors/executor-client';
import {
  ensureWorkerSkeleton,
  upsertWorkerEnv,
  writeAgentTokenFile,
  writeMcpConfigFile,
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

describe('worker-env 结构化文件助手', () => {
  it('writeMcpConfigFile 写入 opencode V2 mcp.servers 配置', async () => {
    const { client, calls } = recordingClient();
    await writeMcpConfigFile(client, '/srv/work/worker/7', {
      'lita-work': {
        type: 'remote',
        url: 'http://work.cinta.team/api/mcp/work',
        oauth: false,
        headers: { 'X-Worker-Token': 'token-123' },
      },
      'custom-sse': {
        type: 'local',
        command: ['npx', '-y', 'mcp-remote', 'https://example.com/sse'],
        environment: { MCP_API_KEY: '{env:MCP_API_KEY}' },
      },
    });
    const call = calls.find((c) => c.method === 'writeSecretFile');
    expect(call?.args[0]).toBe('/srv/work/worker/7');
    expect(call?.args[1]).toBe('.opencode/opencode.json');
    const content = call?.args[2] as string;
    expect(content).toContain('https://opencode.ai/config.json');
    expect(content).toContain('"lita-work"');
    expect(content).toContain('"type": "remote"');
    expect(content).toContain('"url": "http://work.cinta.team/api/mcp/work"');
    expect(content).toContain('"oauth": false');
    expect(content).toContain('"X-Worker-Token": "token-123"');
    expect(content).toContain('"custom-sse"');
    expect(content).toContain('"type": "local"');
    expect(content).toContain('"MCP_API_KEY": "{env:MCP_API_KEY}"');
  });

  it('writeAgentTokenFile 先建目录再写 agent-token', async () => {
    const { client, calls } = recordingClient();
    await writeAgentTokenFile(client, '/srv/work/worker/7', 'token-123');
    expect(calls.map((c) => c.method)).toEqual([
      'ensureDir',
      'writeSecretFile',
    ]);
    expect(calls[0]?.args[0]).toBe('/srv/work/worker/7/.opencode');
    expect(calls[1]?.args).toEqual([
      '/srv/work/worker/7',
      '.opencode/agent-token',
      'token-123',
    ]);
  });

  it('upsertWorkerEnv 写入工位 .env 指定键', async () => {
    const { client, calls } = recordingClient();
    await upsertWorkerEnv(client, '/srv/work/worker/7', {
      LITA_WORK_TOKEN: 't1',
      LITA_PROJECT_TOKEN: 't1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      '/srv/work/worker/7',
      '.opencode/.env',
      { LITA_WORK_TOKEN: 't1', LITA_PROJECT_TOKEN: 't1' },
    ]);
  });

  it('ensureWorkerSkeleton 幂等建立工位骨架目录', async () => {
    const { client, calls } = recordingClient();
    await ensureWorkerSkeleton(client, '/srv/work/worker/7');
    expect(calls.map((c) => c.args[0])).toEqual([
      '/srv/work/worker/7',
      '/srv/work/worker/7/.opencode/skills',
      '/srv/work/worker/7/.opencode/rules',
      '/srv/work/worker/7/.opencode/docs',
    ]);
  });
});
