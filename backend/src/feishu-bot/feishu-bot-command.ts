/** 飞书聊天中的新会话命令（完整文本匹配，不承载额外参数） */
export const FEISHU_NEW_SESSION_COMMAND = '/new';

/** 去除 @ 占位与首尾空白后是否为新会话命令 */
export function isFeishuNewSessionCommand(text: string): boolean {
  return text.trim() === FEISHU_NEW_SESSION_COMMAND;
}
