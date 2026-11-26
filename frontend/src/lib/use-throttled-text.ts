import { useEffect, useRef, useState } from 'react'

/**
 * 流式文本节流：机器人输出时 SSE 每 60ms 推送一次累计全文，
 * 每次都重新解析 Markdown 会随回复变长而急剧变慢（近似 O(n²)）。
 *
 * 这里按 intervalMs 节流落值（默认 200ms），保证最后一次增量一定生效；
 * intervalMs <= 0（消息已结束）时直接透传最终内容。
 */
export function useThrottledText(text: string, intervalMs: number): string {
  const [value, setValue] = useState(text)
  const latestRef = useRef(text)
  const timerRef = useRef<number | null>(null)
  const lastEmitRef = useRef(0)

  useEffect(() => {
    latestRef.current = text
  }, [text])

  useEffect(() => {
    if (text === value) return
    if (intervalMs <= 0) {
      // 消息结束：立即展示完整内容，并丢弃待处理的节流定时器
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      lastEmitRef.current = Date.now()
      // oxlint-disable-next-line react/set-state-in-effect
      setValue(text)
      return
    }
    const now = Date.now()
    const wait = Math.max(0, intervalMs - (now - lastEmitRef.current))
    if (wait === 0) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      lastEmitRef.current = now
      // oxlint-disable-next-line react/set-state-in-effect
      setValue(text)
      return
    }
    // 等待期内只保留一个定时器，到点统一落到最新内容
    if (timerRef.current !== null) return
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      lastEmitRef.current = Date.now()
      setValue(latestRef.current)
    }, wait)
  }, [text, intervalMs, value])

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    },
    [],
  )

  return intervalMs <= 0 ? text : value
}
