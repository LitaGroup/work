import { WorkerRuntime } from '../common/enums';
import { FEISHU_GROUP_SEND_PAUSED_ENV } from '../feishu-bot/feishu-bot-group-pause';
import { TopicPost } from './topic-post.entity';
import { Topic } from './topic.entity';
import { TopicNotifyService } from './topic-notify.service';

const MENTIONED_USER_ID = 7;

function makeTopic(): Topic {
  return {
    id: 3,
    title: '话题标题',
    subjectType: 'backlogs',
    subjectId: 9,
    subjectTitle: '迭代项',
    content: '请在话题中看一下',
    mentions: [1001],
    creatorUserId: 5,
    creatorName: '发起人',
  } as unknown as Topic;
}

/** 构造 TopicNotifyService（只关注 @ 提及通知的暂停行为） */
function makeService() {
  const configs = {
    loadEnabledOfficial: jest.fn().mockResolvedValue({ id: 1 }),
    secretsOf: jest.fn().mockReturnValue({}),
  };
  const client = {
    appUrl: 'http://localhost:5273',
    sendCard: jest.fn().mockResolvedValue(undefined),
  };
  const identities = {
    openIdFor: jest.fn().mockResolvedValue('ou_test'),
  };
  const topics = {
    followerIds: jest.fn().mockResolvedValue([MENTIONED_USER_ID]),
  };
  const workers = {
    find: jest.fn().mockResolvedValue([
      {
        id: 1001,
        name: '真人机器人',
        runtime: WorkerRuntime.HUMAN,
        humanUserId: MENTIONED_USER_ID,
        personalAgentUserId: null,
        enabled: true,
      },
    ]),
  };
  const users = {
    findOne: jest.fn().mockResolvedValue({
      id: MENTIONED_USER_ID,
      feishuOpenId: 'ou_test',
    }),
  };
  const service = new TopicNotifyService(
    configs as never,
    client as never,
    identities as never,
    topics as never,
    {} as never,
    {} as never,
    workers as never,
    users as never,
    { subscribe: jest.fn(), unsubscribe: jest.fn() } as never,
  );
  return { service, configs, client, topics };
}

describe('TopicNotifyService 暂停开关', () => {
  const original = process.env[FEISHU_GROUP_SEND_PAUSED_ENV];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[FEISHU_GROUP_SEND_PAUSED_ENV];
    } else {
      process.env[FEISHU_GROUP_SEND_PAUSED_ENV] = original;
    }
  });

  it('暂停期间不发 @ 提及卡片，且不向关注通知补发同一条', async () => {
    process.env[FEISHU_GROUP_SEND_PAUSED_ENV] = 'true';
    const { service, configs, client, topics } = makeService();
    const topic = makeTopic();

    await service['notifyMentions'](topic, topic.content, topic.mentions, null);

    expect(configs.loadEnabledOfficial).not.toHaveBeenCalled();
    expect(client.sendCard).not.toHaveBeenCalled();

    // 关注者里包含被提及的人，暂停时视为已处理，不再补发关注卡片
    await service['notifyFollowers'](
      topic,
      { id: 11, content: '回复', authorName: '发起人' } as unknown as TopicPost,
      new Set([MENTIONED_USER_ID]),
    );
    expect(topics.followerIds).toHaveBeenCalled();
    expect(configs.loadEnabledOfficial).not.toHaveBeenCalled();
  });

  it('未暂停时正常发送 @ 提及卡片', async () => {
    delete process.env[FEISHU_GROUP_SEND_PAUSED_ENV];
    const { service, client } = makeService();
    const topic = makeTopic();

    await service['notifyMentions'](topic, topic.content, topic.mentions, null);

    expect(client.sendCard).toHaveBeenCalledTimes(1);
  });
});
