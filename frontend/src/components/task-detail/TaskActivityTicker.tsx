import { useEffect, useRef, useState } from 'react'
import { Brain, Loader, Wrench } from '@appica/icons-react'
import type { TaskChatMessage, TaskChatTool } from '../../lib/api'
import { toolSummary } from '../agent-chat/ChatParts'

/** 会话运行中展示的一行实时活动 */
export interface TaskActivityLine {
  /** 行标识：同一标识内文本持续变化时只更新内容，不重复播放滚动动画 */
  key: string
  text: string
  tone: 'tool' | 'reasoning' | 'status'
}

/** 思考内容取最后一个非空行，压缩空白并限制长度 */
function reasoningActivity(
  reasoning?: string,
): { key: string; text: string } | null {
  if (!reasoning?.trim()) return null
  const lines = reasoning
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const last = lines[lines.length - 1]
  if (!last) return null
  return {
    key: `reasoning:${lines.length}`,
    text: last.length > 120 ? `${last.slice(0, 120)}…` : last,
  }
}

function toolActivity(tool: TaskChatTool): TaskActivityLine {
  const summary = toolSummary(tool.argsText)
  return {
    key: `tool:${tool.id}`,
    tone: 'tool',
    text: summary ? `${tool.name} · ${summary}` : tool.name,
  }
}

/**
 * 运行中机器人消息的当前活动行：
 * 优先展示正在运行的工具（名称 + 一行参数摘要），否则展示最新一行思考内容，
 * 都没有时保留「正在执行…」；回合结束返回 null。
 */
function taskActivityLineOf(message: TaskChatMessage): TaskActivityLine | null {
  if (message.status !== 'running') return null
  const tools = message.tools ?? []
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index]
    if (tool.status === 'running') return toolActivity(tool)
  }
  const reasoning = reasoningActivity(message.reasoning)
  if (reasoning) return { ...reasoning, tone: 'reasoning' }
  const lastTool = tools[tools.length - 1]
  if (lastTool) return toolActivity(lastTool)
  return { key: 'running', tone: 'status', text: '正在执行…' }
}

/**
 * 单行活动滚动条：新活动从下方进入、旧行向上移出，始终只占一行高度。
 * 仅用于任务会话，不渲染工具调用卡片与思考过程全文。
 */
export function TaskActivityTicker({ message }: { message: TaskChatMessage }) {
  const line = taskActivityLineOf(message)
  const [leaving, setLeaving] = useState<TaskActivityLine | null>(null)
  const currentRef = useRef<TaskActivityLine | null>(line)

  useEffect(() => {
    const previous = currentRef.current
    currentRef.current = line
    if (!line || !previous || previous.key === line.key) return
    // 活动行发生切换：上一行播放向上移出动画，结束后卸载
    // oxlint-disable-next-line react/set-state-in-effect
    setLeaving(previous)
    // 只在活动行标识变化时播放动画；同一行内文本持续更新不重复触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line?.key])

  if (!line) return null
  return (
    <div
      className="relative mt-2 h-5 overflow-hidden"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {leaving && (
        <div
          key={leaving.key}
          className="task-activity-line-exit absolute inset-x-0 top-0"
          onAnimationEnd={() => setLeaving(null)}
        >
          <ActivityLineContent line={leaving} />
        </div>
      )}
      <div key={line.key} className="task-activity-line-enter">
        <ActivityLineContent line={line} />
      </div>
    </div>
  )
}

function ActivityLineContent({ line }: { line: TaskActivityLine }) {
  return (
    <span className="flex h-5 min-w-0 items-center gap-1.5 text-xs text-foreground-muted">
      {line.tone === 'tool' ? (
        <Wrench className="size-3.5 shrink-0 text-info-foreground" />
      ) : line.tone === 'reasoning' ? (
        <Brain className="size-3.5 shrink-0 text-foreground-subtle" />
      ) : (
        <Loader className="size-3.5 shrink-0 animate-spin text-info-foreground" />
      )}
      <span className="truncate">{line.text}</span>
    </span>
  )
}