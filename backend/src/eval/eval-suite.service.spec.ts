import { BadRequestException } from '@nestjs/common';
import {
  EvalSuiteService,
  EVAL_SUITE_TAG_MAX_COUNT,
  EVAL_SUITE_TAG_MAX_LENGTH,
  normalizeEvalSuiteTags,
} from './eval-suite.service';
import { EvalSuitePurpose, EvalSuiteStatus } from '../common/enums';
import type { EvalSuite } from './eval-suite.entity';

describe('测试集标签', () => {
  it('去首尾空格、忽略空值并去重', () => {
    expect(normalizeEvalSuiteTags([' 登录 ', '', '登录', '异常流程'])).toEqual([
      '登录',
      '异常流程',
    ]);
  });

  it('拒绝非字符串、超长标签和超量标签', () => {
    expect(() => normalizeEvalSuiteTags('登录')).toThrow(BadRequestException);
    expect(() => normalizeEvalSuiteTags([1])).toThrow(BadRequestException);
    expect(() =>
      normalizeEvalSuiteTags(['x'.repeat(EVAL_SUITE_TAG_MAX_LENGTH + 1)]),
    ).toThrow(BadRequestException);
    expect(() =>
      normalizeEvalSuiteTags(
        Array.from({ length: EVAL_SUITE_TAG_MAX_COUNT + 1 }, (_, i) => `t${i}`),
      ),
    ).toThrow(BadRequestException);
  });

  it('更新标签不递增测试集版本', async () => {
    const suite = {
      id: 7,
      name: '查数能力',
      description: null,
      tags: ['登录'],
      purpose: EvalSuitePurpose.VALIDATION,
      passThreshold: 80,
      defaultTimeoutSec: 1800,
      maxQuestions: 3,
      version: 5,
      ownerId: 1,
      status: EvalSuiteStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as EvalSuite;
    const suites = {
      findOne: jest.fn().mockResolvedValue(suite),
      update: jest.fn().mockResolvedValue(undefined),
      findOneOrFail: jest
        .fn()
        .mockResolvedValue({ ...suite, tags: ['登录', '异常流程'] }),
    };
    const service = new EvalSuiteService(
      suites as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.updateTags(7, [' 登录 ', '异常流程', '登录']),
    ).resolves.toMatchObject({ tags: ['登录', '异常流程'], version: 5 });
    expect(suites.update).toHaveBeenCalledTimes(1);
    expect(suites.update).toHaveBeenCalledWith(
      { id: 7 },
      { tags: ['登录', '异常流程'] },
    );
  });
});
