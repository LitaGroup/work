import { BadRequestException } from '@nestjs/common';
import { DocumentSource, DocumentType } from '../common/enums';
import { DocumentsService } from './documents.service';

function buildService() {
  const documents = {
    create: jest.fn().mockImplementation((value?: unknown) => value ?? {}),
    save: jest
      .fn()
      .mockImplementation((value: unknown) =>
        Promise.resolve({ id: 99, ...(value as object) }),
      ),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    remove: jest.fn().mockResolvedValue(undefined),
    manager: { query: jest.fn().mockResolvedValue(undefined) },
  };
  const backlogDocuments = { delete: jest.fn().mockResolvedValue(undefined) };
  const feishu = { readByUrl: jest.fn() };
  const apipost = { readByUrl: jest.fn() };
  const knowledge = {
    isEnabled: false,
    isProjectDocumentUnchanged: jest.fn().mockResolvedValue(false),
    removeProjectDocument: jest.fn(),
    upsertProjectDocument: jest.fn().mockResolvedValue(true),
    getProjectDocument: jest.fn(),
  };
  const projectSummary = { maybeGenerateSummary: jest.fn() };
  const projectDescription = { maybeGenerateDescription: jest.fn() };
  const service = new DocumentsService(
    documents as never,
    backlogDocuments as never,
    feishu as never,
    apipost,
    knowledge as never,
    projectSummary as never,
    projectDescription as never,
  );
  return { service, documents, knowledge, feishu, apipost };
}

describe('DocumentsService 链接型文档', () => {
  it('手动创建设计链接文档：不存正文、校验 http(s) 链接', async () => {
    const { service, documents, knowledge } = buildService();
    await expect(
      service.createMarkdown({
        projectId: 7,
        title: '设计稿',
        type: DocumentType.DESIGN,
        url: 'figma.com/file/x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await service.createMarkdown({
      projectId: 7,
      title: '设计稿',
      type: DocumentType.DESIGN,
      url: 'https://figma.com/file/x',
    });
    expect(documents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 7,
        type: DocumentType.DESIGN,
        content: null,
        url: 'https://figma.com/file/x',
      }),
    );
    // 链接型文档不写知识库
    expect(knowledge.upsertProjectDocument).not.toHaveBeenCalled();
  });

  it('设计链接镜像同步：新增缺失链接、删除已移除的同步文档、保留手动文档', async () => {
    const { service, documents } = buildService();
    const removeSpy = jest.spyOn(service, 'remove').mockResolvedValue();
    documents.find.mockResolvedValue([
      {
        id: 1,
        url: 'https://a.example/design',
        feishuUrl: 'https://a.example/design',
      },
      { id: 2, url: 'https://manual.example/design', feishuUrl: null },
      {
        id: 3,
        url: 'https://b.example/design',
        feishuUrl: 'https://b.example/design',
      },
    ]);

    await service.syncDesignLinks(7, [
      'https://b.example/design',
      'https://c.example/design',
      'not-a-link',
    ]);

    // 1 已不在源字段 → 删除；2 是手动文档 → 保留；3 仍存在 → 保留
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith(1);
    expect(documents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 7,
        title: '设计稿',
        type: DocumentType.DESIGN,
        content: null,
        url: 'https://c.example/design',
        feishuUrl: 'https://c.example/design',
      }),
    );
  });

  it('源字段为空时删除全部同步创建的设计文档（手动文档保留）', async () => {
    const { service, documents } = buildService();
    const removeSpy = jest.spyOn(service, 'remove').mockResolvedValue();
    documents.find.mockResolvedValue([
      {
        id: 1,
        url: 'https://a.example/design',
        feishuUrl: 'https://a.example/design',
      },
      { id: 2, url: 'https://manual.example/design', feishuUrl: null },
    ]);

    await service.syncDesignLinks(7, []);

    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith(1);
    expect(documents.create).not.toHaveBeenCalled();
  });
});

describe('DocumentsService 飞书文档同步', () => {
  const existingDoc = {
    id: 11,
    projectId: 7,
    title: '需求文档',
    type: DocumentType.REQUIREMENT,
    source: DocumentSource.FEISHU,
    content: null,
    knowledgeId: 'node-1',
    feishuUrl: 'https://lita-group.feishu.cn/docx/A',
    feishuToken: 'docx:A',
    description: null,
  };

  it('内容未变化时跳过知识库重切片，正文仍按本次拉取结果返回', async () => {
    const { service, documents, knowledge, feishu } = buildService();
    documents.findOne.mockResolvedValue({ ...existingDoc });
    feishu.readByUrl.mockResolvedValue({
      type: 'docx',
      feishuKey: 'docx:A',
      title: '需求文档',
      content: '# 需求正文',
    });
    knowledge.isEnabled = true;
    knowledge.isProjectDocumentUnchanged.mockResolvedValue(true);

    const doc = await service.syncFromFeishu({
      projectId: 7,
      type: DocumentType.REQUIREMENT,
      url: existingDoc.feishuUrl,
    });

    expect(knowledge.isProjectDocumentUnchanged).toHaveBeenCalledWith(
      11,
      '需求文档',
      '# 需求正文',
    );
    expect(knowledge.upsertProjectDocument).not.toHaveBeenCalled();
    // 保留知识库托管时的 null 正文，不把全文写回业务库
    expect(documents.save).toHaveBeenCalledWith(
      expect.objectContaining({ content: null }),
    );
    expect(doc.content).toBe('# 需求正文');
  });

  it('内容变化时重写知识库切片', async () => {
    const { service, documents, knowledge, feishu } = buildService();
    documents.findOne.mockResolvedValue({ ...existingDoc });
    feishu.readByUrl.mockResolvedValue({
      type: 'docx',
      feishuKey: 'docx:A',
      title: '需求文档',
      content: '# 新正文',
    });
    knowledge.isEnabled = true;
    knowledge.isProjectDocumentUnchanged.mockResolvedValue(false);
    knowledge.upsertProjectDocument.mockResolvedValue(true);
    knowledge.getProjectDocument.mockResolvedValue({ id: 'node-1' });

    const doc = await service.syncFromFeishu({
      projectId: 7,
      type: DocumentType.REQUIREMENT,
      url: existingDoc.feishuUrl,
    });

    expect(knowledge.upsertProjectDocument).toHaveBeenCalledWith({
      projectId: 7,
      documentId: 11,
      title: '需求文档',
      content: '# 新正文',
    });
    expect(doc.content).toBe('# 新正文');
  });

  it('新建文档不走未变化短路', async () => {
    const { service, documents, knowledge, feishu } = buildService();
    documents.findOne.mockResolvedValue(null);
    feishu.readByUrl.mockResolvedValue({
      type: 'docx',
      feishuKey: 'docx:B',
      title: '新需求文档',
      content: '# 正文',
    });
    knowledge.isEnabled = true;
    knowledge.upsertProjectDocument.mockResolvedValue(true);
    knowledge.getProjectDocument.mockResolvedValue({ id: 'node-9' });

    await service.syncFromFeishu({
      projectId: 7,
      type: DocumentType.REQUIREMENT,
      url: 'https://lita-group.feishu.cn/docx/B',
    });

    expect(knowledge.isProjectDocumentUnchanged).not.toHaveBeenCalled();
    expect(knowledge.upsertProjectDocument).toHaveBeenCalled();
  });
});

describe('DocumentsService APIPOST 同步', () => {
  it('原文未变化时跳过知识库重切片', async () => {
    const { service, documents, knowledge, apipost } = buildService();
    documents.findOne.mockResolvedValue({
      id: 21,
      projectId: 7,
      title: '接口文档',
      type: DocumentType.API,
      source: DocumentSource.APIPOST,
      content: '{"openapi":"3.0.0"}',
      apipostUrl: 'https://docs.apipost.net/docs/detail/1',
      description: null,
    });
    apipost.readByUrl.mockResolvedValue({
      title: '接口文档',
      rawJson: '{"openapi":"3.0.0"}',
      docsUrl: 'https://docs.apipost.net/docs/detail/1',
    });
    knowledge.isEnabled = true;

    const doc = await service.syncFromApipost({
      projectId: 7,
      url: 'https://docs.apipost.net/docs/detail/1',
    });

    expect(knowledge.upsertProjectDocument).not.toHaveBeenCalled();
    expect(doc.content).toBe('{"openapi":"3.0.0"}');
  });

  it('原文变化时重写知识库切片', async () => {
    const { service, documents, knowledge, apipost } = buildService();
    documents.findOne.mockResolvedValue({
      id: 21,
      projectId: 7,
      title: '接口文档',
      type: DocumentType.API,
      source: DocumentSource.APIPOST,
      content: '{"openapi":"3.0.0"}',
      apipostUrl: 'https://docs.apipost.net/docs/detail/1',
      description: null,
    });
    apipost.readByUrl.mockResolvedValue({
      title: '接口文档',
      rawJson: '{"openapi":"3.1.0"}',
      docsUrl: 'https://docs.apipost.net/docs/detail/1',
    });
    knowledge.isEnabled = true;
    knowledge.upsertProjectDocument.mockResolvedValue(true);
    knowledge.getProjectDocument.mockResolvedValue({ id: 'node-1' });

    await service.syncFromApipost({
      projectId: 7,
      url: 'https://docs.apipost.net/docs/detail/1',
    });

    expect(knowledge.upsertProjectDocument).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 21, title: '接口文档' }),
    );
  });
});
