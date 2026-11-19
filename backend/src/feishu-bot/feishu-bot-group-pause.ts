/**
 * 飞书群消息全局暂停开关（环境变量 FEISHU_GROUP_SEND_PAUSED，运维止血用）。
 *
 * 为 true 时暂停所有「发往飞书群」的外发动作：
 * - 任务群 / 迭代沟通群 / 项目沟通群的建群、拉人、状态卡片与文本；
 * - 话题落群（首楼卡片、话题内回帖）；
 * - 话题 @ 提及派生的外发：@ 真人机器人的飞书私聊卡片与 @ AI 机器人的自动答复；
 * - 机器人绑定应用的群策略回复与反馈群话题回执。
 *
 * 不受影响：平台名义发送（官方机器人指定 chat_id 的发送，如工单飞书群消息节点、
 * 提测群消息、平台/机器人显式发送）、飞书 OAuth 登录、文档/需求池同步、
 * 其它私聊（P2P）消息、卡片更新（PATCH）与群解散等不产生群消息的维护动作。
 *
 * 只读进程环境变量（ConfigModule 已把 .env 载入 process.env），
 * 切换后需重启后端；未配置或非法值视为「未暂停」。
 */
export const FEISHU_GROUP_SEND_PAUSED_ENV = 'FEISHU_GROUP_SEND_PAUSED';

/** 是否暂停飞书群消息外发（每次调用实时读取，便于暂停期间保持单一判定） */
export function feishuGroupSendPaused(): boolean {
  const raw = (process.env[FEISHU_GROUP_SEND_PAUSED_ENV] ?? '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
