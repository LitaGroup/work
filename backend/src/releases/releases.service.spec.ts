import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { ReleaseStatus } from '../common/enums';
import { Project } from '../projects/project.entity';
import { User } from '../auth/user.entity';
import { Task } from '../tasks/task.entity';
import { TaskWorkerInboxService } from '../tasks/task-worker-inbox.service';
import { ProjectRelease } from './project-release.entity';
import { ReleaseNotifyService } from './release-notify.service';
import { ReleasesService } from './releases.service';

describe('ReleasesService', () => {
  let service: ReleasesService;
  let releasesFind: jest.Mock;
  let releasesFindOne: jest.Mock;
  let releasesSave: jest.Mock;
  let usersFind: jest.Mock;
  let tasksFindOne: jest.Mock;
  let notify: jest.Mock;
  let enqueueReleaseStatus: jest.Mock;

  const buildModule = async () =>
    Test.createTestingModule({
      providers: [
        ReleasesService,
        {
          provide: getRepositoryToken(ProjectRelease),
          useValue: {
            create: (value: Partial<ProjectRelease>) => value,
            save: releasesSave,
            find: releasesFind,
            findOne: releasesFindOne,
            delete: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Project),
          useValue: {
            findOne: jest.fn().mockResolvedValue({ id: 1, name: '活动项目' }),
          },
        },
        { provide: getRepositoryToken(User), useValue: { find: usersFind } },
        {
          provide: getRepositoryToken(Task),
          useValue: { findOne: tasksFindOne },
        },
        {
          provide: TaskWorkerInboxService,
          useValue: { enqueueReleaseStatus },
        },
        { provide: ReleaseNotifyService, useValue: { notify } },
      ],
    }).compile();

  beforeEach(async () => {
    releasesFind = jest.fn().mockResolvedValue([]);
    releasesFindOne = jest.fn();
    releasesSave = jest.fn((value: Partial<ProjectRelease>) =>
      Promise.resolve({ id: 9, createdAt: new Date(), ...value }),
    );
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
      return Promise.resolve([...names].map((name) => ({ name })));
    });
    tasksFindOne = jest.fn();
    notify = jest.fn().mockResolvedValue(true);
    enqueueReleaseStatus = jest.fn().mockResolvedValue(null);

    const moduleRef = await buildModule();
    service = moduleRef.get(ReleasesService);
  });

  describe('prepareBatch', () => {
    it('归一测试人员/提测端/分支/地址，并解析机器人来源任务', async () => {
      tasksFindOne.mockResolvedValue({ id: 88, agentId: 7 });
      const shared = await service.prepareBatch(
        {
          items: [{ backlogId: 12 }],
          ends: ['APP', ' APP ', 'H5'],
          testers: ['王五、赵六, 孙七'],
          branches: [
            { repo: ' LitaGroup/lita-h5 ', branch: ' test ' },
            { repo: '', branch: '' },
          ],
          urls: [' https://staging.example.com ', ''],
        },
        { operator: ' 活动开发机器人 ', workerId: 7 },
      );

      expect(shared).toEqual({
        ends: ['APP', 'H5'],
        testers: ['王五', '赵六', '孙七'],
        branches: [{ repo: 'LitaGroup/lita-h5', branch: 'test' }],
        urls: ['https://staging.example.com'],
        operator: '活动开发机器人',
        workerId: 7,
        sourceTaskId: 88,
      });
      const taskQuery = (
        tasksFindOne.mock.calls[0] as Array<{ where: { agentId: number } }>
      )[0];
      expect(taskQuery.where.agentId).toBe(7);
    });

    it('测试人员为空 → 400', async () => {
      await expect(
        service.prepareBatch({
          items: [{ backlogId: 12 }],
          ends: ['APP'],
          testers: [],
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.prepareBatch({
          items: [{ backlogId: 12 }],
          ends: ['APP'],
          testers: [' 、，'],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('提测端至少 1 个且仅允许 APP / H5 / 后端', async () => {
      await expect(
        service.prepareBatch({
          items: [{ backlogId: 12 }],
          ends: [],
          testers: ['王五'],
        }),
      ).rejects.toThrow(/提测端至少/);
      await expect(
        service.prepareBatch({
          items: [{ backlogId: 12 }],
          ends: ['小程序'],
          testers: ['王五'],
        }),
      ).rejects.toThrow(/无效值/);
    });

    it('机器人显式传入非本人执行的任务 → 400', async () => {
      tasksFindOne.mockResolvedValue({ id: 89, agentId: 8 });
      await expect(
        service.prepareBatch(
          {
            items: [{ backlogId: 12 }],
            ends: ['APP'],
            testers: ['王五'],
            taskId: 89,
          },
          { workerId: 7 },
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  it('createRecord：提测端/工单绑定落库，状态默认待冒烟', async () => {
    const release = await service.createRecord({
      projectId: 1,
      content: ' 回归登录 ',
      ends: ['APP', 'H5'],
      testers: ['王五'],
      branches: [{ repo: 'LitaGroup/lita-h5', branch: 'test' }],
      urls: ['https://staging.example.com'],
      operator: '胡峰',
      workerId: null,
      sourceTaskId: null,
      ticketId: 11,
      ticketCode: 'WO-0011',
    });

    expect(releasesSave).toHaveBeenCalledTimes(1);
    expect(release).toEqual(
      expect.objectContaining({
        projectId: 1,
        content: '回归登录',
        ends: ['APP', 'H5'],
        testers: ['王五'],
        operator: '胡峰',
        ticketId: 11,
        ticketCode: 'WO-0011',
        status: ReleaseStatus.PENDING,
        verifier: null,
        verifiedAt: null,
      }),
    );
  });

  it('提测记录清单 Markdown 使用新提测入口并展示提测端/工单', async () => {
    releasesFind.mockResolvedValue([
      {
        id: 9,
        projectId: 1,
        testers: ['王五'],
        ends: ['APP'],
        ticketId: 11,
        ticketCode: 'WO-0011',
        operator: '胡峰',
        content: '回归登录',
        urls: null,
        branches: null,
        workerId: null,
        sourceTaskId: null,
        verifier: null,
        verifiedAt: null,
        status: ReleaseStatus.PENDING,
        createdAt: new Date('2026-11-17T11:08:04Z'),
      },
    ]);
    const markdown = await service.listMarkdown(1);
    expect(markdown).toContain('POST /api/backlogs/release.md');
    expect(markdown).toContain('提测端：APP');
    expect(markdown).toContain('提测工单：WO-0011（#11）');
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
      ends: null,
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
      ends: null,
    } as ProjectRelease;
    releasesFindOne.mockResolvedValue(release);

    await service.updateStatus(9, ReleaseStatus.PENDING, '王五');
    expect(enqueueReleaseStatus).not.toHaveBeenCalled();

    await service.updateStatus(9, ReleaseStatus.IN_PROGRESS, '王五');
    expect(enqueueReleaseStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 9 }),
      ReleaseStatus.PENDING,
      '活动项目',
    );
  });

  it('测试人员不存在于用户系统 → 400 并列出无效姓名', async () => {
    usersFind.mockResolvedValue([{ name: '王五' }]);
    await expect(
      service.prepareBatch({
        items: [{ backlogId: 12 }],
        ends: ['APP'],
        testers: ['王五', '赵六'],
      }),
    ).rejects.toThrow(/赵六/);
  });
});
