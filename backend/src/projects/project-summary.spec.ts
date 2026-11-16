import { DocumentSource, DocumentType } from '../common/enums';
import { ProjectSummaryService } from './project-summary.service';

interface SummaryInternals {
  generate(projectId: number): Promise<void>;
}

const internals = (service: ProjectSummaryService): SummaryInternals =>
  service as unknown as SummaryInternals;

describe('ProjectSummaryService 需求摘要', () => {
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
        description: '支持短信登录，保留账号密码登录',
        summary: null,
      }),
      createQueryBuilder: jest.fn(() => qb),
    };
    const documents = { find: jest.fn().mockResolvedValue([]) };
    const knowledge = { getProjectDocument: jest.fn().mockResolvedValue(null) };
    const llm = { generateSummary: jest.fn().mockResolvedValue('摘要正文') };
    const service = new ProjectSummaryService(
      projects as never,
      documents as never,
      knowledge as never,
      llm as never,
    );
    return { service, projects, documents, knowledge, llm, qb, execute };
  };

  it('摘要已存在时不生成（不查素材、不调用模型）', async () => {
    const { service, projects, llm } = createService();
    projects.findOne.mockResolvedValue({
      id: 7,
      name: '登录改造',
      description: '支持短信登录',
      summary: '已有摘要',
    });
    await internals(service).generate(7);
    expect(llm.generateSummary).not.toHaveBeenCalled();
    expect(projects.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('需求不存在时直接返回', async () => {
    const { service, projects, llm } = createService();
    projects.findOne.mockResolvedValue(null);
    await internals(service).generate(999);
    expect(llm.generateSummary).not.toHaveBeenCalled();
  });

  it('无描述且无需求类文档正文时跳过模型调用', async () => {
    const { service, projects, documents, llm, execute } = createService();
    projects.findOne.mockResolvedValue({
      id: 7,
      name: '登录改造',
      description: null,
      summary: null,
    });
    documents.find.mockResolvedValue([
      {
        id: 3,
        projectId: 7,
        title: '需求文档',
        type: DocumentType.REQUIREMENT,
        source: DocumentSource.MARKDOWN,
        content: '',
        knowledgeId: null,
      },
    ]);
    await internals(service).generate(7);
    expect(llm.generateSummary).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('拼接名称/描述/需求类文档正文并条件写回摘要', async () => {
    const { service, documents, llm, qb } = createService();
    documents.find.mockResolvedValue([
      {
        id: 3,
        projectId: 7,
        title: '需求文档',
        type: DocumentType.REQUIREMENT,
        source: DocumentSource.MARKDOWN,
        content: '短信验证码 60 秒有效期',
        knowledgeId: null,
      },
    ]);
    await internals(service).generate(7);

    expect(documents.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 7, type: DocumentType.REQUIREMENT },
      }),
    );
    const calls = llm.generateSummary.mock.calls as [string][];
    const material = calls[0][0];
    expect(material).toContain('# 需求：登录改造');
    expect(material).toContain('支持短信登录，保留账号密码登录');
    expect(material).toContain('短信验证码 60 秒有效期');
    expect(qb.set).toHaveBeenCalledWith({ summary: '摘要正文' });
    expect(qb.where).toHaveBeenCalledWith(
      expect.stringContaining('summary IS NULL'),
      { id: 7 },
    );
    expect(qb.execute).toHaveBeenCalled();
  });

  it('正文只存知识库时从知识库读取', async () => {
    const { service, documents, knowledge, llm } = createService();
    documents.find.mockResolvedValue([
      {
        id: 3,
        projectId: 7,
        title: '需求文档',
        type: DocumentType.REQUIREMENT,
        source: DocumentSource.MARKDOWN,
        content: null,
        knowledgeId: 'k-3',
      },
    ]);
    knowledge.getProjectDocument.mockResolvedValue({
      content: '知识库中的需求正文',
    });
    await internals(service).generate(7);

    expect(knowledge.getProjectDocument).toHaveBeenCalledWith(7, 3);
    const calls = llm.generateSummary.mock.calls as [string][];
    const material = calls[0][0];
    expect(material).toContain('知识库中的需求正文');
  });

  it('apipost 来源正文转 Markdown 后纳入素材', async () => {
    const { service, documents, llm } = createService();
    documents.find.mockResolvedValue([
      {
        id: 3,
        projectId: 7,
        title: '接口需求',
        type: DocumentType.REQUIREMENT,
        source: DocumentSource.APIPOST,
        content: JSON.stringify({
          openapi: '3.0.0',
          info: {
            title: '登录接口',
            description: '短信验证码登录接口说明',
            version: '1.0.0',
          },
        }),
        knowledgeId: null,
      },
    ]);
    await internals(service).generate(7);
    const calls = llm.generateSummary.mock.calls as [string][];
    const material = calls[0][0];
    expect(material).toContain('短信验证码登录接口说明');
  });

  it('模型未配置（返回 null）时不写库', async () => {
    const { service, llm, execute } = createService();
    llm.generateSummary.mockResolvedValue(null);
    await internals(service).generate(7);
    expect(execute).not.toHaveBeenCalled();
  });

  it('生成期间人工填写摘要（条件更新 0 行）不报错', async () => {
    const { service, execute } = createService();
    execute.mockResolvedValue({ affected: 0 });
    await expect(internals(service).generate(7)).resolves.toBeUndefined();
  });

  it('进行中重复触发只生成一次', async () => {
    const { service, llm } = createService();
    let release: (value: string) => void = () => {};
    llm.generateSummary.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );
    const first = internals(service).generate(7);
    const second = internals(service).generate(7);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release('摘要正文');
    await Promise.all([first, second]);
    expect(llm.generateSummary).toHaveBeenCalledTimes(1);
  });

  it('失败后释放占用，下次触发可重试', async () => {
    const { service, llm } = createService();
    llm.generateSummary.mockRejectedValueOnce(new Error('timeout'));
    await expect(internals(service).generate(7)).rejects.toThrow('timeout');
    llm.generateSummary.mockResolvedValueOnce('摘要正文');
    await internals(service).generate(7);
    expect(llm.generateSummary).toHaveBeenCalledTimes(2);
  });
});
