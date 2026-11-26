import {
  assertSystemKnowledgeWritable,
  assertSystemRootMetadataChange,
  assertSystemRootRemovable,
} from './system-knowledge.guard';

describe('系统知识目录保护', () => {
  it('拒绝通用接口写入任务、需求、系统镜像和旧路径', () => {
    for (const path of [
      '/98-tasks/20261126/1/API',
      '/01-backlogs/20261126/7/document/9',
      '/99-system/workers/1001/README',
      '/99-system/task-definitions/7/README',
      '/99-system/evaluations/runs/20261126/9/README',
      '/task/20261126/TK-0001/API',
      '/project/7/document/9',
    ]) {
      expect(() => assertSystemKnowledgeWritable(path)).toThrow(
        '系统知识目录由对应业务流程维护',
      );
    }
  });

  it('允许在 /99-system 根下维护人工系统设计资料', () => {
    expect(() => assertSystemKnowledgeWritable('/99-system')).not.toThrow();
    expect(() =>
      assertSystemKnowledgeWritable('/99-system/design'),
    ).not.toThrow();
  });

  it('系统根目录只允许修改名称', () => {
    expect(() =>
      assertSystemRootMetadataChange({
        path: '/98-tasks',
        title: '任务归档',
      }),
    ).not.toThrow();
    expect(() =>
      assertSystemRootMetadataChange({
        path: '/98-tasks',
        name: 'tasks',
      }),
    ).toThrow('路径固定');
    expect(() => assertSystemRootRemovable('/98-tasks')).toThrow('不能删除');
    expect(() => assertSystemRootRemovable('/guides')).not.toThrow();
  });
});
