import { useCallback, useEffect, useState } from 'react'
import { Button } from '@appica/ui-react/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@appica/ui-react/table'
import {
  api,
  type WorkbenchOverviewPage,
  type WorkbenchRole,
  type WorkbenchTask,
} from '../lib/api'
import { TaskStatusBadge } from './StatusBadge'

/** 分页大小：与后端概览接口默认值一致 */
const PAGE_SIZE = 50

/** 工作台角色文案 */
const ROLE_LABELS: Record<WorkbenchRole, string> = {
  agent: '我执行',
  requester: '我是需求方',
  responsible: '我负责',
}

function roleOf(task: WorkbenchTask): string {
  if (task.workbenchRoles.length === 0) return '—'
  return task.workbenchRoles.map((role) => ROLE_LABELS[role]).join(' / ')
}

/** 工作台概览：与我相关的全部任务，按创建时间倒序分页 */
export function WorkbenchOverview({
  onOpenTask,
  refreshToken = 0,
}: {
  onOpenTask: (id: number) => void
  /** 父级统一刷新节奏：变化即重新拉取当前页，不再单独维护定时器 */
  refreshToken?: number
}) {
  const [data, setData] = useState<WorkbenchOverviewPage | null>(null)
  const [page, setPage] = useState(1)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    // refreshToken 由父级定时器递增，仅用于触发当前页重新拉取
    void refreshToken
    try {
      const result = await api.getWorkbenchTasks({ page, pageSize: PAGE_SIZE })
      // 当前页被清空时回退到有效页，避免停在不存在的分页
      const size = result.pageSize || PAGE_SIZE
      const lastPage = Math.max(1, Math.ceil(result.total / size))
      if (page > lastPage) {
        setPage(lastPage)
        return
      }
      setData(result)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [page, refreshToken])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void load()
  }, [load])

  const total = data?.total ?? 0
  const items = data?.items ?? []
  const pageCount = Math.max(1, Math.ceil(total / (data?.pageSize || PAGE_SIZE)))

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">概览</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          与我相关的全部任务，按创建时间倒序
        </p>
      </div>

      {error && (
        <p role="alert" className="text-xs text-error-foreground">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <Table hoverableRows>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">编号</TableHead>
              <TableHead>标题</TableHead>
              <TableHead className="w-28">状态</TableHead>
              <TableHead className="w-40">我的角色</TableHead>
              <TableHead className="w-28">待办动作</TableHead>
              <TableHead className="w-44">创建时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((task) => (
              <TableRow
                key={task.id}
                onClick={() => onOpenTask(task.id)}
                className="cursor-pointer"
              >
                <TableCell className="font-mono text-xs">{task.code}</TableCell>
                <TableCell className="max-w-md truncate" title={task.title}>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpenTask(task.id)
                    }}
                    className="max-w-full truncate text-left underline underline-offset-2 hover:text-foreground-intense"
                  >
                    {task.title}
                  </button>
                </TableCell>
                <TableCell>
                  <TaskStatusBadge
                    status={task.status}
                    subStatus={task.subStatus}
                  />
                </TableCell>
                <TableCell className="text-foreground-emphasis">
                  {roleOf(task)}
                </TableCell>
                <TableCell>{task.workbenchAction ?? '—'}</TableCell>
                <TableCell className="text-foreground-muted">
                  {new Date(task.createdAt).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
            {data !== null && items.length === 0 && (
              <TableRow>
                <TableCell colSpan={6}>暂无相关任务</TableCell>
              </TableRow>
            )}
            {data === null && !error && (
              <TableRow>
                <TableCell colSpan={6}>加载中…</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-foreground-muted">
            共 {total} 条，第 {page} / {pageCount} 页
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pageCount}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}