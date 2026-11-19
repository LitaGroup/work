import { FEISHU_GROUP_SEND_PAUSED_ENV } from '../feishu-bot/feishu-bot-group-pause';
import { TopicLoopService } from './topic-loop.service';

function makeService() {
  const builder = {
    where: () => builder,
    andWhere: () => builder,
    orderBy: () => builder,
    take: () => builder,
    getMany: jest.fn().mockResolvedValue([]),
  };
  const inbox = {
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn().mockReturnValue(builder),
  };
  const topics = { findOne: jest.fn() };
  const replies = { reply: jest.fn() };
  const service = new TopicLoopService(
    inbox as never,
    topics as never,
    replies as never,
  );
  return { service, inbox, replies };
}

describe('TopicLoopService 暂停开关', () => {
  const original = process.env[FEISHU_GROUP_SEND_PAUSED_ENV];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[FEISHU_GROUP_SEND_PAUSED_ENV];
    } else {
      process.env[FEISHU_GROUP_SEND_PAUSED_ENV] = original;
    }
  });

  it('暂停期间不扫描收件箱、不创建答复会话', async () => {
    process.env[FEISHU_GROUP_SEND_PAUSED_ENV] = 'true';
    const { service, inbox, replies } = makeService();

    await service.tick();

    expect(inbox.find).not.toHaveBeenCalled();
    expect(inbox.update).not.toHaveBeenCalled();
    expect(replies.reply).not.toHaveBeenCalled();
  });

  it('未暂停时正常扫描收件箱', async () => {
    delete process.env[FEISHU_GROUP_SEND_PAUSED_ENV];
    const { service, inbox } = makeService();

    await service.tick();

    expect(inbox.find).toHaveBeenCalled();
  });
});
