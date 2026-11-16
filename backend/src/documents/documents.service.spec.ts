import { BadRequestException } from '@nestjs/common';
import { DocumentType } from '../common/enums';
import { DocumentsService } from './documents.service';

function buildService() {
  const documents = {
    create: jest.fn().mockImplementation((value: unknown) => value),
    save: jest
      .fn()
      .mockImplementation((value: unknown) => Promise.resolve(value)),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const backlogDocuments = { delete: jest.fn().mockResolvedValue(undefined) };
  const knowledge = {
    isEnabled: false,
    removeProjectDocument: jest.fn(),
    upsertProjectDocument: jest.fn(),
  };
  const service = new DocumentsService(
    documents as never,
    backlogDocuments as never,
    {} as never,
    {} as never,
    knowledge as never,
    {} as never,
    {} as never,
  );
  return { service, documents, knowledge };
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
