import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@appica/ui-react/table'
import { Button } from '@appica/ui-react/button'
import { Badge } from '@appica/ui-react/badge'
import { Card } from '@appica/ui-react/card'
import { api, type EvalRun } from '../lib/api'

/** 机器人评估 · 评估记录：全部评估批次（点击进入报告） */
export function EvaluationRunsPage() {
  const navigate = useNavigate()
  const [runs, setRuns] = useState<EvalRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    api
      .listEvalRuns()
      .then(setRuns)
      .catch((e: Error) => setError(e.message))
  }

  useEffect(load, [])

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">评估记录</h1>
          <p className="mt-1 text-sm text-foreground-muted">
            每次评估按「用例 × 重复次数」生成评估项，在独立沙箱中执行；点批次查看用例级报告。
          </p>
        </div>
        <Button variant="outline" onClick={load}>
          刷新
        </Button>
      </div>

      {error && (
        <p className="mb-4 text-sm text-foreground-danger">加载失败：{error}</p>
      )}

      <Card className="p-0">
        <Table hoverableRows>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">批次</TableHead>
              <TableHead>测试集</TableHead>
              <TableHead>被测机器人</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead className="w-24">通过率</TableHead>
              <TableHead className="w-24">平均得分</TableHead>
              <TableHead className="w-24">平均介入</TableHead>
              <TableHead className="w-32">开始时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(runs ?? []).map((run) => (
              <TableRow
                key={run.id}
                className="cursor-pointer"
                onClick={() => navigate(`/admin/evaluations/runs/${run.id}`)}
              >
                <TableCell>#{run.id}</TableCell>
                <TableCell>
                  {run.suiteSnapshot?.name ?? '-'}
                  <span className="ml-1 text-xs text-foreground-muted">
                    v{run.suiteVersion}
                  </span>
                </TableCell>
                <TableCell>{run.targetWorkerName}</TableCell>
                <TableCell>
                  <Badge
                    variant={
                      run.status === '已完成'
                        ? 'success'
                        : run.status === '执行中'
                          ? 'warning'
                          : 'secondary'
                    }
                    size="sm"
                  >
                    {run.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  {run.summary?.passRate != null
                    ? `${run.summary.passRate}%`
                    : '-'}
                </TableCell>
                <TableCell>{run.summary?.avgScore ?? '-'}</TableCell>
                <TableCell>{run.summary?.avgIntervention ?? '-'}</TableCell>
                <TableCell>
                  {run.startedAt
                    ? new Date(run.startedAt).toLocaleString('zh-CN')
                    : '-'}
                </TableCell>
              </TableRow>
            ))}
            {runs && runs.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-foreground-muted">
                  暂无评估批次：打开「测试集」选中用例后点击「发起评估」。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}