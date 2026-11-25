import { useEffect, useState } from 'react'
import { Badge } from '@appica/ui-react/badge'
import { api, type TaskTrace, type TaskTraceStep } from '../../lib/api'

/**
 * 任务详情 · 执行过程（TECH_DESIGN 12）：平台侧可见的执行记录。
 * 顶部为内核/模型/轮数/调用/报错/脱敏统计；主体按轮分组展示步骤（调用参数与返回默认折叠）。
 */
export function TaskTracePanel({ taskId }: { taskId: number }) {
  const [trace, setTrace] = useState<TaskTrace | null | undefined>(undefined)
  const [steps, setSteps] = useState<TaskTraceStep[]>([])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .getTaskTrace(taskId)
      .then(async (row) => {
        if (!alive) return
        setTrace(row)
        if (row) {
          const result = await api.getTraceSteps(row.id, { limit: 200 })
          if (alive) setSteps(result.steps)
        }
      })
      .catch((e: Error) => {
        if (alive) {
          setTrace(null)
          setError(e.message)
        }
      })
    return () => {
      alive = false
    }
  }, [taskId])

  if (trace === undefined) {
    return <p className="text-sm text-foreground-muted">加载中…</p>
  }
  if (!trace) {
    return (
      <p className="text-sm text-foreground-muted">
        {error ?? '暂无执行记录（执行记录按机器人「采集执行记录」开关采集，评估任务始终采集）。'}
      </p>
    )
  }

  const turns = new Map<number, TaskTraceStep[]>()
  for (const step of steps) {
    const turn = Number(step.turn ?? 0)
    const list = turns.get(turn) ?? []
    list.push(step)
    turns.set(turn, list)
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-none bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-3 text-xs text-foreground-muted">
        <Badge variant="secondary" size="sm">
          {trace.status}
        </Badge>
        <span>内核：{trace.kernel ?? '-'}</span>
        <span>模型：{trace.model ?? '-'}</span>
        <span>轮数：{trace.turnCount}</span>
        <span>平台调用：{trace.callCount}</span>
        <span>报错：{trace.callErrorCount}</span>
        <span>被拦截：{trace.blockedCount}</span>
        <span>已脱敏：{trace.redactionCount} 处</span>
        {trace.outcome && <span>结果：{trace.outcome}</span>}
        <span className="text-foreground-muted/70">
          仅包含平台侧可见的过程（消息、平台调用、任务事件）
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="grid gap-3">
          {Array.from(turns.entries())
            .sort(([a], [b]) => a - b)
            .map(([turn, list]) => (
              <div key={turn} className="rounded-md border border-border">
                <div className="border-b border-border px-3 py-1.5 text-sm font-medium">
                  第 {turn || '-'} 轮
                </div>
                <div className="grid gap-1 p-3 text-xs">
                  {list.map((step) => (
                    <div key={step.seq} className="grid gap-0.5">
                      <button
                        className="flex w-full items-start gap-2 text-left hover:bg-background-muted"
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev)
                            if (next.has(step.seq)) next.delete(step.seq)
                            else next.add(step.seq)
                            return next
                          })
                        }
                      >
                        <span className="w-20 shrink-0 text-foreground-muted">
                          {new Date(step.at).toLocaleTimeString('zh-CN')}
                        </span>
                        <span className="shrink-0 font-medium">
                          {stepLabel(String(step.type))}
                        </span>
                        <span className="truncate text-foreground-muted">
                          {stepSummary(step)}
                        </span>
                      </button>
                      {expanded.has(step.seq) && (
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-background p-2 text-xs">
                          {JSON.stringify(step, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          {steps.length === 0 && (
            <p className="text-xs text-foreground-muted">
              暂无步骤（记录尚未写入）。
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

function stepLabel(type: string): string {
  const map: Record<string, string> = {
    turn_start: '回合开始',
    message_in: '平台消息',
    platform_call: '平台调用',
    task_event: '任务事件',
    turn_end: '回合结束',
  }
  return map[type] ?? type
}

function stepSummary(step: TaskTraceStep): string {
  if (step.type === 'platform_call') {
    return `${String(step.tool ?? '')} → ${String(step.status ?? '')}（${String(step.durationMs ?? '-')}ms）`
  }
  if (step.type === 'message_in') {
    return String(step.text ?? '').slice(0, 160)
  }
  if (step.type === 'task_event') {
    return `${String(step.event ?? '')} ${JSON.stringify(step.detail ?? '').slice(0, 120)}`
  }
  return ''
}