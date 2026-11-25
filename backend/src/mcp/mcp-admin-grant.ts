/**
 * 显式授权访问 lita-work-admin 的机器人白名单。
 *
 * 纯 AI 机器人没有绑定真人，无法取得管理员身份；平台用环境变量
 * MCP_ADMIN_WORKER_IDS（逗号/空格分隔的机器人 id）临时放开，
 * 授权后初始化/派发会同时注入 lita-work-admin MCP 服务。
 */
export const ADMIN_WORKER_IDS_ENV = 'MCP_ADMIN_WORKER_IDS';

/** lita-work-admin 在工位 MCP 配置中的服务名 */
export const LITA_WORK_ADMIN_SERVER_NAME = 'lita-work-admin';

export function adminGrantedWorkerIds(): Set<number> {
  const raw = process.env[ADMIN_WORKER_IDS_ENV] ?? '';
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((item) => Number(item.trim()))
      .filter((id) => Number.isInteger(id) && id > 0),
  );
}

export function isAdminGrantedWorker(
  workerId: number | null | undefined,
): boolean {
  return !!workerId && adminGrantedWorkerIds().has(workerId);
}