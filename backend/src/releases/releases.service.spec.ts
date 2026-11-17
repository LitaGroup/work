import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProjectStatus, ReleaseStatus } from '../common/enums';
import { FeishuService } from '../feishu/feishu.service';
import { Backlog } from '../iterations/backlog.entity';
import { Project } from '../projects/project.entity';
import { User } from '../auth/user.entity';
import { Task } from '../tasks/task.entity';
import { TaskWorkerInboxService } from '../tasks/task-worker-inbox.service';
import { Worker } from '../workers/worker.entity';
import { ProjectRelease } from './project-release.entity';
import { ReleasesService } from './releases.service';

describe('ReleasesService', () => {
  let service: ReleasesService;
  let releasesSave: jest.Mock;
  let releasesFindOne: jest.Mock;
  let usersFind: jest.Mock;
  let tasksFindOne: jest.Mock;
  let sendUserCard: jest.Mock;
  let enqueueReleaseStatus: jest.Mock;
  let fetchMock: jest.Mock;
  const realFetch = globalThis.fetch;
  const realPause = process.env.FEISHU_GROUP_SEND_PAUSED;

  const project = (over: Partial<Project> = {}): Project =>
    ({
      id: 1,
      name: '活动项目',
      status: ProjectStatus.IN_PROGRESS,
      ...over,
    }) as Project;

  /** 标准依赖装配；releaseWebhook 模拟 ConfigService 的 RELEASE_WEBHOOK_URL */
  const buildModule = (config: { releaseWebhook?: string } = {}) =>
    Test.createTestingModule({
      providers: [
        ReleasesService,
        {
          provide: getRepositoryToken(ProjectRelease),
          useValue: {
            create: (v: Partial<ProjectRelease>) => v,
            save: releasesSave,
            findOne: releasesFindOne,
            delete: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Project),
          useValue: {
            findOne: () => Promise.resolve(project()),
          },
        },
        { provide: getRepositoryToken(User), useValue: { find: usersFind } },
        {
          provide: getRepositoryToken(Backlog),
          useValue: {
            find: jest.fn().mockResolvedValue([
              {
                id: 1,
                members: [
                  { role: '前端', workerId: 2, name: '张三' },
                  { role: '后端', workerId: 3, name: '李四' },
                ],
              },
            ]),
          },
        },
        {
          provide: getRepositoryToken(Worker),
          useValue: {
            find: jest.fn().mockResolvedValue([
              { id: 2, humanUserId: 2, humanUserName: '张三', name: '张三' },
              { id: 3, humanUserId: 3, humanUserName: '李四', name: '李四' },
            ]),
          },
        },
        {
          provide: getRepositoryToken(Task),
          useValue: { findOne: tasksFindOne },
        },
        { provide: FeishuService, useValue: { sendUserCard } },
        {
          provide: TaskWorkerInboxService,
          useValue: { enqueueReleaseStatus },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'RELEASE_WEBHOOK_URL' ? config.releaseWebhook : undefined,
          },
        },
      ],
    }).compile();

  beforeEach(async () => {
    releasesSave = jest.fn();
    releasesSave.mockImplementation((v: Partial<ProjectRelease>) =>
      Promise.resolve({ id: 9, createdAt: new Date(), ...v } as ProjectRelease),
    );
    releasesFindOne = jest.fn();
    // where.name 为 TypeORM In() FindOperator，取其 .value 还原姓名数组
    usersFind = jest.fn();
    usersFind.mockImplementation((args?: { where?: unknown }) => {
      const where = args?.where;
      const conditions = Array.isArray(where) ? where : where ? [where] : [];
      const names = new Set<string>();
      for (const cond of conditions as Array<{
        name?: { value?: string[] };
      }>) {
        for (const name of cond?.name?.value ?? []) names.add(name);
      }
      return Promise.resolve(
        [...names].map((name) => ({
          id: names.size,
          name,
          feishuOpenId: `ou_${name}`,
        })),
      );
    });
    tasksFindOne = jest.fn();
    sendUserCard = jest.fn();
    sendUserCard.mockResolvedValue(undefined);
    enqueueReleaseStatus = jest.fn().mockResolvedValue(null);
    // 群机器人 webhook 打桩：单测不应出网
    fetchMock = jest.fn();
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ code: 0 }),
      } as Response),
    );
    globalThis.fetch = fetchMock;

    const moduleRef = await buildModule();
    service = moduleRef.get(ReleasesService);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realPause === undefined) delete process.env.FEISHU_GROUP_SEND_PAUSED;
    else process.env.FEISHU_GROUP_SEND_PAUSED = realPause;
  });

  it('提测成功：创建记录（待冒烟）+ 提测群 + 测试人员与迭代项成员私聊通知', async () => {
    const release = await service.submit(1, {
      content: ' 修复了登录问题 ',
      urls: [' https://staging.example.com ', ''],
      branches: [
        { repo: ' LitaGroup/lita-h5 ', branch: ' test ' },
        { repo: '', branch: '' },
      ],
      testers: ['王五'],
    });
    expect(release.content).toBe('修复了登录问题');
    expect(release.urls).toEqual(['https://staging.example.com']);
    expect(release.branches).toEqual([
      { repo: 'LitaGroup/lita-h5', branch: 'test' },
    ]);
    expect(release.testers).toEqual(['王五']);
    expect(release.status).toBe(ReleaseStatus.PENDING);
    await new Promise((r) => setTimeout(r, 0)); // 放行 fire-and-forget 通知
    // 群机器人 webhook：默认提测群地址 + msg_type 信封（与机器人 API 卡片不同）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/open-apis/bot/v2/hook/819b2008-');
    const payload = JSON.parse(init.body as string) as {
      msg_type?: string;
      card?: { elements?: unknown };
    };
    expect(payload.msg_type).toBe('interactive');
    expect(Array.isArray(payload.card?.elements)).toBe(true);
    expect(sendUserCard).toHaveBeenCalledTimes(3); // 张三/李四/王五 去重后
  });

  it('配置 RELEASE_WEBHOOK_URL 时推送到自定义群（开发调试群）', async () => {
    const moduleRef = await buildModule({
      releaseWebhook:
        'https://open.feishu.cn/open-apis/bot/v2/hook/1a32d26a-dev',
    });
    const svc = moduleRef.get(ReleasesService);
    await svc.submit(1, { testers: ['王五'] });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/bot/v2/hook/1a32d26a-dev',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('FEISHU_GROUP_SEND_PAUSED 暂停时跳过提测群推送，私聊照发', async () => {
    process.env.FEISHU_GROUP_SEND_PAUSED = 'true';
    const release = await service.submit(1, { testers: ['王五'] });
    expect(release.id).toBe(9);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendUserCard).toHaveBeenCalledTimes(3);
  });

  it('机器人提测：记录机器人身份并自动关联当前执行中的任务', async () => {
    tasksFindOne.mockResolvedValue({
      id: 88,
      agentId: 7,
      code: 'TK-0088',
      title: '实现活动页',
    });
    const release = await service.submit(
      1,
      { testers: ['王五'] },
      { operator: '活动开发机器人', workerId: 7 },
    );
    expect(release.operator).toBe('活动开发机器人');
    expect(release.workerId).toBe(7);
    expect(release.sourceTaskId).toBe(88);
    const taskQuery = (
      tasksFindOne.mock.calls[0] as Array<{ where: { agentId: number } }>
    )[0];
    expect(taskQuery.where.agentId).toBe(7);
  });

  it('机器人显式传入非本人执行的任务 → 400', async () => {
    tasksFindOne.mockResolvedValue({ id: 89, agentId: 8 });
    await expect(
      service.submit(1, { testers: ['王五'], taskId: 89 }, { workerId: 7 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('测试人员为空 → 400', async () => {
    await expect(service.submit(1, { testers: [] })).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.submit(1, { testers: [' 、，'] })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('测试人员不存在于用户系统 → 400 并列出无效姓名', async () => {
    usersFind.mockResolvedValue([{ name: '王五' }]);
    await expect(
      service.submit(1, { testers: ['王五', '赵六'] }),
    ).rejects.toThrow(/赵六/);
  });

  it('项目不存在 → 404', async () => {
    const missing = {
      findOne: () => Promise.resolve(null),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReleasesService,
        {
          provide: getRepositoryToken(ProjectRelease),
          useValue: {
            create: jest.fn(),
            save: releasesSave,
            delete: jest.fn(),
          },
        },
        { provide: getRepositoryToken(Project), useValue: missing },
        { provide: getRepositoryToken(User), useValue: { find: usersFind } },
        {
          provide: getRepositoryToken(Backlog),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(Worker),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(Task),
          useValue: { findOne: jest.fn() },
        },
        { provide: FeishuService, useValue: { sendUserCard } },
        {
          provide: TaskWorkerInboxService,
          useValue: { enqueueReleaseStatus },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    const svc = moduleRef.get(ReleasesService);
    await expect(svc.submit(99, { testers: ['王五'] })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('通知失败不影响提测结果', async () => {
    globalThis.fetch = jest
      .fn()
      .mockImplementation(() => Promise.reject(new Error('network')));
    sendUserCard.mockRejectedValue(new Error('feishu down'));
    const release = await service.submit(1, { testers: ['王五'] });
    expect(release.id).toBe(9);
    await new Promise((r) => setTimeout(r, 0));
    expect(sendUserCard).toHaveBeenCalled();
  });

  it('人员姓名按常见分隔符拆分去重（testers 单条串写多人也支持）', async () => {
    await service.submit(1, { testers: ['王五、赵六, 孙七 王五'] });
    const saved = (
      releasesSave.mock.calls as Partial<ProjectRelease>[][]
    )[0][0];
    expect(saved.testers).toEqual(['王五', '赵六', '孙七']);
  });

  it('推进提测状态：仅已通过/未通过记录判定人与时间，进行中/待冒烟清空', async () => {
    const release = {
      id: 9,
      projectId: 1,
      status: ReleaseStatus.PENDING,
      verifier: null,
      verifiedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      testers: ['王五'],
      operator: null,
      content: null,
      urls: null,
      branches: null,
    } as ProjectRelease;
    releasesFindOne.mockResolvedValue(release);

    const passed = await service.updateStatus(9, ReleaseStatus.PASSED, '王五');
    expect(passed.status).toBe(ReleaseStatus.PASSED);
    expect(passed.verifier).toBe('王五');
    expect(passed.verifiedAt).toBeInstanceOf(Date);

    const failed = await service.updateStatus(9, ReleaseStatus.FAILED, '赵六');
    expect(failed.status).toBe(ReleaseStatus.FAILED);
    expect(failed.verifier).toBe('赵六');

    const inProgress = await service.updateStatus(
      9,
      ReleaseStatus.IN_PROGRESS,
      '王五',
    );
    expect(inProgress.status).toBe(ReleaseStatus.IN_PROGRESS);
    expect(inProgress.verifier).toBeNull();
    expect(inProgress.verifiedAt).toBeNull();

    const pending = await service.updateStatus(
      9,
      ReleaseStatus.PENDING,
      '王五',
    );
    expect(pending.status).toBe(ReleaseStatus.PENDING);
    expect(pending.verifier).toBeNull();
    expect(pending.verifiedAt).toBeNull();
  });

  it('状态变化时进入提测机器人收件箱；状态未变化不通知', async () => {
    releasesFindOne.mockResolvedValue({
      id: 9,
      projectId: 1,
      status: ReleaseStatus.PENDING,
      workerId: 7,
      sourceTaskId: 88,
      operator: '活动开发机器人',
      testers: ['王五'],
      verifier: null,
      verifiedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    await service.updateStatus(9, ReleaseStatus.PASSED, '测试同学');

    expect(enqueueReleaseStatus).toHaveBeenCalledTimes(1);
    expect(enqueueReleaseStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 9,
        workerId: 7,
        sourceTaskId: 88,
        status: ReleaseStatus.PASSED,
      }),
      ReleaseStatus.PENDING,
      '活动项目',
    );

    releasesFindOne.mockResolvedValue({
      id: 9,
      status: ReleaseStatus.PASSED,
      workerId: 7,
      sourceTaskId: 88,
      testers: ['王五'],
    });
    await service.updateStatus(9, ReleaseStatus.PASSED, '测试同学');
    expect(enqueueReleaseStatus).toHaveBeenCalledTimes(1);
  });

  it('状态未变化时幂等返回，不刷新判定人/判定时间', async () => {
    const verifiedAt = new Date('2026-01-02T00:00:00Z');
    releasesFindOne.mockResolvedValue({
      id: 9,
      status: ReleaseStatus.PASSED,
      verifier: '王五',
      verifiedAt,
    });
    const release = await service.updateStatus(9, ReleaseStatus.PASSED, '赵六');
    expect(release.verifier).toBe('王五');
    expect(release.verifiedAt).toBe(verifiedAt);
    expect(releasesSave).not.toHaveBeenCalled();
  });

  it('非法提测状态 → 400，记录不存在 → 404', async () => {
    await expect(
      service.updateStatus(9, '不存在' as ReleaseStatus, '王五'),
    ).rejects.toThrow(BadRequestException);
    releasesFindOne.mockResolvedValue(null);
    await expect(
      service.updateStatus(99, ReleaseStatus.PASSED, '王五'),
    ).rejects.toThrow(NotFoundException);
  });

  it('removeByProject 按项目删除提测记录', async () => {
    const del = jest.fn();
    del.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReleasesService,
        {
          provide: getRepositoryToken(ProjectRelease),
          useValue: { create: jest.fn(), save: releasesSave, delete: del },
        },
        {
          provide: getRepositoryToken(Project),
          useValue: { findOne: jest.fn() },
        },
        { provide: getRepositoryToken(User), useValue: { find: usersFind } },
        {
          provide: getRepositoryToken(Backlog),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(Worker),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(Task),
          useValue: { findOne: jest.fn() },
        },
        { provide: FeishuService, useValue: { sendUserCard } },
        {
          provide: TaskWorkerInboxService,
          useValue: { enqueueReleaseStatus },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    const svc = moduleRef.get(ReleasesService);
    await svc.removeByProject(7);
    expect(del).toHaveBeenCalledWith({ projectId: 7 });
  });
});
