import {
  FEISHU_GROUP_SEND_PAUSED_ENV,
  feishuGroupSendPaused,
} from './feishu-bot-group-pause';

describe('feishuGroupSendPaused', () => {
  const original = process.env[FEISHU_GROUP_SEND_PAUSED_ENV];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[FEISHU_GROUP_SEND_PAUSED_ENV];
    } else {
      process.env[FEISHU_GROUP_SEND_PAUSED_ENV] = original;
    }
  });

  it('未配置或空白视为未暂停', () => {
    delete process.env[FEISHU_GROUP_SEND_PAUSED_ENV];
    expect(feishuGroupSendPaused()).toBe(false);
    process.env[FEISHU_GROUP_SEND_PAUSED_ENV] = '   ';
    expect(feishuGroupSendPaused()).toBe(false);
  });

  it.each(['true', 'TRUE', '1', 'yes', 'on', ' On '])(
    '识别暂停值 %s',
    (value) => {
      process.env[FEISHU_GROUP_SEND_PAUSED_ENV] = value;
      expect(feishuGroupSendPaused()).toBe(true);
    },
  );

  it('false / 0 / off 等非法或关闭值视为未暂停', () => {
    for (const value of ['false', '0', 'no', 'off', 'paused']) {
      process.env[FEISHU_GROUP_SEND_PAUSED_ENV] = value;
      expect(feishuGroupSendPaused()).toBe(false);
    }
  });
});
