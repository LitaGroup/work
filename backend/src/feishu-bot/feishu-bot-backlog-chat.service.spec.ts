import { BacklogStatus, WorkerRuntime } from '../common/enums';
import { Backlog } from '../iterations/backlog.entity';
import { FeishuBotBacklogChat } from './feishu-bot-backlog-chat.entity';
import { FeishuBotBacklogChatService } from './feishu-bot-backlog-chat.service';

describe('FeishuBotBacklogChatService', () => {
  const chatRow = (
    over: Partial<FeishuBotBacklogChat> = {},
  ): FeishuBotBacklogChat => ({
    id: 5,
    backlogId: 2,
    officialConfigId: 1,
    chatId: 'oc_backlog',
    state: 'active',
    name: 'LitaWork-迭代-登录改版 沟通群',
    backlogTitle: '登录改版',
    memberUserIds: [],
    memberWorkerIds: [],
    memberNames: [],
    botIds: [],
    lastStatus: null,
    finishedAt: null,
    finishedNotified: false,
    destroyAfter: null,
    attempts: 0,
    lastError: null,
    createdAt: new Date('2026-11-01T10:00:00+08:00'),
    updatedAt: new Date('2026-11-09T10:00:00+08:00'),
    ...over,
  });

  const backlog = (over: Partial<Backlog> = {}): Backlog =>
    ({
      id: 2,
      code: 'BL-0002',
      title: '登录改版',
      projectId: 3708,
      iterationId: 3,
      status: BacklogStatus.EXECUTING,
      ownerWorkerId: null,
      ownerName: null,
      members: [
        { role: '后端', workerId: 1001, name: '李四' },
        { role: '测试', workerId: 1002, name: '王五' },
      ],
      completedAt: null,
      canceledAt: null,
      expectedOnlineAt: null,
      createdAt: new Date('2026-11-01T10:00:00+08:00'),
      updatedAt: new Date('2026-11-09T10:00:00+08:00'),
      ...over,
    }) as Backlog;

  function setup(
    row: FeishuBotBacklogChat | null = chatRow(),
    item: Backlog = backlog(),
  ) {
    const current = row;
    const official = { id: 1, appId: 'cli_official' };
    const chats = {
      findOne: jest.fn(() => Promise.resolve(current)),
      find: jest.fn(() => Promise.resolve(current ? [current] : [])),
      update: jest.fn(
        (_where: unknown, patch: Partial<FeishuBotBacklogChat>) => {
          if (current) Object.assign(current, patch);
          return Promise.resolve({ affected: 1 });
        },
      ),
      increment: jest.fn(() => Promise.resolve({ affected: 1 })),
    };
    const backlogs = {
      findOne: jest.fn(() => Promise.resolve(item)),
      find: jest.fn(() => Promise.resolve([item])),
    };
    const users = {
      find: jest.fn(() =>
        Promise.resolve([
          { id: 8, name: '李四', feishuOpenId: 'ou_lisi' },
          { id: 9, name: '王五', feishuOpenId: 'ou_wangwu' },
        ]),
      ),
    };
    const workers = {
      find: jest.fn(() =>
        Promise.resolve([
          {
            id: 1001,
            name: '李四',
            runtime: WorkerRuntime.HUMAN,
            humanUserId: 8,
          },
          {
            id: 1002,
            name: '王五',
            runtime: WorkerRuntime.HUMAN,
            humanUserId: 9,
          },
        ]),
      ),
    };
    const configs = {
      loadEnabledOfficial: jest.fn(() => Promise.resolve(official)),
      loadEnabledWithSecrets: jest.fn(() => Promise.resolve(official)),
      secretsOf: jest.fn(() => ({
        appId: official.appId,
        appSecret: 'secret',
        verificationToken: null,
        encryptKey: null,
      })),
      findEnabledWorkerConfig: jest.fn(() => Promise.resolve(null)),
    };
    const client = {
      appUrl: 'http://localhost:5273',
      createChat: jest.fn(() => Promise.resolve('oc_new')),
      getChatInfo: jest.fn(() =>
        Promise.resolve({ name: 'x', chatStatus: 'normal' }),
      ),
      sendCard: jest.fn(() => Promise.resolve({ messageId: 'om_1' })),
      addChatMembers: jest.fn(() => Promise.resolve(undefined)),
      addChatUsers: jest.fn(() => Promise.resolve(undefined)),
      dissolveChat: jest.fn(() => Promise.resolve(undefined)),
    };
    const identities = {
      openIdFor: jest.fn(() => Promise.resolve(null)),
    };
    const service = new FeishuBotBacklogChatService(
      configs as never,
      client as never,
      identities as never,
      chats as never,
      backlogs as never,
      users as never,
      workers as never,
    );
    return {
      service,
      chat: () => current,
      client,
      configs,
      chats,
    };
  }

  it('存量群（无成员跟踪）按当前成员实际补拉，而不是视为已入群', async () => {
    const { service, chat, client } = setup();

    await service.reconcile();

    expect(client.addChatUsers).toHaveBeenCalledWith(
      1,
      expect.any(Object),
      'oc_backlog',
      ['ou_lisi', 'ou_wangwu'],
    );
    expect(chat()).toMatchObject({
      state: 'active',
      memberWorkerIds: [1001, 1002],
      memberNames: ['李四', '王五'],
    });
  });

  it('已有跟踪的群只补拉新增成员', async () => {
    const { service, chat, client } = setup(
      chatRow({ memberWorkerIds: [1001], memberNames: ['李四'] }),
    );

    await service.reconcile();

    expect(client.addChatUsers).toHaveBeenCalledWith(
      1,
      expect.any(Object),
      'oc_backlog',
      ['ou_wangwu'],
    );
    expect(chat()?.memberWorkerIds).toEqual([1001, 1002]);
  });

  it('终态迭代项不再补拉成员', async () => {
    const { service, client } = setup(
      chatRow(),
      backlog({
        status: BacklogStatus.COMPLETED,
        completedAt: new Date(),
      }),
    );

    await service.reconcile();

    expect(client.addChatUsers).not.toHaveBeenCalled();
  });

  it('群已在飞书侧解散时重置绑定，详情页可重新建群', async () => {
    const { service, chat, client } = setup();
    client.getChatInfo.mockResolvedValue({
      name: 'x',
      chatStatus: 'dissolved',
    });

    await service.reconcile();

    expect(chat()).toMatchObject({
      state: 'destroyed',
      lastError: '飞书群已在飞书侧解散，可重新建群',
    });
    expect(client.addChatUsers).not.toHaveBeenCalled();
    await expect(service.describe(2)).resolves.toBeNull();
  });

  it('chat_id 无效（232006）时重置绑定', async () => {
    const { service, chat, client } = setup();
    client.getChatInfo.mockRejectedValue(
      new Error(
        '飞书接口调用失败：Your request specifies a chat_id which is invalid.（code=232006）',
      ),
    );

    await service.reconcile();

    expect(chat()).toMatchObject({
      state: 'destroyed',
      lastError: '飞书群已不存在，可重新建群',
    });
    expect(client.addChatUsers).not.toHaveBeenCalled();
  });

  it('存活校验的其它错误只告警，不重置绑定', async () => {
    const { service, chat, client } = setup();
    client.getChatInfo.mockRejectedValue(new Error('飞书接口调用失败：超时'));

    await service.reconcile();

    expect(chat()?.state).toBe('active');
  });

  describe('飞书群消息暂停（FEISHU_GROUP_SEND_PAUSED）', () => {
    const original = process.env.FEISHU_GROUP_SEND_PAUSED;

    beforeEach(() => {
      process.env.FEISHU_GROUP_SEND_PAUSED = 'true';
    });

    afterEach(() => {
      if (original === undefined) delete process.env.FEISHU_GROUP_SEND_PAUSED;
      else process.env.FEISHU_GROUP_SEND_PAUSED = original;
    });

    it('对账暂停拉人与状态卡片，且不消耗建群重试次数', async () => {
      const { service, client, chats } = setup();

      await service.reconcile();

      expect(client.addChatUsers).not.toHaveBeenCalled();
      expect(client.sendCard).not.toHaveBeenCalled();
      expect(chats.increment).not.toHaveBeenCalled();
    });

    it('手动建群在暂停期间明确拒绝', async () => {
      const { service } = setup(null);
      await expect(service.createForBacklog(2)).rejects.toThrow(
        '已暂停飞书群消息与建群',
      );
    });
  });
});
