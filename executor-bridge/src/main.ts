/**
 * executor-bridge 入口。
 * 环境变量：
 * - BRIDGE_PORT：监听端口（缺省按内核分配，见 PORT_CONVENTION；工位约定每执行器一实例一端口）
 * - BRIDGE_TOKEN：Bearer 令牌（空 = 不鉴权，仅限本机回环）
 * - KERNEL：执行内核（kiro / devin / droid，后续 codex / claude）
 * - BRIDGE_ROOT：工位根目录（文件端点路径限定范围；默认 WORKER_BASE_DIR 或当前目录）
 */
import { resolve } from 'path';
import { SessionManager } from './core/sessions.js';
import { FileOps } from './core/files.js';
import { EventBus } from './server/bus.js';
import { startBridgeServer } from './server/http.js';
import { KiroKernel } from './kernels/kiro/kiro.kernel.js';
import { DevinKernel } from './kernels/devin/devin.kernel.js';
import { DroidKernel } from './kernels/droid/droid.kernel.js';
import type { Kernel } from './kernels/kernel.js';

/**
 * 端口规范：executor-bridge 统一占用 16000-17000 段，
 * 内核缺省端口按下表分配（BRIDGE_PORT 显式设置时覆盖）。
 */
const PORT_CONVENTION: Record<string, number> = {
  kiro: 16010,
  devin: 16020,
  droid: 16030,
};
/** 未分配内核的缺省端口（段内兜底） */
const DEFAULT_BRIDGE_PORT = 16000;

function selectKernel(root: string): Kernel {
  const name = (process.env.KERNEL ?? 'kiro').toLowerCase();
  switch (name) {
    case 'kiro':
      return new KiroKernel(root);
    case 'devin':
      return new DevinKernel(root);
    case 'droid':
      return new DroidKernel(root);
    default:
      throw new Error(
        `未知内核 KERNEL=${name}（当前支持：kiro / devin / droid）`,
      );
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
  port: Number(
    process.env.BRIDGE_PORT ??
      PORT_CONVENTION[kernel.name] ??
      DEFAULT_BRIDGE_PORT,
  ),
  token: process.env.BRIDGE_TOKEN?.trim() || null,
  kernel,
  sessions,
  files,
  bus,
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
