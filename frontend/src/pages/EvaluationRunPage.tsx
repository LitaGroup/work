import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button } from '@appica/ui-react/button'
import { Badge } from '@appica/ui-react/badge'
import { Card } from '@appica/ui-react/card'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@appica/ui-react/table'
import {
  api,
  type EvalEvent,
  type EvalJudgement,
  type EvalRun,
  type EvalRunItem,
} from '../lib/api'
import { visibleEventSource } from '../lib/event-source'
import { PopoverNotice, noticeDurationMs } from '../components/PopoverNotice'

/** 评估报告：汇总卡片 + 用例矩阵 + 评估项详情（事件/判定/执行记录入口），SSE 实时刷新 */
export function EvaluationRunPage() {
  const { runId } = useParams()
  const id = Number(runId)
  const [run, setRun] = useState<EvalRun | null>(null)
  const [items, setItems] = useState<EvalRunItem[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)
  const [events, setEvents] = useState<EvalEvent[]>([])
  const [judgements, setJudgements] = useState<EvalJudgement[]>([])
  const [feedback, setFeedback] = useState<{ success?: string; error?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const sourceRef = useRef<{ close(): void } | null>(null)

  const applySnapshot = useCallback((data: { run?: EvalRun; items?: EvalRunItem[] }) => {
    if (data.run) setRun(data.run)
    if (data.items) setItems(data.items)
  }, [])

  const loadDetail = useCallback(async (itemId: number) => {
    try {
      const [nextEvents, nextJudgements] = await Promise.all([
        api.getEvalItemEvents(itemId),
        api.getEvalItemJudgements(itemId),
      ])
      setEvents(nextEvents)
      setJudgements(nextJudgements)
    } catch {
      setEvents([])
      setJudgements([])
    }
  }, [])

  useEffect(() => {
    if (!Number.isFinite(id) || id <= 0) return
    const source = visibleEventSource(`/api/eval/runs/${id}/stream`)
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          run?: EvalRun
          items?: EvalRunItem[]
          error?: string
        }
        if (data.error) return
        applySnapshot(data)
      } catch {
        /* 忽略心跳等非 JSON 数据 */
      }
    }
    sourceRef.current = source
    // 兜底拉一次快照（晚订阅/重连）
    void Promise.all([api.getEvalRun(id), api.listEvalRunItems(id)])
      .then(([runRow, itemRows]) => applySnapshot({ run: runRow, items: itemRows }))
      .catch(() => undefined)
    return () => {
      source.close()
      sourceRef.current = null
    }
  }, [id, applySnapshot])

  useEffect(() => {
    if (expanded) void loadDetail(expanded)
    else {
      setEvents([])
      setJudgements([])
    }
  }, [expanded, loadDetail])

  const caseTitleOf = useMemo(() => {
    const map = new Map<number, string>()
    for (const c of run?.suiteSnapshot?.cases ?? []) map.set(c.id, c.title)
    return map
  }, [run])

  const promptOf = (caseId: number) =>
    run?.suiteSnapshot?.cases.find((c) => c.id === caseId)?.prompt ?? ''

  const pointsOf = (caseId: number) =>
    run?.suiteSnapshot?.cases.find((c) => c.id === caseId)?.points ?? []

  const cancel = async () => {
    if (!window.confirm('确认取消该评估批次？执行中的评估项会被中断并销毁沙箱。')) return
    setLoading(true)
    try {
      const next = await api.cancelEvalRun(id)
      setRun(next)
      setFeedback({ success: '批次已取消' })
      setTimeout(() => setFeedback(null), noticeDurationMs(null))
    } catch (e) {
      setFeedback({ error: (e as Error).message })
      setTimeout(() => setFeedback(null), noticeDurationMs('x'))
    } finally {
      setLoading(false)
    }
  }

  const rerun = async (itemId: number) => {
    try {
      await api.rerunEvalItem(itemId)
      setFeedback({ success: '已重跑，等待调度' })
      setTimeout(() => setFeedback(null), noticeDurationMs(null))
    } catch (e) {
      setFeedback({ error: (e as Error).message })
      setTimeout(() => setFeedback(null), noticeDurationMs('x'))
    }
  }

  const rejudge = async (itemId: number) => {
    try {
      await api.rejudgeEvalItem(itemId)
      setFeedback({ success: '已发起重新判定' })
      setTimeout(() => setFeedback(null), noticeDurationMs(null))
    } catch (e) {
      setFeedback({ error: (e as Error).message })
      setTimeout(() => setFeedback(null), noticeDurationMs('x'))
    }
  }

  if (!run) {
    return (
      <div className="py-10 text-center text-sm text-foreground-muted">加载中…</div>
    )
  }

  const summary = run.summary
  const active = items.filter((item) =>
    [
      '排队',
      '准备中',
      '已邀约',
      '执行中',
      '等待答复',
      '判定中',
      '返工中',
    ].includes(item.status),
  )

  return (
    <div>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            评估报告 #{run.id}｜{run.suiteSnapshot?.name}
          </h1>
          <p className="mt-1 text-sm text-foreground-muted">
            被测机器人：{run.targetWorkerName}｜测试集 v{run.suiteVersion}（
            {run.suiteSnapshot?.purpose}）｜重复 {run.repeatCount} 次｜并发{' '}
            {run.concurrency}｜{run.status}
            {run.finishedAt
              ? `｜完成于 ${new Date(run.finishedAt).toLocaleString('zh-CN')}`
              : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to={`/admin/evaluations/${run.suiteId}`}>
            <Button variant="outline">测试集</Button>
          </Link>
          {run.status !== '已完成' && run.status !== '已取消' && (
            <PopoverNotice
              open={!!feedback}
              onOpenChange={(open) => {
                if (!open) setFeedback(null)
              }}
              success={feedback?.success}
              error={feedback?.error}
            >
              <Button variant="outline" onClick={cancel} disabled={loading}>
                取消批次
              </Button>
            </PopoverNotice>
          )}
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard
          label="最终通过率"
          value={summary?.passRate != null ? `${summary.passRate}%` : '-'}
          hint={`一次通过 ${summary?.firstPass ?? 0}｜返工后 ${summary?.passAfterRework ?? 0}｜未通过 ${summary?.failed ?? 0}｜提问超限 ${summary?.questionLimit ?? 0}`}
        />
        <SummaryCard
          label="平均得分"
          value={summary?.avgScore != null ? String(summary.avgScore) : '-'}
          hint={`有效项 ${summary?.done ?? 0} / ${summary?.total ?? items.length}`}
        />
        <SummaryCard
          label="平均介入次数"
          value={summary?.avgIntervention != null ? String(summary.avgIntervention) : '-'}
          hint={`超时 ${summary?.timeout ?? 0}｜异常 ${summary?.error ?? 0}｜拒绝 ${summary?.refused ?? 0}`}
        />
        <SummaryCard
          label="平均等待答复"
          value={
            summary?.avgWaitAnswerMs != null
              ? `${Math.round(summary.avgWaitAnswerMs / 1000)}s`
              : '-'
          }
          hint={`进行中 ${active.length} 项`}
        />
      </div>

      <Card className="p-0">
        <div className="px-4 pt-4">
          <h2 className="text-base font-semibold">用例结果</h2>
          <p className="mt-0.5 text-xs text-foreground-muted">
            每行一个「用例 × 重复」；点击展开事件时间线与判定明细。
          </p>
        </div>
        <Table hoverableRows>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">评估项</TableHead>
              <TableHead>用例</TableHead>
              <TableHead className="w-14">重复</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead className="w-24">结果</TableHead>
              <TableHead className="w-16">得分</TableHead>
              <TableHead className="w-16">介入</TableHead>
              <TableHead className="w-20">净耗时</TableHead>
              <TableHead className="w-20">任务</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <>
                <TableRow
                  key={item.id}
                  className="cursor-pointer"
                  onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                >
                  <TableCell>
                    #{item.id}
                    {item.superseded && (
                      <span className="ml-1 text-xs text-foreground-muted">
                        (已替代)
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-96 truncate">
                    {caseTitleOf.get(item.caseId) ?? `用例 #${item.caseId}`}
                  </TableCell>
                  <TableCell>{item.repeatIndex}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        item.status === '已完成'
                          ? 'success'
                          : item.status === '执行中' || item.status === '判定中'
                            ? 'warning'
                            : item.status === '异常' || item.status === '超时'
                              ? 'error'
                              : 'secondary'
                      }
                      size="sm"
                    >
                      {item.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{item.result ?? '-'}</TableCell>
                  <TableCell>{item.finalScore ?? item.firstScore ?? '-'}</TableCell>
                  <TableCell>{item.interventionCount}</TableCell>
                  <TableCell>
                    {item.netExecMs
                      ? formatMs(Number(item.netExecMs))
                      : '-'}
                  </TableCell>
                  <TableCell>
                    {item.taskId ? (
                      <Link
                        to={`/tasks/${item.taskId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="hover:underline"
                      >
                        #{item.taskId}
                      </Link>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                </TableRow>
                {expanded === item.id && (
                  <TableRow key={`${item.id}-detail`}>
                    <TableCell colSpan={9} className="bg-background-muted/40">
                      <div className="grid gap-4 py-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            {(item.status === '异常' || item.status === '超时') && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => rerun(item.id)}
                              >
                                重跑
                              </Button>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => rejudge(item.id)}
                            >
                              重新判定
                            </Button>
                          </div>
                          <span className="text-xs text-foreground-muted">
                            提问 {item.questionCount}｜返工 {item.reworkCount}｜
                            被拦截写操作 {item.blockedWriteCount}
                            {item.errorMessage ? `｜异常：${item.errorMessage}` : ''}
                          </span>
                        </div>

                        <div>
                          <p className="mb-1 text-sm font-medium">输入（Prompt）</p>
                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-background p-2 text-xs">
                            {promptOf(item.caseId)}
                          </pre>
                        </div>

                        <div>
                          <p className="mb-1 text-sm font-medium">期望要点</p>
                          <ul className="list-inside list-disc text-xs">
                            {pointsOf(item.caseId).map((p) => (
                              <li key={p.id}>
                                [{p.required ? '必需' : '可选'}] {p.point}（权重{' '}
                                {p.weight}）
                              </li>
                            ))}
                          </ul>
                        </div>

                        <div>
                          <p className="mb-1 text-sm font-medium">判定结果</p>
                          {judgements.length === 0 ? (
                            <p className="text-xs text-foreground-muted">尚未判定</p>
                          ) : (
                            judgements.map((j) => (
                              <div
                                key={j.id}
                                className="mb-2 rounded-md border border-border p-2 text-xs"
                              >
                                <p className="mb-1">
                                  <Badge variant="secondary" size="sm">
                                    第 {j.round} 轮
                                  </Badge>{' '}
                                  <Badge
                                    variant={j.pass ? 'success' : 'error'}
                                    size="sm"
                                  >
                                    {j.pass ? '通过' : '未通过'}
                                  </Badge>{' '}
                                  得分 {j.score ?? '-'}
                                  {j.effective ? '（生效）' : '（历史）'}
                                </p>
                                {(j.pointsResult ?? []).map((point) => (
                                  <p
                                    key={point.idx}
                                    className={
                                      point.hit >= 1
                                        ? 'text-foreground-success'
                                        : point.hit > 0
                                          ? 'text-foreground-warning'
                                          : 'text-foreground-muted'
                                    }
                                  >
                                    {point.idx}. hit={point.hit}
                                    {point.evidenceInvalid
                                      ? '（证据校验失败，已改为未命中）'
                                      : ''}
                                    {point.note ? `｜${point.note}` : ''}
                                    {point.evidence
                                      ? `｜证据：${point.evidence.slice(0, 120)}`
                                      : ''}
                                  </p>
                                ))}
                                {j.reason && (
                                  <p className="mt-1 text-foreground-muted">
                                    说明：{j.reason}
                                  </p>
                                )}
                              </div>
                            ))
                          )}
                        </div>

                        <div>
                          <p className="mb-1 text-sm font-medium">事件时间线</p>
                          <ul className="space-y-0.5 text-xs">
                            {events.map((event) => (
                              <li key={event.id}>
                                {new Date(event.at).toLocaleTimeString('zh-CN')}{' '}
                                {eventLabel(event.type)}
                                {event.payload
                                  ? `｜${JSON.stringify(event.payload).slice(0, 160)}`
                                  : ''}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </>
            ))}
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-foreground-muted">
                  暂无评估项
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}

function SummaryCard(props: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <Card className="p-4">
      <p className="text-xs text-foreground-muted">{props.label}</p>
      <p className="mt-1 text-2xl font-semibold">{props.value}</p>
      {props.hint && (
        <p className="mt-1 text-xs text-foreground-muted">{props.hint}</p>
      )}
    </Card>
  )
}

function formatMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3600_000).toFixed(1)}h`
}

/** 事件类型中文标签 */
function eventLabel(type: string): string {
  const map: Record<string, string> = {
    sandbox_ready: '沙箱就绪',
    task_created: '创建评估任务',
    accepted: '接受任务',
    refused: '拒绝任务',
    question_asked: '提问',
    question_answered: '规则答复',
    question_skipped: '跳过提问',
    question_limit: '提问超限',
    handoff_applied: '申请验收',
    judge_started: '判定开始',
    judge_done: '判定完成',
    judge_failed: '判定失败',
    rework_sent: '发出返工',
    human_action: '人工介入',
    write_blocked: '写操作被拦截',
    subtask_blocked: '子任务被拦截',
    timeout: '超时',
    error: '异常',
    canceled: '取消',
    sandbox_destroyed: '沙箱销毁',
  }
  return map[type] ?? type
}