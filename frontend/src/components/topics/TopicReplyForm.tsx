import { useState } from 'react'
import { Button } from '@appica/ui-react/button'
import {
  api,
  type TopicPost,
  type TopicStatus,
  type Worker,
} from '../../lib/api'
import { collectMentions } from './mention'
import { MentionTextarea } from './MentionTextarea'

interface TopicReplyFormProps {
  topicId: number
  topicStatus: TopicStatus
  /** 可 @ 的机器人（AI + 真人） */
  workers: Worker[]
  /** 当前引用的帖子（同话题内） */
  quote?: TopicPost | null
  onQuoteChange?: (post: TopicPost | null) => void
  /** 发布成功后回调（刷新帖子/话题列表） */
  onPosted: () => void
}

/** 帖子回复框：纯文本输入（展示侧按 Markdown 渲染），正文 `@` 提及机器人 */
export function TopicReplyForm({
  topicId,
  topicStatus,
  workers,
  quote,
  onQuoteChange,
  onPosted,
}: TopicReplyFormProps) {
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (submitting) return
    const text = content.trim()
    if (!text) {
      setError('帖子内容不能为空')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const mentions = collectMentions(text, workers)
      await api.createTopicPost(topicId, {
        content: text,
        replyToPostId: quote?.id ?? null,
        mentions: mentions.length ? mentions : undefined,
      })
      setContent('')
      onQuoteChange?.(null)
      onPosted()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  if (topicStatus === '已关闭') {
    return (
      <p className="text-sm text-foreground-muted">
        话题已关闭，不能继续发帖（创建人或管理员可重新打开）。
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {quote && (
        <div className="flex items-center justify-between bg-background-muted px-3 py-1 text-xs">
          <span className="truncate">
            引用 #{quote.id} {quote.authorName}：{quote.content.slice(0, 60)}
          </span>
          {onQuoteChange && (
            <button
              type="button"
              className="ml-2 text-foreground-muted hover:text-foreground-intense"
              onClick={() => onQuoteChange(null)}
            >
              取消引用
            </button>
          )}
        </div>
      )}
      <MentionTextarea
        value={content}
        onChange={setContent}
        workers={workers}
        placeholder="输入回复，Enter 发布，Shift+Enter 换行…"
        onSubmit={() => void submit()}
        action={
          <Button
            type="button"
            size="sm"
            disabled={submitting}
            onClick={() => void submit()}
          >
            {submitting ? '提交中…' : '发布'}
          </Button>
        }
      />
      {error && <p className="text-sm text-error">{error}</p>}
    </div>
  )
}