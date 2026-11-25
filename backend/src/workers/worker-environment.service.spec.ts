import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { toArray } from 'rxjs/operators';
import { ExecutorType, WorkerRuntime } from '../common/enums';
import { createExecutorClient } from '../executors/executor-client';
import {
  buildDirectoryAgentsSection,
  buildTaskCollaborationAgents,
  stationTemplateFingerprint,
  WorkerEnvironmentService,
} from './worker-environment.service';
import { ManagedStandardFiles } from './worker-standard-catalog.service';
import { Worker } from './worker.entity';

jest.mock('../executors/executor-client', () => {
  const actual = jest.requireActual<
    typeof import('../executors/executor-client')
  >('../executors/executor-client');
  return {
    ...actual,
    createExecutorClient: jest.fn(),
  };
});

const mockedCreateExecutorClient = jest.mocked(createExecutorClient);

interface FakeClient {
  files: Map<string, Uint8Array>;
  writes: string[];
  removedFiles: string[];
  removedDirs: string[];
  upserts: Array<Record<string, string>>;
  ensureDir: jest.Mock;
  writeFile: jest.Mock;
  writeSecretFile: jest.Mock;
  upsertEnvFile: jest.Mock;
  readFile: jest.Mock;
  removeFiles: jest.Mock;
  removeDir: jest.Mock;
  shell: jest.Mock;
}

function fakeClient(initial: Record<string, string> = {}): FakeClient {
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([path, content]) => [
      path,
      Buffer.from(content, 'utf8'),
    ]),
  );
  const writes: string[] = [];
  const removedFiles: string[] = [];
  const removedDirs: string[] = [];
  const upserts: Array<Record<string, string>> = [];
  return {
    files,
    writes,
    removedFiles,
    removedDirs,
    upserts,
    ensureDir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn((_workdir: string, path: string, bytes: Uint8Array) => {
      writes.push(path);
      files.set(path, bytes);
      return Promise.resolve({ path });
    }),
    writeSecretFile: jest.fn(
      (_workdir: string, path: string, content: string) => {
        writes.push(path);
        files.set(path, Buffer.from(content, 'utf8'));
        return Promise.resolve();
      },
    ),
    upsertEnvFile: jest.fn(
      (_workdir: string, _path: string, entries: Record<string, string>) => {
        upserts.push(entries);
        return Promise.resolve();
      },
    ),
    readFile: jest.fn((_workdir: string, path: string) =>
      Promise.resolve(files.get(path) ?? null),
    ),
    removeFiles: jest.fn((_workdir: string, paths: string[]) => {
      for (const path of paths) {
        removedFiles.push(path);
        files.delete(path);
      }
      return Promise.resolve();
    }),
    removeDir: jest.fn((path: string) => {
      removedDirs.push(path);
      const prefix = `${path.replace(/^.*\/worker\/1001\//, '')}/`;
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) files.delete(key);
      }
      return Promise.resolve();
    }),
    shell: jest.fn().mockResolvedValue(undefined),
  };
}

const worker = {
  id: 1001,
  name: '前端机器人',
  runtime: WorkerRuntime.OPENCODE,
  executorId: 8,
  providerId: 'deepseek',
  modelId: 'deepseek-flash',
  prompt: '## 角色\n\n负责前端开发',
  skills: null,
  standards: [
    {
      name: 'H5 场景开发规范',
      description: 'H5 场景开发与交付规范',
      path: 'fe/h5/README.md',
      directory: 'fe/h5',
      url: 'http://gitea.cinta.team/docs/standard/raw/branch/main/fe/h5/README.md',
      sourceUrl:
        'http://gitea.cinta.team/docs/standard/src/branch/main/fe/h5/README.md',
    },
  ],
  mcps: [],
  githubPermission: 'develop',
  resourcePermission: 'none',
} as unknown as Worker;

const executor = {
  id: 8,
  type: ExecutorType.OPENCODE,
  online: true,
} as never;

const standards: ManagedStandardFiles = {
  branch: 'main',
  rawBase: 'http://gitea.cinta.team/docs/standard/raw/branch/main',
  directories: ['fe/h5'],
  files: ['fe/h5/README.md', 'fe/h5/DEVELOP.md'],
  entries: [
    { path: 'fe/h5/README.md', sha: 'r1' },
    { path: 'fe/h5/DEVELOP.md', sha: 'd1' },
  ],
};

function buildService(
  options: {
    client?: FakeClient;
    worker?: Worker;
    standards?: ManagedStandardFiles;
    skillsFiles?: string[];
  } = {},
): {
  service: WorkerEnvironmentService;
  client: FakeClient;
  sourceGet: jest.Mock;
  resolveStandard: jest.Mock;
  resolveSkills: jest.Mock;
} {
  const activeWorker = options.worker ?? worker;
  const client = options.client ?? fakeClient();
  mockedCreateExecutorClient.mockReturnValue(client as never);
  const resolveStandard = jest
    .fn()
    .mockResolvedValue(options.standards ?? standards);
  const resolveSkills = jest.fn().mockResolvedValue({
    branch: 'main',
    rawBase: 'http://gitea.cinta.team/docs/skills/raw/branch/main',
    directories: ['active/rank'],
    files: options.skillsFiles ?? [
      'active/rank/SKILL.md',
      'active/rank/script/query.py',
    ],
    entries: (
      options.skillsFiles ?? [
        'active/rank/SKILL.md',
        'active/rank/script/query.py',
      ]
    ).map((path) => ({ path, sha: `sha-${path.length}` })),
  });
  const sourceGet = jest.fn((url: string) =>
    Promise.resolve(Buffer.from(`source:${url}`, 'utf8')),
  );
  const service = new WorkerEnvironmentService(
    { findOne: jest.fn().mockResolvedValue(activeWorker) } as never,
    { findOne: jest.fn().mockResolvedValue(executor) } as never,
    {
      workdirOf: () => '/tmp/runtime/worker/1001',
      ensureWorkToken: () => Promise.resolve('worker-token'),
    } as never,
    { resolveManagedFiles: resolveStandard } as never,
    { resolveManagedFiles: resolveSkills } as never,
    { get: sourceGet } as never,
    {
      buildServersConfig: jest.fn().mockResolvedValue({
        'lita-work': { type: 'remote', url: 'http://work/api/mcp/work' },
      }),
    } as never,
    {
      get: (key: string) => {
        if (key === 'APP_URL') return 'http://work.cinta.team/';
        return undefined;
      },
    } as never,
    {
      statusOf: jest.fn().mockResolvedValue({
        configured: false,
        enabled: false,
        githubAccount: null,
        rotatedAt: null,
      }),
    } as never,
  );
  return {
    service,
    client,
    sourceGet,
    resolveStandard,
    resolveSkills,
  };
}

async function waitForTerminal(
  service: WorkerEnvironmentService,
): Promise<ReturnType<WorkerEnvironmentService['snapshotOf']>> {
  for (let index = 0; index < 100; index += 1) {
    const snapshot = service.snapshotOf(1001);
    if (snapshot.status === 'success' || snapshot.status === 'failed') {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('初始化未在测试等待窗口内结束');
}

describe('WorkerEnvironmentService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('直接生成 AGENTS.md 并注入协议、权限、规范、MCP 与目录结构', () => {
    const { service } = buildService();
    const rules = service['buildRulesSection'](worker, standards);
    const mcp = service['buildMcpSection'](['demo']);
    const agents = service['buildAgentsDocument']({
      worker,
      githubCredentialStatus: {
        configured: false,
        enabled: false,
        githubAccount: null,
        rotatedAt: null,
      },
      kernel: ExecutorType.OPENCODE,
      rulesSection: rules,
      mcpSection: mcp,
    });

    expect(agents).toContain('负责前端开发');
    expect(agents).toContain('多机器人任务协同协议（平台固定）');
    expect(agents).toContain('## GitHub 操作权限');
    expect(agents).toContain('## 资源访问权限');
    expect(agents).toContain('### H5 场景开发规范');
    expect(agents).toContain('`DEVELOP.md`');
    expect(agents).toContain('- demo');
    expect(agents).toContain('## 目录结构');
    expect(agents).not.toContain('DONE');
  });

  it('管理员机器人额外注入 lita-work-admin，非管理员不注入', () => {
    const { service } = buildService();
    const adminMcp = service['buildMcpSection']([
      'lita-work-admin',
      'demo',
    ]);
    expect(adminMcp).toContain('lita-work-admin');
    expect(adminMcp).toContain('本机器人访问级别为管理员');
    expect(adminMcp).toContain('- demo');
    expect(adminMcp).not.toContain('- lita-work-admin');

    const normalMcp = service['buildMcpSection'](['demo']);
    expect(normalMcp).not.toContain('本机器人访问级别为管理员');
  });

  it('内容版本随机器人配置与源文件 SHA 变化，避免无变化重复同步', () => {
    const { service } = buildService();
    const input = {
      worker,
      kernel: ExecutorType.OPENCODE,
      githubCredentialStatus: {
        configured: false,
        enabled: false,
        githubAccount: null,
        rotatedAt: null,
      },
      standards,
      skills: {
        branch: 'main',
        rawBase: '',
        directories: ['active/rank'],
        files: ['active/rank/SKILL.md'],
        entries: [{ path: 'active/rank/SKILL.md', sha: 's1' }],
      },
      mcpNames: [] as string[],
    };
    const first = service['stationRevision'](input);
    expect(service['stationRevision'](input)).toBe(first);
    expect(
      service['stationRevision']({
        ...input,
        standards: {
          ...standards,
          entries: [{ path: 'fe/h5/README.md', sha: 'changed' }],
        },
      }),
    ).not.toBe(first);
    expect(
      service['stationRevision']({
        ...input,
        worker: { ...worker, prompt: '新的角色定义' },
      }),
    ).not.toBe(first);
  });

  it('后台同步直接写文件，不创建模型会话，并发布完整 manifest', async () => {
    const { service, client, sourceGet } = buildService();
    const initial = await service.start(1001);
    expect(initial.status).toBe('running');
    const snapshot = await waitForTerminal(service);
    expect(snapshot.status).toBe('success');
    expect(sourceGet).toHaveBeenCalledTimes(4);
    expect(client.writes).toEqual(
      expect.arrayContaining([
        'AGENTS.md',
        '.agents/skills/active/rank/SKILL.md',
        '.agents/skills/active/rank/script/query.py',
        '.agents/rules/fe/h5/README.md',
        '.agents/rules/fe/h5/DEVELOP.md',
        '.agents/rules/.standards-manifest.json',
        '.opencode/rules/fe/h5/README.md',
        '.agents/.station-manifest.json',
      ]),
    );
    const manifest = JSON.parse(
      Buffer.from(client.files.get('.agents/.station-manifest.json')!).toString(
        'utf8',
      ),
    ) as {
      revision?: string;
      files?: Array<{ path?: string }>;
    };
    expect(manifest.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'AGENTS.md' }),
        expect.objectContaining({
          path: '.agents/skills/active/rank/SKILL.md',
        }),
      ]),
    );
    expect(client.upserts[0]).toMatchObject({
      LITA_WORK_TOKEN: 'worker-token',
      LITA_PROJECT_TOKEN: 'worker-token',
      LITA_APP_URL: 'http://work.cinta.team',
    });
    expect(
      (client as unknown as { createSession?: unknown }).createSession,
    ).toBeUndefined();
  });

  it('第二次初始化命中 manifest 时跳过下载与文件发布', async () => {
    const { service, client, sourceGet } = buildService();
    await service.start(1001);
    expect((await waitForTerminal(service)).status).toBe('success');
    sourceGet.mockClear();
    client.writes.length = 0;

    await service.start(1001);
    const snapshot = await waitForTerminal(service);
    expect(snapshot.status).toBe('success');
    expect(snapshot.lines.join('\n')).toContain('工位内容未变化');
    expect(sourceGet).not.toHaveBeenCalled();
    expect(client.writes).not.toContain('AGENTS.md');
  });

  it('只删除旧受管规范文件，不清理 docs 或未受管文档', async () => {
    const client = fakeClient({
      '.agents/rules/.standards-manifest.json': JSON.stringify({
        version: 1,
        files: ['fe/old/README.md', 'fe/h5/README.md'],
      }),
    });
    const { service } = buildService({ client });
    await service.start(1001);
    expect((await waitForTerminal(service)).status).toBe('success');
    expect(client.removedFiles).toContain('.agents/rules/fe/old/README.md');
    expect(client.removedFiles).not.toContain('.agents/rules/fe/h5/README.md');
    expect(client.removedFiles).not.toContain('docs/README.md');
  });

  it('配置缺少执行器时同步抛 400，不创建后台任务', async () => {
    const { service } = buildService({
      worker: { ...worker, executorId: null },
    });
    await expect(service.start(1001)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.snapshotOf(1001).status).toBe('idle');
  });

  it('初始化不再要求供应商与模型', async () => {
    const { service } = buildService({
      worker: {
        ...worker,
        providerId: null,
        modelId: null,
      },
    });
    const snapshot = await service.start(1001);
    expect(snapshot.status).toBe('running');
    expect((await waitForTerminal(service)).status).toBe('success');
  });

  it('合并写入机器人令牌与 Lita 用户令牌，避免同一 env 文件并发更新', async () => {
    const { service, client } = buildService();
    await service['writeWorkerSecrets'](
      client as never,
      1001,
      '/tmp/runtime/worker/1001',
      'worker-token',
      'lita-token',
    );
    expect(client.upserts).toEqual([
      {
        LITA_WORK_TOKEN: 'worker-token',
        LITA_PROJECT_TOKEN: 'worker-token',
        LITA_APP_URL: 'http://work.cinta.team',
        LITA_USER_TOKEN: 'lita-token',
      },
    ]);
  });

  it('snapshotOf 无任务时返回 idle 快照', () => {
    const { service } = buildService();
    expect(service.snapshotOf(9999)).toEqual({
      workerId: 9999,
      status: 'idle',
      lines: [],
      error: null,
      workdir: null,
      startedAt: null,
      finishedAt: null,
    });
  });

  it('stream 无任务时推送 idle 快照后完成', async () => {
    const { service } = buildService();
    const events = await firstValueFrom(service.stream(1001).pipe(toArray()));
    expect(events).toHaveLength(1);
    const payload = events[0].data as {
      type: string;
      snapshot: { status: string };
    };
    expect(payload.type).toBe('snapshot');
    expect(payload.snapshot.status).toBe('idle');
  });
});

describe('工位同步 revision 覆盖平台固定文案', () => {
  it('指纹等于固定文案章节的 sha256，文案一改就变', () => {
    const appUrl = 'http://work.cinta.team';
    const kernel = ExecutorType.OPENCODE;
    const expected = createHash('sha256')
      .update(buildTaskCollaborationAgents(appUrl))
      .update('\n')
      .update(buildDirectoryAgentsSection(kernel))
      .digest('hex');
    expect(stationTemplateFingerprint(appUrl, kernel)).toBe(expected);
    expect(stationTemplateFingerprint(appUrl, kernel)).toBe(
      stationTemplateFingerprint(appUrl, kernel),
    );
  });

  it('平台地址或内核变化时指纹随之变化', () => {
    const a = stationTemplateFingerprint(
      'http://work.cinta.team',
      ExecutorType.OPENCODE,
    );
    expect(
      stationTemplateFingerprint(
        'http://project.cinta.team',
        ExecutorType.OPENCODE,
      ),
    ).not.toBe(a);
    expect(
      stationTemplateFingerprint('http://work.cinta.team', ExecutorType.DROID),
    ).not.toBe(a);
  });
});
