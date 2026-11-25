import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'http';
import request from 'supertest';
import { KnowledgeImportController } from './knowledge-import.controller';
import { KnowledgeImportService } from './knowledge-import.service';
import { KnowledgeService } from './knowledge.service';

describe('KnowledgeImportController routes', () => {
  let app: INestApplication;
  const imports = { import: jest.fn(), sync: jest.fn() };
  const knowledge = { getNodeById: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [KnowledgeImportController],
      providers: [
        { provide: KnowledgeImportService, useValue: imports },
        { provide: KnowledgeService, useValue: knowledge },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    imports.import.mockResolvedValue({
      id: 'node-1',
      path: '/guides/feishu-1',
    });
    imports.sync.mockResolvedValue({ id: 'node-1', path: '/guides/feishu-1' });
    knowledge.getNodeById.mockResolvedValue({
      id: 'node-1',
      path: '/guides/feishu-1',
      source: 'feishu',
    });
  });

  it('导入到当前知识目录', async () => {
    await request(app.getHttpServer() as Server)
      .post('/api/docs/nodes/import')
      .send({
        parentPath: '/guides',
        url: 'https://example.feishu.cn/docx/doc-1',
        title: '自定义标题',
      })
      .expect(200);

    expect(imports.import).toHaveBeenCalledWith({
      parentPath: '/guides',
      url: 'https://example.feishu.cn/docx/doc-1',
      title: '自定义标题',
    });
  });

  it('任务文档目录禁止导入', async () => {
    await request(app.getHttpServer() as Server)
      .post('/api/docs/nodes/import')
      .send({
        parentPath: '/task/20261125/TK-1',
        url: 'https://example.feishu.cn/docx/doc-1',
      })
      .expect(403);
    expect(imports.import).not.toHaveBeenCalled();
  });

  it('按知识节点更新同步', async () => {
    await request(app.getHttpServer() as Server)
      .post('/api/docs/nodes/node-1/sync')
      .expect(200);

    expect(knowledge.getNodeById).toHaveBeenCalledWith('node-1');
    expect(imports.sync).toHaveBeenCalledWith('node-1');
  });
});
