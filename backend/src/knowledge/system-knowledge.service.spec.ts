import type { EvalSuite } from '../eval/eval-suite.entity';
import type { Worker } from '../workers/worker.entity';
import type { KnowledgeService } from './knowledge.service';
import { SystemKnowledgeService } from './system-knowledge.service';

function repo(over: Record<string, jest.Mock> = {}): Record<string, jest.Mock> {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    ...over,
  };
}

function build(worker?: Partial<Worker>) {
  const knowledge = {
    isEnabled: true,
    upsertSystemArticle: jest.fn().mockResolvedValue({}),
    removeSystemPath: jest.fn().mockResolvedValue(0),
  };
  const workers = repo({
    findOne: jest.fn().mockResolvedValue({
      id: 1001,
      name: '执行机器人',
      systemKey: null,
      intro: '负责前端开发',
      avatarUrl: null,
      role: '普通机器人',
      runtime: 'opencode',
      executorId: 1,
      providerId: 'openai',
      modelId: 'gpt-test',
      variant: 'medium',
      backupProviderId: null,
      backupModelId: null,
      backupVariant: null,
      prompt: '# 机器人定义',
      skills: [],
      standards: [],
      mcps: null,
      taskDefs: [],
      humanUserId: null,
      humanUserName: null,
      personalAgentUserId: null,
      ownerUserId: null,
      ownerName: null,
      githubPermission: '开发权限',
      resourcePermission: '只读资源',
      accessLevel: '普通',
      maxParallelTasks: 3,
      enabled: true,
      traceEnabled: true,
      optimizerReadable: true,
      createdAt: new Date('2026-10-28T00:00:00Z'),
      updatedAt: new Date('2026-10-28T01:00:00Z'),
      ...worker,
    }),
  });
  const service = new SystemKnowledgeService(
    knowledge as unknown as KnowledgeService,
    workers as never,
    repo() as never,
    repo() as never,
    repo() as never,
    repo() as never,
    repo() as never,
    repo() as never,
    repo() as never,
    repo() as never,
  );
  return { service, knowledge, workers };
}

describe('SystemKnowledgeService', () => {
  it('机器人设定写入 /99-system/workers/{id}/README，且不包含令牌字段', async () => {
    const { service, knowledge } = build();

    await service.syncWorker(1001);

    expect(knowledge.upsertSystemArticle).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/99-system/workers/1001/README',
        title: '机器人 #1001 执行机器人 · 设定',
        content: expect.stringContaining('gpt-test') as string,
      }),
    );
    const calls = knowledge.upsertSystemArticle.mock.calls as unknown as Array<
      [{ content: string }]
    >;
    const content = calls[0][0].content;
    expect(content).not.toContain('agentToken');
    expect(content).not.toContain('authSecret');
  });

  it('机器人定义中误写的凭据在镜像里脱敏', async () => {
    const { service, knowledge } = build({
      prompt: '# 定义\ntoken: plain-secret\nAuthorization: Bearer abc.def',
    });

    await service.syncWorker(1001);

    const calls = knowledge.upsertSystemArticle.mock.calls as unknown as Array<
      [{ content: string }]
    >;
    const content = calls[0][0].content;
    expect(content).not.toContain('plain-secret');
    expect(content).not.toContain('abc.def');
    expect(content).toContain('[REDACTED]');
  });

  it('个人 AGENT 不进入共享系统知识镜像', async () => {
    const { service, knowledge } = build({ personalAgentUserId: 8 });

    await service.syncWorker(1001);

    expect(knowledge.upsertSystemArticle).not.toHaveBeenCalled();
    expect(knowledge.removeSystemPath).toHaveBeenCalledWith(
      '/99-system/workers/1001',
    );
  });

  it('测试集镜像包含用例和评分要点', async () => {
    const { knowledge } = build();
    const suite: Partial<EvalSuite> = {
      id: 3,
      name: '登录回归',
      description: '登录场景',
      tags: ['登录'],
      purpose: '验证',
      passThreshold: 80,
      defaultTimeoutSec: 1800,
      maxQuestions: 3,
      version: 2,
      ownerId: null,
      status: '启用',
      createdAt: new Date('2026-10-28T00:00:00Z'),
      updatedAt: new Date('2026-10-28T01:00:00Z'),
    };
    const suites = repo({
      findOne: jest.fn().mockResolvedValue(suite),
    });
    const cases = repo({
      find: jest.fn().mockResolvedValue([
        {
          id: 9,
          suiteId: 3,
          caseKey: 'login-1',
          seq: 1,
          title: '正常登录',
          prompt: '登录成功',
          clarify: null,
          passThreshold: null,
          timeoutSec: null,
          enabled: true,
        },
      ]),
    });
    const points = repo({
      find: jest.fn().mockResolvedValue([
        {
          id: 11,
          caseId: 9,
          seq: 1,
          point: '进入首页',
          required: true,
          weight: '1',
          hint: '检查首页',
        },
      ]),
    });
    const typed = new SystemKnowledgeService(
      knowledge as unknown as KnowledgeService,
      repo() as never,
      repo() as never,
      repo() as never,
      suites as never,
      cases as never,
      points as never,
      repo() as never,
      repo() as never,
      repo() as never,
    );

    await typed.syncEvalSuite(3);

    expect(knowledge.upsertSystemArticle).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/99-system/evaluations/suites/3/README',
        content: expect.stringContaining('进入首页') as string,
      }),
    );
  });
});
