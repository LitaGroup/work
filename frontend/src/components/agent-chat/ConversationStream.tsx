import { memo, useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Badge } from '@appica/ui-react/badge'
import { MessageCircleQuestion, Paperclip } from '@appica/icons-react'
import type {
  TaskChatQuestion,
  TaskChatSender,
  TaskChatTool,
  WorkerDebugAttachment,
} from '../../lib/api'
import { questionStatusLabel } from '../../lib/question'
import { useThrottledText } from '../../lib/use-throttled-text'
import { ChatMarkdown } from '../ChatMarkdown'
import { QuestionCard } from '../QuestionCard'
import { SenderLine, WorkerAvatar } from '../task-detail/WorkerAvatar'
import { ActivityTicker } from './ActivityTicker'

/** 会话连接状态（任务会话与机器人对话共用） */
export type ConversationConnection = 'connecting' | 'live' | 'reconnecting'

/**
 * 会话消息的归一化形状：
 * 任务对话的 TaskChatMessage 结构直接满足；机器人对话消息由页面补充 sender 与 kind。
 */
export interface ConversationStreamMessage {
  id: string
  role: 'user' | 'assistant'
  sender: TaskChatSender
  content: string
  /** 机器人思考过程（会话视图只保留尾部窗口） */
  reasoning?: string
  createdAt: string
  status: 'running' | 'complete' | 'error'
  /** message=普通对话气泡；question=机器人提问卡片 */
  kind: 'message' | 'question'
  question?: TaskChatQuestion
  tools?: TaskChatTool[]
  /** 用户消息携带的附件（机器人对话支持，任务会话为空） */
  files?: WorkerDebugAttachment[]
}

/** 距离底部小于该值时仍视为停留在底部，实时内容继续跟随 */
const FOLLOW_BOTTOM_THRESHOLD = 24

/** 运行中消息的 Markdown 渲染节流间隔（SSE 增量 60ms 一次，无需每次都解析） */
const STREAM_RENDER_INTERVAL = 200

/** 虚拟化行距（原列表 gap-4） */
const MESSAGE_GAP = 16

export interface ConversationStreamProps {
  /** 会话头部标题（任务会话 / 机器人会话） */
  title: string
  messages: ConversationStreamMessage[]
  connection: ConversationConnection
  /** 提问是否可作答（任务：需求方/管理员且待反馈；机器人对话：pending 即可） */
  canAnswerQuestions: boolean
  /** 提交中（答复提问等） */
  busy: boolean
  /** 回答（answers）或跳过（null）机器人提问 */
  onReplyQuestion: (
    questionId: string,
    answers: string[][] | null,
  ) => Promise<void>
  /** 切换任务/机器人时重置跟随状态 */
  resetKey: unknown
  /** 空列表时展示的内容（缺省「暂无会话内容」） */
  emptyText?: ReactNode
  /** 输入区：由调用方渲染，固定在消息列表下方 */
  children?: ReactNode
}

/**
 * 会话渲染核心（任务详情「会话」与顶部机器人对话共用）：
 * 虚拟化消息列表 + 底部跟随 + 流式渲染节流，运行中只展示一行实时活动；
 * 提问以交互卡片作答，已答/跳过/失效展示只读时间线。
 */
export function ConversationStream({
  title,
  messages,
  connection,
  canAnswerQuestions,
  busy,
  onReplyQuestion,
  resetKey,
  emptyText,
  children,
}: ConversationStreamProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  /** 列表底部哨兵：可见时跟随最新消息；向上翻阅后保留当前位置 */
  const sentinelRef = useRef<HTMLDivElement>(null)
  const followBottomRef = useRef(true)

  const reconciled = useReconciledMessages(messages)

  const visibleMessages = useMemo(
    () =>
      reconciled.filter((message) =>
        message.kind === 'question'
          ? true
          : Boolean(message.content?.trim()) ||
            message.status === 'running' ||
            (message.files?.length ?? 0) > 0,
      ),
    [reconciled],
  )

  useEffect(() => {
    // 切换任务/机器人后重新定位到新会话的最新消息
    followBottomRef.current = true
  }, [resetKey])

  /**
   * 消息列表虚拟化：会话可能有数百条消息，全部常驻 DOM 时滚动与布局都很昂贵。
   * 只渲染视口附近的行，行高按内容动态测量（流式增长由 ResizeObserver 自动重测）。
   */
  // oxlint-disable-next-line react/incompatible-library -- 项目未启用 React Compiler，虚拟化实例本就应保持稳定引用
  const virtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => boxRef.current,
    estimateSize: () => 160,
    overscan: 8,
    getItemKey: (index) => visibleMessages[index]?.id ?? index,
  })
  const totalSize = virtualizer.getTotalSize()
  const lastIndex = visibleMessages.length - 1
  const lastMessage = visibleMessages[lastIndex]

  useEffect(() => {
    // 底部哨兵进入视口（含 24px 缓冲）即视为停留在底部，实时内容继续跟随
    const box = boxRef.current
    const sentinel = sentinelRef.current
    if (!box || !sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target === sentinel) {
            followBottomRef.current = entry.isIntersecting
          }
        }
      },
      {
        root: box,
        rootMargin: `0px 0px ${FOLLOW_BOTTOM_THRESHOLD}px 0px`,
      },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [])

  /** 最后一条消息内容 / 状态变化或高度测量更新时，停留在底部则继续跟随 */
  const followRevision = lastMessage
    ? `${lastMessage.id}:${lastMessage.content?.length ?? 0}:${lastMessage.status}:${lastMessage.question?.state ?? ''}`
    : ''
  useEffect(() => {
    if (!followBottomRef.current || lastIndex < 0) return
    const frame = window.requestAnimationFrame(() => {
      virtualizer.scrollToIndex(lastIndex, { align: 'end' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [followRevision, lastIndex, totalSize, virtualizer])

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-none bg-background">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground-intense">
            {title}
          </h2>
          <Badge variant="soft" size="sm">
            {visibleMessages.length} 条
          </Badge>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-foreground-muted">
          <span
            className={`size-1.5 rounded-full ${
              connection === 'live'
                ? 'bg-success-emphasis'
                : connection === 'reconnecting'
                  ? 'bg-warning-emphasis'
                  : 'bg-foreground-subtle'
            }`}
          />
          {connection === 'live'
            ? '实时'
            : connection === 'reconnecting'
              ? '重连中…'
              : '连接中…'}
        </span>
      </header>

      <div
        ref={boxRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4"
      >
        {visibleMessages.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-center text-sm text-foreground-muted">
            {emptyText ?? '暂无会话内容'}
          </div>
        ) : (
          <div
            className="relative w-full shrink-0"
            style={{ height: totalSize }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const message = visibleMessages[virtualItem.index]
              if (!message) return null
              const question = message.question
              return (
                <div
                  key={message.id}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 top-0 w-full"
                  style={{
                    transform: `translateY(${virtualItem.start}px)`,
                    paddingBottom: MESSAGE_GAP,
                  }}
                >
                  {message.kind === 'question' && question ? (
                    question.state === 'pending' && canAnswerQuestions ? (
                      <PendingQuestionCard
                        message={message}
                        question={question}
                        busy={busy}
                        onReply={onReplyQuestion}
                      />
                    ) : (
                      <QuestionTimeline message={message} question={question} />
                    )
                  ) : (
                    <ConversationMessage message={message} />
                  )}
                </div>
              )
            })}
          </div>
        )}
        {/* 底部哨兵：判断用户是否停留在列表底部（虚拟列表容器之外常驻） */}
        <div ref={sentinelRef} aria-hidden className="h-px w-full shrink-0" />
      </div>

      {children}
    </section>
  )
}

/**
 * 快照按 id 对账：渲染字段未变化的消息复用旧对象引用，
 * 使 memo 生效，全量快照刷新时不再触发全量 Markdown 重新解析。
 * 这里在渲染期读写上次的列表引用（等价于缓存），是刻意的引用复用而非 UI 状态。
 */
/* oxlint-disable react/refs -- 渲染期复用上次列表引用用于对账，不驱动 UI */
function useReconciledMessages(
  messages: ConversationStreamMessage[],
): ConversationStreamMessage[] {
  const previousRef = useRef<ConversationStreamMessage[]>([])
  return useMemo(() => {
    const current = previousRef.current
    if (current.length === 0) {
      previousRef.current = messages
      return messages
    }
    const previous = new Map(current.map((message) => [message.id, message]))
    let unchanged = true
    const merged = messages.map((message, index) => {
      const existing = previous.get(message.id)
      const reused =
        existing && messagesEquivalent(existing, message) ? existing : message
      if (reused !== current[index]) unchanged = false
      return reused
    })
    if (unchanged && merged.length === current.length) return current
    previousRef.current = merged
    return merged
  }, [messages])
}
/* oxlint-enable react/refs */

/** 会话视图渲染相关字段的等价判断 */
function messagesEquivalent(
  a: ConversationStreamMessage,
  b: ConversationStreamMessage,
): boolean {
  if (a === b) return true
  if (
    a.id !== b.id ||
    a.role !== b.role ||
    a.kind !== b.kind ||
    a.status !== b.status ||
    a.createdAt !== b.createdAt ||
    (a.content ?? '').length !== (b.content ?? '').length ||
    (a.reasoning?.length ?? 0) !== (b.reasoning?.length ?? 0) ||
    !sameSender(a.sender, b.sender) ||
    !sameQuestion(a.question, b.question) ||
    !sameTools(a.tools, b.tools) ||
    !sameFiles(a.files, b.files)
  ) {
    return false
  }
  return a.content === b.content && a.reasoning === b.reasoning
}

function sameSender(a: TaskChatSender, b: TaskChatSender): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.kind === b.kind &&
    a.workerId === b.workerId &&
    a.roleLabel === b.roleLabel &&
    a.avatarUrl === b.avatarUrl
  )
}

function sameQuestion(
  a: TaskChatQuestion | undefined,
  b: TaskChatQuestion | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.id === b.id &&
    a.sessionId === b.sessionId &&
    a.state === b.state &&
    a.askedAt === b.askedAt &&
    a.toolCallId === b.toolCallId &&
    JSON.stringify(a.questions) === JSON.stringify(b.questions) &&
    JSON.stringify(a.answers ?? null) === JSON.stringify(b.answers ?? null)
  )
}

function sameTools(
  a: TaskChatTool[] | undefined,
  b: TaskChatTool[] | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (
      left.id !== right.id ||
      left.name !== right.name ||
      left.status !== right.status ||
      left.detail !== right.detail ||
      left.argsText !== right.argsText ||
      left.startedAt !== right.startedAt ||
      left.finishedAt !== right.finishedAt
    ) {
      return false
    }
  }
  return true
}

function sameFiles(
  a: WorkerDebugAttachment[] | undefined,
  b: WorkerDebugAttachment[] | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (
      a[index].url !== b[index].url ||
      a[index].name !== b[index].name ||
      a[index].size !== b[index].size ||
      a[index].mime !== b[index].mime
    ) {
      return false
    }
  }
  return true
}

/**
 * memo：流式更新时只有当前机器人消息对象会变，历史消息保持同一引用，
 * 避免每次增量都重新解析全部历史 Markdown。
 * 运行中的消息再按 200ms 节流解析：SSE 60ms 一次的全量重解析是 O(n²) 的主要来源。
 */
const ConversationMessage = memo(function ConversationMessage({
  message,
}: {
  message: ConversationStreamMessage
}) {
  const isUser = message.role === 'user'
  const running = message.status === 'running'
  /** 运行中的消息节流渲染；结束后立即展示完整正文 */
  const renderedContent = useThrottledText(
    message.content ?? '',
    running ? STREAM_RENDER_INTERVAL : 0,
  )
  const content = renderedContent.trim()
  const files = message.files ?? []
  return (
    <article
      className={`flex items-start gap-3 px-1 ${isUser ? 'flex-row-reverse' : ''}`}
    >
      <WorkerAvatar sender={message.sender} size={30} className="mt-0.5" />
      <div
        className={`flex min-w-0 flex-col gap-1.5 ${
          isUser ? 'max-w-[88%] items-end' : 'min-w-0 flex-1 items-start'
        }`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <SenderLine
            sender={message.sender}
            time={message.createdAt}
            align={isUser ? 'right' : 'left'}
          />
          {running && (
            <span className="inline-flex items-center gap-1 text-[11px] text-info-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-info-emphasis" />
              实时输出中
            </span>
          )}
        </div>
        {isUser ? (
          <div className="min-w-0 max-w-full rounded-none bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground">
            {files.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {files.map((file, index) => (
                  <a
                    key={`${file.url}-${index}`}
                    href={file.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-full items-center gap-1 rounded-[var(--radius-sm)] bg-primary-foreground/15 px-2 py-1 text-[11px] text-primary-foreground no-underline hover:bg-primary-foreground/25"
                  >
                    <Paperclip className="size-3 shrink-0" />
                    <span className="truncate">{file.name || '附件'}</span>
                  </a>
                ))}
              </div>
            )}
            {content && <ChatMarkdown text={renderedContent} onPrimary />}
          </div>
        ) : (
          <div className="min-w-0 max-w-full text-sm leading-relaxed text-foreground-emphasis">
            {content && (
              <>
                <ChatMarkdown text={renderedContent} />
                {running && (
                  <span className="ml-1 inline-block h-3.5 w-1 animate-pulse rounded-full bg-foreground-muted align-middle" />
                )}
              </>
            )}
            {running && <ActivityTicker message={message} />}
          </div>
        )}
      </div>
    </article>
  )
})

/** 提问状态文案：pending 统一展示「等待回答」，其余沿用问答状态标签 */
function questionLabel(question: TaskChatQuestion): string {
  return question.state === 'pending'
    ? '等待回答'
    : questionStatusLabel(question)
}

/** 待回答提问：直接嵌入可交互卡片（选项 / 自由输入 / 跳过） */
function PendingQuestionCard({
  message,
  question,
  busy,
  onReply,
}: {
  message: ConversationStreamMessage
  question: TaskChatQuestion
  busy: boolean
  onReply: (questionId: string, answers: string[][] | null) => Promise<void>
}) {
  return (
    <article className="flex items-start gap-3 px-1">
      <WorkerAvatar sender={message.sender} size={30} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <SenderLine sender={message.sender} time={message.createdAt} />
          <span className="inline-flex items-center gap-1 text-[11px] text-info-foreground">
            <MessageCircleQuestion className="size-3.5" />
            提问 · {questionLabel(question)}
          </span>
        </div>
        <QuestionCard question={question} busy={busy} onReply={onReply} />
      </div>
    </article>
  )
}

const QuestionTimeline = memo(function QuestionTimeline({
  message,
  question,
}: {
  message: ConversationStreamMessage
  question: TaskChatQuestion
}) {
  return (
    <article className="flex items-start gap-3 px-1">
      <WorkerAvatar sender={message.sender} size={30} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <SenderLine sender={message.sender} time={message.createdAt} />
          <span className="inline-flex items-center gap-1 text-[11px] text-info-foreground">
            <MessageCircleQuestion className="size-3.5" />
            提问 · {questionLabel(question)}
          </span>
        </div>
        <div className="rounded-[var(--radius-lg)] rounded-tl-sm border border-border bg-background-subtle px-4 py-3 text-sm leading-relaxed">
          <div className="flex flex-col gap-2">
            {question.questions.map((item, index) => (
              <div key={`${item.header}-${index}`} className="flex flex-col gap-1">
                <p className="font-medium text-foreground-intense">
                  {index + 1}. {item.header}
                </p>
                <p className="whitespace-pre-wrap break-words text-foreground-emphasis">
                  {item.question}
                </p>
                {item.options && item.options.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5 text-xs text-foreground-muted">
                    {item.options.map((option) => (
                      <li
                        key={option.label}
                        className="rounded-full bg-background-muted px-2 py-0.5"
                        title={option.description}
                      >
                        {option.label}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>

          <div className="mt-3 border-t border-border pt-2">
            {question.answers && question.answers.length > 0 ? (
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium text-success-foreground">
                  回答结果
                </p>
                {question.answers.map((answer, index) => (
                  <p
                    key={index}
                    className="whitespace-pre-wrap break-words text-sm text-foreground-emphasis"
                  >
                    {index + 1}. {answer.join(' / ')}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-xs text-foreground-muted">
                {question.state === 'rejected'
                  ? '已跳过回答。'
                  : question.state === 'cancelled'
                    ? '提问已失效。'
                    : question.state === 'answered'
                      ? '已回答。'
                      : '尚未回答，等待在会话中答复。'}
              </p>
            )}
          </div>
        </div>
      </div>
    </article>
  )
})
