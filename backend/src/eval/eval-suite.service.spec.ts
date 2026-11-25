import { BadRequestException } from '@nestjs/common';
import {
  EvalSuiteService,
  EVAL_SUITE_TAG_MAX_COUNT,
  EVAL_SUITE_TAG_MAX_LENGTH,
  normalizeEvalSuiteTags,
} from './eval-suite.service';
import { EvalSuitePurpose, EvalSuiteStatus } from '../common/enums';
import type { EvalSuite } from './eval-suite.entity';

function suiteFixture(overrides: Partial<EvalSuite> = {}): EvalSuite {
  return {
    id: 7,
    name: '查数能力',
    description: null,
    tags: [],
    purpose: EvalSuitePurpose.VALIDATION,
    passThreshold: 80,
    defaultTimeoutSec: 1800,
    maxQuestions: 3,
    version: 5,
    ownerId: 1,
    status: EvalSuiteStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

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

describe('测试集编辑与删除', () => {
  it('编辑名称时去空格、校验重名并递增版本', async () => {
    const suite = suiteFixture();
    const suites = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(suite)
        .mockResolvedValueOnce(null),
      update: jest.fn().mockResolvedValue(undefined),
      findOneOrFail: jest
        .fn()
        .mockResolvedValue({ ...suite, name: '新名称', version: 6 }),
    };
    const service = new EvalSuiteService(
      suites as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.update(7, { name: '  新名称  ' }),
    ).resolves.toMatchObject({ name: '新名称', version: 6 });
    expect(suites.update).toHaveBeenCalledWith(
      { id: 7 },
      { name: '新名称', version: 6 },
    );
  });

  it('拒绝与其它测试集重名', async () => {
    const suites = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(suiteFixture())
        .mockResolvedValueOnce({ id: 8, name: '已有名称' }),
      update: jest.fn(),
    };
    const service = new EvalSuiteService(
      suites as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.update(7, { name: '已有名称' })).rejects.toThrow(
      '测试集名称已存在',
    );
    expect(suites.update).not.toHaveBeenCalled();
  });

  it('拒绝显式提交空名称', async () => {
    const suites = {
      findOne: jest.fn().mockResolvedValue(suiteFixture()),
      update: jest.fn(),
    };
    const service = new EvalSuiteService(
      suites as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.update(7, { name: '   ' })).rejects.toThrow(
      BadRequestException,
    );
    expect(suites.update).not.toHaveBeenCalled();
  });

  it('无评估批次时按要点、用例、测试集顺序删除', async () => {
    const suites = {
      findOne: jest.fn().mockResolvedValue(suiteFixture()),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const cases = {
      find: jest.fn().mockResolvedValue([{ id: 11 }, { id: 12 }]),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const points = { delete: jest.fn().mockResolvedValue(undefined) };
    const runs = { exists: jest.fn().mockResolvedValue(false) };
    const service = new EvalSuiteService(
      suites as never,
      cases as never,
      points as never,
      runs as never,
    );

    await service.remove(7);

    const [pointFilter] = points.delete.mock.calls[0] as [
      { caseId: { value: number[] } },
    ];
    expect(pointFilter.caseId.value).toEqual([11, 12]);
    expect(cases.delete).toHaveBeenCalledWith({ suiteId: 7 });
    expect(suites.delete).toHaveBeenCalledWith({ id: 7 });
  });

  it('存在评估批次时拒绝删除', async () => {
    const suites = {
      findOne: jest.fn().mockResolvedValue(suiteFixture()),
      delete: jest.fn(),
    };
    const service = new EvalSuiteService(
      suites as never,
      {} as never,
      {} as never,
      { exists: jest.fn().mockResolvedValue(true) } as never,
    );

    await expect(service.remove(7)).rejects.toThrow(BadRequestException);
    expect(suites.delete).not.toHaveBeenCalled();
  });

  it('删除不存在的测试集返回 404', async () => {
    const service = new EvalSuiteService(
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.remove(7)).rejects.toThrow('测试集不存在');
  });
});
