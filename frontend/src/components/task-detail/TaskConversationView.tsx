import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '@appica/ui-react/badge'
import { MessageCircleQuestion } from '@appica/icons-react'
import type {
  TaskChatMessage,
  TaskChatPerspective,
  TaskChatQuestion,
  TaskPackage,
  WorkbenchRole,
} from '../../lib/api'
import { questionStatusLabel } from '../../lib/question'
import { useImeEnterGuard } from '../../lib/ime-enter'
import { ChatMarkdown } from '../ChatMarkdown'
import { QuestionCard } from '../QuestionCard'
import {
  ChatComposerDock,
  ChatComposerFrame,
  ChatSendButton,
} from '../agent-chat/ChatComposer'
import { SenderLine, WorkerAvatar } from './WorkerAvatar'
import { TaskActivityTicker } from './TaskActivityTicker'

/** 任务详情「会话」Tab 的连接状态 */
export type TaskConversationConnection =
  | 'connecting'
  | 'live'
  | 'reconnecting'

/** 距离底部小于该值时仍视为停留在底部，实时内容继续跟随 */
const FOLLOW_BOTTOM_THRESHOLD = 24

export interface TaskConversationViewProps {
  taskId: number
  task: TaskPackage | null
  messages: TaskChatMessage[]
  connection: TaskConversationConnection
  /** 当前用户在该任务中的角色（工作台口径） */
  roles: WorkbenchRole[]
  /** 当前用户是否管理员：可答复提问，但不以需求方身份发消息 */
  isAdmin: boolean
  /** 发送或答复进行中 */
  busy: boolean
  /** 以指定身份发送消息；返回错误文案，成功返回 null */
  onSend: (
    text: string,
    perspective: TaskChatPerspective,
  ) => Promise<string | null>
  /** 回答（answers）或跳过（null）机器人提问 */
  onReplyQuestion: (
    questionId: string,
    answers: string[][] | null,
  ) => Promise<void>
}

/**
 * 任务详情「会话」：实时展示多方交互，并按当前用户身份发送消息与答复提问。
 * 不渲染工具调用和思考过程，运行中只展示一行实时活动；提问以交互卡片作答。
 */
export function TaskConversationView({
  taskId,
  task,
  messages,
  connection,
  roles,
  isAdmin,
  busy,
  onSend,
  onReplyQuestion,
}: TaskConversationViewProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  /** 用户停留在底部时跟随最新消息；向上翻阅后保留当前位置 */
  const followBottomRef = useRef(true)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [perspective, setPerspective] =
    useState<TaskChatPerspective>('requester')
  const imeEnter = useImeEnterGuard()

  const isRequester = roles.includes('requester')
  const isAgent = roles.includes('agent')
  const bothRoles = isRequester && isAgent
  const canSend = isRequester || isAgent
  const showComposer = Boolean(task) && (canSend || isAdmin)

  const finished = task?.status === '已结束'
  const awaitingAnswer = task?.subStatus === '待反馈'
  const awaitingReview = task?.subStatus === '待验收'
  const executing = task?.subStatus === '执行中'
  /** 需求方与管理员可答复提问；执行方与旁观者只读 */
  const canAnswerQuestions = (isRequester || isAdmin) && awaitingAnswer

  /** 单一身份时直接使用该身份；双身份时按切换状态 */
  const activePerspective: TaskChatPerspective = bothRoles
    ? perspective
    : isAgent
      ? 'responsible'
      : 'requester'

  const sendDisabled =
    !task ||
    busy ||
    sending ||
    finished ||
    !canSend ||
    !draft.trim() ||
    (activePerspective === 'responsible' && awaitingReview)

  const visibleMessages = useMemo(
    () =>
      messages.filter((message) =>
        message.kind === 'question'
          ? true
          : Boolean(message.content?.trim()) || message.status === 'running',
      ),
    [messages],
  )

  useEffect(() => {
    // 切换任务后重新定位到新任务的最新消息，并清空未发送内容与身份
    followBottomRef.current = true
    // oxlint-disable-next-line react/set-state-in-effect
    setDraft('')
    // oxlint-disable-next-line react/set-state-in-effect
    setSendError(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setPerspective('requester')
  }, [taskId])

  useEffect(() => {
    const box = boxRef.current
    if (!box || !followBottomRef.current) return
    box.scrollTop = box.scrollHeight
  }, [visibleMessages])

  const handleScroll = () => {
    const box = boxRef.current
    if (!box) return
    followBottomRef.current =
      box.scrollHeight - box.scrollTop - box.clientHeight <=
      FOLLOW_BOTTOM_THRESHOLD
  }

  const selectPerspective = (next: TaskChatPerspective) => {
    if (next === activePerspective) return
    // 切换身份时清空未发送内容，避免把需求方内容误发成执行方消息
    setDraft('')
    setSendError(null)
    setPerspective(next)
  }

  const sendMessage = useCallback(async () => {
    const text = draft.trim()
    if (!text || sendDisabled) return
    setSending(true)
    setSendError(null)
    try {
      const error = await onSend(text, activePerspective)
      if (error) {
        setSendError(error)
      } else {
        // 发送失败保留输入内容，便于直接重试
        setDraft((current) => (current.trim() === text ? '' : current))
      }
    } finally {
      setSending(false)
    }
  }, [draft, sendDisabled, onSend, activePerspective])

  const placeholder = !task
    ? '选择任务后开始交互'
    : finished
      ? '任务已结束，不能继续对话'
      : !canSend
        ? '管理员可直接答复提问，不能以需求方身份发送消息'
        : activePerspective === 'requester'
          ? awaitingReview
            ? '输入验收不通过意见，发送后退回机器人…'
            : '以需求方身份补充需求…'
          : awaitingReview
            ? '待需求方验收，如需继续修改请先撤销交付'
            : isAgent && executing
              ? '以执行方身份回复…'
              : '以执行方身份提供反馈…'

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-none bg-background">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground-intense">
            任务会话
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
        onScroll={handleScroll}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
      >
        {visibleMessages.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-center text-sm text-foreground-muted">
            暂无会话内容
          </div>
        ) : (
          visibleMessages.map((message) => {
            const question = message.question
            if (message.kind === 'question' && question) {
              return question.state === 'pending' && canAnswerQuestions ? (
                <PendingQuestionCard
                  key={message.id}
                  message={message}
                  question={question}
                  busy={busy}
                  onReply={onReplyQuestion}
                />
              ) : (
                <QuestionTimeline
                  key={message.id}
                  message={message}
                  question={question}
                />
              )
            }
            return <ConversationMessage key={message.id} message={message} />
          })
        )}
      </div>

      {showComposer && (
        <ChatComposerDock>
          <ChatComposerFrame
            top={
              bothRoles ? (
                <div className="flex flex-wrap items-center gap-1 px-2 pt-2">
                  {(
                    [
                      ['requester', '需求方'],
                      ['responsible', '执行方'],
                    ] as Array<[TaskChatPerspective, string]>
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => selectPerspective(key)}
                      className={`rounded-[var(--radius-md)] px-2.5 py-1 text-xs ${
                        activePerspective === key
                          ? 'bg-background-muted font-medium text-foreground-intense'
                          : 'text-foreground-muted hover:text-foreground-intense'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : undefined
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
              disabled={
                !task ||
                busy ||
                sending ||
                finished ||
                !canSend ||
                (activePerspective === 'responsible' && awaitingReview)
              }
              onChange={(event) => setDraft(event.target.value)}
              onCompositionStart={imeEnter.onCompositionStart}
              onCompositionEnd={imeEnter.onCompositionEnd}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey) return
                if (imeEnter.isImeEnter(event)) return
                event.preventDefault()
                void sendMessage()
              }}
              placeholder={placeholder}
              className="block h-[72px] w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-foreground-subtle disabled:cursor-not-allowed disabled:opacity-60"
            />
          </ChatComposerFrame>
          {sendError && (
            <p role="alert" className="mt-1.5 text-[11px] text-error-foreground">
              {sendError}
            </p>
          )}
        </ChatComposerDock>
      )}
    </section>
  )
}

function ConversationMessage({ message }: { message: TaskChatMessage }) {
  const isUser = message.role === 'user'
  const running = message.status === 'running'
  const content = message.content?.trim() ?? ''
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
            <ChatMarkdown text={message.content} onPrimary />
          </div>
        ) : (
          <div className="min-w-0 max-w-full text-sm leading-relaxed text-foreground-emphasis">
            {content && (
              <>
                <ChatMarkdown text={message.content} />
                {running && (
                  <span className="ml-1 inline-block h-3.5 w-1 animate-pulse rounded-full bg-foreground-muted align-middle" />
                )}
              </>
            )}
            {running && <TaskActivityTicker message={message} />}
          </div>
        )}
      </div>
    </article>
  )
}

/** 待回答提问：直接嵌入可交互卡片（选项 / 自由输入 / 跳过） */
function PendingQuestionCard({
  message,
  question,
  busy,
  onReply,
}: {
  message: TaskChatMessage
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
            提问 · {questionStatusLabel(question)}
          </span>
        </div>
        <QuestionCard question={question} busy={busy} onReply={onReply} />
      </div>
    </article>
  )
}

function QuestionTimeline({
  message,
  question,
}: {
  message: TaskChatMessage
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
            提问 · {questionStatusLabel(question)}
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
                      : '尚未回答，等待需求方或管理员在会话中答复。'}
              </p>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}