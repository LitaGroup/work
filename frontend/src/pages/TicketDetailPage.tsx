import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@appica/ui-react/table'
import {
  api,
  type TaskChatMessage,
  type TaskChatQuestion,
  type TaskChatSnapshot,
  type TaskChatStreamMessage,
  type TaskDocumentContent,
  type TaskDocumentsView,
  type TaskHandoffDocument,
  type TaskPipelineStage,
  type Ticket,
  type TicketWorkflowRun,
  type TicketWorkflowView,
  type WorkbenchTask,
  type IterationSummary,
  type BacklogSummary,
} from '../lib/api'
import { MarkdownViewer } from '../components/MarkdownViewer'
import { PageBreadcrumb } from '../components/PageBreadcrumb'
import { TicketStatusBadge } from '../components/StatusBadge'
import { DetailAgentPanel } from '../components/detail/DetailAgentPanel'
import { DetailPageLayout } from '../components/detail/DetailPageLayout'
import { TopicsPanel } from '../components/topics/TopicsPanel'
import { TaskActions } from '../components/task-detail/TaskActions'
import { TicketCurrentNodePanel } from '../components/ticket-detail/TicketCurrentNodePanel'
import { TaskDocumentsPanel } from '../components/task-detail/TaskDocumentsPanel'
import { TaskEventsPanel } from '../components/task-detail/TaskEventsPanel'
import { TaskMarkdownDocumentView } from '../components/task-detail/TaskMarkdownDocumentView'
import { TaskTreePanel } from '../components/task-detail/TaskTreePanel'
import { TaskDetailView } from './TaskPackageDetailPage'
import { visibleEventSource } from '../lib/event-source'
import { useTabHash } from '../lib/use-tab-hash'
import { useAuth } from '../context/AuthContext'
import type { ApprovalActionKind } from '../components/task-detail/ApprovalActions'

type TicketContentTab =
  | 'current'
  | 'progress'
  | 'info'
  | 'events'
  | 'tasks'
  | 'documents'
  | 'review'
  | 'topics'

const TICKET_CONTENT_TABS: Array<[TicketContentTab, string]> = [
  ['current', '当前'],
  ['progress', '进度'],
  ['info', '信息'],
  ['events', '事件'],
  ['tasks', '任务'],
  ['documents', '文档'],
  ['review', '复盘'],
  ['topics', '话题'],
]

/** 页签与 URL hash 一一对应（如 /tickets/12#topics） */
const TICKET_CONTENT_TAB_KEYS = TICKET_CONTENT_TABS.map(([key]) => key)

const OUTCOME_LABEL: Record<string, string> = {
  succeeded: '执行成功',
  failed: '执行失败',
  approved: '通过',
  rejected: '驳回',
}

/** 最近一次创建了任务的节点运行（用于事件/文档/复盘等历史内容） */
function latestTaskId(workflow: TicketWorkflowView | null | undefined) {
  let latest: TicketWorkflowRun | null = null
  for (const run of workflow?.runs ?? []) {
    if (!run.taskId) continue
    if (!latest || run.id > latest.id) latest = run
  }
  return latest?.taskId ?? null
}

/** 迭代项人员：需求方 → 负责人 → 成员（按姓名去重，需求方可能多人） */
function backlogPeople(backlog: BacklogSummary): string[] {
  const names: string[] = []
  const push = (value: string | null | undefined) => {
    for (const name of (value ?? '').split(/[、,，;；]+/)) {
      const trimmed = name.trim()
      if (trimmed && !names.includes(trimmed)) names.push(trimmed)
    }
  }
  push(backlog.owner)
  push(backlog.ownerName)
  for (const member of backlog.members ?? []) push(member.name)
  return names
}

/** 工单输入里的迭代项行：「类型」标题（链接到迭代项）+ 需求方 / 负责人 / 成员 */
function BacklogInputLine({ backlog }: { backlog: BacklogSummary }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Badge
        variant="outline"
        size="sm"
        render={<Link to={`/backlogs/${backlog.id}`} />}
      >
        {`「${backlog.requirementType ?? '需求'}」${
          backlog.title || backlog.code
        }`}
      </Badge>
      {backlogPeople(backlog).map((name) => (
        <span key={name} className="font-mono text-xs text-foreground-muted">
          @{name}
        </span>
      ))}
    </li>
  )
}

/** 工单详情：新模型展示工作流进度与节点任务；历史工单继续复用任务详情 */
export function TicketDetailPage() {
  const { ticketId, topicId } = useParams<{
    ticketId: string
    topicId?: string
  }>()
  /** 话题详情深链（/tickets/{id}/topics/{topicId}）：默认打开话题分区并定位 */
  const focusTopicId = topicId ? Number(topicId) : undefined
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const { user: currentUser } = useAuth()
  const id = Number(ticketId)
  /** 飞书审批卡片跳转：?approval=approve|reject 自动打开审批弹窗 */
  const approvalAction: ApprovalActionKind | null =
    searchParams.get('approval') === 'approve'
      ? 'approve'
      : searchParams.get('approval') === 'reject'
        ? 'reject'
        : null
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [iterations, setIterations] = useState<IterationSummary[]>([])
  const [backlogs, setBacklogs] = useState<BacklogSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [acting, setActing] = useState<'accept' | 'reject' | null>(null)
  // 内容分区 tab 与 URL hash 同步（支持 /tickets/12#topics 直达）
  const [contentTab, setContentTab] = useTabHash(
    TICKET_CONTENT_TAB_KEYS,
    focusTopicId ? 'topics' : 'current',
  )
  const [collaborationOpen, setCollaborationOpen] = useState(false)
  const [collaborationUnread, setCollaborationUnread] = useState(0)

  /** 关联节点任务（最近一次创建的节点任务）的实时数据 */
  const [taskChat, setTaskChat] = useState<TaskChatSnapshot | null>(null)
  const [workbenchTask, setWorkbenchTask] = useState<WorkbenchTask | null>(null)
  const [handoffDoc, setHandoffDoc] = useState<TaskHandoffDocument | null>(null)
  const [documents, setDocuments] = useState<TaskDocumentsView | null>(null)
  const [reviewDoc, setReviewDoc] = useState<TaskDocumentContent | null>(null)
  /** 文档清单 / 复盘仅在有对应分区时按需加载 */
  const [extrasLoading, setExtrasLoading] = useState(false)
  const [extrasError, setExtrasError] = useState<string | null>(null)
  const [extrasRevision, setExtrasRevision] = useState(0)
  const [taskError, setTaskError] = useState<string | null>(null)
  const [replying, setReplying] = useState(false)

  const ticketSeq = useRef(0)
  const load = useCallback(async () => {
    const seq = ++ticketSeq.current
    try {
      const row = await api.getTicket(id)
      if (seq !== ticketSeq.current) return row
      setTicket(row)
      setError(null)
      return row
    } catch (e) {
      if (seq === ticketSeq.current) setError((e as Error).message)
      return null
    }
  }, [id])

  useEffect(() => {
    void load()
    // 主刷新走节点任务 SSE；这里只做低频兜底，并在标签页隐藏时暂停
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [load])

  /** 起始节点含迭代 / 迭代项字段时加载清单，用于把 ID 展示为标识 */
  const hasIterationField = useMemo(() => {
    const fields =
      ticket?.workflow?.nodes.find((node) => node.kind === 'start')
        ?.inputFields ?? []
    return fields.some(
      (field) => field.type === 'iteration' || field.type === 'iteration_multi',
    )
  }, [ticket])
  const hasBacklogField = useMemo(() => {
    const fields =
      ticket?.workflow?.nodes.find((node) => node.kind === 'start')
        ?.inputFields ?? []
    return fields.some(
      (field) => field.type === 'backlog' || field.type === 'backlog_multi',
    )
  }, [ticket])

  useEffect(() => {
    if (!hasIterationField && !hasBacklogField) return
    let alive = true
    if (hasIterationField) {
      api
        .listIterations()
        .then((rows) => {
          if (alive) setIterations(rows)
        })
        .catch(() => {
          // 加载失败时回退展示原始 ID
        })
    }
    if (hasBacklogField) {
      api
        .listBacklogs()
        .then((rows) => {
          if (alive) setBacklogs(rows)
        })
        .catch(() => {
          // 加载失败时回退展示原始 ID
        })
    }
    return () => {
      alive = false
    }
  }, [hasIterationField, hasBacklogField])

  /** 审批弹窗按链接参数打开后清理查询参数，避免刷新或切换节点时重复弹出 */
  const clearApprovalParam = useCallback(() => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.delete('approval')
        return next
      },
      { replace: true },
    )
  }, [setSearchParams])

  const act = async (action: 'accept' | 'reject') => {
    setActing(action)
    setActionError(null)
    try {
      await api.acceptTicketWorkflow(id, action)
      await load()
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setActing(null)
    }
  }

  /** 节点事件/任务/文档/复盘跟随最近一次创建了任务的节点运行 */
  const activeTaskId = useMemo(
    () => latestTaskId(ticket?.workflow),
    [ticket],
  )

  /** 当前节点最新一次运行及其任务；无任务时不得沿用上一节点 */
  const currentNodeRun = useMemo(() => {
    const workflow = ticket?.workflow
    const key = workflow?.currentNodeKey
    if (!workflow || !key) return null
    return workflow.runs
      .filter((run) => run.nodeKey === key)
      .reduce<TicketWorkflowRun | null>(
        (latest, run) => (!latest || run.id > latest.id ? run : latest),
        null,
      )
  }, [ticket])
  const currentNodeTaskId = currentNodeRun?.taskId ?? null

  const taskSeq = useRef(0)
  /** 核心数据：会话快照 + 交付文档 + 工作台角色（申请验收依赖交付文档，始终加载） */
  const loadTaskData = useCallback(async () => {
    if (!activeTaskId) return
    const seq = ++taskSeq.current
    try {
      const [chat, handoff, workbench] = await Promise.all([
        api.getTaskChat(activeTaskId),
        api.getTaskHandoff(activeTaskId),
        api.getWorkbenchTask(activeTaskId).catch(() => null),
      ])
      if (seq !== taskSeq.current) return
      setTaskChat(chat)
      setHandoffDoc(handoff)
      setWorkbenchTask(workbench?.id === activeTaskId ? workbench : null)
      setTaskError(null)
    } catch (e) {
      if (seq === taskSeq.current) setTaskError((e as Error).message)
    }
  }, [activeTaskId])

  /** 文档清单 + 复盘：仅在「文档 / 复盘」分区按需加载 */
  const extrasSeq = useRef(0)
  const loadTaskExtras = useCallback(async () => {
    if (!activeTaskId) return
    const seq = ++extrasSeq.current
    setExtrasLoading(true)
    try {
      const [docs, review] = await Promise.all([
        api.listTaskDocuments(activeTaskId),
        api.getTaskReview(activeTaskId),
      ])
      if (seq !== extrasSeq.current) return
      setDocuments(docs)
      setReviewDoc(review)
      setExtrasError(null)
    } catch (e) {
      if (seq === extrasSeq.current) setExtrasError((e as Error).message)
    } finally {
      if (seq === extrasSeq.current) setExtrasLoading(false)
    }
  }, [activeTaskId])

  useEffect(() => {
    // 切换节点任务后丢弃旧任务的数据，重新拉取会话/交付文档/角色
    // oxlint-disable-next-line react/set-state-in-effect
    setTaskChat(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setWorkbenchTask(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setHandoffDoc(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setDocuments(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setReviewDoc(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setExtrasError(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setTaskError(null)
    // 让仍在途的旧任务文档请求失效
    extrasSeq.current += 1
    // oxlint-disable-next-line react/set-state-in-effect
    void loadTaskData()
  }, [loadTaskData])

  /** 文档/复盘按 taskId + 刷新版本去重，避免切换分区重复请求 */
  const needsTaskExtras =
    contentTab === 'documents' || contentTab === 'review'
  const extrasKey = activeTaskId ? `${activeTaskId}:${extrasRevision}` : null
  const extrasSeenRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeTaskId || !needsTaskExtras || !extrasKey) return
    if (extrasSeenRef.current === extrasKey) return
    extrasSeenRef.current = extrasKey
    void loadTaskExtras()
  }, [activeTaskId, needsTaskExtras, extrasKey, loadTaskExtras])

  useEffect(() => {
    // 节点任务实时流：就绪/刷新重拉快照，消息与阶段增量就地合并
    if (!activeTaskId) return
    let closed = false
    const source = visibleEventSource(`/api/tasks/${activeTaskId}/chat/stream`)
    source.onmessage = (event: MessageEvent<string>) => {
      if (closed) return
      let data: TaskChatStreamMessage
      try {
        data = JSON.parse(event.data) as TaskChatStreamMessage
      } catch {
        return
      }
      switch (data.type) {
        case 'ready':
          void loadTaskData()
          // 文档/复盘尚未打开时只递增版本，进入分区后按需加载
          setExtrasRevision((value) => value + 1)
          break
        case 'message.upsert':
          if (data.message.taskId !== activeTaskId) break
          setTaskChat((current) =>
            current
              ? {
                  ...current,
                  messages: upsertMessage(current.messages, data.message),
                }
              : current,
          )
          break
        case 'stage.upsert':
          setTaskChat((current) =>
            current
              ? { ...current, pipeline: upsertStage(current.pipeline, data.stage) }
              : current,
          )
          break
        case 'stage.delete':
          setTaskChat((current) =>
            current
              ? {
                  ...current,
                  pipeline: current.pipeline.filter(
                    (stage) => !data.ids.includes(stage.task.id),
                  ),
                }
              : current,
          )
          break
        case 'refresh':
          void loadTaskData()
          setExtrasRevision((value) => value + 1)
          break
        default:
          // ping 仅保活
          break
      }
    }
    return () => {
      closed = true
      source.close()
    }
  }, [activeTaskId, loadTaskData])

  /** 快照与当前节点任务对齐时才交给面板，避免串任务 */
  const interactiveChat: TaskChatSnapshot | null =
    taskChat?.task.id === activeTaskId ? taskChat : null
  const interactiveTask: WorkbenchTask | null =
    interactiveChat && workbenchTask?.id === interactiveChat.task.id
      ? {
          ...interactiveChat.task,
          workbenchRoles: workbenchTask.workbenchRoles,
          workbenchAction: workbenchTask.workbenchAction,
        }
      : null

  /** 当前节点自己的任务数据；当前节点无任务时不得复用上一节点 */
  const currentNodeChat: TaskChatSnapshot | null =
    currentNodeTaskId && taskChat?.task.id === currentNodeTaskId
      ? taskChat
      : null
  const currentNodeStage =
    currentNodeChat?.pipeline.find(
      (stage) => stage.task.id === currentNodeTaskId,
    ) ?? null
  const currentNodeTask: WorkbenchTask | null =
    currentNodeChat &&
    (currentNodeChat.task.id === interactiveTask?.id ||
      currentNodeChat.task.id === workbenchTask?.id)
      ? {
          ...currentNodeChat.task,
          workbenchRoles:
            interactiveTask?.id === currentNodeChat.task.id
              ? (interactiveTask.workbenchRoles ?? [])
              : (workbenchTask?.workbenchRoles ?? []),
          workbenchAction:
            interactiveTask?.id === currentNodeChat.task.id
              ? (interactiveTask.workbenchAction ?? null)
              : (workbenchTask?.workbenchAction ?? null),
        }
      : null
  const currentAgentName = currentNodeStage?.agent?.name ?? null

  const currentMessages = useMemo(
    () =>
      currentNodeTaskId
        ? (taskChat?.messages ?? []).filter(
            (message) => message.taskId === currentNodeTaskId,
          )
        : [],
    [taskChat, currentNodeTaskId],
  )

  /** 待回答的机器人提问（去重） */
  const pendingQuestions = useMemo(() => {
    return Array.from(
      new Map(
        currentMessages
          .map((message) => message.question)
          .filter(
            (question): question is TaskChatQuestion =>
              Boolean(question && question.state === 'pending'),
          )
          .map((question) => [question.id, question]),
      ).values(),
    )
  }, [currentMessages])

  /** 回答/跳过当前节点任务的机器人提问 */
  const replyQuestion = useCallback(
    async (questionId: string, answers: string[][] | null) => {
      if (!currentNodeTaskId) return
      setReplying(true)
      try {
        await api.replyTaskQuestion(
          currentNodeTaskId,
          questionId,
          answers ? { answers } : { reject: true },
        )
        await loadTaskData()
        setExtrasRevision((value) => value + 1)
      } finally {
        setReplying(false)
      }
    },
    [currentNodeTaskId, loadTaskData],
  )

  /** 提交补充内容：执行中直接投递 opencode 会话，等待阶段并入恢复提示 */
  const sendSupplement = useCallback(
    async (content: string) => {
      if (!currentNodeTaskId) return
      await api.sendTaskMessage(currentNodeTaskId, content)
      await loadTaskData()
      setExtrasRevision((value) => value + 1)
    },
    [currentNodeTaskId, loadTaskData],
  )

  /** 会话发送、答复或助理回合结束后刷新工单与节点任务数据 */
  const refreshTicket = useCallback(async () => {
    const row = await load()
    const nextTaskId = latestTaskId(row?.workflow)
    if (nextTaskId && nextTaskId === activeTaskId) await loadTaskData()
    setExtrasRevision((value) => value + 1)
  }, [load, activeTaskId, loadTaskData])

  if (!ticket && error) {
    return (
      <p className="rounded-[var(--radius-md)] bg-error-muted px-3 py-2 text-sm text-error-foreground">
        加载失败：{error}
      </p>
    )
  }
  if (!ticket) {
    return <p className="text-sm text-foreground-muted">加载中…</p>
  }

  const workflow = ticket.workflow
  const canAccept =
    workflow &&
    ticket.workflowStatus === '待验收' &&
    workflow.currentNodeKey &&
    !workflow.autoAcceptance

  if (workflow) {
    const listPath = `/tickets/wf/${workflow.definitionId}`
    const inputEntries = Object.entries(workflow.inputValues)
    const startFields =
      workflow.nodes.find((node) => node.kind === 'start')?.inputFields ?? []
    const fieldByKey = new Map(startFields.map((field) => [field.key, field]))
    const iterationCodeById = new Map(
      iterations.map((iteration) => [String(iteration.id), iteration.code]),
    )
    const backlogById = new Map(
      backlogs.map((backlog) => [String(backlog.id), backlog]),
    )
    const nodeTaskCode = currentNodeChat?.task.code
    /** 仅操作/审批节点创建节点任务；起始/验收节点只保留「我的AI」 */
    const currentNode = workflow.nodes.find(
      (node) => node.key === workflow.currentNodeKey,
    )
    const isTaskNode =
      currentNode?.kind === 'operation' || currentNode?.kind === 'approval'
    /** 审批节点当前任务与操作权限（不依赖工作台数据，加载失败也可审批） */
    const canApprove =
      currentNode?.kind === 'approval' &&
      Boolean(currentNodeTaskId) &&
      !currentNodeRun?.taskStatus?.startsWith('已结束') &&
      (currentNodeRun?.status === '等待中' ||
        currentNodeRun?.status === '执行中') &&
      (Boolean(currentNodeTask?.workbenchRoles.includes('agent')) ||
        currentUser?.id === ticket.createdById ||
        currentUser?.role === '管理员')

    const pageHeader = (
      <>
        <PageBreadcrumb
          items={[
            { label: '工单', to: '/tickets' },
            { label: workflow.definitionName, to: listPath },
            { label: ticket.code },
          ]}
        />

        <header className="shrink-0">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-semibold text-foreground-intense">
                  {ticket.code} {ticket.title}
                </h1>
                <TicketStatusBadge status={ticket.status} />
                <Badge variant="outline" size="sm">
                  {workflow.definitionName} v{workflow.version}
                </Badge>
                <Badge variant="secondary" size="sm">
                  发起机器人 ·{' '}
                  {ticket.initiatorWorkerName ?? ticket.createdByName}
                </Badge>
                {workflow.autoAcceptance && (
                  <Badge variant="soft" size="sm">含自动验收</Badge>
                )}
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground-muted">
                <span>
                  创建于 {new Date(ticket.createdAt).toLocaleString()}
                </span>
                <span>·</span>
                <span>当前节点 {ticket.currentNodeName ?? '未开始'}</span>
              </p>
            </div>
            <TaskActions
              task={isTaskNode ? currentNodeTask : null}
              chat={isTaskNode ? currentNodeChat : null}
              handoffDoc={
                currentNodeTaskId && currentNodeTaskId === activeTaskId
                  ? handoffDoc
                  : null
              }
              hideApproval
              onRefresh={refreshTicket}
              className="pt-0.5"
            />
          </div>
        </header>

        {(actionError || error) && (
          <p
            role="alert"
            className="rounded-[var(--radius-md)] bg-error-muted px-3 py-2 text-sm text-error-foreground"
          >
            {actionError ?? error}
          </p>
        )}
      </>
    )

    return (
      <div className="flex h-full min-h-0 flex-col gap-4">
        {pageHeader}
        <div className="flex min-h-0 flex-1 flex-col">
          <DetailPageLayout
            aiLabel="我的助理"
            aiCollapsible
            aiOutsideContent
            aiOpen={collaborationOpen}
            onAiOpenChange={setCollaborationOpen}
            aiUnreadCount={collaborationUnread}
            ai={
              <DetailAgentPanel
                taskId={currentNodeTaskId ?? undefined}
                title="我的助理"
                visible={collaborationOpen}
                onUnreadChange={setCollaborationUnread}
                emptyTitle={`${nodeTaskCode ?? ticket.code} 的独立 AI 会话`}
                emptyHint="当前工单的对话与其它页面相互隔离；让 AI 查询、创建或推进任务"
                placeholder={`让 AI 处理 ${nodeTaskCode ?? ticket.code}，或输入其它指令…`}
                onRunFinished={() => {
                  void refreshTicket()
                }}
              />
            }
          >
            <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border bg-background">
              <div className="shrink-0 overflow-x-auto px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div
                    role="tablist"
                    aria-label="工单详情正文"
                    className="inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-[var(--radius-lg)] bg-background-muted p-1"
                  >
                    {TICKET_CONTENT_TABS.map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        role="tab"
                        aria-selected={contentTab === key}
                        onClick={() => setContentTab(key)}
                        className={`shrink-0 whitespace-nowrap rounded-[var(--radius-md)] px-3 py-1.5 text-sm transition-colors ${
                          contentTab === key
                            ? 'bg-background font-medium text-foreground-intense shadow-sm'
                            : 'text-foreground-muted hover:bg-background/60 hover:text-foreground-intense'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {canAccept && (
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={acting !== null}
                        onClick={() => act('reject')}
                      >
                        验收驳回
                      </Button>
                      <Button size="sm" disabled={acting !== null} onClick={() => act('accept')}>
                        验收通过
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              {(contentTab === 'current' ||
                contentTab === 'events' ||
                contentTab === 'tasks') &&
                taskError && (
                  <p
                    role="alert"
                    className="mx-3 mb-2 shrink-0 rounded-[var(--radius-md)] bg-error-muted px-3 py-2 text-sm text-error-foreground"
                  >
                    加载失败：{taskError}
                  </p>
                )}

              <div className="flex min-h-0 flex-1 flex-col p-3">
            {contentTab === 'current' && (
              <TicketCurrentNodePanel
                workflow={workflow}
                currentTask={currentNodeStage?.task ?? null}
                agentName={currentAgentName}
                messages={currentMessages}
                pendingQuestions={pendingQuestions}
                replying={replying}
                approvalTaskId={currentNodeTaskId}
                canApprove={canApprove}
                approvalAction={approvalAction}
                onApprovalInitialHandled={clearApprovalParam}
                onApprovalRefresh={refreshTicket}
                onReplyQuestion={replyQuestion}
                onSend={sendSupplement}
              />
            )}

            {contentTab === 'progress' && (
              <section className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
                <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                  <h2 className="text-sm font-semibold text-foreground-intense">
                    流程进度
                  </h2>
                  <span className="text-xs text-foreground-muted">
                    当前节点：{ticket.currentNodeName || '流程已结束'}
                  </span>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <Table hoverableRows>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-16">顺序</TableHead>
                        <TableHead className="w-40">节点</TableHead>
                        <TableHead className="w-36">处理机器人</TableHead>
                        <TableHead className="w-24">状态</TableHead>
                        <TableHead className="w-24">结果</TableHead>
                        <TableHead>任务</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {workflow.runs.map((run, index) => (
                        <TableRow key={run.id}>
                          <TableCell>{index + 1}</TableCell>
                          <TableCell>
                            <span className="font-medium">{run.nodeName}</span>
                            <span className="ml-1 text-xs text-foreground-muted">
                              第 {run.attempt} 次
                            </span>
                            {run.note && (
                              <p
                                className={`mt-1 text-xs ${
                                  run.status === '已失败'
                                    ? 'text-error-foreground'
                                    : 'text-foreground-muted'
                                }`}
                              >
                                {run.note}
                              </p>
                            )}
                          </TableCell>
                          <TableCell>
                            {run.agentName ??
                              ticket.initiatorWorkerName ??
                              '发起机器人'}
                          </TableCell>
                          <TableCell>{run.status}</TableCell>
                          <TableCell>
                            {run.outcome
                              ? OUTCOME_LABEL[run.outcome] ?? run.outcome
                              : '—'}
                          </TableCell>
                          <TableCell>
                            {run.taskId ? (
                              <Link
                                to={`/tasks/${run.taskId}`}
                                className="font-mono text-xs hover:underline"
                              >
                                TK-{String(run.taskId).padStart(4, '0')}
                                {run.taskStatus ? ` · ${run.taskStatus}` : ''}
                              </Link>
                            ) : (
                              '—'
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                      {workflow.runs.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={6} className="text-foreground-muted">
                            暂无节点运行记录
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </section>
            )}

            {contentTab === 'info' && (
              <section className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
                <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                  <h2 className="text-sm font-semibold text-foreground-intense">
                    工单信息
                  </h2>
                  <span className="font-mono text-xs text-foreground-muted">
                    {ticket.code}
                  </span>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <div className="flex flex-col gap-5">
                    <section>
                      <h3 className="text-sm font-semibold text-foreground-intense">
                        需求正文
                      </h3>
                      <p className="mt-1 text-xs text-foreground-muted">
                        发起工单时填写的工单描述
                      </p>
                      <div className="mt-2 text-sm">
                        {ticket.description?.trim() ? (
                          <MarkdownViewer text={ticket.description} />
                        ) : (
                          <p className="text-foreground-muted">无需求正文</p>
                        )}
                      </div>
                    </section>
                    <section>
                      <h3 className="text-sm font-semibold text-foreground-intense">
                        工单输入
                      </h3>
                      <p className="mt-1 text-xs text-foreground-muted">
                        起始节点提交的结构化信息
                      </p>
                      <div className="mt-2 flex flex-col gap-2 text-sm">
                        {inputEntries.length === 0 && (
                          <p className="text-foreground-muted">无结构化输入</p>
                        )}
                        {inputEntries.map(([key, value]) => {
                          const field = fieldByKey.get(key)
                          const iterationField =
                            field?.type === 'iteration' ||
                            field?.type === 'iteration_multi'
                          const backlogField =
                            field?.type === 'backlog' ||
                            field?.type === 'backlog_multi'
                          const optionsField =
                            field?.type === 'select' ||
                            field?.type === 'multiselect'
                          const values = (
                            Array.isArray(value)
                              ? value.map((item) => String(item))
                              : String(value ?? '').split(',')
                          ).filter(Boolean)
                          const text = iterationField
                            ? values
                                .map(
                                  (iterationId) =>
                                    iterationCodeById.get(iterationId) ??
                                    `#${iterationId}`,
                                )
                                .join('、')
                            : optionsField
                              ? values.join('、')
                              : typeof value === 'object' && value !== null
                                ? JSON.stringify(value)
                                : String(value ?? '')
                          return (
                            <div
                              key={key}
                              className="rounded-[var(--radius-md)] bg-background-muted px-3 py-2"
                            >
                              <p className="text-xs text-foreground-muted">
                                {field?.label ?? key}
                              </p>
                              {backlogField ? (
                                values.length === 0 ? (
                                  <p className="mt-1 text-foreground-muted">—</p>
                                ) : (
                                  <ul className="mt-1 flex flex-col gap-1.5">
                                    {values.map((backlogId) => {
                                      const backlog =
                                        backlogById.get(backlogId)
                                      return backlog ? (
                                        <BacklogInputLine
                                          key={backlogId}
                                          backlog={backlog}
                                        />
                                      ) : (
                                        <li key={backlogId}>
                                          <Badge variant="outline" size="sm">
                                            #{backlogId}
                                          </Badge>
                                        </li>
                                      )
                                    })}
                                  </ul>
                                )
                              ) : optionsField || iterationField ? (
                                values.length === 0 ? (
                                  <p className="mt-1 text-foreground-muted">—</p>
                                ) : (
                                  <div className="mt-1 flex flex-wrap gap-1.5">
                                    {values.map((item) => (
                                      <Badge
                                        key={item}
                                        variant="outline"
                                        size="sm"
                                      >
                                        {iterationField
                                          ? iterationCodeById.get(item) ??
                                            `#${item}`
                                          : item}
                                      </Badge>
                                    ))}
                                  </div>
                                )
                              ) : field?.type === 'textarea' ? (
                                text ? (
                                  <MarkdownViewer text={text} className="mt-1" />
                                ) : (
                                  <p className="mt-1 text-foreground-muted">—</p>
                                )
                              ) : (
                                <p className="mt-1 break-all whitespace-pre-wrap">
                                  {text || '—'}
                                </p>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  </div>
                </div>
              </section>
            )}

            {contentTab === 'events' &&
              (activeTaskId ? (
                <TaskEventsPanel events={interactiveChat?.events ?? []} />
              ) : (
                <EmptyTabPanel text="暂无节点任务事件" />
              ))}

            {contentTab === 'tasks' &&
              (activeTaskId ? (
                <TaskTreePanel
                  pipeline={interactiveChat?.pipeline ?? []}
                  currentTaskId={activeTaskId}
                  onOpenTask={(taskId) => navigate(`/tasks/${taskId}`)}
                />
              ) : (
                <EmptyTabPanel text="暂无节点任务" />
              ))}

            {contentTab === 'documents' &&
              (activeTaskId ? (
                <TaskDocumentsPanel
                  data={documents}
                  loading={extrasLoading}
                  error={extrasError}
                />
              ) : (
                <EmptyTabPanel text="暂无任务文档" />
              ))}

            {contentTab === 'review' &&
              (activeTaskId ? (
                <TaskMarkdownDocumentView
                  title="复盘文档"
                  subtitle={reviewDoc?.path}
                  meta={
                    reviewDoc?.updatedAt
                      ? `更新于 ${new Date(reviewDoc.updatedAt).toLocaleString()}`
                      : null
                  }
                  content={reviewDoc?.content}
                  loading={extrasLoading && !reviewDoc}
                  error={!reviewDoc ? extrasError : null}
                  emptyText={
                    ticket.status === '已完成'
                      ? '该工单按工作流完成，未生成复盘文档'
                      : '工作流节点任务不自动生成复盘文档'
                  }
                  contentKey={reviewDoc?.updatedAt}
                />
              ) : (
                <EmptyTabPanel text="节点任务完成后由平台生成复盘文档" />
              ))}
            {contentTab === 'topics' && (
              <TopicsPanel
                subjectType="工单"
                subjectId={ticket.id}
                subjectTitle={ticket.title}
                focusTopicId={focusTopicId}
              />
            )}
          </div>
          </div>
        </DetailPageLayout>
      </div>
    </div>
    )
  }

  if (!ticket.taskId || !ticket.task) {
    return (
      <p className="rounded-[var(--radius-md)] bg-error-muted px-3 py-2 text-sm text-error-foreground">
        工单关联的任务已不存在，请检查任务中心
      </p>
    )
  }

  const legacyCategoryPath = '/tickets'

  return (
    <TaskDetailView
      taskId={ticket.taskId}
      breadcrumb={[
        { label: ticket.category, to: legacyCategoryPath },
        { label: ticket.code },
      ]}
      title={`${ticket.code} ${ticket.title}`}
      collapsibleCollaboration
      syncTabHash
      focusTopicId={focusTopicId}
      extraBadges={
        <>
          <Badge variant="soft" size="sm">
            {ticket.category}
          </Badge>
          <TicketStatusBadge status={ticket.status} />
          <Badge variant="secondary" size="sm">
            处理机器人 · {ticket.assigneeName}
          </Badge>
        </>
      }
    />
  )
}

/** 无节点任务时的空态占位（与任务文档等面板同款外框样式） */
function EmptyTabPanel({ text }: { text: string }) {
  return (
    <section className="flex h-full min-h-0 flex-col items-center justify-center bg-background">
      <p className="text-sm text-foreground-muted">{text}</p>
    </section>
  )
}

function upsertMessage(
  current: TaskChatMessage[],
  message: TaskChatMessage,
): TaskChatMessage[] {
  const index = current.findIndex((item) => item.id === message.id)
  if (index < 0) {
    return [...current, message].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
  }
  const next = current.slice()
  next[index] = message
  return next
}

function upsertStage(
  current: TaskPipelineStage[],
  stage: TaskPipelineStage,
): TaskPipelineStage[] {
  const index = current.findIndex((item) => item.task.id === stage.task.id)
  if (index < 0) {
    return [...current, stage].sort(
      (a, b) =>
        a.task.sortOrder - b.task.sortOrder || a.task.id - b.task.id,
    )
  }
  const next = current.slice()
  next[index] = stage
  return next
}
