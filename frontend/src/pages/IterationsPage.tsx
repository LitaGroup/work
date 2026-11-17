import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '@appica/ui-react/badge'
import { Button, buttonVariants } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@appica/ui-react/collapsible'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@appica/ui-react/table'
import { ChevronDown, ChevronRight } from '@appica/icons-react'
import {
  api,
  BACKLOG_STATUSES,
  ITERATION_TYPES,
  type Backlog,
  type BacklogStatus,
  type IterationSummary,
  type IterationType,
} from '../lib/api'
import { BacklogStatusBadge, IterationStatusBadge } from '../components/StatusBadge'
import { IterationDescription } from '../components/IterationDescription'
import { useAuth } from '../context/AuthContext'

const GROUP_LABELS: Record<IterationType, string> = {
  T0: 'T0 快速通道',
  T7: 'T7 每周通道',
  Tx: 'Tx 特殊通道',
}

/** 预期上线时间展示到小时 */
function formatHour(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`
}

/**
 * 迭代：T0 快速通道 + T7 每周通道 + Tx 特殊通道，由 backlog 组成。
 * T0 常驻、需求确认即开发、开发完成即可上线；T7 按周进行，标识为「年 + W + 周数」；Tx 用于特殊情况。
 * 整体收在一张卡片内，按类型分组折叠，含当前迭代的分组默认展开，其余默认收起。
 * 每个迭代行可再展开，内联展示该迭代的迭代项（只读），无需进入迭代详情页；
 * 迭代项首次展开时懒加载，之后每次展开先展示缓存并在后台刷新。
 */
export function IterationsPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === '管理员'
  const [items, setItems] = useState<IterationSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [backlogsById, setBacklogsById] = useState<Map<number, Backlog[]>>(
    new Map(),
  )
  const [loadingIds, setLoadingIds] = useState<Set<number>>(new Set())
  const [backlogErrors, setBacklogErrors] = useState<Map<number, string>>(
    new Map(),
  )

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

  const loadBacklogs = useCallback((iterationId: number) => {
    setLoadingIds((prev) => new Set(prev).add(iterationId))
    setBacklogErrors((prev) => {
      const next = new Map(prev)
      next.delete(iterationId)
      return next
    })
    api
      .getIteration(iterationId)
      .then((detail) => {
        setBacklogsById((prev) => new Map(prev).set(iterationId, detail.backlogs))
        // 展开区以迭代项列表为准，顺带刷新标题行的进度汇总
        setItems((prev) =>
          prev
            ? prev.map((item) =>
                item.id === detail.id
                  ? {
                      ...item,
                      total: detail.total,
                      done: detail.done,
                      percent: detail.percent,
                      statusCounts: detail.statusCounts,
                    }
                  : item,
              )
            : prev,
        )
      })
      .catch((e: Error) => {
        setBacklogErrors((prev) =>
          new Map(prev).set(iterationId, e.message || '加载失败'),
        )
      })
      .finally(() => {
        setLoadingIds((prev) => {
          const next = new Set(prev)
          next.delete(iterationId)
          return next
        })
      })
  }, [])

  const groups = useMemo(
    () =>
      ITERATION_TYPES.map((type) => ({
        type,
        items: (items ?? []).filter((item) => item.type === type),
      })),
    [items],
  )

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

      {items && (
        <Card contentProps={{ className: 'p-0' }}>
          <div className="divide-y divide-border">
            {groups.map((group) => (
              <Collapsible
                key={group.type}
                defaultOpen={group.items.some((item) => item.current)}
              >
                <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-2 text-left">
                  <ChevronRight className="size-4 group-data-[panel-open]:hidden" />
                  <ChevronDown className="hidden size-4 group-data-[panel-open]:block" />
                  <span className="font-medium">{GROUP_LABELS[group.type]}</span>
                  <span className="text-sm text-foreground-muted">
                    共 {group.items.length} 个
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {group.items.length > 0 ? (
                    <div className="divide-y divide-border">
                      {group.items.map((iteration) => (
                        <IterationRow
                          key={iteration.id}
                          iteration={iteration}
                          backlogs={backlogsById.get(iteration.id) ?? null}
                          loading={loadingIds.has(iteration.id)}
                          backlogError={backlogErrors.get(iteration.id) ?? null}
                          onLoad={() => loadBacklogs(iteration.id)}
                          canEdit={isAdmin}
                          onDescriptionChange={(description) =>
                            setItems((prev) =>
                              prev
                                ? prev.map((item) =>
                                    item.id === iteration.id
                                      ? { ...item, description }
                                      : item,
                                  )
                                : prev,
                            )
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="px-4 py-3 text-sm text-foreground-muted">
                      暂无迭代
                    </p>
                  )}
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        </Card>
      )}

      {items && items.length === 0 && (
        <p className="mt-4 text-sm text-foreground-muted">
          暂无迭代；管理员可新建迭代或向 T0 快速通道转入需求。
        </p>
      )}
    </div>
  )
}

interface IterationRowProps {
  iteration: IterationSummary
  /** 已加载的迭代项；null 表示尚未加载 */
  backlogs: Backlog[] | null
  loading: boolean
  backlogError: string | null
  onLoad: () => void
  /** 是否可编辑描述（管理员） */
  canEdit: boolean
  onDescriptionChange: (description: string | null) => void
}

function IterationRow({
  iteration,
  backlogs,
  loading,
  backlogError,
  onLoad,
  canEdit,
  onDescriptionChange,
}: IterationRowProps) {
  const [open, setOpen] = useState(false)

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) onLoad()
  }

  return (
    <Collapsible open={open}>
      <div
        className="flex cursor-pointer items-start gap-2 px-4 py-3"
        onClick={toggle}
      >
        <button
          type="button"
          className="mt-1 shrink-0 text-foreground-muted"
          aria-expanded={open}
          aria-label={open ? '收起迭代项' : '展开迭代项'}
          onClick={(event) => {
            event.stopPropagation()
            toggle()
          }}
        >
          {open ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            {iteration.type === 'T0' ? (
              <Badge variant="primary">T0 快速通道</Badge>
            ) : (
              <>
                <Badge variant="soft">{iteration.type}</Badge>
                <span className="font-mono">{iteration.code}</span>
              </>
            )}
            <IterationDescription
              iterationId={iteration.id}
              value={iteration.description}
              canEdit={canEdit}
              onSaved={onDescriptionChange}
            />
            {iteration.type !== 'T0' && (
              <span className="text-sm text-foreground-muted">
                {iteration.startAt ?? '?'} ~ {iteration.endAt ?? '?'}
              </span>
            )}
            {iteration.current && <Badge variant="soft">当前迭代</Badge>}
            <IterationStatusBadge status={iteration.status} />
            <span className="ml-auto text-sm text-foreground-muted">
              共 {iteration.total} 条
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <div className="h-1.5 min-w-32 flex-1 overflow-hidden rounded-full bg-background-muted">
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
        </div>
        <Link
          to={`/iterations/${iteration.id}`}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          onClick={(event) => event.stopPropagation()}
        >
          详情
        </Link>
      </div>
      <CollapsibleContent>
        <div className="px-4 pb-3 pl-10">
          {loading && (
            <p className="text-sm text-foreground-muted">
              {backlogs ? '刷新中…' : '加载中…'}
            </p>
          )}
          {!loading && backlogError && (
            <div className="flex items-center gap-3 text-sm">
              <span>加载失败:{backlogError}</span>
              <Button variant="outline" size="sm" onClick={onLoad}>
                重试
              </Button>
            </div>
          )}
          {!backlogError && backlogs && backlogs.length === 0 && (
            <p className="text-sm text-foreground-muted">
              暂无迭代项，可在迭代详情页「添加需求」转入
            </p>
          )}
          {!backlogError && backlogs && backlogs.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">编号</TableHead>
                  <TableHead>标题</TableHead>
                  <TableHead className="text-center">成员</TableHead>
                  <TableHead className="w-36 text-center">预期上线</TableHead>
                  <TableHead className="text-center">状态</TableHead>
                  <TableHead className="text-center">交付任务</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {backlogs.map((backlog) => {
                  const owner = backlog.ownerName
                  const members = (backlog.members ?? []).filter(
                    (member) => member.name !== owner,
                  )
                  return (
                    <TableRow key={backlog.id}>
                      <TableCell className="font-mono text-sm">
                        {backlog.code}
                      </TableCell>
                      <TableCell
                        className="max-w-md truncate"
                        title={backlog.title}
                      >
                        <Link to={`/backlogs/${backlog.id}`} className="underline">
                          {backlog.title}
                        </Link>
                        <span
                          className="ml-2 text-xs text-foreground-muted"
                          title="原始需求"
                        >
                          需求 #{backlog.projectId}
                        </span>
                      </TableCell>
                      <TableCell className="text-center">
                        {owner || members.length > 0 ? (
                          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
                            {owner && (
                              <span className="font-semibold" title="负责人">
                                {owner}
                              </span>
                            )}
                            {members.map((member) => (
                              <span
                                key={`${member.role}:${member.workerId}`}
                                title={member.role}
                              >
                                {member.name}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-foreground-muted">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {formatHour(backlog.expectedOnlineAt)}
                      </TableCell>
                      <TableCell className="text-center">
                        <BacklogStatusBadge status={backlog.status} />
                      </TableCell>
                      <TableCell className="text-center">
                        {backlog.taskId ? (
                          <Link
                            to={`/tasks/${backlog.taskId}`}
                            className="underline"
                          >
                            #{backlog.taskId}
                          </Link>
                        ) : (
                          <span className="text-foreground-muted">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}