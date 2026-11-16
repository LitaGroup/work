import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { Input } from '@appica/ui-react/input'
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

interface TopicTitleInputProps {
  value: string
  onChange: (value: string) => void
  /** 可 @ 的机器人（AI + 真人） */
  workers: Worker[]
  placeholder?: string
}

/**
 * 话题标题输入：标题里同样输入 `@` 可直接提及机器人，
 * 联想面板使用 DropdownMenu；选择后写入 `@名称`。
 */
export function TopicTitleInput({
  value,
  onChange,
  workers,
  placeholder,
}: TopicTitleInputProps) {
  const [query, setQuery] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuOpenRef = useRef(false)

  // 联想面板打开时避免 Base UI 把焦点移到菜单，保证能继续输入筛选关键词
  useEffect(() => {
    if (query === null) {
      menuOpenRef.current = false
      return
    }
    if (menuOpenRef.current) return
    menuOpenRef.current = true
    const restore = () => {
      const input = wrapRef.current?.querySelector('input')
      if (input && document.activeElement !== input) input.focus()
    }
    const first = window.setTimeout(restore, 0)
    const second = window.setTimeout(restore, 120)
    return () => {
      window.clearTimeout(first)
      window.clearTimeout(second)
    }
  }, [query])

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

  const pick = (worker: Worker) => {
    onChange(replaceTrailingMention(value, worker.name))
    setQuery(null)
    // 菜单关闭后把焦点放回输入框，便于继续输入
    window.setTimeout(() => {
      wrapRef.current?.querySelector('input')?.focus()
    }, 0)
  }

  // 候选变化时把键盘高亮重置到第一项
  useEffect(() => {
    setActiveIndex(0)
  }, [query, candidates.length])

  // 上下键移动时把高亮项滚动到可视区域
  useEffect(() => {
    if (query === null) return
    document
      .querySelector('[data-title-mention-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, query])

  /** 联想面板打开时接管上下键与回车/ESC（焦点在输入框，菜单收不到键盘事件） */
  const handleKeyDown = (event: KeyboardEvent) => {
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
    if (event.key === 'Enter') {
      if (candidates.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      pick(candidates[Math.min(activeIndex, candidates.length - 1)])
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
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value)
          setQuery(trailingMentionQuery(e.target.value))
        }}
      />
      <DropdownMenu
        open={query !== null}
        onOpenChange={(next) => {
          if (!next) setQuery(null)
        }}
        modal={false}
      >
        {/* 0 高度锚点：联想面板对齐输入框下方，不包裹输入框以免影响输入 */}
        <DropdownMenuTrigger
          render={<div className="h-0 w-full" tabIndex={-1} />}
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
                data-title-mention-active={
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
            选择后标题会写入 @名称；也可直接输入完整 @名称 触发机器人
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}