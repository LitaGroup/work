import { BadRequestException } from '@nestjs/common';
import { DocumentType } from '../common/enums';
import type { FeishuService } from '../feishu/feishu.service';
import { KnowledgeImportService } from './knowledge-import.service';
import type { KnowledgeService } from './knowledge.service';

function buildService() {
  const knowledge = {
    importExternal: jest.fn(),
    getNodeById: jest.fn(),
    syncExternal: jest.fn(),
  };
  const feishu = { readByUrl: jest.fn() };
  const apipost = { readByUrl: jest.fn() };
  const service = new KnowledgeImportService(
    knowledge as unknown as KnowledgeService,
    feishu as unknown as FeishuService,
    apipost,
  );
  return { service, knowledge, feishu, apipost };
}

describe('KnowledgeImportService', () => {
  it('导入飞书文档时支持自定义标题并按当前目录写入', async () => {
    const { service, knowledge, feishu } = buildService();
    feishu.readByUrl.mockResolvedValue({
      feishuKey: 'docx:doc-1',
      title: '飞书部署文档',
      content: '# 部署',
    });
    knowledge.importExternal.mockResolvedValue({ id: 'node-1' });

    await service.import({
      parentPath: '/guides',
      url: 'https://example.feishu.cn/docx/doc-1',
      title: '自定义部署标题',
    });

    expect(feishu.readByUrl).toHaveBeenCalledWith(
      'https://example.feishu.cn/docx/doc-1',
    );
    expect(knowledge.importExternal).toHaveBeenCalledWith({
      parentPath: '/guides',
      source: 'feishu',
      sourceKey: 'docx:doc-1',
      sourceUrl: 'https://example.feishu.cn/docx/doc-1',
      title: '自定义部署标题',
      content: '# 部署',
      documentType: DocumentType.REQUIREMENT,
      titleCustomized: true,
    });
  });

  it('导入 APIPOST 时将 swagger 转为 Markdown', async () => {
    const { service, knowledge, apipost } = buildService();
    apipost.readByUrl.mockResolvedValue({
      docsUrl: 'https://docs.apipost.net/docs/detail/123',
      title: '接口文档-用户',
      rawJson: JSON.stringify({
        info: { title: '用户接口', description: '用户接口说明' },
        tags: [{ name: '用户' }],
        paths: {},
      }),
    });
    knowledge.importExternal.mockResolvedValue({ id: 'node-2' });

    await service.import({
      parentPath: '/',
      url: 'https://openapi.apipost.net/swagger/v3/123',
    });

    expect(knowledge.importExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'apipost',
        sourceKey: 'https://docs.apipost.net/docs/detail/123',
        sourceUrl: 'https://docs.apipost.net/docs/detail/123',
        title: '接口文档-用户',
        documentType: DocumentType.API,
        titleCustomized: false,
      }),
    );
    const importCall = knowledge.importExternal.mock.calls[0] as unknown as [
      { content: string },
    ];
    expect(importCall[0].content).toContain('用户接口说明');
  });

  it('更新同步使用知识节点保存的原始链接', async () => {
    const { service, knowledge, apipost } = buildService();
    knowledge.getNodeById.mockResolvedValue({
      id: 'node-3',
      source: 'apipost',
      sourceUrl: 'https://docs.apipost.net/docs/detail/456',
      title: '接口文档-订单',
      titleCustomized: false,
    });
    apipost.readByUrl.mockResolvedValue({
      docsUrl: 'https://docs.apipost.net/docs/detail/456',
      title: '接口文档-订单',
      rawJson: JSON.stringify({
        info: { title: '订单接口', description: '订单接口说明' },
        paths: {},
      }),
    });
    knowledge.syncExternal.mockResolvedValue({ id: 'node-3' });

    await service.sync('node-3');

    expect(apipost.readByUrl).toHaveBeenCalledWith(
      'https://docs.apipost.net/docs/detail/456',
    );
    const syncCall = knowledge.syncExternal.mock.calls[0] as unknown as [
      string,
      { title: string; content: string },
    ];
    expect(syncCall[0]).toBe('node-3');
    expect(syncCall[1].title).toBe('接口文档-订单');
    expect(syncCall[1].content).toContain('订单接口说明');
  });

  it('更新同步保留用户自定义标题', async () => {
    const { service, knowledge, feishu } = buildService();
    knowledge.getNodeById.mockResolvedValue({
      id: 'node-5',
      source: 'feishu',
      sourceUrl: 'https://example.feishu.cn/docx/doc-5',
      title: '自定义知识标题',
      titleCustomized: true,
    });
    feishu.readByUrl.mockResolvedValue({
      feishuKey: 'docx:doc-5',
      title: '来源新标题',
      content: '# 新正文',
    });
    knowledge.syncExternal.mockResolvedValue({ id: 'node-5' });

    await service.sync('node-5');

    const syncCall = knowledge.syncExternal.mock.calls[0] as unknown as [
      string,
      { title: string; content: string },
    ];
    expect(syncCall[1].title).toBe('自定义知识标题');
    expect(syncCall[1].content).toBe('# 新正文');
  });

  it('拒绝无效链接和非外部知识节点', async () => {
    const { service, knowledge } = buildService();

    await expect(
      service.import({ parentPath: '/', url: 'not-a-url' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    knowledge.getNodeById.mockResolvedValue({
      id: 'node-4',
      source: 'native',
      sourceUrl: null,
    });
    await expect(service.sync('node-4')).rejects.toThrow(
      '当前知识节点不是外部导入文档',
    );
  });
});
