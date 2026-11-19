import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { User } from '../auth/user.entity';
import { FeishuBotConfigService } from '../feishu-bot/feishu-bot-config.service';
import { FeishuBotIdentityService } from '../feishu-bot/feishu-bot-identity.service';
import { FeishuBotOfficialMessageService } from '../feishu-bot/feishu-bot-official-message.service';
import {
  ReleaseNoticeInput,
  ReleaseNotifyService,
} from './release-notify.service';

describe('ReleaseNotifyService', () => {
  let service: ReleaseNotifyService;
  let usersFind: jest.Mock;
  let openIdFor: jest.Mock;
  let send: jest.Mock;
  let loadEnabledOfficial: jest.Mock;
  const realPause = process.env.FEISHU_GROUP_SEND_PAUSED;

  const build = async (chatId = 'oc_release_group') =>
    Test.createTestingModule({
      providers: [
        ReleaseNotifyService,
        {
          provide: getRepositoryToken(User),
          useValue: { find: usersFind },
        },
        {
          provide: FeishuBotConfigService,
          useValue: { loadEnabledOfficial },
        },
        {
          provide: FeishuBotIdentityService,
          useValue: { openIdFor },
        },
        {
          provide: FeishuBotOfficialMessageService,
          useValue: { send },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'RELEASE_FEISHU_CHAT_ID' ? chatId : undefined,
          },
        },
      ],
    }).compile();

  const notice = (): ReleaseNoticeInput => ({
    title: '礼包改版 等2个迭代',
    ends: ['APP', 'H5'],
    operator: '胡峰',
    testers: ['赵六'],
    demanders: ['李四', '王五'],
    developers: ['前端A', '后端B'],
    branches: [{ repo: 'LitaGroup/lita-h5', branch: 'test' }],
    urls: ['https://staging.example.com'],
    items: [
      { code: 'BL-0001', title: '礼包改版', content: '回归支付' },
      { code: 'BL-0002', title: '签到优化', content: null },
    ],
    createdAt: new Date('2026-11-17T11:08:04Z'),
    sender: { type: 'user', id: 1, name: '胡峰' },
  });

  beforeEach(async () => {
    usersFind = jest.fn().mockResolvedValue([
      { id: 1, name: '胡峰', feishuOpenId: 'ou_hufeng' },
      { id: 2, name: '李四', feishuOpenId: 'ou_lisi' },
      { id: 3, name: '赵六', feishuOpenId: null },
    ]);
    openIdFor = jest.fn((_configId: number, userId: number) =>
      Promise.resolve(userId === 2 ? 'ou_lisi_app' : null),
    );
    send = jest.fn().mockResolvedValue(undefined);
    loadEnabledOfficial = jest.fn().mockResolvedValue({ id: 5 });
    const moduleRef = await build();
    service = moduleRef.get(ReleaseNotifyService);
  });

  afterEach(() => {
    if (realPause === undefined) delete process.env.FEISHU_GROUP_SEND_PAUSED;
    else process.env.FEISHU_GROUP_SEND_PAUSED = realPause;
  });

  it('按模板渲染消息，@ 优先生成官方应用 open_id，解析不到降级姓名', async () => {
    const content = await service.render(notice());
    expect(content).toBe(
      [
        '【提测】礼包改版 等2个迭代',
        '提测端：APP / H5',
        '提测人：<at id=ou_hufeng></at>',
        '需求方：<at id=ou_lisi_app></at> 王五',
        '测试人员：赵六',
        '开发人员：前端A 后端B',
        '提测时间：2026-11-17 19:08:04',
        '代码分支：LitaGroup/lita-h5 @ test',
        '访问地址：https://staging.example.com',
        '提测内容：',
        '1. BL-0001 礼包改版',
        '回归支付',
        '2. BL-0002 签到优化',
        '（无提测内容）',
      ].join('\n'),
    );
  });

  it('单个迭代项时提测内容直接展示（不带编号）', async () => {
    const input = {
      ...notice(),
      items: [{ code: 'BL-0001', title: '礼包改版', content: '回归支付' }],
    };
    const content = await service.render(input);
    expect(content).toContain('提测内容：\n回归支付');
    expect(content).not.toContain('1. BL-0001');
  });

  it('未配置提测群 chat_id 时跳过发送', async () => {
    const moduleRef = await build('');
    const svc = moduleRef.get(ReleaseNotifyService);
    const sent = await svc.notify(notice());
    expect(sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('FEISHU_GROUP_SEND_PAUSED 暂停时跳过发送', async () => {
    process.env.FEISHU_GROUP_SEND_PAUSED = 'true';
    const sent = await service.notify(notice());
    expect(sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('通过平台官方机器人发送到配置的群', async () => {
    const sent = await service.notify(notice());
    expect(sent).toBe(true);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'oc_release_group' }),
      { type: 'user', id: 1, name: '胡峰' },
    );
    const [[payload]] = send.mock.calls as [[{ content: string }]];
    expect(payload.content).toContain('【提测】礼包改版 等2个迭代');
  });

  it('发送失败只返回 false，不抛出', async () => {
    send.mockRejectedValue(new Error('feishu down'));
    await expect(service.notify(notice())).resolves.toBe(false);
  });
});
