import { BadRequestException } from '@nestjs/common';
import { Subject } from 'rxjs';
import {
  TopicPriority,
  TopicStatus,
  TopicSubjectType,
  WorkerRuntime,
} from '../common/enums';
import { TopicsService, fallbackTopicTitle } from './topics.service';

/** 构造 TopicsService（仓储全部为内存 mock，聚焦业务规则） */
function makeService(overrides: Record<string, unknown> = {}) {
  const events = new Subject();
  const savedRows: Record<string, unknown>[] = [];
  const topics = {
    create: (value: Record<string, unknown>) => value,
    save: jest.fn((value: Record<string, unknown>) => {
      savedRows.push(value);
      return { ...value, id: 5 };
    }),
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn(),
    createQueryBuilder: jest.fn(),
    ...(overrides.topics as object),
  };
  const posts = {
    create: (value: Record<string, unknown>) => value,
    save: jest.fn((value: Record<string, unknown>) => ({
      ...value,
      id: 11,
      createdAt: new Date('2026-11-16T10:00:00Z'),
    })),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    delete: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    ...(overrides.posts as object),
  };
  const follows = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(() => ({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    })),
    ...(overrides.follows as object),
  };
  const inbox = {
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn((value: Record<string, unknown>) => value),
    create: (value: Record<string, unknown>) => value,
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn(),
    ...(overrides.inbox as object),
  };
  const workers = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    ...(overrides.workers as object),
  };
  const backlogs = {
    findOne: jest.fn().mockResolvedValue({ id: 9, title: '礼包改版' }),
    ...(overrides.backlogs as object),
  };
  const service = new TopicsService(
    topics as never,
    posts as never,
    follows as never,
    inbox as never,
    workers as never,
    backlogs as never,
    { findOne: jest.fn() } as never,
    { findOne: jest.fn() } as never,
    { findOne: jest.fn() } as never,
    { findOne: jest.fn() } as never,
    { generateTitle: jest.fn().mockResolvedValue(null) } as never,
    events as never,
  );
  return { service, topics, posts, follows, inbox, workers, backlogs, events };
}

const actor = {
  userId: 7,
  workerId: null,
  userName: '张三',
  isAdmin: false,
};

describe('fallbackTopicTitle', () => {
  it('取正文首行并去掉 Markdown 标记', () => {
    expect(fallbackTopicTitle('## 接口超时\n详情…')).toBe('接口超时');
  });

  it('正文为空时使用兜底标题', () => {
    expect(fallbackTopicTitle('   ')).toBe('新话题');
  });
});

describe('TopicsService.create', () => {
  it('主体存在时创建话题并广播 topic-created', async () => {
    const { service, events, backlogs } = makeService();
    const pushed: unknown[] = [];
    events.subscribe((event) => pushed.push(event));
    const topic = await service.create(
      {
        subjectType: TopicSubjectType.BACKLOG,
        subjectId: 9,
        content: '接口偶发 500，需要排查',
      },
      actor,
    );
    expect(backlogs.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 9 } }),
    );
    expect(topic.subjectTitle).toBe('礼包改版');
    expect(topic.title).toBe('接口偶发 500，需要排查');
    expect(topic.priority).toBe(TopicPriority.MEDIUM);
    expect(topic.status).toBe(TopicStatus.OPEN);
    expect(pushed).toEqual([{ kind: 'topic-created', topicId: 5 }]);
  });

  it('正文为空时拒绝创建', async () => {
    const { service } = makeService();
    await expect(
      service.create(
        {
          subjectType: TopicSubjectType.BACKLOG,
          subjectId: 9,
          content: '   ',
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('主体不存在时拒绝创建', async () => {
    const { service } = makeService({
      backlogs: { findOne: jest.fn().mockResolvedValue(null) },
    });
    await expect(
      service.create(
        {
          subjectType: TopicSubjectType.BACKLOG,
          subjectId: 404,
          content: '内容',
        },
        actor,
      ),
    ).rejects.toThrow('话题主体不存在');
  });

  it('@ AI 机器人时写入收件箱；真人机器人不写（由通知服务处理）', async () => {
    const { service, inbox } = makeService({
      workers: {
        find: jest.fn().mockResolvedValue([
          {
            id: 101,
            runtime: WorkerRuntime.OPENCODE,
            enabled: true,
            personalAgentUserId: null,
          },
          {
            id: 102,
            runtime: WorkerRuntime.HUMAN,
            enabled: true,
            personalAgentUserId: null,
          },
        ]),
      },
    });
    await service.create(
      {
        subjectType: TopicSubjectType.BACKLOG,
        subjectId: 9,
        content: '请机器人看一下',
        mentions: [101, 102],
      },
      actor,
    );
    expect(inbox.save).toHaveBeenCalledTimes(1);
    expect(inbox.save).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: 101, status: 'pending', postId: 0 }),
    );
  });
});

describe('TopicsService.createPost', () => {
  const openTopic = {
    id: 5,
    subjectType: TopicSubjectType.BACKLOG,
    subjectId: 9,
    subjectTitle: '礼包改版',
    title: '接口偶发 500',
    priority: TopicPriority.MEDIUM,
    status: TopicStatus.OPEN,
    tags: null,
    content: '首楼',
    creatorUserId: 7,
    creatorWorkerId: null,
    creatorName: '张三',
    mentions: null,
    postCount: 0,
    lastPostAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('关闭的话题禁止发帖', async () => {
    const { service } = makeService({
      topics: {
        findOne: jest
          .fn()
          .mockResolvedValue({ ...openTopic, status: TopicStatus.CLOSED }),
      },
    });
    await expect(
      service.createPost(5, { content: '继续讨论' }, actor),
    ).rejects.toThrow('话题已关闭');
  });

  it('发帖累加计数并广播 post-created', async () => {
    const { service, topics, events } = makeService({
      topics: { findOne: jest.fn().mockResolvedValue(openTopic) },
    });
    const pushed: unknown[] = [];
    events.subscribe((event) => pushed.push(event));
    const post = await service.createPost(5, { content: '补充日志' }, actor);
    expect(post.id).toBe(11);
    expect(topics.update).toHaveBeenCalledWith(
      { id: 5 },
      expect.objectContaining({ postCount: 1 }),
    );
    expect(pushed).toEqual([{ kind: 'post-created', topicId: 5, postId: 11 }]);
  });

  it('机器人回帖后关闭其待答复收件箱', async () => {
    const { service, inbox } = makeService({
      topics: { findOne: jest.fn().mockResolvedValue(openTopic) },
    });
    await service.createPost(
      5,
      { content: '已排查，是网关超时' },
      {
        userId: null,
        workerId: 101,
        userName: '机器人甲',
        isAdmin: false,
      },
    );
    expect(inbox.update).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: 5, workerId: 101 }),
      expect.objectContaining({ status: 'done' }),
    );
  });
});

describe('TopicsService.follow', () => {
  it('关注幂等（冲突忽略）', async () => {
    const { service, topics, follows } = makeService();
    topics.findOne.mockResolvedValue({ id: 5 });
    await service.follow(5, 7);
    expect(follows.createQueryBuilder).toHaveBeenCalled();
  });

  it('未登录用户查询关注状态返回 false', async () => {
    const { service } = makeService();
    await expect(service.isFollowing(5, null)).resolves.toBe(false);
  });
});
