import { useState } from 'react'
import { Button } from '@appica/ui-react/button'
import {
  Dialog,
  DialogTrigger,
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
import { Input } from '@appica/ui-react/input'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@appica/ui-react/select'
import { api, type ProjectCheck, type ProjectSchedule } from '../lib/api'

/** 新建/编辑定时任务：标题 + crontab 表达式 + 使用的检查脚本（本项目已登记检查）；任务详情页复用 */
export function ScheduleFormDialog({
  projectId,
  checks,
  schedule,
  onSaved,
}: {
  projectId: number
  /** 可选的检查脚本（本项目已登记检查） */
  checks: ProjectCheck[]
  /** 传入则为编辑，否则为新建 */
  schedule?: ProjectSchedule
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [cron, setCron] = useState('')
  const [checkId, setCheckId] = useState('')
  const [error, setError] = useState<string | null>(null)

  // 打开时初始化表单
  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      setTitle(schedule?.title ?? '')
      setCron(schedule?.cron ?? '')
      setCheckId(schedule ? String(schedule.checkId) : '')
      setError(null)
    }
  }

  const submit = () => {
    setError(null)
    const saving = schedule
      ? api.updateSchedule(schedule.id, { title, cron, checkId: Number(checkId) })
      : api.createSchedule({
          projectId,
          title,
          cron,
          checkId: Number(checkId),
        })
    saving
      .then(() => {
        setOpen(false)
        onSaved()
      })
      .catch((e: Error) => setError(e.message))
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        {schedule ? '编辑' : '添加定时任务'}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{schedule ? '编辑定时任务' : '添加定时任务'}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm">
              标题
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="如 每小时检查榜单数据"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              执行周期（crontab：分 时 日 月 周，可在最前加"秒"）
              <Input
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="如 */5 * * * *（每 5 分钟）或 */10 * * * * *（每 10 秒）"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              检查脚本（到点自动运行该检查）
              <Select
                value={checkId}
                onValueChange={(v) => setCheckId(v as string)}
                items={Object.fromEntries(
                  checks.map((c) => [String(c.id), `${c.code}（${c.scriptPath}）`]),
                )}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择检查" />
                </SelectTrigger>
                <SelectContent>
                  {checks.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.code}（{c.scriptPath}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {checks.length === 0 && (
              <p className="text-sm text-foreground-muted">
                项目还没有登记检查，请先在项目详情中添加
              </p>
            )}
            {error && <p className="text-sm">保存失败:{error}</p>}
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose>
            <Button variant="outline" size="sm">取消</Button>
          </DialogClose>
          <Button
            size="sm"
            onClick={submit}
            disabled={!title.trim() || !cron.trim() || !checkId}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 删除定时任务（保留已产生的运行记录） */
export function DeleteScheduleButton({
  schedule,
  onDeleted,
}: {
  schedule: ProjectSchedule
  onDeleted: () => void
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="outline" size="sm" />}>删除</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除定时任务</AlertDialogTitle>
          <AlertDialogDescription>
            确定删除定时任务「{schedule.title}」吗？删除后不再定时触发，已产生的检查运行记录保留。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose>
            <Button variant="outline" size="sm">取消</Button>
          </AlertDialogClose>
          <AlertDialogClose>
            <Button variant="destructive" onClick={onDeleted}>
              确认删除
            </Button>
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}