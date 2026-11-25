import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
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
import { Input } from '@appica/ui-react/input'
import { Textarea } from '@appica/ui-react/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  DialogClose,
} from '@appica/ui-react/dialog'
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from '@appica/ui-react/alert-dialog'
import {
  api,
  EVAL_SUITE_PURPOSES,
  type EvalSuitePurpose,
  type EvalSuiteSummary,
} from '../lib/api'
import { PopoverNotice, noticeDurationMs } from '../components/PopoverNotice'
import { EvalSuiteTags } from '../components/EvalSuiteTags'

/** 机器人评估 · 测试集列表（评估批次见「评估记录」） */
export function EvaluationsPage() {
  const navigate = useNavigate()
  const [suites, setSuites] = useState<EvalSuiteSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{
    success?: string
    error?: string
  } | null>(null)
  const [form, setForm] = useState({
    name: '',
    description: '',
    purpose: '验证' as EvalSuitePurpose,
    passThreshold: 80,
    defaultTimeoutSec: 1800,
    maxQuestions: 3,
  })
  const [renameTarget, setRenameTarget] = useState<EvalSuiteSummary | null>(
    null,
  )
  const [renameName, setRenameName] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameFeedback, setRenameFeedback] = useState<{
    success?: string
    error?: string
  } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<EvalSuiteSummary | null>(
    null,
  )
  const [deleting, setDeleting] = useState(false)
  const [deleteFeedback, setDeleteFeedback] = useState<{
    success?: string
    error?: string
  } | null>(null)
  const renameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = (ref: {
    current: ReturnType<typeof setTimeout> | null
  }) => {
    if (ref.current !== null) {
      clearTimeout(ref.current)
      ref.current = null
    }
  }

  useEffect(() => {
    return () => {
      clearTimer(renameTimerRef)
      clearTimer(deleteTimerRef)
    }
  }, [])

  const load = useCallback(() => {
    api
      .listEvalSuites()
      .then(setSuites)
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(load, [load])

  const create = async () => {
    if (!form.name.trim()) return
    setSaving(true)
    try {
      const suite = await api.createEvalSuite({
        name: form.name.trim(),
        description: form.description.trim() || null,
        purpose: form.purpose,
        passThreshold: form.passThreshold,
        defaultTimeoutSec: form.defaultTimeoutSec,
        maxQuestions: form.maxQuestions,
      })
      setFeedback({ success: '测试集已创建' })
      setTimeout(() => {
        setFeedback(null)
        setDialogOpen(false)
        setForm({ ...form, name: '', description: '' })
        load()
        navigate(`/admin/evaluations/${suite.id}`)
      }, noticeDurationMs(null))
    } catch (e) {
      setFeedback({ error: (e as Error).message })
      setTimeout(() => setFeedback(null), noticeDurationMs('x'))
    } finally {
      setSaving(false)
    }
  }

  const showRenameFeedback = (
    next: { success?: string; error?: string },
    after?: () => void,
  ) => {
    clearTimer(renameTimerRef)
    setRenameFeedback(next)
    renameTimerRef.current = setTimeout(() => {
      renameTimerRef.current = null
      setRenameFeedback(null)
      after?.()
    }, noticeDurationMs(next.error))
  }

  const showDeleteFeedback = (
    next: { success?: string; error?: string },
    after?: () => void,
  ) => {
    clearTimer(deleteTimerRef)
    setDeleteFeedback(next)
    deleteTimerRef.current = setTimeout(() => {
      deleteTimerRef.current = null
      setDeleteFeedback(null)
      after?.()
    }, noticeDurationMs(next.error))
  }

  const openRename = (suite: EvalSuiteSummary) => {
    clearTimer(renameTimerRef)
    setRenameTarget(suite)
    setRenameName(suite.name)
    setRenameFeedback(null)
  }

  const closeRename = () => {
    clearTimer(renameTimerRef)
    setRenameTarget(null)
    setRenameFeedback(null)
  }

  const saveRename = async () => {
    if (!renameTarget || renaming) return
    const name = renameName.trim()
    if (!name) {
      showRenameFeedback({ error: '测试集名称不能为空' })
      return
    }
    setRenaming(true)
    try {
      const updated = await api.updateEvalSuite(renameTarget.id, { name })
      setSuites((prev) =>
        prev
          ? prev.map((row) =>
              row.id === updated.id ? { ...row, ...updated } : row,
            )
          : prev,
      )
      showRenameFeedback({ success: '名称已更新' }, () => setRenameTarget(null))
    } catch (e) {
      showRenameFeedback({ error: (e as Error).message })
    } finally {
      setRenaming(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return
    const suiteId = deleteTarget.id
    setDeleting(true)
    try {
      await api.deleteEvalSuite(suiteId)
      showDeleteFeedback({ success: '测试集已删除' }, () => {
        setSuites((prev) =>
          prev ? prev.filter((row) => row.id !== suiteId) : prev,
        )
        setDeleteTarget(null)
      })
    } catch (e) {
      showDeleteFeedback({ error: (e as Error).message })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">机器人评估</h1>
        <div className="flex items-center gap-2">
          <Button onClick={() => setDialogOpen(true)}>新建测试集</Button>
        </div>
      </div>

      {error && (
        <p className="mb-4 text-sm text-foreground-danger">加载失败：{error}</p>
      )}

      <Card className="mb-6 p-0">
        <div className="flex items-center justify-between px-4 pt-4">
          <div>
            <h2 className="text-base font-semibold">测试集</h2>
            <p className="mt-0.5 text-xs text-foreground-muted">
              每个用例包含输入（Prompt）、补充信息和要点清单；评估按处理时间、介入次数与判定得分统计。
            </p>
          </div>
        </div>
        <Table hoverableRows>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead className="w-64">标签</TableHead>
              <TableHead className="w-24">用途</TableHead>
              <TableHead className="w-24">用例数</TableHead>
              <TableHead className="w-20">版本</TableHead>
              <TableHead className="w-20">状态</TableHead>
              <TableHead className="w-56 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(suites ?? []).map((suite) => (
              <TableRow key={suite.id}>
                <TableCell>
                  <Link
                    to={`/admin/evaluations/${suite.id}`}
                    className="font-medium hover:underline"
                  >
                    「{suite.id}」{suite.name}
                  </Link>
                  {suite.description && (
                    <p className="mt-0.5 max-w-2xl truncate text-xs text-foreground-muted">
                      {suite.description}
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  <EvalSuiteTags
                    suite={suite}
                    onUpdated={(updated) =>
                      setSuites((prev) =>
                        prev
                          ? prev.map((row) =>
                              row.id === updated.id
                                ? { ...row, ...updated }
                                : row,
                            )
                          : prev,
                      )
                    }
                  />
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" size="sm">
                    {suite.purpose}
                  </Badge>
                </TableCell>
                <TableCell>
                  {suite.enabledCaseCount} / {suite.caseCount}
                  {suite.purpose === '验证' &&
                    suite.enabledCaseCount > 0 &&
                    suite.enabledCaseCount < 10 && (
                      <span
                        className="ml-1 text-xs text-foreground-warning"
                        title="验证集用例较少，结果可能波动较大"
                      >
                        ⚠
                      </span>
                    )}
                </TableCell>
                <TableCell>v{suite.version}</TableCell>
                <TableCell>{suite.status}</TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openRename(suite)}
                    >
                      编辑名称
                    </Button>
                    <Link to={`/admin/evaluations/${suite.id}`}>
                      <Button variant="outline" size="sm">
                        查看
                      </Button>
                    </Link>
                    <AlertDialog
                      open={deleteTarget?.id === suite.id}
                      onOpenChange={(open) => {
                        if (open) {
                          setDeleteTarget(suite)
                          setDeleteFeedback(null)
                          return
                        }
                        const deleted = !!deleteFeedback?.success
                        clearTimer(deleteTimerRef)
                        setDeleteTarget(null)
                        setDeleteFeedback(null)
                        if (deleted) load()
                      }}
                    >
                      <AlertDialogTrigger
                        render={
                          <Button variant="outline" size="sm">
                            删除
                          </Button>
                        }
                      />
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            删除测试集「{suite.id}」{suite.name}？
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            将同时删除该测试集的全部用例和要点，且不可恢复。已有评估批次的测试集不能删除，可改为归档。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogClose
                            render={<Button variant="outline" size="sm" />}
                          >
                            取消
                          </AlertDialogClose>
                          <PopoverNotice
                            open={!!deleteFeedback}
                            onOpenChange={(open) => {
                              if (!open) {
                                clearTimer(deleteTimerRef)
                                setDeleteFeedback(null)
                              }
                            }}
                            success={deleteFeedback?.success}
                            error={deleteFeedback?.error}
                          >
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={deleting || !!deleteFeedback?.success}
                              onClick={() => void confirmDelete()}
                            >
                              {deleting ? '删除中…' : '确认删除'}
                            </Button>
                          </PopoverNotice>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {suites && suites.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-foreground-muted">
                  还没有测试集。点击右上角「新建测试集」，添加 Prompt 与期望要点。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建测试集</DialogTitle>
          </DialogHeader>
          <DialogBody className="grid gap-3">
            <label className="grid gap-1 text-sm">
              名称
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：查数能力"
              />
            </label>
            <label className="grid gap-1 text-sm">
              说明
              <Textarea
                rows={3}
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-sm">
                用途
                <select
                  className="h-9 rounded-md border border-border bg-background px-2"
                  value={form.purpose}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      purpose: e.target.value as EvalSuitePurpose,
                    })
                  }
                >
                  {EVAL_SUITE_PURPOSES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                通过阈值（0-100）
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={form.passThreshold}
                  onChange={(e) =>
                    setForm({ ...form, passThreshold: Number(e.target.value) })
                  }
                />
              </label>
              <label className="grid gap-1 text-sm">
                默认用例超时（秒）
                <Input
                  type="number"
                  min={60}
                  value={form.defaultTimeoutSec}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      defaultTimeoutSec: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label className="grid gap-1 text-sm">
                每个评估项最多答复提问（次）
                <Input
                  type="number"
                  min={1}
                  value={form.maxQuestions}
                  onChange={(e) =>
                    setForm({ ...form, maxQuestions: Number(e.target.value) })
                  }
                />
              </label>
            </div>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              取消
            </DialogClose>
            <PopoverNotice
              open={!!feedback}
              onOpenChange={(open) => {
                if (!open) setFeedback(null)
              }}
              success={feedback?.success}
              error={feedback?.error}
            >
              <Button onClick={create} disabled={saving || !form.name.trim()}>
                {saving ? '创建中…' : '创建'}
              </Button>
            </PopoverNotice>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!renameTarget}
        onOpenChange={(open) => {
          if (!open) closeRename()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑测试集名称</DialogTitle>
          </DialogHeader>
          <DialogBody className="grid gap-3">
            <label className="grid gap-1 text-sm">
              名称
              <Input
                autoFocus
                maxLength={128}
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                placeholder="例如：查数能力"
              />
            </label>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              取消
            </DialogClose>
            <PopoverNotice
              open={!!renameFeedback}
              onOpenChange={(open) => {
                if (!open) {
                  clearTimer(renameTimerRef)
                  setRenameFeedback(null)
                }
              }}
              success={renameFeedback?.success}
              error={renameFeedback?.error}
            >
              <Button
                onClick={() => void saveRename()}
                disabled={renaming || !renameName.trim()}
              >
                {renaming ? '保存中…' : '保存'}
              </Button>
            </PopoverNotice>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}