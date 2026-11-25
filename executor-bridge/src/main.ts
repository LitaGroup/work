/**
 * executor-bridge 入口。
 * 环境变量：
 * - BRIDGE_PORT：监听端口（缺省按内核分配，见 PORT_CONVENTION；工位约定每执行器一实例一端口）
 * - BRIDGE_TOKEN：Bearer 令牌（空 = 不鉴权，仅限本机回环）
 * - KERNEL：执行内核（kiro / devin / droid，后续 codex / claude）
 * - BRIDGE_ROOT：工位根目录（文件端点路径限定范围；默认 WORKER_BASE_DIR 或当前目录）
 * - BRIDGE_STATE_FILE：会话快照文件（默认 {BRIDGE_ROOT}/.executor-bridge/{KERNEL}-{PORT}.json）
 * - BRIDGE_MAX_TURNS：同时运行的回合上限（默认 10，超出的回合按序排队）
 * - BRIDGE_SESSION_TTL_MS：空闲会话回收时间（默认 24 小时）
 */
import { join, resolve } from 'path';
import { SessionManager } from './core/sessions.js';
import { SessionStore } from './core/session-store.js';
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

async function bootstrap(): Promise<void> {
  const root = resolve(
    process.env.BRIDGE_ROOT || process.env.WORKER_BASE_DIR || process.cwd(),
  );
  const kernel = selectKernel(root);
  const port = Number(
    process.env.BRIDGE_PORT ??
      PORT_CONVENTION[kernel.name] ??
      DEFAULT_BRIDGE_PORT,
  );
  const ttlMs = Math.max(
    60_000,
    Number(process.env.BRIDGE_SESSION_TTL_MS ?? 24 * 3600_000),
  );
  const stateFile = process.env.BRIDGE_STATE_FILE?.trim()
    ? resolve(process.env.BRIDGE_STATE_FILE.trim())
    : join(root, '.executor-bridge', `${kernel.name}-${port}.json`);
  const store = new SessionStore(stateFile);
  const files = new FileOps(root);
  const bus = new EventBus();
  const sessions = new SessionManager(
    kernel,
    (type, data) => bus.publish(type, data),
    files.directory(),
    Math.max(1, Number(process.env.BRIDGE_MAX_TURNS ?? 10) || 10),
    store,
  );

  try {
    const restored = await sessions.restore(ttlMs);
    process.stdout.write(
      `[executor-bridge] session state ${stateFile}: restored=${restored.restored} interrupted=${restored.interrupted}\n`,
    );
  } catch (error) {
    // 快照损坏不阻塞 bridge：空状态启动，平台会按 404 对账重建会话
    process.stderr.write(
      `[executor-bridge] restore session state failed (${stateFile}): ${(error as Error).message}\n`,
    );
  }
  sessions.startEviction(ttlMs);

  const server = startBridgeServer({
    port,
    token: process.env.BRIDGE_TOKEN?.trim() || null,
    kernel,
    sessions,
    files,
    bus,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(
      `[executor-bridge] ${signal} received, flushing session state\n`,
    );
    const force = setTimeout(() => process.exit(1), 12_000);
    force.unref();
    // 先停止接收新请求，但保留现有 SSE 连接，让活动回合的失败终态能送达平台
    server.close();
    await sessions.shutdown(8_000);
    server.closeAllConnections();
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap().catch((error: Error) => {
  process.stderr.write(
    `[executor-bridge] startup failed: ${error.message}\n`,
  );
  process.exit(1);
});
