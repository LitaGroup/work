import { useCallback, useEffect, useState } from 'react'

/**
 * 详情页分区 tab 与 URL hash 双向同步（规范：`/{主体}/{id}#{分区}` 直达对应分区）。
 * - 挂载与 hashchange 时从地址栏读取，不在 tabs 内回退 fallback
 * - 切换分区时 replaceState 更新地址栏，不产生历史记录
 * - enabled=false 时不读写地址栏（工作台等嵌入场景）
 */
export function useTabHash<T extends string>(
  /** 全部合法分区 key，与页签列表一一对应，须为模块级常量 */
  tabs: readonly T[],
  /** 无有效 hash 时的默认分区（话题深链等场景可传 'topics'） */
  fallback: T,
  enabled = true,
): [tab: T, changeTab: (next: T) => void] {
  const read = useCallback(() => {
    const key = window.location.hash.replace(/^#/, '')
    return tabs.includes(key as T) ? (key as T) : fallback
  }, [tabs, fallback])

  const [tab, setTab] = useState<T>(() => (enabled ? read() : fallback))

  useEffect(() => {
    if (!enabled) return
    const sync = () => setTab(read())
    sync()
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [enabled, read])

  const changeTab = useCallback(
    (next: T) => {
      setTab(next)
      if (!enabled) return
      if (window.location.hash.replace(/^#/, '') !== next) {
        window.history.replaceState(null, '', `#${next}`)
      }
    },
    [enabled],
  )

  return [tab, changeTab]
}