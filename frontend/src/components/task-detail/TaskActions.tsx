import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from 'react'
import { Button } from '@appica/ui-react/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@appica/ui-react/dialog'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  createComboboxItems,
} from '@appica/ui-react/combobox'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@appica/ui-react/popover'
import {
  ArrowsExchange,
  Ban,
  CircleCheck,
  CircleX,
  ClipboardCheck,
  Loader,
  Package2Export,
  Package2Import,
  Sparkles,
  Subtask,
} from '@appica/icons-react'
import {
  api,
  type TaskChatSnapshot,
  type TaskHandoffDocument,
  type TaskTemplate,
  type WorkbenchTask,
  type Worker,
} from '../../lib/api'
import { matchesPinyinSearch } from '../../lib/pinyin-search'
import { MarkdownField } from '../MarkdownField'
import type { MarkdownEditorHandle } from '../MarkdownEditor'
import { useAuth } from '../../context/AuthContext'
import {
  ApprovalActions,
  type ApprovalActionKind,
} from './ApprovalActions'

/** 成功反馈停留时长 */
const SUCCESS_STAY_MS = 2_000
/** 失败反馈停留时长 */
const FAILURE_STAY_MS = 5_000

type DialogKind =
  | 'refuse'
  | 'handoff'
  | 'assign'
  | 'subtask'
  | 'stop'
  | null

type Feedback = { kind: 'success' | 'failure'; message: string } | null

export interface TaskActionsProps {
  /** 当前任务及其工作台角色；无任务时不渲染操作 */
  task: WorkbenchTask | null
  /** 任务对话快照，用于判断是否已经申请过验收 */
  chat: TaskChatSnapshot | null
  /** 交付文档，用于发起交付前确认当前版本 */
  handoffDoc?: TaskHandoffDocument | null
  /** 交付文档正在编辑时禁止发起交付 */
  handoffEditing?: boolean
  /** 操作成功后刷新任务、聊天、交付文档与角色 */
  onRefresh: () => Promise<unknown> | unknown
  /** 审批任务默认打开的弹窗（飞书卡片链接 ?approval=） */
  approvalAction?: ApprovalActionKind | null
  /** 隐藏审批操作（工单页把审批按钮放在当前节点卡片内，避免重复） */
  hideApproval?: boolean
  className?: string
}

/**
 * 任务操作区：展示在任务详情标题右侧，不依赖右侧协作面板是否展开。
 *
 * 角色和状态判断与此前 AI 面板内的操作保持一致；业务动作仍由工作台接口校验。
 */
export function TaskActions({
  task,
  chat,
  handoffDoc = null,
  handoffEditing = false,
  onRefresh,
  approvalAction = null,
  hideApproval = false,
  className,
}: TaskActionsProps) {
  const { user } = useAuth()
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [dialogText, setDialogText] = useState('')
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [workers, setWorkers] = useState<Worker[]>([])
  const [templates, setTemplates] = useState<TaskTemplate[]>([])
  const [assignWorkerId, setAssignWorkerId] = useState('')
  const [subtaskTemplateId, setSubtaskTemplateId] = useState('')
  const [subtaskAgentId, setSubtaskAgentId] = useState('')
  const [subtaskContent, setSubtaskContent] = useState('')
  const subtaskContentRef = useRef<MarkdownEditorHandle>(null)
  /** 上一次由任务定义自动带入的指定人；手动选择/清空后置空 */
  const autoSubtaskAgentIdRef = useRef<number | null>(null)

  const roles = task?.workbenchRoles ?? []
  const isAgent = roles.includes('agent')
  const isRequester = roles.includes('requester')
  const isApprovalTask = task?.type === '审批'
  const activeChat = chat && task && chat.task.id === task.id ? chat : null
  const executing = task?.subStatus === '执行中'
  const awaitingAcceptance = task?.subStatus === '待接受'
  const pendingApply = task?.subStatus === '待申请验收'
  const awaitingReview = task?.subStatus === '待验收'
  const finished = task?.status === '已结束'
  const completed = finished && task?.subStatus === '完成'
  const delivered = activeChat?.hasAcceptanceApplication ?? false
  const handoffReady = Boolean(
    handoffDoc?.exists &&
      handoffDoc.content.trim() &&
      handoffDoc.content.trim() !== '> 正在处理中……',
  )

  /** 任务发起者或管理员可停止任务（后端再次校验） */
  const canStop = Boolean(
    task && !finished && (isRequester || user?.role === '管理员'),
  )
  /** 审批任务：发起人、当前审批处理人（执行方）与管理员可通过/驳回 */
  const canApproveApproval = Boolean(
    task &&
      isApprovalTask &&
      !hideApproval &&
      !finished &&
      (isAgent || isRequester || user?.role === '管理员'),
  )
  const canAcceptHandoff = Boolean(
    task && isRequester && awaitingReview && !isApprovalTask,
  )
  const canAcceptTask = Boolean(task && isAgent && awaitingAcceptance)
  const canRefuseTask = canAcceptTask
  const canApplyHandoff = Boolean(
    task &&
      !isApprovalTask &&
      isAgent &&
      (executing || pendingApply) &&
      handoffReady &&
      !handoffEditing,
  )
  const canRevokeHandoff = Boolean(
    task && !isApprovalTask && isAgent && awaitingReview,
  )
  const canAssign = Boolean(
    task && !finished && !isApprovalTask && (isRequester || isAgent),
  )
  const responsibleSubtaskAvailable = Boolean(
    task && !isApprovalTask && isAgent && executing && !delivered,
  )
  /** 子任务固定以父任务执行方身份创建，仅执行机器人主人可见入口 */
  const canCreateSubtask = responsibleSubtaskAvailable
  const canRegenerateReview = Boolean(
    task && isRequester && completed && !isApprovalTask,
  )

  const assignWorkers = useMemo(
    () => workers.filter((worker) => worker.id !== task?.agentId),
    [workers, task?.agentId],
  )
  const assignWorkerItems = useMemo(
    () =>
      createComboboxItems(assignWorkers, {
        getValue: (worker) => String(worker.id),
        getLabel: (worker) => worker.name,
      }),
    [assignWorkers],
  )
  const subtaskTemplateItems = useMemo(
    () =>
      createComboboxItems(templates, {
        getValue: (template) => String(template.id),
        getLabel: (template) => template.name,
      }),
    [templates],
  )
  const subtaskAgentItems = useMemo(
    () =>
      createComboboxItems(workers, {
        getValue: (worker) => String(worker.id),
        getLabel: (worker) => worker.name,
      }),
    [workers],
  )

  const resetDialogFields = useCallback(() => {
    setDialogText('')
    setDialogError(null)
    setAssignWorkerId('')
    setSubtaskTemplateId('')
    setSubtaskAgentId('')
    setSubtaskContent('')
    autoSubtaskAgentIdRef.current = null
  }, [])

  useEffect(() => {
    // 切换任务时清空上一次未提交的弹窗内容
    // oxlint-disable-next-line react/set-state-in-effect
    resetDialogFields()
  }, [task?.id, resetDialogFields])

  useEffect(() => {
    if (dialog !== 'assign' && dialog !== 'subtask') return
    let closed = false
    api
      .listWorkers({ role: '工作者' })
      .then((rows) => {
        if (!closed) setWorkers(rows.filter((row) => row.enabled))
      })
      .catch(() => undefined)
    return () => {
      closed = true
    }
  }, [dialog])

  useEffect(() => {
    if (dialog !== 'subtask') return
    let closed = false
    api
      .listTaskTemplates()
      .then((rows) => {
        if (!closed) setTemplates(rows)
      })
      .catch(() => undefined)
    return () => {
      closed = true
    }
  }, [dialog])

  /** 执行任务请求；返回错误文案，成功时返回 null */
  const request = useCallback(
    async (action: () => Promise<unknown>): Promise<string | null> => {
      setBusy(true)
      setDialogError(null)
      try {
        await action()
        return null
      } catch (error) {
        return (error as Error).message
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  /** 执行并在成功后刷新页面数据 */
  const requestAndRefresh = useCallback(
    async (action: () => Promise<unknown>): Promise<string | null> => {
      const failure = await request(action)
      if (failure) return failure
      try {
        await onRefresh()
        return null
      } catch (error) {
        return (error as Error).message
      }
    },
    [request, onRefresh],
  )

  const openDialog = useCallback((kind: Exclude<DialogKind, null>) => {
    setDialogError(null)
    setDialog(kind)
  }, [])

  /**
   * 选择任务定义时自动带入该定义默认处理机器人（第一个启用机器人）；
   * 手动指定过「指定人」后不再覆盖，清空指定人则由平台按任务定义分配。
   */
  const changeSubtaskTemplate = useCallback(
    (value: string | null) => {
      const next = String(value ?? '')
      setSubtaskTemplateId(next)
      const template = templates.find((item) => String(item.id) === next)
      const current = workers.find(
        (worker) => String(worker.id) === subtaskAgentId,
      )
      const isAutoAgent =
        autoSubtaskAgentIdRef.current !== null &&
        current?.id === autoSubtaskAgentIdRef.current
      if (!template) {
        autoSubtaskAgentIdRef.current = null
        if (isAutoAgent) setSubtaskAgentId('')
        return
      }
      if (subtaskAgentId.trim() && !isAutoAgent) return
      const candidates = [...new Set(template.agentIds)]
        .map((id) => workers.find((worker) => worker.id === id))
        .filter((worker): worker is Worker => Boolean(worker))
      if (candidates.length === 0) {
        autoSubtaskAgentIdRef.current = null
        if (isAutoAgent) setSubtaskAgentId('')
        return
      }
      autoSubtaskAgentIdRef.current = candidates[0].id
      setSubtaskAgentId(String(candidates[0].id))
    },
    [templates, workers, subtaskAgentId],
  )

  const submitDialog = useCallback(async () => {
    if (busy || !task) return
    let failure: string | null = null
    if (dialog === 'refuse') {
      failure = await requestAndRefresh(() =>
        api.workbenchRefuse(task.id, dialogText.trim()),
      )
    } else if (dialog === 'handoff') {
      failure = await requestAndRefresh(() =>
        api.workbenchApplyHandoff(task.id),
      )
    } else if (dialog === 'assign') {
      if (!assignWorkerId) return
      failure = await requestAndRefresh(() =>
        api.assignTask(task.id, Number(assignWorkerId)),
      )
    } else if (dialog === 'stop') {
      failure = await requestAndRefresh(() =>
        api.workbenchCancelTask(task.id),
      )
    } else if (dialog === 'subtask') {
      // 取编辑器当前内容：onChange 有防抖，避免刚输入就创建丢字
      const content =
        subtaskContentRef.current?.getMarkdown() ?? subtaskContent
      if (!subtaskTemplateId || !content.trim()) return
      failure = await requestAndRefresh(() =>
        api.workbenchCreateSubtask(task.id, {
          templateId: Number(subtaskTemplateId),
          agentId: subtaskAgentId ? Number(subtaskAgentId) : null,
          content: content.trim(),
        }),
      )
    }
    if (failure) {
      setDialogError(failure)
      return
    }
    setDialog(null)
    resetDialogFields()
  }, [
    task,
    busy,
    dialog,
    dialogText,
    assignWorkerId,
    subtaskTemplateId,
    subtaskAgentId,
    subtaskContent,
    requestAndRefresh,
    resetDialogFields,
  ])

  if (!task) return null

  const visibleActions = [
    canApproveApproval,
    canStop,
    canAcceptHandoff,
    canAcceptTask,
    canRefuseTask,
    canApplyHandoff,
    canRevokeHandoff,
    canAssign,
    canCreateSubtask,
    canRegenerateReview,
  ].some(Boolean)

  if (!visibleActions) return null

  return (
    <>
      <div
        className={`flex flex-wrap items-center justify-end gap-2 ${
          className ?? ''
        }`}
      >
        {canApproveApproval && (
          <ApprovalActions
            taskId={task.id}
            initialAction={approvalAction}
            onRefresh={onRefresh}
            disabled={busy}
          />
        )}
        {canAcceptHandoff && (
          <DirectActionButton
            label="验收通过"
            successMessage="任务已验收通过，正在刷新验收结果。"
            icon={ClipboardCheck}
            variant="primary"
            disabled={busy}
            onClick={() =>
              request(() => api.workbenchAcceptHandoff(task.id))
            }
            onSuccess={onRefresh}
          />
        )}
        {canAcceptTask && (
          <DirectActionButton
            label="接受任务"
            successMessage="任务已接受，机器人开始处理。"
            icon={CircleCheck}
            variant="primary"
            disabled={busy}
            onClick={() => request(() => api.workbenchAccept(task.id))}
            onSuccess={onRefresh}
          />
        )}
        {canApplyHandoff && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => openDialog('handoff')}
          >
            <Package2Export className="size-3.5" />
            申请验收
          </Button>
        )}
        {canRevokeHandoff && (
          <DirectActionButton
            label="撤销交付"
            successMessage="已撤销交付，任务回到执行中。"
            icon={Package2Import}
            variant="outline"
            disabled={busy}
            onClick={() => request(() => api.workbenchRevokeHandoff(task.id))}
            onSuccess={onRefresh}
          />
        )}
        {canRefuseTask && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-error-foreground"
            disabled={busy}
            onClick={() => openDialog('refuse')}
          >
            <Ban className="size-3.5" />
            拒绝任务
          </Button>
        )}
        {canCreateSubtask && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => openDialog('subtask')}
          >
            <Subtask className="size-3.5" />
            新子任务
          </Button>
        )}
        {canAssign && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => openDialog('assign')}
          >
            <ArrowsExchange className="size-3.5" />
            分配任务
          </Button>
        )}
        {canRegenerateReview && (
          <DirectActionButton
            label="复盘任务"
            successMessage="复盘任务已提交，完成后会自动更新复盘文档。"
            icon={Sparkles}
            variant="outline"
            disabled={busy}
            onClick={() => request(() => api.generateTaskHandoff(task.id))}
            onSuccess={onRefresh}
          />
        )}
        {canStop && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-error-foreground"
            disabled={busy}
            onClick={() => openDialog('stop')}
          >
            <CircleX className="size-3.5" />
            停止任务
          </Button>
        )}
      </div>

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null)
            setDialogError(null)
          }
        }}
      >
        <DialogContent
          className={
            dialog === 'handoff' || dialog === 'subtask'
              ? 'sm:max-w-2xl'
              : undefined
          }
        >
          <DialogHeader>
            <DialogTitle>
              {dialog === 'refuse'
                ? '拒绝任务'
                : dialog === 'handoff'
                  ? '发起交付'
                  : dialog === 'assign'
                    ? '分配任务'
                    : dialog === 'stop'
                      ? '停止任务'
                      : '创建子任务'}
            </DialogTitle>
          </DialogHeader>

          {dialog === 'refuse' && (
            <DialogBody>
              <textarea
                value={dialogText}
                rows={5}
                onChange={(event) => setDialogText(event.target.value)}
                placeholder="请说明原因或反馈意见"
                className="w-full rounded-[var(--radius-md)] border border-border bg-background px-3 py-2 text-sm outline-none focus:border-border-strong"
              />
            </DialogBody>
          )}

          {dialog === 'handoff' && (
            <DialogBody>
              <div className="space-y-2 text-xs leading-relaxed text-foreground-muted">
                <p>
                  交付内容以任务交付文档为准，本次申请会锁定当前版本并提交给需求方验收。
                </p>
                <p>
                  当前文档：
                  {handoffDoc?.exists
                    ? ` ${handoffDoc.path} · v${handoffDoc.version}`
                    : handoffDoc
                      ? ` ${handoffDoc.path} · 尚未创建`
                      : ' 尚未加载'}
                </p>
                {!handoffReady && (
                  <p role="alert" className="text-error-foreground">
                    交付文档尚未创建或还没有有效内容，请先在「交付」中创建并补充后再申请验收。
                  </p>
                )}
                <p>
                  申请后如需继续修改，请先撤销交付或等待需求方返工。
                </p>
              </div>
            </DialogBody>
          )}

          {dialog === 'assign' && (
            <DialogBody>
              <label className="block space-y-1">
                <span className="text-xs text-foreground-muted">处理机器人</span>
                <Combobox
                  items={assignWorkerItems}
                  value={assignWorkerId || null}
                  onValueChange={(value) =>
                    setAssignWorkerId(String(value ?? ''))
                  }
                  filter={(worker: Worker, query: string) =>
                    matchesPinyinSearch(query, [worker.name])
                  }
                >
                  <ComboboxInput
                    placeholder="搜索机器人名称"
                    aria-label="处理机器人"
                  />
                  <ComboboxContent>
                    <ComboboxEmpty>没有匹配的机器人</ComboboxEmpty>
                    <ComboboxList>
                      {(worker: Worker) => (
                        <ComboboxItem key={worker.id} value={String(worker.id)}>
                          {worker.name}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </label>
            </DialogBody>
          )}

          {dialog === 'subtask' && (
            <DialogBody>
              <div className="space-y-3">
                <label className="block space-y-1">
                  <span className="text-xs text-foreground-muted">任务定义</span>
                  <Combobox
                    items={subtaskTemplateItems}
                    value={subtaskTemplateId || null}
                    onValueChange={changeSubtaskTemplate}
                    filter={(template: TaskTemplate, query: string) =>
                      matchesPinyinSearch(query, [template.name])
                    }
                  >
                    <ComboboxInput
                      placeholder="搜索任务定义名称"
                      aria-label="任务定义"
                    />
                    <ComboboxContent>
                      <ComboboxEmpty>没有匹配的任务定义</ComboboxEmpty>
                      <ComboboxList>
                        {(template: TaskTemplate) => (
                          <ComboboxItem
                            key={template.id}
                            value={String(template.id)}
                          >
                            {template.name}
                          </ComboboxItem>
                        )}
                      </ComboboxList>
                    </ComboboxContent>
                  </Combobox>
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-foreground-muted">指定人</span>
                  <Combobox
                    items={subtaskAgentItems}
                    value={subtaskAgentId || null}
                    onValueChange={(value) => {
                      autoSubtaskAgentIdRef.current = null
                      setSubtaskAgentId(String(value ?? ''))
                    }}
                    filter={(worker: Worker, query: string) =>
                      matchesPinyinSearch(query, [worker.name])
                    }
                  >
                    <ComboboxInput
                      placeholder="跟随任务定义自动分配，可手动指定"
                      aria-label="指定人"
                    />
                    <ComboboxContent>
                      <ComboboxEmpty>没有匹配的机器人</ComboboxEmpty>
                      <ComboboxList>
                        {(worker: Worker) => (
                          <ComboboxItem key={worker.id} value={String(worker.id)}>
                            {worker.name}
                          </ComboboxItem>
                        )}
                      </ComboboxList>
                    </ComboboxContent>
                  </Combobox>
                </label>
                <MarkdownField
                  label="任务内容"
                  value={subtaskContent}
                  onChange={setSubtaskContent}
                  handleRef={subtaskContentRef}
                  editorKey={`subtask-${task?.id ?? 0}`}
                  heightClassName="h-56"
                />
              </div>
            </DialogBody>
          )}

          {dialog === 'stop' && (
            <DialogBody>
              <p className="text-sm leading-relaxed text-foreground-muted">
                停止后任务将进入「已结束-取消」，执行中的机器人会被中断，且不可恢复。该任务下所有未结束的子任务（含更深层级）也会被强制停止。确认停止
                {task ? ` ${task.code}「${task.title}」` : '当前任务'}？
              </p>
            </DialogBody>
          )}

          {dialogError && (
            <p role="alert" className="px-4 text-xs text-error-foreground">
              {dialogError}
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={
                busy ||
                (dialog === 'refuse' && !dialogText.trim()) ||
                (dialog === 'assign' && !assignWorkerId) ||
                (dialog === 'subtask' &&
                  (!subtaskTemplateId || !subtaskContent.trim())) ||
                (dialog === 'handoff' && !handoffReady)
              }
              onClick={() => void submitDialog()}
            >
              {dialog === 'stop' ? '确认停止' : '提交'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface DirectActionButtonProps {
  label: string
  successMessage: string
  icon: ComponentType<{ className?: string }>
  onClick: () => Promise<string | null>
  onSuccess: () => Promise<unknown> | unknown
  variant?: 'primary' | 'outline'
  disabled?: boolean
}

/** 直接执行的任务按钮：结果通过锚定按钮的 Popover 展示 */
function DirectActionButton({
  label,
  successMessage,
  icon: Icon,
  onClick,
  onSuccess,
  variant = 'outline',
  disabled = false,
}: DirectActionButtonProps) {
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => clearTimer, [clearTimer])

  const handleClick = useCallback(async () => {
    if (pending || disabled) return
    clearTimer()
    setFeedback(null)
    setPending(true)
    const failure = await onClick()
    setPending(false)
    if (failure) {
      setFeedback({ kind: 'failure', message: failure })
      timerRef.current = setTimeout(() => {
        setFeedback(null)
        timerRef.current = null
      }, FAILURE_STAY_MS)
      return
    }
    setFeedback({ kind: 'success', message: successMessage })
    timerRef.current = setTimeout(() => {
      setFeedback(null)
      timerRef.current = null
      void onSuccess()
    }, SUCCESS_STAY_MS)
  }, [
    pending,
    disabled,
    clearTimer,
    onClick,
    successMessage,
    onSuccess,
  ])

  const blocked = disabled || pending || feedback?.kind === 'success'

  return (
    <Popover
      open={feedback !== null}
      onOpenChange={(open) => {
        if (!open && feedback?.kind === 'failure') {
          clearTimer()
          setFeedback(null)
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant={variant}
            size="sm"
            disabled={blocked}
            onClick={() => void handleClick()}
          />
        }
      >
        {pending ? (
          <Loader className="size-3.5 animate-spin" />
        ) : (
          <Icon className="size-3.5" />
        )}
        {label}
      </PopoverTrigger>
      <PopoverContent side="top" align="center">
        {feedback?.kind === 'success' && (
          <>
            <PopoverTitle>成功</PopoverTitle>
            <PopoverDescription>{feedback.message}</PopoverDescription>
          </>
        )}
        {feedback?.kind === 'failure' && (
          <>
            <PopoverTitle>失败</PopoverTitle>
            <PopoverDescription>{feedback.message}</PopoverDescription>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
