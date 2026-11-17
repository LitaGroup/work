import { useEffect, useRef, useState } from 'react'
import { Button } from '@appica/ui-react/button'
import { Input } from '@appica/ui-react/input'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
  PopoverDescription,
} from '@appica/ui-react/popover'
import { api } from '../lib/api'

const SUCCESS_STAY_MS = 2_000
const FAILURE_STAY_MS = 5_000

/** 与后端 ITERATION_DESCRIPTION_MAX 保持一致 */
const DESCRIPTION_MAX = 200

type Feedback =
  | { kind: 'success'; message: string }
  | { kind: 'failure'; message: string }
  | null

interface IterationDescriptionProps {
  /** 迭代 ID */
  iterationId: number
  /** 当前描述（可空） */
  value: string | null
  /** 是否可编辑（目前仅管理员） */
  canEdit: boolean
  /** 保存成功回调（description 为 null 表示已清空） */
  onSaved: (description: string | null) => void
  /** 空值时的可编辑占位文案 */
  placeholder?: string
  className?: string
}

/**
 * 迭代描述：默认空，点击文本就地编辑（Enter 保存 / Esc 取消）。
 * 保存结果按 UI 规范用 Popover 锚定「保存」按钮反馈；成功后停留 2 秒再退出编辑态。
 * 组件内所有交互都会阻止事件冒泡，避免触发外层可点击行（展开/收起迭代项）。
 */
export function IterationDescription({
  iterationId,
  value,
  canEdit,
  onSaved,
  placeholder = '添加描述',
  className,
}: IterationDescriptionProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }
  useEffect(() => clearTimer, [])

  const showFeedback = (
    next: NonNullable<Feedback>,
    stayMs: number,
    after?: () => void,
  ) => {
    clearTimer()
    setFeedback(next)
    timerRef.current = setTimeout(() => {
      setFeedback(null)
      after?.()
    }, stayMs)
  }

  const startEdit = () => {
    setDraft(value ?? '')
    setFeedback(null)
    setEditing(true)
  }

  const cancel = () => {
    if (pending) return
    clearTimer()
    setFeedback(null)
    setEditing(false)
  }

  const save = () => {
    if (pending) return
    const next = draft.trim()
    setPending(true)
    api
      .updateIteration(iterationId, { description: next || null })
      .then((updated) => {
        const saved = updated.description ?? null
        onSaved(saved)
        showFeedback(
          {
            kind: 'success',
            message: saved ? '描述已保存' : '描述已清空',
          },
          SUCCESS_STAY_MS,
          () => setEditing(false),
        )
      })
      .catch((e: Error) =>
        showFeedback(
          { kind: 'failure', message: e.message || '保存失败' },
          FAILURE_STAY_MS,
        ),
      )
      .finally(() => setPending(false))
  }

  const text = value?.trim() ?? ''

  if (editing) {
    return (
      <span
        className={`inline-flex flex-wrap items-center gap-2 ${className ?? ''}`}
        onClick={(event) => event.stopPropagation()}
      >
        <Input
          autoFocus
          value={draft}
          maxLength={DESCRIPTION_MAX}
          placeholder="迭代描述（可空）"
          className="h-7 w-64"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              save()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancel()
            }
          }}
        />
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
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={save}
              />
            }
          >
            {pending ? '保存中…' : '保存'}
          </PopoverTrigger>
          <PopoverContent side="top" align="start">
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
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={(event) => {
            event.stopPropagation()
            cancel()
          }}
        >
          取消
        </Button>
      </span>
    )
  }

  if (!text) {
    if (!canEdit) return null
    return (
      <button
        type="button"
        className={`text-sm text-foreground-muted underline-offset-2 hover:underline ${className ?? ''}`}
        onClick={(event) => {
          event.stopPropagation()
          startEdit()
        }}
      >
        {placeholder}
      </button>
    )
  }

  if (!canEdit) {
    return (
      <span
        className={`max-w-64 truncate text-sm ${className ?? ''}`}
        title={text}
      >
        {text}
      </span>
    )
  }

  return (
    <button
      type="button"
      className={`max-w-64 truncate text-left text-sm underline-offset-2 hover:underline ${className ?? ''}`}
      title={`${text}（点击编辑）`}
      onClick={(event) => {
        event.stopPropagation()
        startEdit()
      }}
    >
      {text}
    </button>
  )
}