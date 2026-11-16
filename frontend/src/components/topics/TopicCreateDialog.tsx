import { useMemo, useState } from 'react'
import { Button } from '@appica/ui-react/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  DialogClose,
} from '@appica/ui-react/dialog'
import { Input } from '@appica/ui-react/input'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@appica/ui-react/select'
import {
  api,
  TOPIC_PRIORITIES,
  type Topic,
  type TopicPriority,
  type TopicSubjectType,
  type Worker,
} from '../../lib/api'
import { collectMentions } from './mention'
import { MentionTextarea } from './MentionTextarea'
import { TopicTitleInput } from './TopicTitleInput'

interface TopicCreateDialogProps {
  subjectType: TopicSubjectType
  subjectId: number
  subjectTitle: string
  /** Tab 名称（话题/讨论），用于按钮与标题文案 */
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (topic: Topic) => void
  workers: Worker[]
}

/** 新建话题：纯文本正文（展示侧按 Markdown 渲染），正文/标题输入 @ 提及机器人 */
export function TopicCreateDialog({
  subjectType,
  subjectId,
  subjectTitle,
  label,
  open,
  onOpenChange,
  onCreated,
  workers,
}: TopicCreateDialogProps) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [priority, setPriority] = useState<TopicPriority>('中')
  const [tags, setTags] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const priorityItems = useMemo(
    () => Object.fromEntries(TOPIC_PRIORITIES.map((item) => [item, item])),
    [],
  )

  const reset = () => {
    setTitle('')
    setContent('')
    setPriority('中')
    setTags('')
    setError(null)
  }

  const submit = async () => {
    const text = content.trim()
    if (!text) {
      setError('话题内容不能为空')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const mentions = [
        ...new Set([
          ...collectMentions(title, workers),
          ...collectMentions(text, workers),
        ]),
      ]
      const topic = await api.createTopic({
        subjectType,
        subjectId,
        title: title.trim() || undefined,
        content: text,
        priority,
        tags: tags
          .split(/[,，、\s]+/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        mentions: mentions.length ? mentions : undefined,
      })
      reset()
      onOpenChange(false)
      onCreated(topic)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="w-full max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            新建{label}
            <span className="ml-2 text-sm font-normal text-foreground-muted">
              {subjectTitle}
            </span>
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4 overflow-y-auto">
          <div className="space-y-1">
            <label className="text-sm text-foreground-muted">
              标题（可空；输入 @ 可提及机器人）
            </label>
            <TopicTitleInput
              value={title}
              onChange={setTitle}
              workers={workers}
              placeholder="可留空：平台用正文首行兜底并异步生成「TP-{id}」标题"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm text-foreground-muted">优先级</label>
              <Select
                value={priority}
                onValueChange={(value) => setPriority(value as TopicPriority)}
                items={priorityItems}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TOPIC_PRIORITIES.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-sm text-foreground-muted">
                标签（逗号分隔，最多 10 个）
              </label>
              <Input
                value={tags}
                placeholder="如：性能, 接口"
                onChange={(e) => setTags(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-sm text-foreground-muted">
              正文（纯文本，输入 @ 可直接提及机器人；展示时按 Markdown 渲染）
            </label>
            <MentionTextarea
              value={content}
              onChange={setContent}
              workers={workers}
              maxHeight={480}
              placeholder="描述问题、背景或想讨论的内容…"
            />
          </div>
          {error && <p className="text-sm text-error">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <DialogClose>
            <Button variant="ghost" type="button">
              取消
            </Button>
          </DialogClose>
          <Button type="button" disabled={submitting} onClick={() => void submit()}>
            {submitting ? '创建中…' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}