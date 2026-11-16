import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@appica/ui-react/dropdown-menu'
import type { Worker } from '../../lib/api'
import { matchesPinyinSearch } from '../../lib/pinyin-search'
import {
  replaceTrailingMention,
  trailingMentionQuery,
} from './mention'

/** 候选机器人数量上限 */
const MENTION_CANDIDATE_LIMIT = 8

interface MentionTextareaProps {
  value: string
  onChange: (value: string) => void
  /** 可 @ 的机器人（AI + 真人） */
  workers: Worker[]
  placeholder?: string
  /** 默认行数（初始高度） */
  rows?: number
  /** 自动延伸的最大高度（px），超出后内部滚动 */
  maxHeight?: number
  disabled?: boolean
  /** 输入框内右下角的操作区（如「发布」按钮），与 AI 面板输入框一致 */
  action?: ReactNode
  /** 回车提交（Shift+回车换行），传入后与 AI 面板输入行为一致 */
  onSubmit?: () => void
}

/**
 * 纯文本输入框（不支持 Markdown 编辑）：输入 `@` 直接联想机器人并写入 `@名称`，
 * 支持上下键选择、回车确认、ESC 关闭。展示侧仍按 Markdown 渲染。
 * 外框与 AI 面板输入框一致：圆角边框 + focus 描边，操作按钮可嵌入框内右下角。
 */
export function MentionTextarea({
  value,
  onChange,
  workers,
  placeholder,
  rows = 3,
  maxHeight = 360,
  disabled,
  action,
  onSubmit,
}: MentionTextareaProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  )
  const [query, setQuery] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const menuOpenRef = useRef(false)

  // 默认 rows 行，内容变多时自动延伸；超过 maxHeight 后内部滚动
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const next = Math.min(textarea.scrollHeight, maxHeight)
    textarea.style.height = `${next}px`
    textarea.style.overflowY =
      textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [value, rows, maxHeight])

  const candidates = useMemo(() => {
    if (query === null) return []
    return workers
      .filter((worker) => worker.enabled && !worker.personalAgentUserId)
      .filter(
        (worker) =>
          !query ||
          matchesPinyinSearch(query, [worker.name, worker.humanUserName]),
      )
      .slice(0, MENTION_CANDIDATE_LIMIT)
  }, [workers, query])

  // 联想面板打开时把焦点留在输入框，避免 Base UI 抢焦点后无法继续输入
  useEffect(() => {
    if (query === null) {
      menuOpenRef.current = false
      return
    }
    if (menuOpenRef.current) return
    menuOpenRef.current = true
    const restore = () => {
      const textarea = wrapRef.current?.querySelector('textarea')
      if (textarea && document.activeElement !== textarea) textarea.focus()
    }
    const first = window.setTimeout(restore, 0)
    const second = window.setTimeout(restore, 120)
    return () => {
      window.clearTimeout(first)
      window.clearTimeout(second)
    }
  }, [query])

  // 候选变化时重置键盘高亮；上下键移动时把高亮项滚入可视区
  useEffect(() => {
    setActiveIndex(0)
  }, [query, candidates.length])

  useEffect(() => {
    if (query === null) return
    document
      .querySelector('[data-textarea-mention-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, query])

  /** 把联想面板锚点移到光标所在行（紧贴正在输入的 @） */
  const updateAnchor = () => {
    const textarea = textareaRef.current
    const wrap = wrapRef.current
    if (!textarea || !wrap) {
      setAnchor(null)
      return
    }
    const caret = caretCoordinates(
      textarea,
      textarea.selectionStart ?? textarea.value.length,
    )
    if (!caret) {
      setAnchor(null)
      return
    }
    const taRect = textarea.getBoundingClientRect()
    const wrapRect = wrap.getBoundingClientRect()
    setAnchor({
      top: taRect.top - wrapRect.top + caret.top + caret.lineHeight + 4,
      left: Math.max(0, taRect.left - wrapRect.left + caret.left),
    })
  }

  const handleValueChange = (textarea: HTMLTextAreaElement) => {
    onChange(textarea.value)
    const next = trailingMentionQuery(textarea.value)
    setQuery(next)
    if (next !== null) {
      window.requestAnimationFrame(updateAnchor)
    }
  }

  const pick = (worker: Worker) => {
    onChange(replaceTrailingMention(value, worker.name))
    setQuery(null)
    window.setTimeout(() => {
      wrapRef.current?.querySelector('textarea')?.focus()
    }, 0)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    // 输入法组合中的回车交给输入法处理
    if (event.nativeEvent.isComposing) return

    if (event.key === 'Enter') {
      if (event.shiftKey) {
        // Shift+回车 = 换行：关闭联想，保留 textarea 默认换行
        if (query !== null) setQuery(null)
        return
      }
      if (query !== null) {
        // 联想面板打开时，回车选中当前候选
        if (candidates.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        pick(candidates[Math.min(activeIndex, candidates.length - 1)])
        return
      }
      if (onSubmit && !disabled) {
        // 回车 = 发布（与 AI 面板输入一致）
        event.preventDefault()
        event.stopPropagation()
        onSubmit()
      }
      return
    }

    if (query === null) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      event.stopPropagation()
      setActiveIndex((index) =>
        candidates.length ? (index + 1) % candidates.length : 0,
      )
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      setActiveIndex((index) =>
        candidates.length
          ? (index - 1 + candidates.length) % candidates.length
          : 0,
      )
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setQuery(null)
    }
  }

  return (
    <div
      className="relative"
      ref={wrapRef}
      onKeyDownCapture={handleKeyDown}
    >
      <div className="relative flex flex-col rounded-[var(--radius-lg)] border border-border bg-background px-3 py-2 transition-colors focus-within:border-border-strong">
        <textarea
          ref={textareaRef}
          value={value}
          rows={rows}
          placeholder={placeholder}
          disabled={disabled}
          className={`w-full resize-none overflow-hidden bg-transparent text-sm leading-relaxed text-foreground outline-none placeholder:text-foreground-subtle disabled:cursor-not-allowed ${
            action ? 'pr-24' : ''
          }`}
          onChange={(e) => handleValueChange(e.currentTarget)}
        />
        {action && (
          <div className="absolute right-2 bottom-2 flex items-center">
            {action}
          </div>
        )}
      </div>
      <DropdownMenu
        open={query !== null}
        onOpenChange={(next) => {
          if (!next) setQuery(null)
        }}
        modal={false}
      >
        <DropdownMenuTrigger
          render={
            <div
              className="pointer-events-none absolute h-0 w-0"
              style={{ top: anchor?.top ?? 0, left: anchor?.left ?? 0 }}
              tabIndex={-1}
            />
          }
        />
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={4}
          className="max-h-64 min-w-64 overflow-y-auto"
        >
          {candidates.length === 0 ? (
            <div className="px-3 py-2 text-sm text-foreground-muted">
              没有匹配的机器人
            </div>
          ) : (
            candidates.map((worker, index) => (
              <DropdownMenuItem
                key={worker.id}
                data-textarea-mention-active={
                  index === activeIndex ? 'true' : undefined
                }
                className={
                  index === activeIndex ? 'bg-background-muted' : undefined
                }
                onClick={() => pick(worker)}
              >
                <span className="mr-2 text-xs text-foreground-muted">
                  {worker.runtime === 'human' ? '真人' : 'AI'}
                </span>
                {worker.name}
                {worker.humanUserName ? (
                  <span className="ml-2 text-xs text-foreground-muted">
                    {worker.humanUserName}
                  </span>
                ) : null}
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <p className="px-2 py-1 text-xs text-foreground-muted">
            选择后正文会写入 @名称；也可直接输入完整 @名称 触发机器人
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/**
 * 用隐藏镜像测量 textarea 光标位置（支持自动换行）：
 * 返回相对内容盒的坐标与行高，用于把联想面板定位在 @ 附近。
 */
function caretCoordinates(
  textarea: HTMLTextAreaElement,
  position: number,
): { top: number; left: number; lineHeight: number } | null {
  const style = window.getComputedStyle(textarea)
  const mirror = document.createElement('div')
  const properties = [
    'boxSizing',
    'width',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'fontStyle',
    'fontVariant',
    'fontWeight',
    'fontStretch',
    'fontSize',
    'fontFamily',
    'lineHeight',
    'textAlign',
    'textTransform',
    'textIndent',
    'letterSpacing',
    'wordSpacing',
    'tabSize',
    'overflowWrap',
    'wordBreak',
  ] as const
  for (const prop of properties) {
    mirror.style[prop] = style[prop]
  }
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.top = '0'
  mirror.style.left = '0'
  mirror.style.height = 'auto'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.textContent = textarea.value.slice(0, position)
  const marker = document.createElement('span')
  marker.textContent = '\u200b'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const lineHeight =
    parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5
  const top = marker.offsetTop - textarea.scrollTop
  const left = marker.offsetLeft - textarea.scrollLeft
  document.body.removeChild(mirror)
  return { top, left, lineHeight }
}