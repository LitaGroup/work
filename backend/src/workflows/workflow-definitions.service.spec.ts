import { DataSource, Repository } from 'typeorm';
import { TaskTemplate } from '../tasks/task-template.entity';
import { Worker } from '../workers/worker.entity';
import { WorkflowDefinitionVersion } from './workflow-definition-version.entity';
import { WorkflowDefinition } from './workflow-definition.entity';
import { WorkflowDefinitionsService } from './workflow-definitions.service';
import { RELEASE_TICKET_WORKFLOW } from './system-workflows';

/** 工单配置服务：启动时幂等预置内置系统工作流并发布 v1 */
describe('WorkflowDefinitionsService', () => {
  const definitions = {
    findOne: jest.fn(),
    find: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const versions = {
    findOne: jest.fn(),
  };
  const taskTemplates = {
    find: jest.fn(),
  };
  const workers = {
    find: jest.fn(),
  };
  const manager = {
    findOne: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
  };
  const dataSource = {
    transaction: jest.fn(),
  };
  const insertBuilder = {
    insert: jest.fn(),
    into: jest.fn(),
    values: jest.fn(),
    orIgnore: jest.fn(),
    execute: jest.fn(),
  };
  let service: WorkflowDefinitionsService;

  const definition = (
    input: Partial<WorkflowDefinition>,
  ): WorkflowDefinition => ({
    id: 7,
    code: RELEASE_TICKET_WORKFLOW.code,
    category: RELEASE_TICKET_WORKFLOW.category,
    name: RELEASE_TICKET_WORKFLOW.name,
    description: RELEASE_TICKET_WORKFLOW.description,
    builtIn: true,
    enabled: true,
    draftDefinition: RELEASE_TICKET_WORKFLOW.definition,
    latestPublishedVersion: 0,
    latestPublishedAt: null,
    draftUpdatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...input,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    insertBuilder.insert.mockReturnValue(insertBuilder);
    insertBuilder.into.mockReturnValue(insertBuilder);
    insertBuilder.values.mockReturnValue(insertBuilder);
    insertBuilder.orIgnore.mockReturnValue(insertBuilder);
    insertBuilder.execute.mockResolvedValue(undefined);
    definitions.createQueryBuilder.mockReturnValue(insertBuilder);
    definitions.find.mockResolvedValue([]);
    manager.findOne.mockResolvedValue(null);
    manager.insert.mockResolvedValue(undefined);
    manager.update.mockResolvedValue(undefined);
    dataSource.transaction.mockImplementation(
      (callback: (m: typeof manager) => Promise<unknown>) => callback(manager),
    );
    service = new WorkflowDefinitionsService(
      definitions as unknown as Repository<WorkflowDefinition>,
      versions as unknown as Repository<WorkflowDefinitionVersion>,
      taskTemplates as unknown as Repository<TaskTemplate>,
      workers as unknown as Repository<Worker>,
      dataSource as unknown as DataSource,
    );
  });

  it('启动时为未发布的内置工作流幂等发布 v1', async () => {
    // 三个内置工作流都已存在，但都没有发布（开发库 synchronize 建表、迁移未执行的场景）
    definitions.findOne.mockImplementation(
      (input: { where: Array<{ code: string }> | { code: string } }) => {
        const code = Array.isArray(input.where)
          ? input.where[0].code
          : input.where.code;
        return definition({ code, latestPublishedVersion: 0 });
      },
    );
    // 每个工作流各查一次：被锁定的定义草稿与 v1 版本记录
    manager.findOne.mockImplementation(
      (entity: unknown, options: { where: Record<string, unknown> }) =>
        entity === WorkflowDefinition
          ? definition({
              id: options.where.id as number,
              latestPublishedVersion: 0,
            })
          : null,
    );

    await service.onModuleInit();

    expect(manager.insert).toHaveBeenCalledTimes(3);
    expect(manager.insert).toHaveBeenCalledWith(
      WorkflowDefinitionVersion,
      expect.objectContaining({
        version: 1,
        definition: RELEASE_TICKET_WORKFLOW.definition,
        publishedById: null,
      }),
    );
    expect(manager.update).toHaveBeenCalledTimes(3);
    expect(manager.update).toHaveBeenCalledWith(
      WorkflowDefinition,
      7,
      expect.objectContaining({ enabled: true, latestPublishedVersion: 1 }),
    );
  });

  it('定义缺失时先预置草稿，再发布 v1', async () => {
    // 其余内置工作流已存在且已发布；提测工作流首次按 code/category 未命中，插入后按 code 命中
    const calls = new Map<string, number>();
    definitions.findOne.mockImplementation(
      (input: { where: Array<{ code: string }> | { code: string } }) => {
        const code = Array.isArray(input.where)
          ? input.where[0].code
          : input.where.code;
        const count = (calls.get(code) ?? 0) + 1;
        calls.set(code, count);
        if (code !== RELEASE_TICKET_WORKFLOW.code) {
          return definition({ code, latestPublishedVersion: 1 });
        }
        return count === 1
          ? null
          : definition({ code, latestPublishedVersion: 0 });
      },
    );
    manager.findOne.mockImplementation((entity: unknown) =>
      entity === WorkflowDefinition
        ? definition({ id: 7, latestPublishedVersion: 0 })
        : null,
    );

    await service.onModuleInit();

    expect(insertBuilder.values).toHaveBeenCalledWith(
      expect.objectContaining({
        code: RELEASE_TICKET_WORKFLOW.code,
        latestPublishedVersion: 0,
      }),
    );
    expect(manager.insert).toHaveBeenCalledWith(
      WorkflowDefinitionVersion,
      expect.objectContaining({ definitionId: 7, version: 1 }),
    );
    expect(manager.update).toHaveBeenCalledWith(
      WorkflowDefinition,
      7,
      expect.objectContaining({ latestPublishedVersion: 1 }),
    );
  });

  it('已发布的内置工作流启动时不重复发布', async () => {
    definitions.findOne.mockResolvedValue(
      definition({ latestPublishedVersion: 1 }),
    );

    await service.onModuleInit();

    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(insertBuilder.values).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
  });
});
