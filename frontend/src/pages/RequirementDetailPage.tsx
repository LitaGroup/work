import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@appica/ui-react/card'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@appica/ui-react/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  DialogClose,
} from '@appica/ui-react/dialog'
import { Button, buttonVariants } from '@appica/ui-react/button'
import { Textarea } from '@appica/ui-react/textarea'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@appica/ui-react/select'
import { Badge } from '@appica/ui-react/badge'
import { DatePicker } from '@appica/ui-react/date-picker'
import { Input } from '@appica/ui-react/input'
import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipContent,
} from '@appica/ui-react/tooltip'
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@appica/ui-react/tabs'
import {
  api,
  documentSourceLabel,
  PROJECT_TYPES,
  type BacklogSummary,
  type DocumentType,
  type Project,
  type ProjectDocument,
  type ProjectType,
} from '../lib/api'
import { CreateDocumentDialog, ImportDocumentDialog } from '../components/DocumentDialogs'
import { StatusBadge } from '../components/StatusBadge'
import { PageBreadcrumb } from '../components/PageBreadcrumb'
import { TransferToIterationButton } from '../components/TransferToIterationButton'
import { DeleteRequirementButton } from '../components/DeleteRequirementButton'
import { DetailPageLayout } from '../components/detail/DetailPageLayout'
import { TopicsPanel } from '../components/topics/TopicsPanel'
import { DetailAgentPanel } from '../components/detail/DetailAgentPanel'
import { CountRow } from '../components/CountRow'
import { MarkdownViewer } from '../components/MarkdownViewer'
import { useTabHash } from '../lib/use-tab-hash'

/** 需求摘要字数上限（与后端 SUMMARY_MAX_CHARS 一致） */
const SUMMARY_MAX_CHARS = 200

/** 内容分区：详情 / 资料 / 讨论 / 操作 */
type RequirementDetailTab = 'details' | 'docs' | 'topics' | 'ops'

/** 页签与 URL hash 一一对应（如 /requirements/2#topics） */
const REQUIREMENT_DETAIL_TABS: RequirementDetailTab[] = [
  'details',
  'docs',
  'topics',
  'ops',
]

/**
 * 需求详情：内容分区为 详情（信息 / 摘要 / 详情描述）/ 资料 / 讨论 / 操作；
 * 标题右上角为迭代入口（未进入迭代时管理员可「移入迭代」，已进入时「进入迭代」）。
 * 研发过程数据（检查/测试/缺陷等）不再在此页展示，操作入口见任务中心与对应列表页。
 */
export function RequirementDetailPage() {
  const { id, topicId } = useParams<{ id: string; topicId?: string }>()
  const projectId = Number(id)
  /** 话题详情深链（/requirements/{id}/topics/{topicId}）：默认打开讨论分区并定位 */
  const focusTopicId = topicId ? Number(topicId) : undefined
  const navigate = useNavigate()
  const [project, setProject] = useState<Project | null>(null)
  const [backlogs, setBacklogs] = useState<BacklogSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiUnread, setAiUnread] = useState(0)

  // 内容分区 tab（与 URL hash 同步，支持 /requirements/2#topics 直达）
  const [tab, changeTab] = useTabHash(
    REQUIREMENT_DETAIL_TABS,
    focusTopicId ? 'topics' : 'details',
  )

  // 话题计数（TopicsPanel 加载后回调）
  const [topicsCount, setTopicsCount] = useState(0)

  const reload = useCallback(() => {
    if (!Number.isInteger(projectId) || projectId <= 0) return
    // 需求详情使用轻量接口：只取核心字段与文档清单，避免加载研发过程数据
    api
      .getRequirement(projectId)
      .then(setProject)
      .catch((e: Error) => setError(e.message))
    api
      .listBacklogs({ projectId, includeCanceled: true })
      .then(setBacklogs)
      .catch(() => setBacklogs([]))
  }, [projectId])

  useEffect(reload, [reload])

  // 该需求当前唯一未取消的迭代项（有则右上角「进入迭代」，无则「移入迭代」）
  const activeBacklog = useMemo(
    () => (backlogs ?? []).find((b) => b.status !== '取消') ?? null,
    [backlogs],
  )

  if (!id || !Number.isInteger(projectId) || projectId <= 0) {
    return <Navigate to="/requirements" replace />
  }
  if (error) return <p>加载失败:{error}</p>
  if (!project) return <p>加载中…</p>

  return (
    <DetailPageLayout
      aiCollapsible
      aiOutsideContent
      aiLabel="AI助理"
      aiOpen={aiOpen}
      onAiOpenChange={setAiOpen}
      aiUnreadCount={aiUnread}
      ai={
        <DetailAgentPanel
          title="AI助理"
          visible={aiOpen}
          onUnreadChange={setAiUnread}
          context={{
            type: 'project',
            id: `project:${project.id}`,
            title: project.name,
            summary: [
              `类型：${project.type}`,
              `状态：${project.status}`,
              project.expectedReleaseAt
                ? `预期发布：${project.expectedReleaseAt}`
                : '',
              project.priority ? `优先级：${project.priority}` : '',
            ]
              .filter(Boolean)
              .join('；'),
            readUrl: `/api/requirements/${project.id}.md`,
          }}
          emptyTitle={`「${project.name}」的独立 AI 会话`}
          emptyHint="让助理读取当前需求、梳理资料或协助推进迭代交付"
          placeholder="询问当前需求或让助理执行操作…"
        />
      }
    >
      <div className="flex h-full min-h-0 min-w-0 flex-col gap-4 overflow-y-auto pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <PageBreadcrumb
              items={[{ label: '需求', to: '/requirements' }, { label: project.name }]}
            />
            <h1 className="mt-2 flex items-center gap-3 text-2xl font-semibold">
              <span className="truncate">{project.name}</span>
              <StatusBadge status={project.status} />
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {activeBacklog ? (
              <Link
                to={`/backlogs/${activeBacklog.id}`}
                className={buttonVariants({ size: 'sm' })}
              >
                进入迭代
              </Link>
            ) : (
              <TransferToIterationButton
                projectId={project.id}
                projectName={project.name}
                onTransferred={reload}
              />
            )}
          </div>
        </div>

        <Tabs
          value={tab}
          onValueChange={(value) => changeTab(value as RequirementDetailTab)}
          variant="line"
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <TabsList className="shrink-0">
            <TabsTrigger value="details">详情</TabsTrigger>
            <TabsTrigger value="docs">
              资料 {project.documents?.length ?? 0}
            </TabsTrigger>
            <TabsTrigger value="topics">讨论 {topicsCount}</TabsTrigger>
            <TabsTrigger value="ops">操作</TabsTrigger>
          </TabsList>

          <TabsContent value="details" keepMounted className="pt-4">
            {/* 详情：信息属性、需求摘要与需求描述三个纵向块 */}
            <TooltipProvider>
              <Card>
                <CardHeader>
                  <CardTitle>详情</CardTitle>
                  <CardDescription>
                    需求信息、需求摘要与需求描述；点击带下划线的值即可编辑
                  </CardDescription>
                </CardHeader>
                <div className="flex flex-col gap-6 px-4 pb-4">
                  <section className="flex flex-col gap-2 text-sm">
                    <h3 className="text-sm font-medium text-foreground-intense">信息</h3>
                    <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <div className="flex items-center justify-between">
                        <dt>类型</dt>
                        <dd>
                          <ProjectTypeSelect project={project} onChanged={reload} />
                        </dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt>状态</dt>
                        <dd>
                          {/* 状态为推导值（是否进入迭代 + 创建时间），不可手改 */}
                          <StatusBadge status={project.status} />
                        </dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt>预期发布</dt>
                        <dd>
                          <ExpectedReleaseInput project={project} onChanged={reload} />
                        </dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt>计划周(w)</dt>
                        <dd>
                          <ProjectDictSelect
                            project={project}
                            field="iterationCycle"
                            suggestionsKey="iterations"
                            onChanged={reload}
                          />
                        </dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt>优先级</dt>
                        <dd>
                          <ProjectDictSelect
                            project={project}
                            field="priority"
                            suggestionsKey="priorities"
                            onChanged={reload}
                          />
                        </dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt>需求方</dt>
                        <dd>
                          <OwnerInput project={project} onChanged={reload} />
                        </dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt>涉及方</dt>
                        <dd>
                          <InvolvedPartiesInput project={project} onChanged={reload} />
                        </dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt>备注</dt>
                        <dd>
                          <RemarkInput project={project} onChanged={reload} />
                        </dd>
                      </div>
                      <div className="flex justify-between">
                        <dt>来源</dt>
                        <dd>{project.feishuRecordId ? '飞书同步' : '手动创建'}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt>资源</dt>
                        <dd>—</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt>更新时间</dt>
                        <dd>{new Date(project.updatedAt).toLocaleString()}</dd>
                      </div>
                    </dl>
                  </section>

                  <section className="flex flex-col gap-2 border-t border-border pt-4">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <h3 className="text-sm font-medium text-foreground-intense">摘要</h3>
                      <span className="text-xs text-foreground-muted">
                        ≤{SUMMARY_MAX_CHARS} 字，模型生成，可编辑
                      </span>
                    </div>
                    <div className="text-sm">
                      <EditSummaryDialog project={project} onSaved={reload} />
                    </div>
                  </section>

                  <section className="flex flex-col gap-2 border-t border-border pt-4">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <h3 className="text-sm font-medium text-foreground-intense">详情</h3>
                      <span className="text-xs text-foreground-muted">
                        Markdown 需求描述，点击编辑
                      </span>
                    </div>
                    <div className="text-sm">
                      <EditDescriptionDialog project={project} onSaved={reload} />
                    </div>
                  </section>
                </div>
              </Card>
            </TooltipProvider>
          </TabsContent>

          <TabsContent value="docs" keepMounted className="pt-4">
            {/* 资料：需求的文档清单与新建/导入/同步 */}
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <CardTitle className="flex items-center gap-2">
                      资料
                      <Badge variant="soft">{project.documents?.length ?? 0}</Badge>
                    </CardTitle>
                    <CardDescription>
                      需求的文档资料；可新建，或从飞书 / APIPOST 导入后按来源同步
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/documents?projectId=${project.id}`}
                      className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    >
                      查看全部
                    </Link>
                    <CreateDocumentDialog projectId={project.id} onCreated={reload} />
                    <ImportDocumentDialog projectId={project.id} onImported={reload} />
                  </div>
                </div>
              </CardHeader>
              <DocumentsPanel project={project} onChanged={reload} />
            </Card>
          </TabsContent>

          <TabsContent value="topics" keepMounted className="pt-4">
            {/* 讨论：与迭代项「话题」分区一致的折叠话题列表 */}
            <TopicsPanel
              subjectType="需求"
              subjectId={project.id}
              subjectTitle={project.name}
              onCountChange={setTopicsCount}
              focusTopicId={focusTopicId}
            />
          </TabsContent>

          <TabsContent value="ops" keepMounted className="pt-4">
            {/* 操作：删除需求（状态为推导值，不可手改，只读展示在信息区） */}
            <Card>
              <CardHeader>
                <CardTitle>操作</CardTitle>
                <CardDescription>
                  需求状态由迭代项与创建时间自动推导，不可手动修改；这里提供不可逆操作
                </CardDescription>
              </CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-4">
                <div className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-foreground-intense">删除需求</span>
                  <span className="text-foreground-muted">
                    其下的文档、资源、提测、缺陷等关联数据会一并清理，且不可恢复。
                  </span>
                </div>
                <DeleteRequirementButton
                  project={project}
                  onDeleted={() => navigate('/requirements')}
                />
              </div>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DetailPageLayout>
  )
}

function DocumentsPanel({
  project,
  onChanged,
}: {
  project: Project
  onChanged: () => void
}) {
  const allDocuments = project.documents ?? []
  const documents = allDocuments.slice(0, 10)
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>标题</TableHead>
          <TableHead>类型</TableHead>
          <TableHead>描述</TableHead>
          <TableHead>来源</TableHead>
          <TableHead className="w-40 text-center">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {documents.map((d) => (
          <TableRow key={d.id}>
            <TableCell className="max-w-md truncate" title={d.title}>
              {d.url ? (
                <a
                  href={d.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {d.title}
                </a>
              ) : (
                <Link to={`/documents/${d.id}`} className="underline">
                  {d.title}
                </Link>
              )}
            </TableCell>
            <TableCell>{d.type}</TableCell>
            <TableCell className="max-w-48 truncate" title={d.description ?? ''}>
              {d.description ?? '—'}
            </TableCell>
            <TableCell>
              {(() => {
                const url = d.source === 'apipost' ? d.apipostUrl : d.feishuUrl
                return url ? (
                  <a href={url} target="_blank" rel="noreferrer" className="underline">
                    {documentSourceLabel(d.source)}
                  </a>
                ) : (
                  documentSourceLabel(d.source)
                )
              })()}
            </TableCell>
            <TableCell className="text-center">
              {(d.source === '飞书' || d.source === 'apipost') && (
                <ResyncDocumentButton
                  document={d}
                  projectId={project.id}
                  onSynced={onChanged}
                />
              )}
            </TableCell>
          </TableRow>
        ))}
        {documents.length === 0 && (
          <TableRow>
            <TableCell colSpan={5}>暂无文档</TableCell>
          </TableRow>
        )}
        <CountRow
          colSpan={5}
          total={allDocuments.length}
          displayed={documents.length}
        />
      </TableBody>
    </Table>
  )
}

/** 更新同步：按原始链接重新从源（飞书 / APIPOST）拉取（覆盖本地内容） */
function ResyncDocumentButton({
  document: doc,
  projectId,
  onSynced,
}: {
  document: ProjectDocument
  projectId: number
  onSynced: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resync = () => {
    const url = doc.source === 'apipost' ? doc.apipostUrl : doc.feishuUrl
    if (!url) return
    setLoading(true)
    setError(null)
    const call =
      doc.source === 'apipost'
        ? api.importApipostDocument({ projectId, url })
        : api.importFeishuDocument({
            projectId,
            type: doc.type as DocumentType,
            url,
          })
    call
      .then(onSynced)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={resync}
        disabled={loading}
        title={error ?? '从源重新拉取最新内容'}
      >
        {loading ? '同步中…' : '同步'}
      </Button>
      {error && <span className="text-sm">{error}</span>}
    </>
  )
}

/**
 * 可编辑字段的展示态：值下面一条虚线下划线，hover/聚焦时提示「点击编辑」，点击交给调用方进入编辑。
 * 颜色用 Appica 角色 token（不写 hue 字面量）。
 */
function EditableValue({
  children,
  onClick,
  className = '',
  title = '点击编辑',
}: {
  children: ReactNode
  onClick: () => void
  className?: string
  title?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            className={`cursor-pointer border-b border-dashed border-border-strong pb-0.5 text-left transition-colors hover:border-border-intense hover:text-foreground-intense ${className}`}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  )
}

/** 展示需求类型；点击值展开下拉，选中后立即保存（飞书同步需求下次同步会被飞书侧覆盖） */
function ProjectTypeSelect({
  project,
  onChanged,
}: {
  project: Project
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const change = (type: string) => {
    if (type === project.type) return
    setError(null)
    api
      .updateProject(project.id, { type: type as ProjectType })
      .then(onChanged)
      .catch((e: Error) => setError(e.message))
  }

  return (
    <span className="flex flex-col items-end gap-1">
      {editing ? (
        <Select
          defaultOpen
          value={project.type}
          onOpenChange={(open) => {
            if (!open) setEditing(false)
          }}
          onValueChange={(v) => change(v as string)}
          items={Object.fromEntries(PROJECT_TYPES.map((t) => [t, t]))}
        >
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROJECT_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <EditableValue onClick={() => setEditing(true)}>
          <Badge variant="secondary">{project.type}</Badge>
        </EditableValue>
      )}
      {error && <span className="text-xs">{error}</span>}
    </span>
  )
}

/** 后端 date 列（YYYY-MM-DD）解析为本地 Date，避免 new Date('YYYY-MM-DD') 按 UTC 解析产生跨天偏差 */
function parseProjectDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return undefined
  return new Date(y, m - 1, d)
}

/** 本地 Date → 后端 date 列（YYYY-MM-DD，按本地年月日，避免 toISOString 的 UTC 偏移） */
function formatProjectDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 展示预期发布时间；点击值展开日期选择，选好后立即保存，清空则置为未定 */
function ExpectedReleaseInput({
  project,
  onChanged,
}: {
  project: Project
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const change = (date: Date | undefined) => {
    const value = date ? formatProjectDate(date) : ''
    if (value === (project.expectedReleaseAt ?? '')) return
    setError(null)
    api
      .updateProject(project.id, { expectedReleaseAt: value })
      .then(onChanged)
      .catch((e: Error) => setError(e.message))
  }

  return (
    <span className="flex flex-col items-end gap-1">
      {editing ? (
        <DatePicker
          defaultOpen
          size="sm"
          className="w-40"
          dateFormat="yyyy-MM-dd"
          value={parseProjectDate(project.expectedReleaseAt)}
          onValueChange={change}
          onOpenChange={(open) => {
            if (!open) setEditing(false)
          }}
        />
      ) : (
        <EditableValue onClick={() => setEditing(true)}>
          {project.expectedReleaseAt ?? '未定'}
        </EditableValue>
      )}
      {error && <span className="text-xs">{error}</span>}
    </span>
  )
}

/** 展示需求方；点击值展开输入框，Enter / 失焦保存，Esc 取消（空串清除；须在用户系统内） */
function OwnerInput({
  project,
  onChanged,
}: {
  project: Project
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const startEditing = () => {
    setValue(project.owner ?? '')
    setError(null)
    setEditing(true)
  }

  const save = () => {
    if (!editing || submitting) return
    const next = value.trim()
    if (next === (project.owner ?? '')) {
      setEditing(false)
      return
    }
    setSubmitting(true)
    setError(null)
    api
      .updateProject(project.id, { owner: next })
      .then(() => {
        setEditing(false)
        onChanged()
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSubmitting(false))
  }

  return (
    <span className="flex flex-col items-end gap-1">
      {editing ? (
        <Input
          autoFocus
          inputSize="sm"
          className="w-40"
          value={value}
          disabled={submitting}
          placeholder="姓名，多个用、分隔"
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') {
              setEditing(false)
              setError(null)
            }
          }}
        />
      ) : (
        <EditableValue onClick={startEditing}>
          <span className="block max-w-40 truncate" title={project.owner ?? undefined}>
            {project.owner || '—'}
          </span>
        </EditableValue>
      )}
      {error && <span className="text-xs">{error}</span>}
    </span>
  )
}

/** 展示涉及方（飞书「涉及方」多选同步）；点击值展开输入框，Enter / 失焦保存，Esc 取消（顿号/逗号分隔，空串清除） */
function InvolvedPartiesInput({
  project,
  onChanged,
}: {
  project: Project
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = project.involvedParties?.join('、') ?? ''

  const startEditing = () => {
    setValue(current)
    setError(null)
    setEditing(true)
  }

  const save = () => {
    if (!editing || submitting) return
    const next = value.trim()
    if (next === current) {
      setEditing(false)
      return
    }
    setSubmitting(true)
    setError(null)
    api
      .updateProject(project.id, { involvedParties: next })
      .then(() => {
        setEditing(false)
        onChanged()
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSubmitting(false))
  }

  return (
    <span className="flex flex-col items-end gap-1">
      {editing ? (
        <Input
          autoFocus
          inputSize="sm"
          className="w-48"
          value={value}
          disabled={submitting}
          placeholder="如 Android、iOS、Backend"
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') {
              setEditing(false)
              setError(null)
            }
          }}
        />
      ) : (
        <EditableValue onClick={startEditing}>
          <span className="block max-w-40 truncate" title={current || undefined}>
            {current || '—'}
          </span>
        </EditableValue>
      )}
      {error && <span className="text-xs">{error}</span>}
    </span>
  )
}

/** 展示备注；点击值展开输入框，Enter / 失焦保存，Esc 取消（空串清除） */
function RemarkInput({
  project,
  onChanged,
}: {
  project: Project
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const startEditing = () => {
    setValue(project.remark ?? '')
    setError(null)
    setEditing(true)
  }

  const save = () => {
    if (!editing || submitting) return
    const next = value.trim()
    if (next === (project.remark ?? '')) {
      setEditing(false)
      return
    }
    setSubmitting(true)
    setError(null)
    api
      .updateProject(project.id, { remark: next })
      .then(() => {
        setEditing(false)
        onChanged()
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSubmitting(false))
  }

  return (
    <span className="flex flex-col items-end gap-1">
      {editing ? (
        <Input
          autoFocus
          inputSize="sm"
          className="w-48"
          value={value}
          disabled={submitting}
          placeholder="备注"
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') {
              setEditing(false)
              setError(null)
            }
          }}
        />
      ) : (
        <EditableValue onClick={startEditing}>
          <span className="block max-w-40 truncate" title={project.remark ?? undefined}>
            {project.remark || '—'}
          </span>
        </EditableValue>
      )}
      {error && <span className="text-xs">{error}</span>}
    </span>
  )
}

/** 展示迭代/优先级；点击值展开下拉（全平台已有取值，取自 /projects/page 的去重值），选中后立即保存，选"未设置"清除 */
function ProjectDictSelect({
  project,
  field,
  suggestionsKey,
  onChanged,
}: {
  project: Project
  field: 'iterationCycle' | 'priority'
  /** /projects/page 返回中的去重取值列表字段 */
  suggestionsKey: 'iterations' | 'priorities'
  onChanged: () => void
}) {
  const CLEAR = '__clear__'
  const [editing, setEditing] = useState(false)
  const [options, setOptions] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  // 进入编辑态时拉取全平台已有取值
  useEffect(() => {
    if (!editing) return
    api
      .listProjectPage({ page: 1, pageSize: 1 })
      .then((r) => setOptions(r[suggestionsKey]))
      .catch(() => setOptions([]))
  }, [editing, suggestionsKey])

  const current = project[field] ?? ''
  // 当前值不在已有取值中时补进选项，避免触发器显示异常
  const allOptions =
    current && !options.includes(current) ? [current, ...options] : options

  const change = (v: string) => {
    const next = v === CLEAR ? '' : v
    if (next === current) return
    setError(null)
    api
      .updateProject(project.id, { [field]: next })
      .then(onChanged)
      .catch((e: Error) => setError(e.message))
  }

  return (
    <span className="flex flex-col items-end gap-1">
      {editing ? (
        <Select
          defaultOpen
          value={current || CLEAR}
          onOpenChange={(open) => {
            if (!open) setEditing(false)
          }}
          onValueChange={(v) => change(v as string)}
          items={{
            [CLEAR]: '（未设置）',
            ...Object.fromEntries(allOptions.map((o) => [o, o])),
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={CLEAR}>（未设置）</SelectItem>
            {allOptions.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <EditableValue onClick={() => setEditing(true)}>
          <span className="block max-w-40 truncate" title={current}>
            {current || '—'}
          </span>
        </EditableValue>
      )}
      {error && <span className="text-xs">{error}</span>}
    </span>
  )
}

/** 编辑需求描述（Markdown，空串清除）；展示态点击描述文本打开弹窗 */
function EditDescriptionDialog({
  project,
  onSaved,
}: {
  project: Project
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      setDescription(project.description ?? '')
      setError(null)
    }
  }

  const submit = () => {
    setError(null)
    api
      .updateProject(project.id, { description })
      .then(() => {
        setOpen(false)
        onSaved()
      })
      .catch((e: Error) => setError(e.message))
  }

  return (
    <>
      <EditableValue
        className="block w-full text-sm"
        onClick={() => handleOpenChange(true)}
      >
        {project.description?.trim() ? (
          // 链接自行处理点击，避免同时打开需求描述编辑弹窗
          <span
            className="block"
            onClick={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest('a')
              ) {
                event.stopPropagation()
              }
            }}
          >
            <MarkdownViewer text={project.description} />
          </span>
        ) : (
          '暂无描述'
        )}
      </EditableValue>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑需求描述</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1 text-sm">
                需求描述（Markdown，留空清除）
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="需求背景、目标、链接…"
                  rows={8}
                />
              </label>
              {error && <p className="text-sm">保存失败:{error}</p>}
            </div>
          </DialogBody>
          <DialogFooter>
            <DialogClose>
              <Button variant="outline" size="sm">取消</Button>
            </DialogClose>
            <Button onClick={submit}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
/**
 * 编辑需求摘要（≤200 字，空串清除）：摘要由模型根据需求描述与「需求」类文档生成，
 * 人工可改；清空后会在需求或需求类文档更新时自动重新生成。
 */
function EditSummaryDialog({
  project,
  onSaved,
}: {
  project: Project
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [summary, setSummary] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      setSummary(project.summary ?? '')
      setError(null)
    }
  }

  const submit = () => {
    const value = summary.trim()
    if (value.length > SUMMARY_MAX_CHARS) {
      setError(`摘要不能超过 ${SUMMARY_MAX_CHARS} 字（当前 ${value.length} 字）`)
      return
    }
    setError(null)
    api
      .updateProject(project.id, { summary: value })
      .then(() => {
        setOpen(false)
        onSaved()
      })
      .catch((e: Error) => setError(e.message))
  }

  return (
    <>
      <EditableValue
        className="block w-full text-sm"
        title="点击编辑需求摘要"
        onClick={() => handleOpenChange(true)}
      >
        {project.summary?.trim() ? (
          <span className="block">{project.summary}</span>
        ) : (
          <span className="block text-foreground-muted">
            暂无摘要（需求或需求类文档更新后自动生成）
          </span>
        )}
      </EditableValue>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑需求摘要</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1 text-sm">
                需求摘要（≤{SUMMARY_MAX_CHARS} 字，留空清除）
                <Textarea
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="留空清除后，会在需求或需求类文档更新时自动重新生成"
                  rows={5}
                />
              </label>
              <p className="text-xs text-foreground-muted">
                当前 {summary.trim().length} / {SUMMARY_MAX_CHARS} 字
              </p>
              {error && <p className="text-sm">保存失败:{error}</p>}
            </div>
          </DialogBody>
          <DialogFooter>
            <DialogClose>
              <Button variant="outline" size="sm">取消</Button>
            </DialogClose>
            <Button onClick={submit}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
