import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'http';
import request from 'supertest';
import { ProjectsService } from './projects.service';
import { RequirementsController } from './requirements.controller';

describe('RequirementsController', () => {
  let app: INestApplication;
  const projects = {
    searchMarkdown: jest.fn(),
    findOneRequirementMarkdown: jest.fn(),
    updateMarkdown: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RequirementsController],
      providers: [{ provide: ProjectsService, useValue: projects }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    projects.searchMarkdown.mockResolvedValue('# 需求搜索');
    projects.findOneRequirementMarkdown.mockResolvedValue('# 需求详情');
    projects.updateMarkdown.mockResolvedValue('# 需求已更新');
  });

  it('GET /requirements/search.md 返回 Markdown 搜索结果', async () => {
    const res = await request(app.getHttpServer() as Server).get(
      '/requirements/search.md?q=pk',
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(projects.searchMarkdown).toHaveBeenCalledWith('pk');
    expect(res.text).toBe('# 需求搜索');
  });

  it('GET /requirements/:id.md 返回精简需求视图', async () => {
    const res = await request(app.getHttpServer() as Server).get(
      '/requirements/7.md',
    );
    expect(res.status).toBe(200);
    expect(projects.findOneRequirementMarkdown).toHaveBeenCalledWith(7);
    expect(res.text).toBe('# 需求详情');
  });

  it('POST /requirements/:id/update.md 委托 updateMarkdown', async () => {
    const res = await request(app.getHttpServer() as Server)
      .post('/requirements/7/update.md')
      .send({ description: '新描述' });
    expect(res.status).toBe(201);
    expect(projects.updateMarkdown).toHaveBeenCalledWith(7, {
      description: '新描述',
    });
    expect(res.text).toBe('# 需求已更新');
  });
});
