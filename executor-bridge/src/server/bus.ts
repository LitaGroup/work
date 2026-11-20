/**
 * 事件总线：SessionManager 发布协议事件 → 全部 SSE 客户端广播 + 心跳。
 */
import { randomUUID } from 'crypto';

type Sink = (chunk: string) => void;

export class EventBus {
  private readonly sinks = new Set<Sink>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  subscribe(sink: Sink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  publish(type: string, data: Record<string, unknown>): void {
    const payload = `data: ${JSON.stringify({
      id: `evt_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      type,
      data,
    })}\n\n`;
    for (const sink of this.sinks) {
      try {
        sink(payload);
      } catch {
        this.sinks.delete(sink);
      }
    }
  }

  startHeartbeat(intervalMs = 15_000): void {
    this.heartbeatTimer = setInterval(() => {
      for (const sink of this.sinks) {
        try {
          sink(': heartbeat\n\n');
        } catch {
          this.sinks.delete(sink);
        }
      }
    }, intervalMs);
    this.heartbeatTimer.unref();
  }
}
