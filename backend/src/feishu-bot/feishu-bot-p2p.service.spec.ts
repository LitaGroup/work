import { EMPTY, Subject } from 'rxjs';
import { WorkerRuntime } from '../common/enums';
import type { FeishuBotConfig } from './feishu-bot-config.entity';
import {
  FeishuBotP2PService,
  type FeishuInboundMessage,
} from './feishu-bot-p2p.service';

// 附件落盘走真实目录，单测里屏蔽文件系统副作用
jest.mock('fs/promises', () => ({
  mkdir: jest.fn(() => Promise.resolve()),
  writeFile: jest.fn(() => Promise.resolve()),
}));

describe('FeishuBotP2PService 私聊消息', () => {
  const config = (over: Partial<FeishuBotConfig> = {}): FeishuBotConfig =>
    ({
      id: 2,
      kind: 'worker',
      workerId: 5,
      appId: 'cli_app',
      policy: {},
      ...over,
    }) as FeishuBotConfig;

  const user = () => ({ id: 7, name: '张三' }) as never;

  const message = (over: Partial<FeishuInboundMessage> = {}) => ({
    messageId: 'om_1',
    chatId: 'oc_p2p',
    chatType: 'p2p',
    messageType: 'image',
    content: JSON.stringify({ image_key: 'img_1' }),
    ...over,
  });

  const textMessage = (
    text: string,
    over: Partial<FeishuInboundMessage> = {},
  ) =>
    message({
      messageType: 'text',
      content: JSON.stringify({ text }),
      ...over,
    });

  function setup() {
    const client = {
      sendText: jest.fn(() => Promise.resolve({ messageId: null })),
      sendCard: jest.fn(() => Promise.resolve({ messageId: null })),
      react: jest.fn(() => Promise.resolve({ reactionId: 'r1' })),
      unreact: jest.fn(() => Promise.resolve()),
      downloadImage: jest.fn(() => Promise.resolve(Buffer.from('img'))),
      downloadFile: jest.fn(() => Promise.resolve(Buffer.from('file'))),
      uploadLocalImage: jest.fn(() => Promise.resolve('img_key')),
      uploadLocalFile: jest.fn(() => Promise.resolve('file_key')),
      sendImage: jest.fn(() => Promise.resolve({ messageId: null })),
      sendFile: jest.fn(() => Promise.resolve({ messageId: null })),
    };
    const messages = {
      sendMarkdown: jest.fn(() => Promise.resolve([])),
      sendQuestionCard: jest.fn(() => Promise.resolve({ messageId: null })),
    };
    const debug = {
      send: jest.fn(() => Promise.resolve({})),
      stream: jest.fn(() => EMPTY),
      replyQuestion: jest.fn(() => Promise.resolve({})),
      interrupt: jest.fn(() => Promise.resolve({})),
      reset: jest.fn(() => Promise.resolve({})),
    };
    const personalAgents = {
      ensureForUser: jest.fn(() => Promise.resolve({ id: 8 })),
      send: jest.fn(() => Promise.resolve({})),
      reset: jest.fn(() => Promise.resolve({})),
    };
    const cards = {
      findOne: jest.fn(() => Promise.resolve(null)),
      create: jest.fn((value: unknown) => value),
      save: jest.fn((value: { id?: number }) =>
        Promise.resolve({ ...value, id: 99 }),
      ),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
    };
    const workers = {
      findOne: jest.fn(() =>
        Promise.resolve({
          id: 5,
          enabled: true,
          runtime: WorkerRuntime.OPENCODE,
        }),
      ),
    };
    const service = new FeishuBotP2PService(
      client as never,
      messages as never,
      debug as never,
      personalAgents as never,
      cards as never,
      workers as never,
    );
    return { service, client, messages, debug, personalAgents, cards, workers };
  }

  it('图片下载失败时显式回执，不再静默', async () => {
    const { service, client, debug, personalAgents } = setup();
    client.downloadImage.mockRejectedValueOnce(
      new Error('飞书素材下载失败：HTTP 403'),
    );

    await expect(
      service.handleMessage(config(), {} as never, user(), message()),
    ).resolves.toBeUndefined();

    expect(client.sendText).toHaveBeenCalledWith(
      2,
      expect.anything(),
      'chat_id',
      'oc_p2p',
      expect.stringContaining('附件接收失败'),
    );
    expect(client.sendText).toHaveBeenCalledWith(
      2,
      expect.anything(),
      'chat_id',
      'oc_p2p',
      expect.stringContaining('飞书素材下载失败：HTTP 403'),
    );
    expect(client.sendText).toHaveBeenCalledWith(
      2,
      expect.anything(),
      'chat_id',
      'oc_p2p',
      expect.stringContaining('im:message'),
    );
    // 失败发生在表情回应与会话投递之前
    expect(client.react).not.toHaveBeenCalled();
    expect(debug.send).not.toHaveBeenCalled();
    expect(personalAgents.send).not.toHaveBeenCalled();
  });

  it('图片正常下载后作为附件投递机器人会话', async () => {
    const { service, client, debug } = setup();

    await service.handleMessage(config(), {} as never, user(), message());

    expect(client.downloadImage).toHaveBeenCalledWith(
      2,
      expect.anything(),
      'om_1',
      'img_1',
    );
    expect(client.sendText).not.toHaveBeenCalled();
    expect(debug.send).toHaveBeenCalledWith(
      7,
      5,
      '',
      expect.objectContaining({ scope: 'feishu:p2p:oc_p2p' }),
    );
    const sentOptions = debug.send.mock.calls[0][3] as unknown as {
      files?: Array<{ name: string; mime: string; url: string }>;
    };
    expect(sentOptions.files).toHaveLength(1);
    expect(sentOptions.files?.[0]).toMatchObject({
      name: '飞书图片.png',
      mime: 'image/png',
    });
    expect(sentOptions.files?.[0]?.url).toContain('/files/feishu/');
  });

  it('官方机器人图片下载失败同样显式回执', async () => {
    const { service, client, personalAgents } = setup();
    client.downloadImage.mockRejectedValueOnce(
      new Error('飞书素材下载失败：HTTP 403'),
    );

    await service.handleMessage(
      config({ kind: 'official', workerId: null }),
      {} as never,
      user(),
      message(),
    );

    expect(client.sendText).toHaveBeenCalledWith(
      2,
      expect.anything(),
      'chat_id',
      'oc_p2p',
      expect.stringContaining('附件接收失败'),
    );
    expect(personalAgents.send).not.toHaveBeenCalled();
  });

  it('/new 重置自定义机器人私聊会话并发送确认', async () => {
    const { service, client, debug, personalAgents, cards } = setup();

    await service.handleMessage(
      config(),
      {} as never,
      user(),
      textMessage('/new'),
    );

    expect(debug.reset).toHaveBeenCalledWith(7, 5, 'feishu:p2p:oc_p2p');
    expect(cards.update).toHaveBeenCalledWith(
      { configId: 2, scope: 'feishu:p2p:oc_p2p', state: 'pending' },
      { state: 'expired' },
    );
    expect(debug.send).not.toHaveBeenCalled();
    expect(personalAgents.send).not.toHaveBeenCalled();
    expect(client.react).not.toHaveBeenCalled();
    expect(client.sendText).toHaveBeenCalledWith(
      2,
      expect.anything(),
      'chat_id',
      'oc_p2p',
      expect.stringContaining('已开启新会话'),
    );
  });

  it('官方机器人 /new 重置发送者的个人 AGENT 会话', async () => {
    const { service, debug, personalAgents } = setup();

    await service.handleMessage(
      config({ kind: 'official', workerId: null }),
      {} as never,
      user(),
      textMessage('/new'),
    );

    expect(personalAgents.reset).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      null,
      'feishu:p2p:oc_p2p',
    );
    expect(debug.reset).not.toHaveBeenCalled();
    expect(personalAgents.send).not.toHaveBeenCalled();
  });

  it('/new 附带其它内容时仍作为普通消息投递', async () => {
    const { service, debug } = setup();

    await service.handleMessage(
      config(),
      {} as never,
      user(),
      textMessage('/new 继续分析'),
    );

    expect(debug.reset).not.toHaveBeenCalled();
    expect(debug.send).toHaveBeenCalledWith(
      7,
      5,
      '/new 继续分析',
      expect.objectContaining({ scope: 'feishu:p2p:oc_p2p' }),
    );
  });

  it('执行中 /new 优先于 busy，作废旧轮次且不再回传旧结果', async () => {
    const { service, client, debug, messages } = setup();
    const events = new Subject<{
      data: {
        type: 'snapshot';
        snapshot: {
          status: string;
          messages: Array<Record<string, unknown>>;
        };
      };
    }>();
    debug.stream.mockReturnValue(events.asObservable());

    const activeRuns = (service as unknown as { runs: Map<string, unknown> })
      .runs;
    await service.handleMessage(
      config(),
      {} as never,
      user(),
      textMessage('先做一件事', { messageId: 'om_first' }),
    );
    expect(activeRuns.size).toBe(1);

    await service.handleMessage(
      config(),
      {} as never,
      user(),
      textMessage('/new', { messageId: 'om_new' }),
    );

    expect(debug.reset).toHaveBeenCalledWith(7, 5, 'feishu:p2p:oc_p2p');
    expect(client.sendText).not.toHaveBeenCalledWith(
      2,
      expect.anything(),
      'chat_id',
      'oc_p2p',
      expect.stringContaining('正在处理上一条消息'),
    );
    expect(activeRuns.size).toBe(0);

    events.next({
      data: {
        type: 'snapshot',
        snapshot: {
          status: 'idle',
          messages: [
            {
              id: 'assistant:old',
              role: 'assistant',
              status: 'complete',
              content: '旧会话结果',
            },
          ],
        },
      },
    });
    expect(messages.sendMarkdown).not.toHaveBeenCalled();
  });
});
