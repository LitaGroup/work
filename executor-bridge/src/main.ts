/**
 * executor-bridge 入口。
 * 环境变量：
 * - BRIDGE_PORT：监听端口（默认 4590；工位约定每执行器一实例一端口）
 * - BRIDGE_TOKEN：Bearer 令牌（空 = 不鉴权，仅限本机回环）
 * - KERNEL：执行内核（kiro，后续 codex / claude）
 * - BRIDGE_ROOT：工位根目录（文件端点路径限定范围；默认 WORKER_BASE_DIR 或当前目录）
 */
import { resolve } from 'path';
import { SessionManager } from './core/sessions.js';
import { FileOps } from './core/files.js';
import { EventBus } from './server/bus.js';
import { startBridgeServer } from './server/http.js';
import { KiroKernel } from './kernels/kiro/kiro.kernel.js';
import type { Kernel } from './kernels/kernel.js';

function selectKernel(root: string): Kernel {
  const name = (process.env.KERNEL ?? 'kiro').toLowerCase();
  switch (name) {
    case 'kiro':
      return new KiroKernel(root);
    default:
      throw new Error(`未知内核 KERNEL=${name}（当前支持：kiro）`);
  }
}

const root = resolve(
  process.env.BRIDGE_ROOT || process.env.WORKER_BASE_DIR || process.cwd(),
);
const kernel = selectKernel(root);
const files = new FileOps(root);
const bus = new EventBus();
const sessions = new SessionManager(
  kernel,
  (type, data) => bus.publish(type, data),
  files.directory(),
);

startBridgeServer({
  port: Number(process.env.BRIDGE_PORT ?? 4590),
  token: process.env.BRIDGE_TOKEN?.trim() || null,
  kernel,
  sessions,
  files,
  bus,
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
