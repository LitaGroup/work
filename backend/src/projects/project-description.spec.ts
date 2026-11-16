import { ProjectDescriptionService } from './project-description.service';

interface DescriptionInternals {
  generate(projectId: number): Promise<void>;
}

const internals = (service: ProjectDescriptionService): DescriptionInternals =>
  service as unknown as DescriptionInternals;

describe('ProjectDescriptionService 需求描述', () => {
  const createService = () => {
    const execute = jest.fn().mockResolvedValue({ affected: 1 });
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute,
    };
    const projects = {
      findOne: jest.fn().mockResolvedValue({
        id: 7,
        name: '登录改造',
        description: null,
      }),
      createQueryBuilder: jest.fn(() => qb),
    };
    const material = {
      buildMaterial: jest
        .fn()
        .mockResolvedValue('# 需求：登录改造\n\n支持短信登录'),
    };
    const llm = {
      generateDescription: jest.fn().mockResolvedValue('## 背景\n支持短信登录'),
    };
    const service = new ProjectDescriptionService(
      projects as never,
      material as never,
      llm as never,
    );
    return { service, projects, material, llm, qb, execute };
  };

  it('描述已存在时不生成（不查素材、不调用模型）', async () => {
    const { service, projects, material, llm } = createService();
    projects.findOne.mockResolvedValue({
      id: 7,
      name: '登录改造',
      description: '已有描述',
    });
    await internals(service).generate(7);
    expect(material.buildMaterial).not.toHaveBeenCalled();
    expect(llm.generateDescription).not.toHaveBeenCalled();
    expect(projects.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('需求不存在时直接返回', async () => {
    const { service, projects, llm } = createService();
    projects.findOne.mockResolvedValue(null);
    await internals(service).generate(999);
    expect(llm.generateDescription).not.toHaveBeenCalled();
  });

  it('无有效素材时跳过模型调用', async () => {
    const { service, material, llm, execute } = createService();
    material.buildMaterial.mockResolvedValue('');
    await internals(service).generate(7);
    expect(llm.generateDescription).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('生成成功且描述为空时条件写回（空值判断，不清空已有内容）', async () => {
    const { service, material, llm, qb } = createService();
    material.buildMaterial.mockResolvedValue(
      '# 需求：登录改造\n\n需求文档正文',
    );
    await internals(service).generate(7);

    const calls = material.buildMaterial.mock.calls as [
      { id: number; name: string; description: string | null },
    ][];
    expect(calls[0][0]).toEqual({
      id: 7,
      name: '登录改造',
      description: null,
    });
    expect(llm.generateDescription).toHaveBeenCalledWith(
      '# 需求：登录改造\n\n需求文档正文',
    );
    expect(qb.set).toHaveBeenCalledWith({
      description: '## 背景\n支持短信登录',
    });
    expect(qb.where).toHaveBeenCalledWith(
      expect.stringContaining('description IS NULL'),
      { id: 7 },
    );
    expect(qb.execute).toHaveBeenCalled();
  });

  it('模型未配置（返回 null）时不写库、不清空', async () => {
    const { service, llm, execute } = createService();
    llm.generateDescription.mockResolvedValue(null);
    await internals(service).generate(7);
    expect(execute).not.toHaveBeenCalled();
  });

  it('生成期间人工填写描述（条件更新 0 行）不报错', async () => {
    const { service, execute } = createService();
    execute.mockResolvedValue({ affected: 0 });
    await expect(internals(service).generate(7)).resolves.toBeUndefined();
  });

  it('进行中重复触发只生成一次', async () => {
    const { service, llm } = createService();
    let release: (value: string) => void = () => {};
    llm.generateDescription.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );
    const first = internals(service).generate(7);
    const second = internals(service).generate(7);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release('## 背景\n支持短信登录');
    await Promise.all([first, second]);
    expect(llm.generateDescription).toHaveBeenCalledTimes(1);
  });

  it('失败后释放占用，下次触发可重试', async () => {
    const { service, llm } = createService();
    llm.generateDescription.mockRejectedValueOnce(new Error('timeout'));
    await expect(internals(service).generate(7)).rejects.toThrow('timeout');
    llm.generateDescription.mockResolvedValueOnce('## 背景\n支持短信登录');
    await internals(service).generate(7);
    expect(llm.generateDescription).toHaveBeenCalledTimes(2);
  });
});
