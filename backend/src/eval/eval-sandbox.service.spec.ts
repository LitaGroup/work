import { ExecutorType } from '../common/enums';
import type { ExecutorClient } from '../executors/executor-client';
import { EvalSandboxService } from './eval-sandbox.service';

/** 结构化文件能力桩：记录调用，shell 一律视为失败（bridge 内核无 shell） */
function createClient(location = '/home/ecs-user/runtime/worker') {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string) =>
    (...args: unknown[]): Promise<void> => {
      calls.push({ method, args });
      return Promise.resolve();
    };
  const client = {
    copyDir: jest.fn(record('copyDir')),
    ensureDir: jest.fn(record('ensureDir')),
    writeSecretFile: jest.fn(record('writeSecretFile')),
    upsertEnvFile: jest.fn(record('upsertEnvFile')),
    removeDir: jest.fn(record('removeDir')),
    location: jest.fn(() => Promise.resolve({ directory: location })),
    shell: jest.fn(() => {
      throw new Error('评估沙箱不应依赖 shell');
    }),
  };
  return {
    client: client as unknown as ExecutorClient,
    clientMock: client,
    calls,
  };
}

function createService(): EvalSandboxService {
  return new EvalSandboxService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('EvalSandboxService 沙箱构建', () => {
  const workdir = '/home/ecs-user/runtime/worker/1017';
  const sandbox = '/home/ecs-user/runtime/worker/eval/12/3';
  const mcpServers = {
    ['lita-work']: {
      type: 'remote',
      url: 'http://work.example.com/api/mcp/work',
    },
  };

  it('经结构化 copyDir 复制工位，剔除 docs 与真实凭据', async () => {
    const { client, clientMock, calls } = createClient();

    await createService().buildSandbox(
      client,
      workdir,
      sandbox,
      ExecutorType.OPENCODE,
      mcpServers,
      'eval-token',
      'http://work.example.com',
      true,
    );

    expect(calls.filter((call) => call.method === 'copyDir')).toHaveLength(1);
    expect(clientMock.copyDir).toHaveBeenCalledWith({
      source: workdir,
      target: sandbox,
      exclude: [
        'docs',
        '.agents/.env',
        '.agents/mcp.json',
        '.opencode/opencode.json',
        '.kiro/settings/mcp.json',
        '.devin/mcp_config.json',
        '.factory/mcp.json',
      ],
    });
    expect(clientMock.shell).not.toHaveBeenCalled();
  });

  it('重建 docs 与 .agents 目录并写入评估令牌', async () => {
    const { client, clientMock, calls } = createClient();

    await createService().buildSandbox(
      client,
      workdir,
      sandbox,
      ExecutorType.OPENCODE,
      mcpServers,
      'eval-token',
      'http://work.example.com',
      true,
    );

    const dirs = calls
      .filter((call) => call.method === 'ensureDir')
      .map((call) => call.args[0]);
    expect(dirs).toEqual([
      `${sandbox}/docs`,
      `${sandbox}/.agents`,
      `${sandbox}/.agents`,
      `${sandbox}/home`,
    ]);
    expect(clientMock.upsertEnvFile).toHaveBeenCalledWith(
      sandbox,
      '.agents/.env',
      {
        LITA_WORK_TOKEN: 'eval-token',
        LITA_PROJECT_TOKEN: 'eval-token',
        LITA_APP_URL: 'http://work.example.com',
      },
    );
    // opencode 适配物：沙箱内重新生成 .opencode/opencode.json
    expect(clientMock.writeSecretFile).toHaveBeenCalledWith(
      sandbox,
      '.opencode/opencode.json',
      expect.stringContaining('lita-work'),
    );
  });

  it('bridge 内核沙箱写对应内核 MCP 配置', async () => {
    const { client, clientMock } = createClient();

    await createService().buildSandbox(
      client,
      workdir,
      sandbox,
      ExecutorType.KIRO,
      mcpServers,
      'eval-token',
      'http://work.example.com',
      true,
    );

    expect(clientMock.writeSecretFile).toHaveBeenCalledWith(
      sandbox,
      '.kiro/settings/mcp.json',
      expect.stringContaining('lita-work'),
    );
    expect(clientMock.shell).not.toHaveBeenCalled();
  });

  it('刷新凭据只覆盖 .env 与 MCP 配置，不复制工位', async () => {
    const { client, clientMock } = createClient();

    await createService().refreshCredentials(
      client,
      sandbox,
      ExecutorType.OPENCODE,
      {
        ['lita-work']: {
          type: 'remote',
          url: 'http://work.example.com/api/mcp/work',
          headers: { 'X-Worker-Token': 'new-eval-token' },
        },
      },
      'new-eval-token',
      'http://work.example.com',
      true,
    );

    expect(clientMock.copyDir).not.toHaveBeenCalled();
    expect(clientMock.upsertEnvFile).toHaveBeenCalledWith(
      sandbox,
      '.agents/.env',
      {
        LITA_WORK_TOKEN: 'new-eval-token',
        LITA_PROJECT_TOKEN: 'new-eval-token',
        LITA_APP_URL: 'http://work.example.com',
      },
    );
    expect(clientMock.writeSecretFile).toHaveBeenCalledWith(
      sandbox,
      '.opencode/opencode.json',
      expect.stringContaining('new-eval-token'),
    );
  });

  it('bridge 根目录只含单个工位时给出 BRIDGE_ROOT 提示', async () => {
    const { client, clientMock } = createClient(
      '/home/ecs-user/runtime/worker/1017',
    );

    await expect(
      createService().buildSandbox(
        client,
        workdir,
        sandbox,
        ExecutorType.KIRO,
        mcpServers,
        'eval-token',
        'http://work.example.com',
        true,
      ),
    ).rejects.toThrow(/BRIDGE_ROOT/);
    expect(clientMock.copyDir).not.toHaveBeenCalled();
  });
});

describe('EvalSandboxService 沙箱销毁', () => {
  it('经 removeDir 删除沙箱目录', async () => {
    const { client, clientMock } = createClient();

    await createService().destroySandbox(
      client,
      '/home/ecs-user/runtime/worker/eval/12/3',
    );

    expect(clientMock.removeDir).toHaveBeenCalledWith(
      '/home/ecs-user/runtime/worker/eval/12/3',
    );
    expect(clientMock.shell).not.toHaveBeenCalled();
  });

  it('清理失败只告警不抛出', async () => {
    const { client, clientMock } = createClient();
    clientMock.removeDir.mockRejectedValue(new Error('执行器不可达'));

    await expect(
      createService().destroySandbox(
        client,
        '/home/ecs-user/runtime/worker/eval/1/1',
      ),
    ).resolves.toBeUndefined();
  });
});
