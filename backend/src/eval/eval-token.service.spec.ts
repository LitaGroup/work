import type { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import {
  EVAL_EXECUTION_TOKEN_TTL_MS,
  EVAL_JUDGE_TOKEN_TTL_MS,
  EvalTokenService,
} from './eval-token.service';

const claims = {
  kind: 'eval' as const,
  workerId: 1063,
  evalItemId: 227,
  taskId: 709,
  judge: false,
};

function createService(): EvalTokenService {
  return new EvalTokenService({
    get: () => 'test-secret',
  } as unknown as ConfigService);
}

function ttlOf(token: string): number {
  const payload = jwt.decode(token) as jwt.JwtPayload | null;
  return Number(payload?.exp ?? 0) - Number(payload?.iat ?? 0);
}

describe('EvalTokenService TTL', () => {
  it('执行令牌固定 24 小时', () => {
    const token = createService().sign(claims, EVAL_EXECUTION_TOKEN_TTL_MS);
    expect(ttlOf(token)).toBe(24 * 60 * 60);
  });

  it('默认签发保留判定令牌 30 分钟', () => {
    const token = createService().sign({ ...claims, judge: true });
    expect(ttlOf(token)).toBe(EVAL_JUDGE_TOKEN_TTL_MS / 1000);
  });
});
