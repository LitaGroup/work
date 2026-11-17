import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import { Skeleton } from '@appica/ui-react/skeleton'
import {
  api,
  type TaskChatMessage,
  type TaskChatPerspective,
  type TaskChatSnapshot,
  type TaskChatStreamMessage,
  type TaskDocumentContent,
  type TaskDocumentsView,
  type TaskHandoffDocument,
  type TaskPackage,
  type TaskPipelineStage,
  type WorkbenchTask,
} from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { TaskStatusBadge } from '../components/StatusBadge'
import { PageBreadcrumb, type Crumb } from '../components/PageBreadcrumb'
import { DetailPageLayout } from '../components/detail/DetailPageLayout'
import { TopicsPanel } from '../components/topics/TopicsPanel'
import { DetailAgentPanel } from '../components/detail/DetailAgentPanel'
import { TaskActions } from '../components/task-detail/TaskActions'
import { TaskConversationView } from '../components/task-detail/TaskConversationView'
import { TaskDocumentsPanel } from '../components/task-detail/TaskDocumentsPanel'
import { TaskEventsPanel } from '../components/task-detail/TaskEventsPanel'
import { TaskInfoPanel } from '../components/task-detail/TaskInfoPanel'
import { TaskRequirementPanel } from '../components/task-detail/TaskRequirementPanel'
import { TaskTreePanel } from '../components/task-detail/TaskTreePanel'
import {
  HandoffDocumentStatus,
  TaskMarkdownDocumentView,
} from '../components/task-detail/TaskMarkdownDocumentView'
import type { MarkdownEditorHandle } from '../components/MarkdownEditor'
import { formatDuration, taskDurationMs } from '../lib/duration'
import { visibleEventSource } from '../lib/event-source'

type ConnectionState = 'connecting' | 'live' | 'reconnecting'
type TaskContentTab =
  | 'handoff'
  | 'requirement'
  | 'tasks'
  | 'info'
  | 'events'
  | 'documents'
  | 'conversation'
  | 'review'
  | 'topics'

const TASK_CONTENT_TABS: Array<[TaskContentTab, string]> = [
  ['requirement', '需求'],
  ['handoff', '交付'],
  ['tasks', '任务'],
  ['info', '信息'],
  ['events', '事件'],
  ['documents', '文档'],
  ['conversation', '会话'],
  ['review', '复盘'],
  ['topics', '话题'],
]

const TASK_CONTENT_TAB_KEYS = TASK_CONTENT_TABS.map(([key]) => key)

/** 从 URL hash 读取分区（如 /tasks/302#documents），不在页签列表内回退默认 */
function readTaskTabFromHash(fallback: TaskContentTab): TaskContentTab {
  const key = window.location.hash.replace(/^#/, '')
  return TASK_CONTENT_TAB_KEYS.includes(key as TaskContentTab)
    ? (key as TaskContentTab)
    : fallback
}

/**
 * 任务详情：正文按「需求 / 交付 / 任务 / 信息 / 事件 / 文档 / 会话 / 复盘」组织，
 * 默认打开「需求」；右侧固定为「我的助理」个人 AI 会话。
 * 正文「会话」实时展示多方交互，并按当前用户身份发送消息、答复机器人提问。
 */
export function TaskPackageDetailPage() {
  const { id, topicId } = useParams<{ id: string; topicId?: string }>()
  return (
    <TaskDetailView
      taskId={Number(id)}
      collapsibleCollaboration
      syncTabHash
      focusTopicId={topicId ? Number(topicId) : undefined}
    />
  )
}

/**
 * 可复用的任务详情主体：工单详情页补充工单面包屑与状态徽标；
 * 工作台隐藏任务面包屑，并开放「交付」Tab 的 HANDOFF 创建/编辑。
 */
export function TaskDetailView({
  taskId,
  breadcrumb,
  title,
  extraBadges,
  hideBreadcrumb = false,
  handoffEditable = false,
  collapsibleCollaboration = false,
  syncTabHash = false,
  onTaskChange,
  onOpenTask,
  focusTopicId,
}: {
  taskId: number
  breadcrumb?: Crumb[]
  title?: string
  extraBadges?: ReactNode
  /** 嵌入工作台时隐藏面包屑（工作台保留自己的左侧任务列表） */
  hideBreadcrumb?: boolean
  /** 工作台模式：需求方/执行方可在「交付」Tab 创建与编辑交付文档 */
  handoffEditable?: boolean
  /** 普通详情页：右侧「我的助理」外置并默认收起；工作台保持常驻 */
  collapsibleCollaboration?: boolean
  /** 分区与 URL hash 双向同步（/tasks/302#documents 直达）；工单详情与工作台保持原状 */
  syncTabHash?: boolean
  /** 任务或文档刷新后通知外部，用于同步工作台左侧任务列表 */
  onTaskChange?: () => void | Promise<void>
  /** 打开关联任务：普通详情默认跳转任务中心，工作台可切换当前任务 */
  onOpenTask?: (taskId: number) => void
  /** 话题详情深链（/tasks/{id}/topics/{topicId}）：默认打开话题分区并定位 */
  focusTopicId?: number
}) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [task, setTask] = useState<TaskPackage | null>(null)
  /** 根任务所属需求（子任务兜底「需求」分区关联跳转） */
  const [rootProjectId, setRootProjectId] = useState<number | null>(null)
  const [workbenchTask, setWorkbenchTask] = useState<WorkbenchTask | null>(null)
  const [pipeline, setPipeline] = useState<TaskPipelineStage[]>([])
  const [messages, setMessages] = useState<TaskChatMessage[]>([])
  const [hasAcceptanceApplication, setHasAcceptanceApplication] =
    useState(false)
  const [requesterName, setRequesterName] = useState<string | null>(null)
  const [agentOwnerName, setAgentOwnerName] = useState<string | null>(null)
  const [interventionCount, setInterventionCount] = useState(0)
  const [events, setEvents] = useState<TaskChatSnapshot['events']>([])
  const [now, setNow] = useState(() => Date.now())
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [contentTab, setContentTab] = useState<TaskContentTab>(() =>
    syncTabHash
      ? readTaskTabFromHash(focusTopicId ? 'topics' : 'requirement')
      : focusTopicId
        ? 'topics'
        : 'requirement',
  )
  const [handoffDoc, setHandoffDoc] = useState<TaskHandoffDocument | null>(null)
  const [reviewDoc, setReviewDoc] = useState<TaskDocumentContent | null>(null)
  const [documents, setDocuments] = useState<TaskDocumentsView | null>(null)
  const [docsLoading, setDocsLoading] = useState(true)
  const [docsError, setDocsError] = useState<string | null>(null)
  /** 文档写入（交付/复盘/普通文档）后由任务 SSE 递增，驱动只读预览刷新 */
  const [docsRevision, setDocsRevision] = useState(0)
  const [collaborationOpen, setCollaborationOpen] = useState(false)
  const [collaborationUnread, setCollaborationUnread] = useState(0)
  const [handoffEditing, setHandoffEditing] = useState(false)
  const [handoffSaving, setHandoffSaving] = useState(false)
  const [handoffError, setHandoffError] = useState<string | null>(null)
  const handoffEditorRef = useRef<MarkdownEditorHandle>(null)
  /** 文档刷新时保留正在编辑的本地版本，避免远端版本变化重挂载编辑器 */
  const handoffEditingRef = useRef(false)
  const onTaskChangeRef = useRef(onTaskChange)

  const loadSeq = useRef(0)
  /** 首次快照请求是否已返回（用于与 SSE ready 对齐，避免重复加载） */
  const initialSettledRef = useRef(false)
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    setLoading(true)
    try {
      const data: TaskChatSnapshot = await api.getTaskChat(taskId)
      if (seq !== loadSeq.current) return
      setTask(data.task)
      setRootProjectId(data.rootTask?.projectId ?? null)
      setPipeline(data.pipeline)
      // 后端已按当前任务返回消息；这里再按 taskId 收敛一次，避免旧服务或异常数据串任务
      setMessages(data.messages.filter((message) => message.taskId === taskId))
      setHasAcceptanceApplication(data.hasAcceptanceApplication)
      setRequesterName(data.requesterName)
      setAgentOwnerName(data.agentOwnerName)
      setInterventionCount(data.interventionCount)
      setEvents(data.events)
      setError(null)
    } catch (e) {
      if (seq === loadSeq.current) setError((e as Error).message)
    } finally {
      if (seq === loadSeq.current) {
        setLoading(false)
        initialSettledRef.current = true
      }
    }
  }, [taskId])

  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  useEffect(() => {
    onTaskChangeRef.current = onTaskChange
  }, [onTaskChange])

  useEffect(() => {
    handoffEditingRef.current = handoffEditing
  }, [handoffEditing])

  useEffect(() => {
    // 切换任务时退出交付文档编辑，避免把上一个任务的正文带到新任务
    // oxlint-disable-next-line react/set-state-in-effect
    setHandoffEditing(false)
    // oxlint-disable-next-line react/set-state-in-effect
    setHandoffSaving(false)
    // oxlint-disable-next-line react/set-state-in-effect
    setHandoffError(null)
  }, [taskId])

  // 分区与 URL hash 双向同步：支持 /tasks/302#documents 直达，切换分区时更新 hash
  useEffect(() => {
    if (!syncTabHash) return
    const sync = () =>
      setContentTab(
        readTaskTabFromHash(focusTopicId ? 'topics' : 'requirement'),
      )
    sync()
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [syncTabHash, taskId, focusTopicId])

  /** 切换分区：开启 hash 同步时更新地址栏（replaceState 不产生历史记录） */
  const changeContentTab = (key: TaskContentTab) => {
    setContentTab(key)
    if (!syncTabHash) return
    if (window.location.hash.replace(/^#/, '') !== key) {
      window.history.replaceState(null, '', `#${key}`)
    }
  }

  /** 「会话」页签未读：停留在其它分区时累计新消息，进入会话即清零 */
  const [conversationUnread, setConversationUnread] = useState(0)
  const conversationUnreadRef = useRef(0)
  const seenConversationIdsRef = useRef(new Set<string>())
  const conversationTaskRef = useRef<number | null>(null)
  /** 当前任务的会话是否已完成首次对齐（此后到达的消息才计入未读） */
  const conversationSeededRef = useRef(false)
  useEffect(() => {
    const emit = (next: number) => {
      if (conversationUnreadRef.current === next) return
      conversationUnreadRef.current = next
      setConversationUnread(next)
    }
    // 切换任务时重新对齐，避免把上一个任务的角标带过来
    if (conversationTaskRef.current !== taskId) {
      conversationTaskRef.current = taskId
      conversationSeededRef.current = false
      seenConversationIdsRef.current = new Set()
      emit(0)
    }
    if (!conversationSeededRef.current) {
      // 首屏快照返回前不累计未读，避免刚打开任务就出现角标
      for (const message of messages) {
        seenConversationIdsRef.current.add(message.id)
      }
      if (messages.length > 0 || !loading) conversationSeededRef.current = true
      emit(0)
      return
    }
    if (contentTab === 'conversation') {
      for (const message of messages) {
        seenConversationIdsRef.current.add(message.id)
      }
      emit(0)
      return
    }
    const ownSenderId = user ? `user:${user.name ?? user.id}` : null
    let added = 0
    for (const message of messages) {
      if (message.taskId !== taskId) continue
      if (seenConversationIdsRef.current.has(message.id)) continue
      seenConversationIdsRef.current.add(message.id)
      if (
        ownSenderId &&
        message.sender.kind === 'user' &&
        message.sender.id === ownSenderId
      ) {
        continue
      }
      added += 1
    }
    if (added > 0) emit(conversationUnreadRef.current + added)
  }, [messages, contentTab, taskId, user, loading])

  /** 当前用户在该任务中的工作台角色；加载失败时降级为仅「我的 AI」 */
  const roleSeq = useRef(0)
  const loadWorkbenchTask = useCallback(async () => {
    const seq = ++roleSeq.current
    try {
      const data = await api.getWorkbenchTask(taskId)
      if (seq === roleSeq.current) setWorkbenchTask(data)
    } catch {
      // 瞬态失败保留已加载角色；首次失败降级为仅「我的 AI」
      if (seq === roleSeq.current) {
        setWorkbenchTask((current) =>
          current?.id === taskId ? current : null,
        )
      }
    }
  }, [taskId])

  const loadWorkbenchTaskRef = useRef(loadWorkbenchTask)
  useEffect(() => {
    loadWorkbenchTaskRef.current = loadWorkbenchTask
  }, [loadWorkbenchTask])

  useEffect(() => {
    // 首次拉取任务对话与当前用户角色；setState 均在 fetch 完成后的异步回调里触发
    initialSettledRef.current = false
    // oxlint-disable-next-line react/set-state-in-effect
    void load()
    // oxlint-disable-next-line react/set-state-in-effect
    void loadWorkbenchTask()
  }, [load, loadWorkbenchTask])

  /** 任务文档数据：交付 / 复盘 / 文档清单；SSE 文档刷新时整体重读 */
  const docsSeq = useRef(0)
  const loadTaskDocuments = useCallback(async () => {
    const seq = ++docsSeq.current
    setDocsLoading(true)
    try {
      const [handoff, review, documentList] = await Promise.all([
        api.getTaskHandoff(taskId),
        api.getTaskReview(taskId),
        api.listTaskDocuments(taskId),
      ])
      if (seq !== docsSeq.current) return
      setHandoffDoc((current) =>
        handoffEditingRef.current && current ? current : handoff,
      )
      setReviewDoc(review)
      setDocuments(documentList)
      setDocsError(null)
    } catch (e) {
      if (seq === docsSeq.current) setDocsError((e as Error).message)
    } finally {
      if (seq === docsSeq.current) setDocsLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    // 打开详情及每次文档变更事件后重读任务文档
    // oxlint-disable-next-line react/set-state-in-effect
    void loadTaskDocuments()
  }, [loadTaskDocuments, docsRevision])

  /** 会话发送、答复提问或助理回合结束后同步刷新任务、角色与文档 */
  const refreshTaskPanel = useCallback(async () => {
    await Promise.all([
      loadRef.current(),
      loadWorkbenchTaskRef.current(),
      loadTaskDocuments(),
    ])
    await onTaskChangeRef.current?.()
  }, [loadTaskDocuments])

  /** 工作台维护交付文档：保存时以读取到的版本为基准，版本冲突由后端返回 409 */
  const saveHandoff = useCallback(async () => {
    if (
      !handoffEditable ||
      !handoffEditing ||
      handoffSaving ||
      !handoffDoc ||
      task?.id !== taskId
    ) {
      return
    }
    setHandoffSaving(true)
    setHandoffError(null)
    try {
      const content =
        handoffEditorRef.current?.getMarkdown() ?? handoffDoc.content
      const document = await api.updateWorkbenchHandoff(taskId, {
        content,
        baseVersion: handoffDoc.version,
      })
      setHandoffDoc(document)
      setHandoffEditing(false)
      await Promise.all([loadRef.current(), loadWorkbenchTaskRef.current()])
      // 编辑态引用会在下一次渲染后更新，此处触发文档重读以同步文档 Tab 与状态
      setDocsRevision((value) => value + 1)
      await onTaskChangeRef.current?.()
    } catch (error) {
      setHandoffError((error as Error).message)
    } finally {
      setHandoffSaving(false)
    }
  }, [handoffEditable, handoffEditing, handoffSaving, handoffDoc, task, taskId])

  const cancelHandoffEditing = useCallback(() => {
    setHandoffEditing(false)
    setHandoffError(null)
    // 取消编辑后重读一次交付文档，丢弃编辑期间可能到达的远端更新
    setDocsRevision((value) => value + 1)
  }, [])

  // 持续时间展示：未结束任务定时刷新
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])

  // 任务聊天 SSE：机器人文本增量 / 工具调用 / PIPELINE 阶段变化 / 快照刷新信号
  useEffect(() => {
    let closed = false
    let refreshTimer: number | undefined
    const source = visibleEventSource(`/api/tasks/${taskId}/chat/stream`)

    source.onopen = () => {
      if (!closed) setConnection('live')
    }
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
          setConnection('live')
          // 首次快照请求已先于 SSE 就绪完成 → 补一次对齐，覆盖订阅建立前的间隙；
          // 请求仍在途则跳过（避免进入页面重复加载），活跃任务的事件会经 refresh 持续补偿
          if (initialSettledRef.current) {
            void loadRef.current()
            void loadWorkbenchTaskRef.current()
            setDocsRevision((value) => value + 1)
          }
          break
        case 'message.upsert':
          if (data.message.taskId !== taskId) break
          setMessages((current) => upsertMessage(current, data.message))
          break
        case 'stage.upsert':
          setPipeline((current) => upsertStage(current, data.stage))
          setTask((current) =>
            current?.id === data.stage.task.id ? data.stage.task : current,
          )
          break
        case 'stage.delete':
          setPipeline((current) =>
            current.filter((stage) => !data.ids.includes(stage.task.id)),
          )
          break
        case 'refresh':
          if (refreshTimer) window.clearTimeout(refreshTimer)
          refreshTimer = window.setTimeout(() => {
            refreshTimer = undefined
            void loadRef.current()
            void loadWorkbenchTaskRef.current()
            // 文档、交付、复盘与任务详情共用同一个刷新信号
            setDocsRevision((value) => value + 1)
          }, 120)
          break
        default:
          // ping 仅保活
          break
      }
    }
    source.onerror = () => {
      if (!closed) setConnection('reconnecting')
    }

    return () => {
      closed = true
      source.close()
      if (refreshTimer) window.clearTimeout(refreshTimer)
    }
  }, [taskId])

  /** 回答/跳过提问：待反馈走 project 答复，历史会话兼容 opencode reply/reject */
  const replyQuestion = useCallback(
    async (questionId: string, answers: string[][] | null) => {
      setBusy(true)
      setError(null)
      try {
        await api.replyTaskQuestion(
          taskId,
          questionId,
          answers ? { answers } : { reject: true },
        )
        setMessages((current) =>
          current.map((message) => {
            const question = message.question
            if (!question || question.id !== questionId) return message
            return {
              ...message,
              status: 'complete',
              question: {
                ...question,
                state: answers ? ('answered' as const) : ('rejected' as const),
                answers: answers ?? undefined,
              },
            }
          }),
        )
        // 答复后任务可能从「待反馈」推进到「待继续」，同步刷新任务与角色
        await refreshTaskPanel()
      } catch (e) {
        setError((e as Error).message)
        throw e
      } finally {
        setBusy(false)
      }
    },
    [taskId, refreshTaskPanel],
  )

  const currentTask = task?.id === taskId ? task : null
  /** 角色取工作台单任务接口，任务状态取实时聊天快照，避免操作后状态滞后 */
  const interactiveTask: WorkbenchTask | null =
    currentTask && workbenchTask?.id === currentTask.id
      ? {
          ...currentTask,
          workbenchRoles: workbenchTask.workbenchRoles,
          workbenchAction: workbenchTask.workbenchAction,
        }
      : null
  const canEditHandoff = Boolean(
    handoffEditable &&
      interactiveTask &&
      currentTask &&
      currentTask.status !== '已结束' &&
      currentTask.subStatus !== '待验收' &&
      (interactiveTask.workbenchRoles.includes('requester') ||
        interactiveTask.workbenchRoles.includes('agent')),
  )
  const interactiveChat: TaskChatSnapshot | null = currentTask
    ? {
        task: currentTask,
        rootTask: currentTask,
        pipeline,
        messages,
        requesterName,
        agentOwnerName,
        interventionCount,
        hasAcceptanceApplication,
        events,
      }
    : null

  const conversationRoles = interactiveTask?.workbenchRoles ?? []
  const isAdmin = user?.role === '管理员'

  /** 会话发送：按当前用户角色自动选择身份与投递接口；返回错误文案，成功为 null */
  const sendConversationMessage = useCallback(
    async (
      text: string,
      perspective: TaskChatPerspective,
    ): Promise<string | null> => {
      if (!currentTask || currentTask.id !== taskId) {
        return '任务尚未加载完成'
      }
      if (currentTask.status === '已结束') return '任务已结束，不能继续对话'
      const roles =
        workbenchTask?.id === taskId ? workbenchTask.workbenchRoles : []
      if (perspective === 'requester' && !roles.includes('requester')) {
        return '仅需求方可以需求方身份发送消息'
      }
      if (perspective === 'responsible' && !roles.includes('agent')) {
        return '仅执行方可以执行方身份发送消息'
      }
      setBusy(true)
      setError(null)
      try {
        if (perspective === 'requester') {
          // 需求方在待验收时发送消息等同于验收不通过
          await (currentTask.subStatus === '待验收'
            ? api.workbenchRejectHandoff(taskId, text)
            : api.sendTaskMessage(taskId, text, 'requester'))
        } else {
          // 执行中直接投递执行机器人会话，其余阶段按执行方补充反馈
          await (currentTask.subStatus === '执行中'
            ? api.workbenchSendMessage(taskId, text)
            : api.sendTaskMessage(taskId, text, 'responsible'))
        }
        await refreshTaskPanel()
        return null
      } catch (e) {
        return (e as Error).message
      } finally {
        setBusy(false)
      }
    },
    [currentTask, taskId, workbenchTask, refreshTaskPanel],
  )

  // 初始加载失败（没有任何数据）：页面内错误 + 重试
  if (!currentTask && !loading && error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-error-foreground">加载失败：{error}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setLoading(true)
            void load()
          }}
        >
          重试
        </Button>
      </div>
    )
  }
  // 首屏骨架：立即渲染页面结构（面包屑/标题/左右面板占位），快照返回后就地填充
  if (!currentTask) {
    return <TaskDetailSkeleton hideBreadcrumb={hideBreadcrumb} />
  }

  const durationMs = taskDurationMs(currentTask, now)
  const handoffPlaceholder =
    !handoffDoc?.exists ||
    !handoffDoc.content.trim() ||
    handoffDoc.content.trim() === '> 正在处理中……'
  const agentName = pipeline.find(
    (stage) => stage.task.id === currentTask.id,
  )?.agent?.name
  const openRelatedTask =
    onOpenTask ?? ((id: number) => navigate(`/tasks/${id}`))

  const pageHeader = (
    <>
      {!hideBreadcrumb && (
        <PageBreadcrumb
          items={
            breadcrumb ?? [
              { label: '任务', to: '/tasks/list' },
              { label: currentTask.title },
            ]
          }
        />
      )}

      <header className="shrink-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" size="sm">
                {currentTask.templateName ?? '未设置'}
              </Badge>
              <h1 className="break-words text-xl font-semibold text-foreground-intense">
                {title ?? `${currentTask.code} ${currentTask.title}`}
              </h1>
              {extraBadges}
              <TaskStatusBadge
                status={currentTask.status}
                subStatus={currentTask.subStatus}
                showMain
              />
              {currentTask.type === '审批' && (
                <Badge variant="warning" size="sm">
                  审批任务
                </Badge>
              )}
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground-muted">
              <span>
                创建于 {new Date(currentTask.createdAt).toLocaleString()}
              </span>
              <span>·</span>
              <span>
                {currentTask.status === '已结束' ? '持续时间' : '已运行'}{' '}
                {formatDuration(durationMs)}
              </span>
              <span>·</span>
              <span>人工介入 {interventionCount} 次</span>
            </p>
          </div>
          <TaskActions
            task={interactiveTask}
            chat={interactiveChat}
            handoffDoc={handoffDoc}
            handoffEditing={handoffEditing}
            onRefresh={refreshTaskPanel}
            className="pt-0.5"
          />
        </div>
      </header>

      {error && (
        <p
          role="alert"
          className="shrink-0 rounded-[var(--radius-md)] bg-error-soft px-3 py-2 text-sm text-error-foreground"
        >
          {error}
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
          aiCollapsible={collapsibleCollaboration}
          aiOutsideContent={collapsibleCollaboration}
          aiOpen={collaborationOpen}
          onAiOpenChange={setCollaborationOpen}
          aiUnreadCount={collaborationUnread}
          ai={
            <DetailAgentPanel
              taskId={currentTask.id}
              title="我的助理"
              visible={collapsibleCollaboration ? collaborationOpen : true}
              onUnreadChange={setCollaborationUnread}
              emptyTitle={`${currentTask.code} 的独立 AI 会话`}
              emptyHint="当前任务的对话与其它页面相互隔离；让 AI 查询、创建或推进任务"
              placeholder={`让 AI 处理 ${currentTask.code}，或输入其它指令…`}
              onRunFinished={() => {
                void refreshTaskPanel()
              }}
            />
          }
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border bg-background">
            <div className="shrink-0 overflow-x-auto px-3 py-2">
              <div
                role="tablist"
                aria-label="任务详情正文"
                className="inline-flex max-w-full items-center gap-1 rounded-[var(--radius-lg)] bg-background-muted p-1"
              >
                {TASK_CONTENT_TABS.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={contentTab === key}
                    onClick={() => changeContentTab(key)}
                    className={`shrink-0 whitespace-nowrap rounded-[var(--radius-md)] px-3 py-1.5 text-sm transition-colors ${
                      contentTab === key
                        ? 'bg-background font-medium text-foreground-intense shadow-sm'
                        : 'text-foreground-muted hover:bg-background/60 hover:text-foreground-intense'
                    }`}
                  >
                    {label}
                    {key === 'conversation' && conversationUnread > 0 && (
                      <span className="ml-1 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground">
                        {conversationUnread > 99 ? '99+' : conversationUnread}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col p-3">
            {contentTab === 'handoff' && (
              <TaskMarkdownDocumentView
                title="交付文档"
                actions={
                  handoffEditing ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() => void saveHandoff()}
                        disabled={handoffSaving}
                      >
                        {handoffSaving ? '保存中…' : '保存'}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={cancelHandoffEditing}
                        disabled={handoffSaving}
                      >
                        取消
                      </Button>
                    </>
                  ) : canEditHandoff ? (
                    handoffDoc ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setHandoffError(null)
                          setHandoffEditing(true)
                        }}
                      >
                        {handoffDoc.exists ? '编辑' : '创建'}
                      </Button>
                    ) : null
                  ) : docsLoading && !handoffDoc ? (
                    <span>更新中…</span>
                  ) : null
                }
                notice={
                  handoffError ? (
                    <p role="alert" className="text-error-foreground">
                      保存交付文档失败：{handoffError}
                    </p>
                  ) : handoffEditing ? (
                    <p className="text-foreground-muted">
                      {handoffDoc?.exists
                        ? '文档正文由执行方和需求方共同维护；内容变化后版本号自动递增，需求方修改会通知执行机器人读取最新版本。'
                        : '保存后创建交付文档 v1；执行方应在开始处理后立即创建，并随任务进展持续更新。'}
                    </p>
                  ) : null
                }
                footer={
                  <HandoffDocumentStatus
                    path={handoffDoc?.path}
                    version={handoffDoc?.version}
                    updatedAt={handoffDoc?.updatedAt}
                    exists={handoffDoc?.exists}
                    loading={docsLoading && !handoffDoc}
                  />
                }
                content={
                  handoffEditing
                    ? handoffDoc?.content
                    : handoffPlaceholder
                      ? undefined
                      : handoffDoc?.content
                }
                loading={docsLoading && !handoffDoc}
                error={!handoffDoc ? docsError : null}
                emptyText={
                  handoffDoc?.exists
                    ? '执行方尚未更新交付文档，更新后会自动展示'
                    : handoffDoc
                      ? '执行方尚未创建交付文档；接受任务并开始处理后应立即创建'
                      : '暂无交付文档'
                }
                contentKey={handoffDoc?.version}
                editing={handoffEditing}
                editorRef={handoffEditorRef}
              />
            )}

            {contentTab === 'requirement' && (
              <TaskRequirementPanel
                key={taskId}
                task={currentTask}
                fallbackProjectId={rootProjectId}
              />
            )}

            {contentTab === 'tasks' && (
              <TaskTreePanel
                key={taskId}
                pipeline={pipeline}
                currentTaskId={currentTask.id}
                onOpenTask={openRelatedTask}
              />
            )}

            {contentTab === 'info' && (
              <TaskInfoPanel
                key={taskId}
                task={currentTask}
                agentName={agentName}
                requesterName={requesterName}
                agentOwnerName={agentOwnerName}
                interventionCount={interventionCount}
                durationMs={durationMs}
              />
            )}

            {contentTab === 'events' && (
              <TaskEventsPanel events={events} />
            )}

            {contentTab === 'documents' && (
              <TaskDocumentsPanel
                data={documents}
                loading={docsLoading}
                error={docsError}
              />
            )}

            {contentTab === 'conversation' && (
              <TaskConversationView
                taskId={taskId}
                task={currentTask}
                messages={messages}
                connection={connection}
                roles={conversationRoles}
                isAdmin={isAdmin}
                busy={busy}
                onSend={sendConversationMessage}
                onReplyQuestion={replyQuestion}
              />
            )}

            {contentTab === 'review' && (
              <TaskMarkdownDocumentView
                title="复盘文档"
                subtitle={reviewDoc?.path}
                meta={
                  reviewDoc?.updatedAt
                    ? `更新于 ${new Date(reviewDoc.updatedAt).toLocaleString()}`
                    : null
                }
                content={reviewDoc?.content}
                loading={docsLoading && !reviewDoc}
                error={!reviewDoc ? docsError : null}
                emptyText={
                  currentTask.status === '已结束' &&
                  currentTask.subStatus === '完成'
                    ? '复盘生成中，完成后自动展示'
                    : '任务验收通过后由平台生成复盘文档'
                }
                contentKey={reviewDoc?.updatedAt}
              />
            )}
            {contentTab === 'topics' && (
              <TopicsPanel
                subjectType="任务"
                subjectId={currentTask.id}
                subjectTitle={currentTask.title}
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

/**
 * 首屏骨架：镜像真实页面布局（面包屑 + 标题区 + 正文 Tab + 右侧 AI），
 * 快照返回后就地填充，避免整页空白等待与明显布局跳动。
 */
function TaskDetailSkeleton({
  hideBreadcrumb = false,
}: {
  hideBreadcrumb?: boolean
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {!hideBreadcrumb && (
        <PageBreadcrumb
          items={[{ label: '任务', to: '/tasks/list' }, { label: '加载中' }]}
        />
      )}
      <header className="shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-7 w-72 max-w-full" />
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton className="h-4 w-[28rem] max-w-full" />
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <DetailPageLayout
          aiLabel="我的助理"
          ai={
            <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border bg-background">
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-5 w-12 rounded-full" />
              </div>
              <div className="flex flex-1 flex-col justify-end gap-4 px-4 py-4">
                <ChatBubbleSkeleton />
                <ChatBubbleSkeleton align="right" />
                <ChatBubbleSkeleton />
              </div>
            </section>
          }
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border bg-background">
            <div className="shrink-0 overflow-x-auto px-3 py-2">
              <div className="inline-flex max-w-full items-center gap-1 rounded-[var(--radius-lg)] bg-background-muted p-1">
                {TASK_CONTENT_TABS.map(([key]) => (
                  <Skeleton
                    key={key}
                    className="h-7 w-14 shrink-0 rounded-[var(--radius-md)]"
                  />
                ))}
              </div>
            </div>
            <div className="flex flex-1 flex-col gap-3 p-4">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-11/12" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="mt-3 h-6 w-1/2" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-10/12" />
            </div>
          </div>
        </DetailPageLayout>
      </div>
    </div>
  )
}

function ChatBubbleSkeleton({ align = 'left' }: { align?: 'left' | 'right' }) {
  return (
    <div
      className={`flex items-start gap-2.5 ${align === 'right' ? 'flex-row-reverse' : ''}`}
    >
      <Skeleton className="size-8 shrink-0 rounded-full" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-full max-w-md" />
        <Skeleton className="h-3 w-2/3 max-w-xs" />
      </div>
    </div>
  )
}
