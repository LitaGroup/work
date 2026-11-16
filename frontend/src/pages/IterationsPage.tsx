import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '@appica/ui-react/badge'
import { buttonVariants } from '@appica/ui-react/button'
import { Card, CardHeader, CardTitle } from '@appica/ui-react/card'
import {
  api,
  BACKLOG_STATUSES,
  type BacklogStatus,
  type IterationSummary,
} from '../lib/api'
import { IterationStatusBadge } from '../components/StatusBadge'
import { useAuth } from '../context/AuthContext'

/**
 * 迭代：T0 快速通道 + T7 每周通道 + Tx 特殊通道，由 backlog 组成。
 * T0 常驻、需求确认即开发、开发完成即可上线；T7 按周进行，标识为「年 + W + 周数」；Tx 用于特殊情况。
 */
export function IterationsPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === '管理员'
  const [items, setItems] = useState<IterationSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .listIterations()
      .then((r) => {
        if (cancelled) return
        setItems(r)
        setError(null)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">迭代</h1>
          <p className="mt-1 text-sm">
            T0 快速通道 + T7 每周通道 + Tx 特殊通道；迭代由 backlog 组成，需求转入时指定负责人
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/api/iterations.md"
            target="_blank"
            rel="noreferrer"
            className="text-sm underline"
            title="Markdown 视图"
          >
            MD
          </a>
          {isAdmin && (
            <Link to="/iterations/new" className={buttonVariants()}>
              新建迭代
            </Link>
          )}
        </div>
      </div>

      {error && <p className="mb-4 text-sm">加载失败:{error}</p>}

      {!items && !error && (
        <p className="text-sm text-foreground-muted">加载中…</p>
      )}

      <div className="flex flex-col gap-3">
        {(items ?? []).map((iteration) => (
          <Card
            key={iteration.id}
            className={iteration.current ? 'ring-1 ring-foreground-intense' : undefined}
          >
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-3 text-base">
                {iteration.type === 'T0' ? (
                  <Link to={`/iterations/${iteration.id}`} className="underline">
                    <Badge variant="primary">T0 快速通道</Badge>
                  </Link>
                ) : (
                  <>
                    <Badge variant="soft">{iteration.type}</Badge>
                    <Link
                      to={`/iterations/${iteration.id}`}
                      className="font-mono underline"
                    >
                      {iteration.code}
                    </Link>
                    <span className="text-sm text-foreground-muted">
                      {iteration.startAt ?? '?'} ~ {iteration.endAt ?? '?'}
                    </span>
                  </>
                )}
                {iteration.current && <Badge variant="soft">当前迭代</Badge>}
                <IterationStatusBadge status={iteration.status} />
                <span className="ml-auto text-sm text-foreground-muted">
                  共 {iteration.total} 条
                </span>
              </CardTitle>
              <div className="mt-2 flex items-center gap-3">
                <div className="h-1.5 min-w-32 flex-1 overflow-hidden rounded-full bg-background">
                  <div
                    className="h-full rounded-full bg-foreground-intense"
                    style={{ width: `${iteration.percent}%` }}
                  />
                </div>
                <span className="w-16 text-right text-sm text-foreground-muted">
                  {iteration.percent}% 完成
                </span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground-muted">
                  {BACKLOG_STATUSES.filter(
                    (status: BacklogStatus) =>
                      (iteration.statusCounts[status] ?? 0) > 0,
                  ).map((status) => (
                    <span key={status}>
                      {status} {iteration.statusCounts[status]}
                    </span>
                  ))}
                  {iteration.total === 0 && <span>暂无迭代项</span>}
                </span>
              </div>
            </CardHeader>
          </Card>
        ))}
        {items && items.length === 0 && (
          <p className="text-sm text-foreground-muted">
            暂无迭代；管理员可新建迭代或向 T0 快速通道转入需求。
          </p>
        )}
      </div>
    </div>
  )
}