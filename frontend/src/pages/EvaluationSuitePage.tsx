import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button } from '@appica/ui-react/button'
import { Card } from '@appica/ui-react/card'
import { Input } from '@appica/ui-react/input'
import { Textarea } from '@appica/ui-react/textarea'
import { Switch } from '@appica/ui-react/switch'
import {
  Combobox,
  ComboboxTrigger,
  ComboboxValue,
  ComboboxInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxList,
  ComboboxItem,
  createComboboxItems,
} from '@appica/ui-react/combobox'
import { ScrollArea } from '@appica/ui-react/scroll-area'
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
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@appica/ui-react/table'
import {
  api,
  type EvalCaseInput,
  type EvalCaseWithPoints,
  type EvalSuiteDetail,
  type Worker,
} from '../lib/api'
import { PopoverNotice, noticeDurationMs } from '../components/PopoverNotice'
import { EvalSuiteTags } from '../components/EvalSuiteTags'
import { matchesPinyinSearch } from '../lib/pinyin-search'

/** 空用例模板 */
function emptyCase(seq: number): EvalCaseWithPoints {
  return {
    id: 0,
    suiteId: 0,
    caseKey: `case-${Date.now().toString(36)}`,
    seq,
    title: '',
    prompt: '',
    clarify: null,
    passThreshold: null,
    timeoutSec: null,
    enabled: true,
    points: [
      { id: 0, caseId: 0, seq: 1, point: '', required: true, weight: '1', hint: null },
    ],
  }
}

/**
 * 测试集详情：左侧用例列表，右侧用例编辑区（标题 / Prompt / 补充信息 / 要点表格）。
 * 支持导入导出与发起评估（选被测机器人 + 评估机器人 + 重复次数/并发）。
 */
export function EvaluationSuitePage() {
  const { suiteId } = useParams()
  const id = Number(suiteId)
  const navigate = useNavigate()
  const [detail, setDetail] = useState<EvalSuiteDetail | null>(null)
  const [selectedCaseId, setSelectedCaseId] = useState<number | null>(null)
  const [draft, setDraft] = useState<EvalCaseWithPoints | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ success?: string; error?: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [runOpen, setRunOpen] = useState(false)
  const [workers, setWorkers] = useState<Worker[]>([])
  const [runForm, setRunForm] = useState({
    targetWorkerId: 0,
    evaluatorWorkerId: 0,
    repeatCount: 1,
    concurrency: 1,
  })

  const load = useCallback(() => {
    api
      .getEvalSuite(id)
      .then((data) => {
        setDetail(data)
        setSelectedCaseId((prev) => {
          if (prev && data.cases.some((c) => c.id === prev)) {
            const found = data.cases.find((c) => c.id === prev)!
            setDraft(cloneCase(found))
            return prev
          }
          const first = data.cases[0]
          if (first) {
            setDraft(cloneCase(first))
            return first.id
          }
          setDraft(null)
          return null
        })
      })
      .catch((e: Error) => setError(e.message))
  }, [id])

  useEffect(load, [load])

  useEffect(() => {
    api
      .listWorkers()
      .then((rows) =>
        setWorkers(rows.filter((w) => w.runtime !== 'human' && w.enabled)),
      )
      .catch(() => undefined)
  }, [])

  // 机器人数量多：可搜索 Combobox（名称 / ID，原文 + 拼音），列表限高滚动
  const workerItems = useMemo(
    () =>
      createComboboxItems(workers, {
        getValue: (worker) => String(worker.id),
        getLabel: (worker) => `${worker.name}（#${worker.id}）`,
      }),
    [workers],
  )

  const selectCase = (row: EvalCaseWithPoints) => {
    setSelectedCaseId(row.id)
    setDraft(cloneCase(row))
  }

  const addCase = () => {
    const next = emptyCase((detail?.cases.length ?? 0) + 1)
    setSelectedCaseId(null)
    setDraft(next)
  }

  const saveCase = async () => {
    if (!draft) return
    if (!draft.prompt.trim()) {
      showError('Prompt 不能为空')
      return
    }
    if (draft.points.length === 0 || draft.points.some((p) => !p.point.trim())) {
      showError('至少需要 1 个要点，且要点内容不能为空')
      return
    }
    setSaving(true)
    const input: EvalCaseInput = {
      caseKey: draft.caseKey,
      seq: draft.seq,
      title: draft.title,
      prompt: draft.prompt,
      clarify: draft.clarify,
      passThreshold: draft.passThreshold,
      timeoutSec: draft.timeoutSec,
      enabled: draft.enabled,
      points: draft.points.map((p, index) => ({
        seq: index + 1,
        point: p.point,
        required: p.required,
        weight: Number(p.weight) || 1,
        hint: p.hint,
      })),
    }
    try {
      if (draft.id > 0) {
        await api.updateEvalCase(id, draft.id, input)
      } else {
        const created = await api.addEvalCase(id, input)
        setSelectedCaseId(created.id)
      }
      setFeedback({ success: '用例已保存' })
      setTimeout(() => setFeedback(null), noticeDurationMs(null))
      load()
    } catch (e) {
      showError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const deleteCase = async () => {
    if (!draft || draft.id <= 0) {
      setDraft(null)
      setSelectedCaseId(null)
      return
    }
    if (!window.confirm('确认删除该用例？')) return
    try {
      await api.deleteEvalCase(id, draft.id)
      setFeedback({ success: '用例已删除' })
      setTimeout(() => setFeedback(null), noticeDurationMs(null))
      load()
      addCase()
    } catch (e) {
      showError((e as Error).message)
    }
  }

  const importJson = async () => {
    const text = window.prompt('粘贴导入 JSON（14.2 格式）')
    if (!text) return
    try {
      const payload = JSON.parse(text) as unknown
      const result = await api.importEvalSuite(id, payload)
      setFeedback({
        success: `导入完成：新增 ${result.added}，更新 ${result.updated}`,
      })
      setTimeout(() => setFeedback(null), noticeDurationMs(null))
      load()
    } catch (e) {
      showError(`导入失败：${(e as Error).message}`)
    }
  }

  const exportJson = async () => {
    try {
      const payload = await api.exportEvalSuite(id)
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      setFeedback({ success: '导出 JSON 已复制到剪贴板' })
      setTimeout(() => setFeedback(null), noticeDurationMs(null))
    } catch (e) {
      showError((e as Error).message)
    }
  }

  const launchRun = async () => {
    if (!runForm.targetWorkerId || !runForm.evaluatorWorkerId) {
      showError('请选择被测机器人与评估机器人')
      return
    }
    setSaving(true)
    try {
      const run = await api.createEvalRun({
        suiteId: id,
        targetWorkerId: runForm.targetWorkerId,
        evaluatorWorkerId: runForm.evaluatorWorkerId,
        repeatCount: runForm.repeatCount,
        concurrency: runForm.concurrency,
      })
      setFeedback({ success: '评估已发起' })
      setTimeout(() => {
        setFeedback(null)
        setRunOpen(false)
        navigate(`/admin/evaluations/runs/${run.id}`)
      }, noticeDurationMs(null))
    } catch (e) {
      showError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const showError = (message: string) => {
    setFeedback({ error: message })
    setTimeout(() => setFeedback(null), noticeDurationMs('x'))
  }

  if (!detail) {
    return (
      <div>
        <p className="text-sm text-foreground-muted">
          {error ? `加载失败：${error}` : '加载中…'}
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{detail.suite.name}</h1>
          <p className="mt-1 text-sm text-foreground-muted">
            {detail.suite.description || '未填写说明'}｜用途：{detail.suite.purpose}｜
            通过阈值：{detail.suite.passThreshold}｜超时：{detail.suite.defaultTimeoutSec}s｜
            提问上限：{detail.suite.maxQuestions} 次/项
          </p>
          <EvalSuiteTags
            className="mt-2"
            suite={detail.suite}
            onUpdated={(updated) =>
              setDetail((prev) =>
                prev ? { ...prev, suite: updated } : prev,
              )
            }
          />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={importJson}>
            导入
          </Button>
          <Button variant="outline" onClick={exportJson}>
            导出
          </Button>
          <Button variant="outline" onClick={addCase}>
            新建用例
          </Button>
          <PopoverNotice
            open={!!feedback}
            onOpenChange={(open) => {
              if (!open) setFeedback(null)
            }}
            success={feedback?.success}
            error={feedback?.error}
          >
            <Button onClick={() => setRunOpen(true)}>发起评估</Button>
          </PopoverNotice>
        </div>
      </div>

      <div className="grid grid-cols-[280px_1fr] gap-4">
        <Card className="p-0">
          <div className="border-b border-border px-3 py-2 text-sm font-medium">
            用例（{detail.cases.length}）
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {detail.cases.map((row) => (
              <button
                key={row.id}
                onClick={() => selectCase(row)}
                className={`block w-full border-b border-border px-3 py-2 text-left text-sm hover:bg-background-muted ${
                  selectedCaseId === row.id ? 'bg-background-selected' : ''
                }`}
              >
                <span className="block truncate font-medium">
                  {row.title || '未命名用例'}
                </span>
                <span className="mt-0.5 block truncate text-xs text-foreground-muted">
                  {row.caseKey}｜{row.points.length} 个要点
                  {row.enabled ? '' : '｜停用'}
                </span>
              </button>
            ))}
            {detail.cases.length === 0 && (
              <p className="px-3 py-4 text-xs text-foreground-muted">
                暂无用例，点击右上角「新建用例」添加。
              </p>
            )}
          </div>
        </Card>

        {draft && (
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">
                {draft.id > 0 ? `用例 #${draft.id}` : '新用例'}
              </h2>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-sm">
                  <Switch
                    checked={draft.enabled}
                    onCheckedChange={(checked) =>
                      setDraft({ ...draft, enabled: checked })
                    }
                  />
                  启用
                </label>
                <Button variant="outline" size="sm" onClick={deleteCase}>
                  删除
                </Button>
                <PopoverNotice
                  open={!!feedback}
                  onOpenChange={(open) => {
                    if (!open) setFeedback(null)
                  }}
                  success={feedback?.success}
                  error={feedback?.error}
                >
                  <Button size="sm" onClick={saveCase} disabled={saving}>
                    {saving ? '保存中…' : '保存用例'}
                  </Button>
                </PopoverNotice>
              </div>
            </div>
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1 text-sm">
                  标题（作为评估任务标题）
                  <Input
                    value={draft.title}
                    onChange={(e) =>
                      setDraft({ ...draft, title: e.target.value })
                    }
                    placeholder="留空时取 Prompt 首行"
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  caseKey（导入导出匹配用）
                  <Input
                    value={draft.caseKey}
                    onChange={(e) =>
                      setDraft({ ...draft, caseKey: e.target.value })
                    }
                  />
                </label>
              </div>
              <label className="grid gap-1 text-sm">
                输入（Prompt）
                <Textarea
                  rows={7}
                  value={draft.prompt}
                  onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                  placeholder="被测机器人收到的任务描述（Markdown）"
                />
              </label>
              <label className="grid gap-1 text-sm">
                补充信息（被测方第一次提问时原样答复，可空）
                <Textarea
                  rows={2}
                  value={draft.clarify ?? ''}
                  onChange={(e) =>
                    setDraft({ ...draft, clarify: e.target.value || null })
                  }
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1 text-sm">
                  通过阈值覆盖（0-100，空=用测试集）
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={draft.passThreshold ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        passThreshold:
                          e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  超时覆盖（秒，空=用测试集）
                  <Input
                    type="number"
                    min={60}
                    value={draft.timeoutSec ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        timeoutSec:
                          e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                  />
                </label>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-sm font-medium">期望要点（判定依据）</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        points: [
                          ...draft.points,
                          {
                            id: 0,
                            caseId: draft.id,
                            seq: draft.points.length + 1,
                            point: '',
                            required: false,
                            weight: '1',
                            hint: null,
                          },
                        ],
                      })
                    }
                  >
                    添加要点
                  </Button>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      <TableHead>要点</TableHead>
                      <TableHead className="w-16">必需</TableHead>
                      <TableHead className="w-20">权重</TableHead>
                      <TableHead className="w-52">返工提示（可空）</TableHead>
                      <TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {draft.points.map((point, index) => (
                      <TableRow key={index}>
                        <TableCell>{index + 1}</TableCell>
                        <TableCell>
                          <Textarea
                            rows={2}
                            value={point.point}
                            onChange={(e) => {
                              const points = [...draft.points]
                              points[index] = { ...point, point: e.target.value }
                              setDraft({ ...draft, points })
                            }}
                          />
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={point.required}
                            onCheckedChange={(checked) => {
                              const points = [...draft.points]
                              points[index] = { ...point, required: checked }
                              setDraft({ ...draft, points })
                            }}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            step="0.5"
                            min="0.5"
                            max="10"
                            value={point.weight}
                            onChange={(e) => {
                              const points = [...draft.points]
                              points[index] = { ...point, weight: e.target.value }
                              setDraft({ ...draft, points })
                            }}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            value={point.hint ?? ''}
                            placeholder="返工反馈只引用这里"
                            onChange={(e) => {
                              const points = [...draft.points]
                              points[index] = {
                                ...point,
                                hint: e.target.value || null,
                              }
                              setDraft({ ...draft, points })
                            }}
                          />
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setDraft({
                                ...draft,
                                points: draft.points.filter(
                                  (_, i) => i !== index,
                                ),
                              })
                            }
                          >
                            移除
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="mt-2 text-xs text-foreground-muted">
                  提示：返工提示不要直接写出期望答案；被测方看不到要点清单。
                </p>
              </div>
            </div>
          </Card>
        )}
      </div>

      <Dialog open={runOpen} onOpenChange={setRunOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>发起评估</DialogTitle>
          </DialogHeader>
          <DialogBody className="grid gap-3">
            <label className="grid gap-1 text-sm">
              被测机器人
              <Combobox
                items={workerItems}
                value={
                  runForm.targetWorkerId ? String(runForm.targetWorkerId) : null
                }
                onValueChange={(value) =>
                  setRunForm((prev) => ({
                    ...prev,
                    targetWorkerId: value == null ? 0 : Number(value),
                  }))
                }
                filter={(worker: Worker, query: string) =>
                  matchesPinyinSearch(query, [worker.id, worker.name])
                }
                icon={false}
              >
                <ComboboxTrigger aria-label="被测机器人">
                  <ComboboxValue placeholder="选择被测机器人" />
                </ComboboxTrigger>
                <ComboboxContent>
                  <div className="px-2 pb-2 group-data-empty/combobox-content:pt-2">
                    <ComboboxInput
                      placeholder="搜索机器人名称、ID 或拼音"
                      aria-label="搜索被测机器人"
                    />
                  </div>
                  <ScrollArea className="max-h-64">
                    <ComboboxEmpty>没有匹配的机器人</ComboboxEmpty>
                    <ComboboxList className="overflow-y-visible">
                      {(worker: Worker) => (
                        <ComboboxItem key={worker.id} value={String(worker.id)}>
                          {worker.name}（#{worker.id}）
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ScrollArea>
                </ComboboxContent>
              </Combobox>
            </label>
            <label className="grid gap-1 text-sm">
              评估机器人
              <Combobox
                items={workerItems}
                value={
                  runForm.evaluatorWorkerId
                    ? String(runForm.evaluatorWorkerId)
                    : null
                }
                onValueChange={(value) =>
                  setRunForm((prev) => ({
                    ...prev,
                    evaluatorWorkerId: value == null ? 0 : Number(value),
                  }))
                }
                filter={(worker: Worker, query: string) =>
                  matchesPinyinSearch(query, [worker.id, worker.name])
                }
                icon={false}
              >
                <ComboboxTrigger aria-label="评估机器人">
                  <ComboboxValue placeholder="选择评估机器人（专职）" />
                </ComboboxTrigger>
                <ComboboxContent>
                  <div className="px-2 pb-2 group-data-empty/combobox-content:pt-2">
                    <ComboboxInput
                      placeholder="搜索机器人名称、ID 或拼音"
                      aria-label="搜索评估机器人"
                    />
                  </div>
                  <ScrollArea className="max-h-64">
                    <ComboboxEmpty>没有匹配的机器人</ComboboxEmpty>
                    <ComboboxList className="overflow-y-visible">
                      {(worker: Worker) => (
                        <ComboboxItem key={worker.id} value={String(worker.id)}>
                          {worker.name}（#{worker.id}）
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ScrollArea>
                </ComboboxContent>
              </Combobox>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-sm">
                每个用例重复次数（1-5）
                <Input
                  type="number"
                  min={1}
                  max={5}
                  value={runForm.repeatCount}
                  onChange={(e) =>
                    setRunForm({ ...runForm, repeatCount: Number(e.target.value) })
                  }
                />
              </label>
              <label className="grid gap-1 text-sm">
                批次并发（1-5）
                <Input
                  type="number"
                  min={1}
                  max={5}
                  value={runForm.concurrency}
                  onChange={(e) =>
                    setRunForm({ ...runForm, concurrency: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <p className="text-xs text-foreground-muted">
              评估项数量：启用用例 {detail.cases.filter((c) => c.enabled).length} ×{' '}
              {runForm.repeatCount} 次 ={' '}
              {detail.cases.filter((c) => c.enabled).length * runForm.repeatCount} 项。
              每个评估项在独立沙箱中执行，不保留记忆。
            </p>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              取消
            </DialogClose>
            <Button onClick={launchRun} disabled={saving}>
              {saving ? '发起中…' : '确认发起'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 用例深拷贝（编辑草稿与列表解耦） */
function cloneCase(row: EvalCaseWithPoints): EvalCaseWithPoints {
  return {
    ...row,
    points: row.points.map((p) => ({ ...p })),
  }
}