/** 知识路径规范化：内部统一为以 / 开头、无结尾 / 的绝对路径 */
export interface NormalizedKnowledgePath {
  /** 规范化后的绝对路径，如 /a/b/c；根目录为 / */
  path: string;
  /** 路径分段；根目录为空数组 */
  segments: string[];
  /** 父目录路径；根目录的父目录仍为 / */
  parentPath: string;
  /** 当前节点名；根目录为空串 */
  name: string;
}

function invalid(path: string, reason: string): never {
  throw new Error(`非法知识路径「${path}」：${reason}`);
}

function validateSegment(segment: string, original: string): string {
  if (!segment) invalid(original, '不能包含空路径段');
  if (segment === '.' || segment === '..') {
    invalid(original, '不能包含 . 或 ..');
  }
  if (segment.trim() !== segment) {
    invalid(original, '路径段首尾不能有空白');
  }
  if (
    Array.from(segment).some((ch) => {
      const code = ch.charCodeAt(0);
      return code < 32 || code === 127 || ch === '\\';
    })
  ) {
    invalid(original, '不能包含控制字符或反斜杠');
  }
  if (segment.length > 200) invalid(original, '单个路径段不能超过 200 个字符');
  return segment;
}

/**
 * 规范化知识路径。输入可带或不带首尾 /，但只能有一个语义：
 * `/a/b`、`a/b` 均得到 `/a/b`；根路径 `/` 单独保留。
 */
export function normalizeKnowledgePath(input: string): NormalizedKnowledgePath {
  const original = input;
  if (typeof input !== 'string') invalid(String(input), '路径必须是字符串');
  const trimmed = input.trim();
  if (!trimmed) return { path: '/', segments: [], parentPath: '/', name: '' };
  if (trimmed.includes('%2f') || trimmed.includes('%2F')) {
    invalid(original, '编码后的斜杠不能作为路径段内容');
  }
  if (trimmed.includes('//')) invalid(original, '不能包含连续斜杠');
  if (trimmed.includes('\\')) invalid(original, '不能包含反斜杠');

  const withoutEdges = trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!withoutEdges)
    return { path: '/', segments: [], parentPath: '/', name: '' };
  const segments = withoutEdges
    .split('/')
    .map((s) => validateSegment(s, original));
  if (segments.length > 50) invalid(original, '目录层级不能超过 50 层');
  const path = `/${segments.join('/')}`;
  if (path.length > 2000) invalid(original, '路径总长度不能超过 2000 个字符');
  const parentSegments = segments.slice(0, -1);
  return {
    path,
    segments,
    parentPath: parentSegments.length ? `/${parentSegments.join('/')}` : '/',
    name: segments[segments.length - 1],
  };
}

/** 仅用于拼接父子路径；name 不允许包含 / */
export function joinKnowledgePath(parent: string, name: string): string {
  const p = normalizeKnowledgePath(parent).path;
  const child = validateSegment(name.trim(), name);
  return p === '/' ? `/${child}` : `${p}/${child}`;
}

/** 判断 path 是否为 parent 自身或其后代 */
export function isKnowledgePathWithin(path: string, parent: string): boolean {
  const p = normalizeKnowledgePath(path).path;
  const base = normalizeKnowledgePath(parent).path;
  return base === '/' || p === base || p.startsWith(`${base}/`);
}

/** 系统级知识目录：路径固定，只有标题可由用户修改 */
export interface SystemKnowledgeDirectoryDefinition {
  /** 稳定的代码标识，不参与路径 */
  key: 'backlogs' | 'tasks' | 'workspace' | 'system';
  path: string;
  name: string;
  title: string;
}

/** 机器人专属知识工作区根目录；其下按机器人 ID 建立固定子目录 */
export const WORKER_WORKSPACE_ROOT = '/95-workspace';

export const SYSTEM_KNOWLEDGE_DIRECTORIES: SystemKnowledgeDirectoryDefinition[] =
  [
    {
      key: 'backlogs',
      path: '/01-backlogs',
      name: '01-backlogs',
      title: '需求迭代',
    },
    {
      key: 'workspace',
      path: WORKER_WORKSPACE_ROOT,
      name: '95-workspace',
      title: '机器人工作区',
    },
    {
      key: 'tasks',
      path: '/98-tasks',
      name: '98-tasks',
      title: '任务记录',
    },
    {
      key: 'system',
      path: '/99-system',
      name: '99-system',
      title: '系统设计',
    },
  ];

/** 旧版系统路径：只读兼容与迁移来源，不再作为新文档目录 */
export const LEGACY_KNOWLEDGE_ROOTS = ['/task', '/project'] as const;

/** 系统镜像子树：由平台自动同步，通用知识接口不可写 */
export const SYSTEM_MIRROR_ROOTS = [
  '/99-system/workers',
  '/99-system/task-definitions',
  '/99-system/evaluations',
] as const;

export function findSystemKnowledgeDirectory(
  path: string,
): SystemKnowledgeDirectoryDefinition | null {
  const normalized = normalizeKnowledgePath(path).path;
  return (
    SYSTEM_KNOWLEDGE_DIRECTORIES.find((entry) => entry.path === normalized) ??
    null
  );
}

export function isSystemKnowledgeRoot(path: string): boolean {
  return Boolean(findSystemKnowledgeDirectory(path));
}

export function isSystemManagedKnowledgePath(path: string): boolean {
  const normalized = normalizeKnowledgePath(path).path;
  if (
    LEGACY_KNOWLEDGE_ROOTS.some(
      (root) => normalized === root || normalized.startsWith(`${root}/`),
    )
  ) {
    return true;
  }
  if (
    normalized === '/01-backlogs' ||
    normalized.startsWith('/01-backlogs/') ||
    normalized === WORKER_WORKSPACE_ROOT ||
    normalized === '/98-tasks' ||
    normalized.startsWith('/98-tasks/')
  ) {
    return true;
  }
  return SYSTEM_MIRROR_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );
}

/** 北京时间日期时间片段（统一使用两位数字，便于拼装系统路径） */
function beijingStampParts(
  value: Date | string,
): (type: Intl.DateTimeFormatPartTypes) => string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`非法日期：${String(value)}`);
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return (type) => parts.find((part) => part.type === type)?.value ?? '';
}

/** 北京时间 yyyyMMdd，用于系统目录按创建日期归档 */
export function beijingDateStamp(value: Date | string): string {
  const read = beijingStampParts(value);
  return `${read('year')}${read('month')}${read('day')}`;
}

/** 北京时间 yyyyMMddHHmmss，用于机器人会话复盘文件名 */
export function beijingDateTimeStamp(value: Date | string): string {
  const read = beijingStampParts(value);
  return `${read('year')}${read('month')}${read('day')}${read('hour')}${read('minute')}${read('second')}`;
}

/** 任务记录目录：/98-tasks/{yyyyMMdd}/{数字任务ID} */
export function taskRecordRootPath(task: {
  id: number;
  createdAt: Date | string;
}): string {
  return `/98-tasks/${beijingDateStamp(task.createdAt)}/${task.id}`;
}

/** 需求目录：/01-backlogs/{yyyyMMdd}/{需求ID} */
export function requirementRootPath(project: {
  id: number;
  createdAt: Date | string;
}): string {
  return `/01-backlogs/${beijingDateStamp(project.createdAt)}/${project.id}`;
}

/** 需求文档在知识库中的路径；文档本体始终归属需求 */
export function projectDocumentPath(
  project: { id: number; createdAt: Date | string },
  documentId: number,
): string {
  return `${requirementRootPath(project)}/document/${documentId}`;
}

/** 项目在知识库中的保留路径（系统维护，不允许普通知识编辑） */
export function projectRootPath(project: {
  id: number;
  createdAt: Date | string;
}): string {
  return requirementRootPath(project);
}

export function systemWorkerRootPath(workerId: number): string {
  return `/99-system/workers/${workerId}`;
}

/** 机器人对话交付与临时文档目录：/95-workspace/{机器人ID} */
export function workerWorkspaceRootPath(workerId: number): string {
  return `${WORKER_WORKSPACE_ROOT}/${workerId}`;
}

/** 机器人会话复盘目录：/95-workspace/{机器人ID}/reviews */
export function workerReviewsRootPath(workerId: number): string {
  return `${workerWorkspaceRootPath(workerId)}/reviews`;
}

/** 单篇复盘知识路径：/95-workspace/{机器人ID}/reviews/{yyyyMMddHHmmss} */
export function workerReviewPath(workerId: number, name: string): string {
  return `${workerReviewsRootPath(workerId)}/${name}`;
}

export function systemTaskDefinitionRootPath(templateId: number): string {
  return `/99-system/task-definitions/${templateId}`;
}

export function systemEvalSuiteRootPath(suiteId: number): string {
  return `/99-system/evaluations/suites/${suiteId}`;
}

export function systemEvalRunRootPath(run: {
  id: number;
  createdAt: Date | string;
}): string {
  return `/99-system/evaluations/runs/${beijingDateStamp(run.createdAt)}/${run.id}`;
}

/** URL 路径编码：逐段编码，保留 / */
export function encodeKnowledgePath(path: string): string {
  const normalized = normalizeKnowledgePath(path);
  if (normalized.path === '/') return '/';
  return normalized.segments.map((s) => encodeURIComponent(s)).join('/');
}
