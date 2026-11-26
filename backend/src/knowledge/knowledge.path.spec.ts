import {
  encodeKnowledgePath,
  isKnowledgePathWithin,
  isSystemKnowledgeRoot,
  isSystemManagedKnowledgePath,
  joinKnowledgePath,
  normalizeKnowledgePath,
  projectDocumentPath,
  systemEvalRunRootPath,
  systemEvalSuiteRootPath,
  systemTaskDefinitionRootPath,
  systemWorkerRootPath,
  taskRecordRootPath,
} from './knowledge.path';

describe('knowledge path', () => {
  it('规范化首尾斜杠和层级', () => {
    expect(normalizeKnowledgePath('/a/b/c/')).toEqual({
      path: '/a/b/c',
      segments: ['a', 'b', 'c'],
      parentPath: '/a/b',
      name: 'c',
    });
    expect(normalizeKnowledgePath('a/b').path).toBe('/a/b');
    expect(normalizeKnowledgePath('/')).toMatchObject({
      path: '/',
      segments: [],
      parentPath: '/',
    });
  });

  it('拒绝越级、连续斜杠、反斜杠和编码斜杠', () => {
    expect(() => normalizeKnowledgePath('/a/../b')).toThrow('..');
    expect(() => normalizeKnowledgePath('/a//b')).toThrow('连续斜杠');
    expect(() => normalizeKnowledgePath('/a\\b')).toThrow('反斜杠');
    expect(() => normalizeKnowledgePath('/a%2Fb')).toThrow('编码后的斜杠');
    expect(() => normalizeKnowledgePath('/ a')).toThrow('首尾不能有空白');
  });

  it('拼接、包含判断与项目文档固定路径', () => {
    expect(joinKnowledgePath('/', 'guides')).toBe('/guides');
    expect(joinKnowledgePath('/guides', 'deploy')).toBe('/guides/deploy');
    expect(isKnowledgePathWithin('/guides/deploy', '/guides')).toBe(true);
    expect(isKnowledgePathWithin('/guides2', '/guides')).toBe(false);
    expect(isKnowledgePathWithin('/anything', '/')).toBe(true);
    expect(
      projectDocumentPath(
        { id: 123, createdAt: new Date('2026-10-27T16:30:00Z') },
        456,
      ),
    ).toBe('/01-backlogs/20261028/123/document/456');
  });

  it('任务、系统镜像路径使用数字 ID 与北京时间日期', () => {
    expect(
      taskRecordRootPath({
        id: 42,
        createdAt: new Date('2026-11-25T16:30:00Z'),
      }),
    ).toBe('/98-tasks/20261126/42');
    expect(systemWorkerRootPath(1001)).toBe('/99-system/workers/1001');
    expect(systemTaskDefinitionRootPath(7)).toBe(
      '/99-system/task-definitions/7',
    );
    expect(systemEvalSuiteRootPath(3)).toBe('/99-system/evaluations/suites/3');
    expect(
      systemEvalRunRootPath({
        id: 9,
        createdAt: new Date('2026-11-25T16:30:00Z'),
      }),
    ).toBe('/99-system/evaluations/runs/20261126/9');
  });

  it('系统根目录路径固定，受管子树不允许通用知识写入', () => {
    expect(isSystemKnowledgeRoot('/98-tasks')).toBe(true);
    expect(isSystemKnowledgeRoot('/98-tasks/20261126/1')).toBe(false);
    expect(isSystemManagedKnowledgePath('/98-tasks/20261126/1/API')).toBe(true);
    expect(isSystemManagedKnowledgePath('/01-backlogs/20261126/1')).toBe(true);
    expect(isSystemManagedKnowledgePath('/99-system/workers/1001/README')).toBe(
      true,
    );
    expect(isSystemManagedKnowledgePath('/99-system')).toBe(false);
    expect(isSystemManagedKnowledgePath('/99-system/design')).toBe(false);
    expect(isSystemManagedKnowledgePath('/task/20261126/TK-1')).toBe(true);
  });

  it('逐段 URL 编码，保留目录层级', () => {
    expect(encodeKnowledgePath('/中文/部署 v2')).toBe(
      '%E4%B8%AD%E6%96%87/%E9%83%A8%E7%BD%B2%20v2',
    );
    expect(encodeKnowledgePath('/')).toBe('/');
  });
});
