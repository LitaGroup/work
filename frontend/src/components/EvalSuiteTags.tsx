import { useEffect, useRef, useState } from 'react'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@appica/ui-react/dialog'
import { Input } from '@appica/ui-react/input'
import {
  api,
  EVAL_SUITE_TAG_MAX_COUNT,
  EVAL_SUITE_TAG_MAX_LENGTH,
  type EvalSuite,
} from '../lib/api'
import { PopoverNotice, noticeDurationMs } from './PopoverNotice'

interface EvalSuiteTagsProps {
  suite: Pick<EvalSuite, 'id' | 'name' | 'tags'>
  /** 保存成功后回传最新测试集，供列表或详情同步 */
  onUpdated?: (suite: EvalSuite) => void
  canEdit?: boolean
  className?: string
}

/**
 * 测试集标签：展示现有标签，并通过弹窗手动添加/删除。
 * 标签只做分类展示，保存不递增测试集版本。
 */
export function EvalSuiteTags({
  suite,
  onUpdated,
  canEdit = true,
  className,
}: EvalSuiteTagsProps) {
  const tags = suite.tags ?? []
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string[]>(tags)
  const [input, setInput] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<{
    success?: string
    error?: string
  } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => clearTimer, [])

  const changeOpen = (next: boolean) => {
    clearTimer()
    if (next) {
      setDraft([...tags])
      setInput('')
      setInputError(null)
      setFeedback(null)
    } else {
      setFeedback(null)
    }
    setOpen(next)
  }

  const addTag = () => {
    const tag = input.trim()
    if (!tag) return
    if (draft.includes(tag)) {
      setInputError('标签已存在')
      return
    }
    if (draft.length >= EVAL_SUITE_TAG_MAX_COUNT) {
      setInputError(`标签最多 ${EVAL_SUITE_TAG_MAX_COUNT} 个`)
      return
    }
    setDraft([...draft, tag])
    setInput('')
    setInputError(null)
  }

  const save = () => {
    if (pending) return
    clearTimer()
    setPending(true)
    api
      .updateEvalSuiteTags(suite.id, draft)
      .then((updated) => {
        setDraft(updated.tags ?? [])
        onUpdated?.(updated)
        setFeedback({ success: '标签已保存' })
        timerRef.current = setTimeout(() => {
          setFeedback(null)
          setOpen(false)
        }, noticeDurationMs(null))
      })
      .catch((e: Error) => {
        setFeedback({ error: e.message || '标签保存失败' })
        timerRef.current = setTimeout(() => {
          setFeedback(null)
        }, noticeDurationMs('x'))
      })
      .finally(() => setPending(false))
  }

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`}>
      {tags.length > 0 ? (
        tags.map((tag) => (
          <Badge key={tag} variant="secondary" size="sm">
            {tag}
          </Badge>
        ))
      ) : (
        <span className="text-xs text-foreground-muted">未设置标签</span>
      )}
      {canEdit && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => changeOpen(true)}
          aria-label={`编辑测试集「${suite.name}」标签`}
        >
          编辑标签
        </Button>
      )}

      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑测试集标签</DialogTitle>
          </DialogHeader>
          <DialogBody className="grid gap-3">
            <div className="flex flex-wrap gap-1.5">
              {draft.map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  size="sm"
                  className="gap-1 pr-1"
                >
                  {tag}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5"
                    disabled={pending}
                    aria-label={`删除标签「${tag}」`}
                    onClick={() =>
                      setDraft(draft.filter((item) => item !== tag))
                    }
                  >
                    ×
                  </Button>
                </Badge>
              ))}
              {draft.length === 0 && (
                <span className="text-sm text-foreground-muted">
                  暂无标签，可在下方添加。
                </span>
              )}
            </div>
            <div className="flex items-end gap-2">
              <label className="grid flex-1 gap-1 text-sm">
                添加标签
                <Input
                  value={input}
                  maxLength={EVAL_SUITE_TAG_MAX_LENGTH}
                  placeholder={`输入标签，最多 ${EVAL_SUITE_TAG_MAX_LENGTH} 个字符`}
                  disabled={pending || draft.length >= EVAL_SUITE_TAG_MAX_COUNT}
                  onChange={(e) => {
                    setInput(e.target.value)
                    setInputError(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addTag()
                    }
                  }}
                />
              </label>
              <Button
                variant="outline"
                disabled={
                  pending ||
                  !input.trim() ||
                  draft.length >= EVAL_SUITE_TAG_MAX_COUNT
                }
                onClick={addTag}
              >
                添加
              </Button>
            </div>
            {inputError && (
              <p className="text-sm text-foreground-danger">{inputError}</p>
            )}
            <p className="text-xs text-foreground-muted">
              最多 {EVAL_SUITE_TAG_MAX_COUNT} 个标签；标签仅用于分类展示，不影响评估结果。
            </p>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              取消
            </DialogClose>
            <PopoverNotice
              open={!!feedback}
              onOpenChange={(next) => {
                if (!next && feedback?.error) setFeedback(null)
              }}
              success={feedback?.success}
              error={feedback?.error}
            >
              <Button onClick={save} disabled={pending}>
                {pending ? '保存中…' : '保存标签'}
              </Button>
            </PopoverNotice>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}