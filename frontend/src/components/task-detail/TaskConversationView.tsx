import { useCallback, useEffect, useState } from 'react'
import type {
  TaskChatMessage,
  TaskChatPerspective,
  TaskPackage,
  WorkbenchRole,
} from '../../lib/api'
import { useImeEnterGuard } from '../../lib/ime-enter'
import {
  ChatComposerDock,
  ChatComposerFrame,
  ChatSendButton,
} from '../agent-chat/ChatComposer'
import {
  ConversationStream,
  type ConversationConnection,
} from '../agent-chat/ConversationStream'

/** 任务详情「会话」Tab 的连接状态（与共享会话组件一致） */
export type TaskConversationConnection = ConversationConnection

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
 * 消息流渲染复用共享组件（虚拟化 + 底部跟随 + 单行活动），
 * 本组件只保留任务身份/状态相关的输入区逻辑。
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

  useEffect(() => {
    // 切换任务后清空未发送内容与身份
    // oxlint-disable-next-line react/set-state-in-effect
    setDraft('')
    // oxlint-disable-next-line react/set-state-in-effect
    setSendError(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setPerspective('requester')
  }, [taskId])

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
    <ConversationStream
      title="任务会话"
      messages={messages}
      connection={connection}
      canAnswerQuestions={canAnswerQuestions}
      busy={busy}
      onReplyQuestion={onReplyQuestion}
      resetKey={taskId}
    >
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
    </ConversationStream>
  )
}
