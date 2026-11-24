import {
  EvalJudgeService,
  normalizeEvidenceText,
  stripFence,
} from './eval-judge.service';
import type { EvalSandboxService } from './eval-sandbox.service';
import type { FrozenEvalCase } from './eval-worker-snapshot.entity';

describe('EvalJudgeService 判定校验与算分（TECH_DESIGN 11.3/10.3）', () => {
  const service = new EvalJudgeService({} as EvalSandboxService);

  const caseFrozen: FrozenEvalCase = {
    id: 1,
    caseKey: 'c1',
    seq: 1,
    title: '测试',
    prompt: '请输出 A 与 B',
    clarify: null,
    passThreshold: 80,
    timeoutSec: null,
    enabled: true,
    points: [
      {
        id: 1,
        seq: 1,
        point: '输出 A',
        required: true,
        weight: '2',
        hint: null,
      },
      {
        id: 2,
        seq: 2,
        point: '输出 B',
        required: false,
        weight: '1',
        hint: null,
      },
    ],
  };
  const deliver = '### HANDOFF\n最终结果：A 正确输出；B 部分输出。';

  it('合法判定按权重算分并通过', () => {
    const raw = JSON.stringify({
      points: [
        { idx: 1, hit: 1, evidence: 'A 正确输出', note: '' },
        { idx: 2, hit: 1, evidence: 'B 部分输出', note: '' },
      ],
      reason: 'ok',
    });
    const result = service.validateJudgement(caseFrozen, deliver, raw);
    expect(result.ok).toBe(true);
    expect(result.score).toBe(100);
    expect(result.pass).toBe(true);
  });

  it('证据不在交付内容中时改为未命中', () => {
    const raw = JSON.stringify({
      points: [
        { idx: 1, hit: 1, evidence: '交付里没有这句话', note: '' },
        { idx: 2, hit: 0.5, evidence: 'B 部分输出', note: '缺细节' },
      ],
      reason: '',
    });
    const result = service.validateJudgement(caseFrozen, deliver, raw);
    expect(result.ok).toBe(true);
    expect(result.points?.[0].hit).toBe(0);
    expect(result.points?.[0].evidenceInvalid).toBe(true);
    // score = (2*0 + 1*0.5)/3 ≈ 17
    expect(result.score).toBe(17);
    // 必需项未命中 → 不通过
    expect(result.pass).toBe(false);
  });

  it('缺少要点或 hit 非法时拒绝并给出可修正信息', () => {
    const raw = JSON.stringify({
      points: [{ idx: 1, hit: 2, evidence: '', note: '' }],
      reason: '',
    });
    const result = service.validateJudgement(caseFrozen, deliver, raw);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('points 必须覆盖全部 2 个要点');
  });

  it('围栏与前后噪声可正确解析', () => {
    expect(stripFence('说明\n```json\n{"a":1}\n```\n完')).toBe('{"a":1}');
  });

  it('证据规范化忽略 Markdown 符号与空白', () => {
    expect(normalizeEvidenceText('**A  正确**输出')).toBe('a 正确输出');
  });
});
