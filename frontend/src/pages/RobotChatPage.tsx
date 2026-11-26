import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button } from '@appica/ui-react/button'
import { Badge } from '@appica/ui-react/badge'
import { Input } from '@appica/ui-react/input'
import { Loader, Plus, Refresh, Robot } from '@appica/icons-react'
import {
  api,
  workerChatStreamUrl,
  type TaskChatSender,
  type WorkerChatSession,
  type WorkerDebugAttachment,
  type WorkerDebugOption,
  type WorkerDebugSnapshot,
} from '../lib/api'
import { visibleEventSource } from '../lib/event-source'
import { useImeEnterGuard } from '../lib/ime-enter'
import { matchesPinyinSearch } from '../lib/pinyin-search'
import { useAuth } from '../context/AuthContext'
import { RobotAvatar } from '../components/task-detail/WorkerAvatar'
import {
  ConversationStream,
  type ConversationConnection,
  type ConversationStreamMessage,
} from '../components/agent-chat/ConversationStream'
import {
  ChatActionIcon,
  ChatAttachmentChips,
  ChatComposerDock,
  ChatComposerFrame,
  ChatSendButton,
} from '../components/agent-chat/ChatComposer'

/**
 * 顶部「机器人」：左侧会话 / 全部机器人，右侧统一聊天区。
 * 每个用户与每个机器人固定一个 chat 会话（与我的 AI 隔离），
 * 可重置；消息经 SSE 实时推送，支持附件上传与机器人提问。
 * 聊天交互复用任务详情「会话」的共享组件（虚拟化 + 底部跟随 + 单行活动）。
 */
export function RobotChatPage() {
  const { workerId } = useParams<{ workerId?: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const selectedId = workerId ? Number(workerId) : null
  const valid = selectedId !== null && Number.isInteger(selectedId) && selectedId > 0

  const [workers, setWorkers] = useState<WorkerDebugOption[]>([])
  const [sessions, setSessions] = useState<WorkerChatSession[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const [snapshot, setSnapshot] = useState<WorkerDebugSnapshot | null>(null)
  const [connection, setConnection] =
    useState<ConversationConnection>('connecting')
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const loadSeq = useRef(0)

  // 输入区：附件沿用机器人对话能力（任务会话的交互中不包含附件）
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [replying, setReplying] = useState(false)
  const [attachments, setAttachments] = useState<WorkerDebugAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imeEnter = useImeEnterGuard()

  const loadOverview = useCallback(async () => {
    try {
      const [nextWorkers, nextSessions] = await Promise.all([
        api.listWorkerChatWorkers(),
        api.listWorkerChatSessions(),
      ])
      setWorkers(nextWorkers)
      setSessions(nextSessions)
      setListError(null)
      if (!workerId && nextSessions[0]) {
        navigate(`/robots/${nextSessions[0].worker.id}`, { replace: true })
      }
    } catch (error) {
      setListError((error as Error).message)
    } finally {
      setListLoading(false)
    }
  }, [navigate, workerId])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- 进入页面同步拉取会话与机器人清单
    void loadOverview()
  }, [loadOverview])

  useEffect(() => {
    if (!valid || selectedId === null) {
      // 切换/离开机器人时立即清空旧会话，避免展示串台；后续状态在异步回调中更新。
      // oxlint-disable-next-line react/set-state-in-effect
      setSnapshot(null)
      // oxlint-disable-next-line react/set-state-in-effect
      setSessionError(null)
      // oxlint-disable-next-line react/set-state-in-effect
      setConnection('connecting')
      return
    }
    const seq = ++loadSeq.current
    // oxlint-disable-next-line react/set-state-in-effect
    setSnapshot(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setSessionError(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setConnection('connecting')
    // SSE 订阅成功后会先推送一次完整快照，不再额外拉取同一份快照接口
    const source = visibleEventSource(workerChatStreamUrl(selectedId))
    source.onopen = () => {
      if (seq === loadSeq.current) setConnection('live')
    }
    source.onmessage = (event: MessageEvent<string>) => {
      if (seq !== loadSeq.current) return
      let payload: { type?: string; snapshot?: WorkerDebugSnapshot }
      try {
        payload = JSON.parse(event.data) as typeof payload
      } catch {
        return
      }
      if (payload.type === 'snapshot' && payload.snapshot) {
        setConnection('live')
        setSnapshot(payload.snapshot)
      }
    }
    source.onerror = () => {
      if (seq === loadSeq.current) setConnection('reconnecting')
    }
    return () => {
      loadSeq.current += 1
      source.close()
    }
  }, [valid, selectedId, reloadKey])

  const selectedWorker = useMemo(() => {
    if (selectedId === null) return null
    return (
      workers.find((worker) => worker.id === selectedId) ??
      sessions.find((session) => session.worker.id === selectedId)?.worker ??
      snapshot?.worker ??
      null
    )
  }, [selectedId, sessions, snapshot?.worker, workers])

  const filteredWorkers = useMemo(
    () =>
      workers.filter((worker) =>
        matchesPinyinSearch(search, [worker.id, worker.name, worker.intro]),
      ),
    [search, workers],
  )

  /** 会话消息归一化：机器人对话没有需求方概念，按消息角色合成发送方 */
  const streamMessages = useMemo<ConversationStreamMessage[]>(() => {
    if (!snapshot) return []
    const workerSender: TaskChatSender = {
      id: `worker:${snapshot.worker.id}`,
      name: snapshot.worker.name,
      kind: 'worker',
      workerId: snapshot.worker.id,
      avatarUrl: snapshot.worker.avatarUrl,
    }
    const userSender: TaskChatSender = {
      id: `user:${user?.id ?? 'me'}`,
      name: user?.name ?? '我',
      kind: 'user',
      avatarUrl: user?.avatarUrl ?? null,
    }
    return snapshot.messages.map((message) => ({
      id: message.id,
      role: message.role,
      sender: message.role === 'user' ? userSender : workerSender,
      content: message.content,
      reasoning: message.reasoning,
      createdAt: message.createdAt,
      status: message.status,
      kind: message.kind ?? 'message',
      question: message.question,
      tools: message.tools,
      files: message.files,
    }))
  }, [snapshot, user])

  const selectWorker = useCallback(
    (id: number) => {
      navigate(`/robots/${id}`)
    },
    [navigate],
  )

  useEffect(() => {
    // 切换机器人时清空未发送内容与附件，避免串台
    // oxlint-disable-next-line react/set-state-in-effect
    setDraft('')
    // oxlint-disable-next-line react/set-state-in-effect
    setSendError(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setUploadError(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setAttachments([])
  }, [selectedId])

  const handleFiles = useCallback(async (list: FileList | null) => {
    if (!list?.length) return
    setUploading(true)
    setUploadError(null)
    try {
      const uploaded = await Promise.all(
        Array.from(list)
          .slice(0, 10)
          .map((file) => api.uploadFile(file)),
      )
      setAttachments((current) =>
        [
          ...current,
          ...uploaded.map((file) => ({
            name: file.filename,
            url: file.url,
            size: file.size,
            mime: file.mime,
          })),
        ].slice(0, 10),
      )
    } catch (error) {
      setUploadError((error as Error).message)
    } finally {
      setUploading(false)
    }
  }, [])

  const sendMessage = useCallback(async () => {
    if (!valid || selectedId === null || snapshot?.status === 'running') return
    const text = draft.trim()
    const files = attachments
    if (!text && files.length === 0) return
    setSending(true)
    setSendError(null)
    try {
      const next = await api.sendWorkerChatMessage(
        selectedId,
        text,
        files.length > 0 ? files : undefined,
      )
      setSnapshot(next)
      setDraft('')
      setAttachments([])
      setUploadError(null)
      // 首条消息后会话进入左侧列表；列表刷新不改变已选中的机器人
      void loadOverview()
    } catch (error) {
      setSendError((error as Error).message)
    } finally {
      setSending(false)
    }
  }, [attachments, draft, loadOverview, selectedId, snapshot?.status, valid])

  const replyQuestion = useCallback(
    async (questionId: string, answers: string[][] | null) => {
      if (!valid || selectedId === null) return
      setReplying(true)
      setSessionError(null)
      try {
        setSnapshot(
          await api.replyWorkerChatQuestion(selectedId, questionId, answers),
        )
      } catch (error) {
        setSessionError((error as Error).message)
        throw error
      } finally {
        setReplying(false)
      }
    },
    [selectedId, valid],
  )

  const reset = useCallback(async () => {
    if (!valid || selectedId === null || snapshot?.status === 'running') return
    setResetting(true)
    setSessionError(null)
    try {
      setSnapshot(await api.resetWorkerChat(selectedId))
      setDraft('')
      setAttachments([])
      void loadOverview()
    } catch (error) {
      setSessionError((error as Error).message)
    } finally {
      setResetting(false)
    }
  }, [loadOverview, selectedId, snapshot?.status, valid])

  /** 按钮与 ⌥R 快捷键共用的可用条件 */
  const canReset =
    !!snapshot &&
    snapshot.status !== 'running' &&
    snapshot.messages.length > 0 &&
    !resetting

  const sendDisabled =
    !snapshot ||
    snapshot.status === 'running' ||
    sending ||
    (!draft.trim() && attachments.length === 0)

  // ⌥/Alt+R：直接重置当前会话；用 code 兼容 macOS Option+R 的死键行为。
  useEffect(() => {
    if (!canReset) return
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.code !== 'KeyR' ||
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return
      }
      event.preventDefault()
      void reset()
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [canReset, reset])

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-[20%] shrink-0 overflow-y-auto bg-background p-3">
        <div className="flex items-center justify-between gap-2 px-1 py-2">
          <h1 className="text-lg font-semibold text-foreground-intense">机器人</h1>
          <Badge variant="soft" size="sm">
            {workers.length}
          </Badge>
        </div>

        {listError && (
          <p
            role="alert"
            className="mb-3 rounded-[var(--radius-md)] bg-error-soft px-2.5 py-2 text-xs text-error-foreground"
          >
            {listError}
          </p>
        )}

        <section className="mt-2">
          <div className="flex items-center justify-between px-1 py-1.5">
            <h2 className="text-sm font-medium text-foreground-intense">会话</h2>
            <span className="text-[11px] text-foreground-muted">
              {sessions.length}
            </span>
          </div>
          {listLoading && sessions.length === 0 ? (
            <p className="flex items-center gap-2 px-2 py-3 text-xs text-foreground-muted">
              <Loader className="size-3.5 animate-spin" />
              加载会话…
            </p>
          ) : sessions.length === 0 ? (
            <p className="px-2 py-3 text-xs leading-relaxed text-foreground-muted">
              暂无会话，从下方「所有」选择机器人开始对话
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {sessions.map((session) => (
                <li key={session.worker.id}>
                  <RobotChatItem
                    worker={session.worker}
                    selected={session.worker.id === selectedId}
                    meta={formatSessionTime(session.startedAt)}
                    onClick={() => selectWorker(session.worker.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-5">
          <div className="flex items-center justify-between px-1 py-1.5">
            <h2 className="text-sm font-medium text-foreground-intense">所有</h2>
            <span className="text-[11px] text-foreground-muted">
              {filteredWorkers.length}
            </span>
          </div>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onClear={() => setSearch('')}
            clearable
            placeholder="搜索名称、简介、ID 或拼音…"
            aria-label="搜索机器人"
          />
          {filteredWorkers.length === 0 ? (
            <p className="px-2 py-3 text-xs text-foreground-muted">
              {workers.length === 0 ? '暂无可对话的机器人' : '未找到匹配的机器人'}
            </p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5">
              {filteredWorkers.map((worker) => (
                <li key={worker.id}>
                  <RobotChatItem
                    worker={worker}
                    selected={worker.id === selectedId}
                    meta={worker.executorName}
                    onClick={() => selectWorker(worker.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>

      <main className="h-full min-w-0 flex-1 p-3">
        <div className="h-full min-h-0 rounded-[var(--radius-lg)] bg-background-muted p-3">
          {!valid ? (
            <EmptySelection />
          ) : (
            <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border bg-background">
              <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  {selectedWorker ? (
                    <RobotAvatar
                      name={selectedWorker.name}
                      avatarUrl={selectedWorker.avatarUrl}
                      size={30}
                    />
                  ) : (
                    <span className="flex size-[30px] items-center justify-center rounded-full bg-background-muted">
                      <Robot className="size-4" />
                    </span>
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground-intense">
                      {selectedWorker?.name ?? '机器人'}
                    </p>
                    <p className="truncate text-xs text-foreground-muted">
                      {selectedWorker
                        ? `${selectedWorker.executorName} · ${selectedWorker.providerId}/${selectedWorker.modelId}${
                            snapshot?.sessionId
                              ? ` · 会话 ${snapshot.sessionId.slice(0, 8)}`
                              : ''
                          }`
                        : '正在加载会话…'}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {snapshot?.status === 'running' && (
                    <span className="text-xs text-foreground-muted">回复中…</span>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canReset}
                    title="重置会话（⌥R）"
                    onClick={() => void reset()}
                  >
                    <Refresh className="size-3.5" />
                    {resetting ? '重置中…' : '重置会话'}
                    <kbd className="text-[10px] font-normal text-foreground-subtle">
                      ⌥R
                    </kbd>
                  </Button>
                </div>
              </header>

              {sessionError && (
                <p
                  role="alert"
                  className="shrink-0 border-b border-border px-4 py-1.5 text-xs text-error-foreground"
                >
                  {sessionError}
                </p>
              )}

              {snapshot ? (
                <ConversationStream
                  title="会话"
                  messages={streamMessages}
                  connection={connection}
                  canAnswerQuestions
                  busy={replying || sending}
                  onReplyQuestion={replyQuestion}
                  resetKey={selectedId}
                  emptyText={
                    <div className="flex flex-col items-center gap-2">
                      <RobotAvatar
                        name={snapshot.worker.name}
                        avatarUrl={snapshot.worker.avatarUrl}
                        size={48}
                      />
                      <p>和 {snapshot.worker.name} 开始对话</p>
                      <p className="text-xs">
                        发送第一条消息建立会话；之后可随时回来继续，也可以在右上角重置
                      </p>
                    </div>
                  }
                >
                  <ChatComposerDock>
                    <ChatComposerFrame
                      top={
                        <ChatAttachmentChips
                          files={attachments}
                          onRemove={(index) =>
                            setAttachments((current) =>
                              current.filter((_, item) => item !== index),
                            )
                          }
                        />
                      }
                      left={
                        <>
                          <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            className="hidden"
                            onChange={(event) => {
                              void handleFiles(event.target.files)
                              event.target.value = ''
                            }}
                          />
                          <ChatActionIcon
                            label={uploading ? '正在上传文件' : '上传文件'}
                            icon={Plus}
                            busy={uploading}
                            disabled={snapshot.status === 'running'}
                            onClick={() => fileInputRef.current?.click()}
                          />
                        </>
                      }
                      right={
                        <ChatSendButton
                          onClick={() => void sendMessage()}
                          disabled={sendDisabled}
                        />
                      }
                    >
                      <textarea
                        value={draft}
                        rows={3}
                        disabled={snapshot.status === 'running' || sending}
                        onChange={(event) => setDraft(event.target.value)}
                        onCompositionStart={imeEnter.onCompositionStart}
                        onCompositionEnd={imeEnter.onCompositionEnd}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' || event.shiftKey) return
                          if (imeEnter.isImeEnter(event)) return
                          event.preventDefault()
                          void sendMessage()
                        }}
                        placeholder={
                          snapshot.status === 'running'
                            ? '机器人正在回复…'
                            : '输入消息，Enter 发送，Shift+Enter 换行…'
                        }
                        className="block h-[72px] w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-foreground-subtle disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    </ChatComposerFrame>
                    {uploadError && (
                      <p className="mt-1.5 text-[11px] text-error-foreground">
                        附件上传失败：{uploadError}
                      </p>
                    )}
                    {sendError && (
                      <p
                        role="alert"
                        className="mt-1.5 text-[11px] text-error-foreground"
                      >
                        {sendError}
                      </p>
                    )}
                  </ChatComposerDock>
                </ConversationStream>
              ) : connection === 'reconnecting' ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                  <p className="text-sm text-foreground-muted">
                    会话加载失败：实时连接断开，正在重连…
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setReloadKey((value) => value + 1)}
                  >
                    重试
                  </Button>
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center gap-2 text-sm text-foreground-muted">
                  <Loader className="size-4 animate-spin" />
                  加载会话…
                </div>
              )}
            </section>
          )}
        </div>
      </main>
    </div>
  )
}

function RobotChatItem({
  worker,
  selected,
  meta,
  onClick,
}: {
  worker: WorkerDebugOption
  selected: boolean
  meta: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-current={selected ? 'page' : undefined}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 py-2 text-left transition-colors ${
        selected
          ? 'bg-background-muted text-foreground-intense'
          : 'text-foreground-emphasis hover:bg-background-muted'
      }`}
    >
      <RobotAvatar name={worker.name} avatarUrl={worker.avatarUrl} size={28} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{worker.name}</span>
        <span className="mt-0.5 block truncate text-[11px] text-foreground-muted">
          {worker.intro || meta}
        </span>
      </span>
      <span className="shrink-0 text-[10px] text-foreground-subtle">{meta}</span>
    </button>
  )
}

function EmptySelection() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border border-border bg-background text-center">
      <span className="rounded-full bg-background-muted p-4">
        <Robot className="size-6 text-foreground-muted" />
      </span>
      <div>
        <p className="text-sm font-medium text-foreground-intense">
          选择机器人开始对话
        </p>
        <p className="mt-1 text-xs text-foreground-muted">
          左侧「会话」保留最近聊天，「所有」可搜索全部可对话机器人
        </p>
      </div>
    </div>
  )
}

/** 会话时间：当天只显示时分，跨天显示月日与时分 */
function formatSessionTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  return date.toLocaleString('zh-CN', {
    ...(sameDay ? {} : { month: '2-digit', day: '2-digit' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}
