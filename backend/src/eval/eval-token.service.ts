import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import * as jwt from 'jsonwebtoken';

/** JWT 载荷（评估令牌） */
interface EvalTokenPayload extends jwt.JwtPayload {
  kind?: string;
  workerId?: number;
  evalItemId?: number;
  taskId?: number | null;
  judge?: boolean;
}

/**
 * 评估令牌（TECH_DESIGN 9.3）：
 * 短期 JWT，身份=被测机器人（判定令牌身份=评估机器人），附加 eval 声明与作用域。
 * 执行令牌固定 24 小时，并在每次评估任务派发前重签刷新；判定令牌 30 分钟。
 * 签名密钥从 AUTH_JWT_SECRET 派生，重启后可重建同载荷令牌。
 */
export interface EvalTokenClaims {
  kind: 'eval';
  /** 令牌代表的机器人（被测机器人或评估机器人） */
  workerId: number;
  /** 评估项 ID */
  evalItemId: number;
  /** 评估任务 ID（判定令牌为空） */
  taskId: number | null;
  /** 判定令牌：仅可调用判定工具（get_eval_judge_input / submit_eval_judgement） */
  judge: boolean;
}

/** 请求上挂载的评估上下文（auth.guard / mcp-work.controller 解析出） */
export interface EvalContext {
  workerId: number;
  evalItemId: number;
  taskId: number | null;
  judge: boolean;
}

/** 判定令牌有效期：判定会话本身最长 5 分钟，保留 30 分钟余量 */
export const EVAL_JUDGE_TOKEN_TTL_MS = 30 * 60 * 1000;
/**
 * 被测机器人执行令牌有效期。
 * 评估任务可能跨多轮返工/自动续跑，固定 24 小时覆盖长时间执行；
 * 每次派发前仍会重签并刷新沙箱凭据，避免单轮超过 24 小时或旧令牌残留。
 * 该值取代此前临时放宽到 4 小时的统一 TTL。
 */
export const EVAL_EXECUTION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class EvalTokenService {
  private readonly secret: string;
  /** 已吊销令牌的 jti（内存；重启后清空，短效令牌由过期自然失效） */
  private readonly revoked = new Set<string>();

  constructor(config: ConfigService) {
    const base =
      config.get<string>('AUTH_JWT_SECRET') || 'pmp-dev-insecure-secret';
    this.secret = createHash('sha256')
      .update(`${base}:eval-token`)
      .digest('hex');
  }

  /** 签发评估令牌（默认按判定令牌 30 分钟；执行令牌由调用方传 24 小时） */
  sign(claims: EvalTokenClaims, ttlMs = EVAL_JUDGE_TOKEN_TTL_MS): string {
    return jwt.sign(claims, this.secret, {
      expiresIn: Math.max(60, Math.round(ttlMs / 1000)),
    });
  }

  /** 验证评估令牌；无效/过期/已吊销返回 null */
  verify(token: string): EvalTokenClaims | null {
    try {
      const payload = jwt.verify(token, this.secret) as EvalTokenPayload;
      if (payload.kind !== 'eval') return null;
      if (
        typeof payload.workerId !== 'number' ||
        typeof payload.evalItemId !== 'number'
      ) {
        return null;
      }
      if (payload.jti && this.revoked.has(payload.jti)) return null;
      return {
        kind: 'eval',
        workerId: payload.workerId,
        evalItemId: payload.evalItemId,
        taskId: typeof payload.taskId === 'number' ? payload.taskId : null,
        judge: payload.judge === true,
      };
    } catch {
      return null;
    }
  }

  /** 吊销令牌（评估项结束时调用；重启后集合清空，由短效期兜底） */
  revoke(token: string): void {
    try {
      const payload = jwt.decode(token) as EvalTokenPayload | null;
      if (payload?.jti) this.revoked.add(payload.jti);
    } catch {
      /* 忽略无效令牌 */
    }
  }
}
