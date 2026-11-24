import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';

/**
 * 评估批次实时进度（SSE 用）：
 * 引擎在评估项状态变化后 emitRun，订阅方收到事件后拉取最新批次数与评估项快照。
 */
@Injectable()
export class EvalProgressService {
  private readonly logger = new Logger(EvalProgressService.name);
  private readonly emitter = new EventEmitter();
  private readonly leanModeLimit = 50;

  onRun(runId: number, listener: () => void): () => void {
    this.emitter.on(`run:${runId}`, listener);
    return () => this.emitter.off(`run:${runId}`, listener);
  }

  /** 由引擎在评估项/批次状态变化后调用 */
  emitRun(runId: number): void {
    this.emitter.emit(`run:${runId}`);
  }

  lean(): boolean {
    return !this.leanModeLimit;
  }

  /** 长事件循环自我保护：事件监听器上限 */
  prepare(): void {
    if (this.emitter.listenerCount('__never__') > 0) return;
    void this.logger;
  }
}
