import { useEffect, useMemo, useState } from 'react'
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
  Autocomplete,
  AutocompleteInput,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteList,
  AutocompleteItem,
} from '@appica/ui-react/autocomplete'
import { Button } from '@appica/ui-react/button'
import { Checkbox } from '@appica/ui-react/checkbox'
import { Input } from '@appica/ui-react/input'
import { ScrollArea } from '@appica/ui-react/scroll-area'
import { Textarea } from '@appica/ui-react/textarea'
import {
  api,
  RELEASE_ENDS,
  type BacklogDetail,
  type BacklogReleaseResult,
  type BacklogStatus,
  type BacklogSummary,
  type Project,
  type ReleaseBranch,
  type ReleaseEnd,
  type TicketWorkflowInputField,
} from '../lib/api'
import { matchesPinyinSearch } from '../lib/pinyin-search'
import { WorkflowField } from './WorkflowFieldInput'

/** 端映射：需求「涉及方」→ 提测端默认值（Android/iOS → APP，Backend → 后端） */
const INVOLVED_END_MAP: Record<string, ReleaseEnd> = {
  Android: 'APP',
  iOS: 'APP',
  H5: 'H5',
  Backend: '后端',
}

/**
 * 提测工单保留字段：由提测弹窗的专用控件承载（迭代项选择、标题、提测端、
 * 测试人员、分支、地址、各迭代项内容、详细说明），不进入动态字段区。
 * 与后端 `RELEASE_RESERVED_INPUT_KEYS` 保持一致。
 */
const RELEASE_RESERVED_INPUT_KEYS = new Set([
  'title',
  'description',
  'backlogs',
  'content',
  'testEnds',
  'testers',
  'branch',
  'url',
])

/** 迭代 / 迭代项引用字段：随所选迭代项自动代入，不渲染选择器 */
const RELEASE_REFERENCE_TYPES = new Set<TicketWorkflowInputField['type']>([
  'iteration',
  'iteration_multi',
  'backlog',
  'backlog_multi',
])

/** 批量提测标题：单迭代「提测-{code} {标题}」，多迭代「{首个标题} 等x个迭代」 */
function defaultReleaseTitle(rows: BacklogSummary[], codes: string[]): string {
  if (rows.length === 0) return ''
  if (rows.length === 1 && codes[0]) {
    return `提测-${codes[0]} ${rows[0].title}`.slice(0, 200)
  }
  return `${rows[0].title} 等${rows.length}个迭代`.slice(0, 200)
}

/** 按所选迭代项的原始需求「涉及方」预选提测端 */
function defaultReleaseEnds(
  rows: BacklogSummary[],
  projects: Project[],
): ReleaseEnd[] {
  const involved = new Set<string>()
  for (const row of rows) {
    const project = projects.find((item) => item.id === row.projectId)
    for (const party of project?.involvedParties ?? []) involved.add(party)
  }
  const ends = new Set<ReleaseEnd>()
  for (const party of involved) {
    const end = INVOLVED_END_MAP[party]
    if (end) ends.add(end)
  }
  return [...ends]
}

/** 引用字段自动代入值：迭代项 → BL 编号 + 标题；迭代 → 标识 */
function referenceSummary(
  field: TicketWorkflowInputField,
  rows: BacklogSummary[],
): string {
  if (field.type === 'backlog' || field.type === 'backlog_multi') {
    return rows.length > 0
      ? rows.map((row) => `${row.code} ${row.title}`).join('、')
      : '未选择迭代项'
  }
  const codes = [
    ...new Set(
      rows.map((row) => row.iteration?.code ?? `#${row.iterationId}`),
    ),
  ]
  return codes.length > 0 ? codes.join('、') : '未选择迭代项'
}

/**
 * 批量提测弹窗：
 * - 可跨迭代多选迭代项（默认预选当前迭代项），每个迭代项填写各自的提测内容；
 * - 整单共用提测端（APP / H5 / 后端，多选至少 1 个）、测试人员、代码分支、访问地址；
 * - 表单按「提测工单」（release-ticket）发布版本起始节点的字段配置动态渲染：
 *   迭代项 / 迭代引用字段随所选迭代项自动代入，其余自定义字段按类型渲染；
 * - 提交后每个迭代项各生成提测工单 + 提测记录，汇总一条提测群消息。
 */
export function BacklogReleaseDialog({
  backlog,
  open,
  onOpenChange,
  onDone,
}: {
  backlog: BacklogDetail
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: (result: BacklogReleaseResult) => void
}) {
  const [candidates, setCandidates] = useState<BacklogSummary[] | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [userNames, setUserNames] = useState<string[]>([])
  const [selected, setSelected] = useState<number[]>([backlog.id])
  const [contents, setContents] = useState<Record<number, string>>({})
  const [title, setTitle] = useState('')
  const [titleTouched, setTitleTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [descriptionTouched, setDescriptionTouched] = useState(false)
  const [dynamicValues, setDynamicValues] = useState<Record<string, string>>({})
  const [ends, setEnds] = useState<ReleaseEnd[]>([])
  const [endsTouched, setEndsTouched] = useState(false)
  const [testers, setTesters] = useState<string[]>([''])
  const [branches, setBranches] = useState<ReleaseBranch[]>([])
  const [urls, setUrls] = useState<string[]>([])
  const [keyword, setKeyword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  /** 工单配置起始节点字段（弹窗动态渲染的依据） */
  const configFields = useMemo(
    () => backlog.releaseWorkflow?.inputFields ?? [],
    [backlog.releaseWorkflow],
  )
  const configFieldByKey = useMemo(
    () => new Map(configFields.map((field) => [field.key, field])),
    [configFields],
  )
  /** 自定义动态字段：排除保留 key 与迭代/迭代项引用字段 */
  const dynamicFields = useMemo(
    () =>
      configFields.filter(
        (field) =>
          !RELEASE_RESERVED_INPUT_KEYS.has(field.key) &&
          !RELEASE_REFERENCE_TYPES.has(field.type),
      ),
    [configFields],
  )
  /** 引用字段：随所选迭代项自动代入（只读展示） */
  const referenceFields = useMemo(
    () =>
      configFields.filter(
        (field) =>
          !RELEASE_RESERVED_INPUT_KEYS.has(field.key) &&
          RELEASE_REFERENCE_TYPES.has(field.type),
      ),
    [configFields],
  )
  const reservedRequired = (key: string) =>
    configFieldByKey.get(key)?.required ?? false

  useEffect(() => {
    if (!open) return
    setSelected([backlog.id])
    setContents({})
    setTitle('')
    setTitleTouched(false)
    setDescription(backlog.releaseDescriptionPreview ?? '')
    setDescriptionTouched(false)
    setDynamicValues(
      Object.fromEntries(
        configFields.map((field) => [
          field.key,
          field.defaultValue == null ? '' : String(field.defaultValue),
        ]),
      ),
    )
    setEnds([])
    setEndsTouched(false)
    setTesters([''])
    setBranches([])
    setUrls([])
    setKeyword('')
    setError(null)
    setSaving(false)
    api
      .listBacklogs()
      .then(setCandidates)
      .catch(() => setCandidates([]))
    api
      .listProjects()
      .then(setProjects)
      .catch(() => setProjects([]))
    api
      .listUsers()
      .then((users) => setUserNames(users.map((user) => user.name)))
      .catch(() => setUserNames([]))
    // configFields 仅在迭代项切换/打开时变化，随 open 一起重置即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, backlog.id])

  /** 候选列表：当前迭代项始终可选项（即使未在列表中） */
  const backlogRows = useMemo(() => {
    const rows = [...(candidates ?? [])]
    if (!rows.some((row) => row.id === backlog.id)) {
      rows.unshift({
        id: backlog.id,
        code: backlog.code,
        projectId: backlog.projectId,
        iterationId: backlog.iterationId,
        title: backlog.title,
        status: backlog.status,
        ownerWorkerId: backlog.ownerWorkerId,
        ownerName: backlog.ownerName,
        owner: backlog.owner,
        expectedOnlineAt: backlog.expectedOnlineAt,
        updatedAt: backlog.updatedAt,
        iteration: backlog.iteration
          ? {
              id: backlog.iteration.id,
              code: backlog.iteration.code,
              type: backlog.iteration.type,
            }
          : null,
      })
    }
    return rows
  }, [candidates, backlog])

  const byId = useMemo(
    () => new Map(backlogRows.map((row) => [row.id, row])),
    [backlogRows],
  )

  const selectedRows = useMemo(
    () =>
      selected
        .map((id) => byId.get(id))
        .filter((row): row is BacklogSummary => Boolean(row)),
    [selected, byId],
  )

  const visibleRows = useMemo(() => {
    const q = keyword.trim()
    // 已选项始终展示，避免被筛选后无法取消
    const picked = selectedRows
    const rest = backlogRows
      .filter((row) => !selected.includes(row.id))
      .filter((row) => {
        if (!q) return true
        return matchesPinyinSearch(q, [
          row.code,
          row.title,
          row.iteration?.code ?? '',
        ])
      })
      .slice(0, q ? 100 : 50)
    return [...picked, ...rest]
  }, [backlogRows, selectedRows, selected, keyword])

  // 选择变化时自动更新标题与提测端（用户手动改过则保留）
  useEffect(() => {
    if (!open) return
    if (!titleTouched) {
      setTitle(
        defaultReleaseTitle(
          selectedRows,
          selectedRows.map((row) => row.code),
        ),
      )
    }
    if (!endsTouched) {
      setEnds(defaultReleaseEnds(selectedRows, projects))
    }
  }, [open, selectedRows, projects, titleTouched, endsTouched])

  const toggle = (id: number, checked: boolean) => {
    setSelected((list) =>
      checked
        ? [...new Set([...list, id])]
        : list.filter((item) => item !== id),
    )
    setError(null)
  }

  const toggleEnd = (end: ReleaseEnd, checked: boolean) => {
    setEndsTouched(true)
    setEnds((list) =>
      checked ? [...new Set([...list, end])] : list.filter((item) => item !== end),
    )
    setError(null)
  }

  const submit = async () => {
    if (saving) return
    const items = selectedRows.map((row) => ({
      backlogId: row.id,
      content: contents[row.id]?.trim() || undefined,
    }))
    const validTesters = testers.map((name) => name.trim()).filter(Boolean)
    const validBranches = branches
      .map((row) => ({ repo: row.repo.trim(), branch: row.branch.trim() }))
      .filter((row) => row.repo || row.branch)
    const validUrls = urls.map((url) => url.trim()).filter(Boolean)
    let message: string | null = null
    if (items.length === 0) message = '至少选择一个迭代项'
    else if (ends.length === 0) message = '提测端至少选择 1 个'
    else if (validTesters.length === 0) message = '测试人员至少填写 1 人'
    else if (validBranches.some((row) => !row.repo || !row.branch)) {
      message = '代码分支需同时填写仓库与分支'
    } else if (reservedRequired('branch') && validBranches.length === 0) {
      message = '代码分支为必填项'
    } else if (reservedRequired('url') && validUrls.length === 0) {
      message = '访问地址为必填项'
    } else if (
      reservedRequired('content') &&
      selectedRows.some((row) => !contents[row.id]?.trim())
    ) {
      message = '每个迭代项的提测内容均为必填项'
    } else {
      const missingDynamic = dynamicFields.find(
        (field) => field.required && !(dynamicValues[field.key] ?? '').trim(),
      )
      if (missingDynamic) message = `「${missingDynamic.label}」不能为空`
    }
    if (message) {
      setError(message)
      return
    }
    // 动态字段透传（保留 key 由后端按提测表单映射）；详细说明仅在人工修改后提交
    const inputValues: Record<string, unknown> = {}
    for (const field of dynamicFields) {
      const value = (dynamicValues[field.key] ?? '').trim()
      if (value) inputValues[field.key] = value
    }
    // 引用字段自动代入：迭代项 / 迭代（按所选迭代项与所属迭代生成）
    for (const field of referenceFields) {
      const isBacklog =
        field.type === 'backlog' || field.type === 'backlog_multi'
      const isMulti =
        field.type === 'backlog_multi' || field.type === 'iteration_multi'
      const ids = isBacklog
        ? selectedRows.map((row) => String(row.id))
        : [...new Set(selectedRows.map((row) => String(row.iterationId)))]
      const value = isMulti ? ids.join(',') : (ids[0] ?? '')
      if (value) inputValues[field.key] = value
    }
    if (descriptionTouched && description.trim()) {
      inputValues.description = description.trim()
    }
    setSaving(true)
    setError(null)
    try {
      const result = await api.submitBacklogRelease({
        items,
        title: title.trim() || undefined,
        ends,
        testers: validTesters,
        branches: validBranches,
        urls: validUrls,
        inputValues:
          Object.keys(inputValues).length > 0 ? inputValues : undefined,
      })
      onOpenChange(false)
      onDone(result)
    } catch (e) {
      setError((e as Error).message || '提测失败')
    } finally {
      setSaving(false)
    }
  }

  const statusLabel = (status: BacklogStatus) => status

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>发起提测</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pe-1">
            <p className="text-xs text-foreground-muted">
              可跨迭代多选迭代项；每个迭代项各生成一张提测工单与一条提测记录，提测群只推送一条汇总消息。
              {configFields.length > 0 &&
                '表单字段按「提测工单」配置动态生成，迭代项等引用字段自动代入。'}
            </p>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-sm">迭代项（至少 1 个）</span>
                <span className="text-xs text-foreground-muted">
                  已选 {selected.length} 个
                </span>
              </div>
              <Input
                placeholder="搜索迭代项编号/标题（支持拼音）…"
                clearable
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onClear={() => setKeyword('')}
              />
              <ScrollArea className="max-h-56 rounded-md border border-border">
                <div className="flex flex-col">
                  {visibleRows.map((row) => (
                    <label
                      key={row.id}
                      className="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0"
                    >
                      <Checkbox
                        checked={selected.includes(row.id)}
                        onCheckedChange={(value) =>
                          toggle(row.id, value === true)
                        }
                        aria-label={`选择 ${row.code}`}
                      />
                      <span className="shrink-0 font-mono text-xs text-foreground-muted">
                        {row.code}
                      </span>
                      <span className="min-w-0 flex-1 truncate" title={row.title}>
                        {row.title}
                      </span>
                      <span className="shrink-0 text-xs text-foreground-muted">
                        {row.iteration?.code ?? `迭代 #${row.iterationId}`} ·{' '}
                        {statusLabel(row.status)}
                      </span>
                    </label>
                  ))}
                  {visibleRows.length === 0 && (
                    <p className="px-3 py-4 text-sm text-foreground-muted">
                      没有匹配的迭代项
                    </p>
                  )}
                </div>
              </ScrollArea>
            </div>

            <label className="flex flex-col gap-1 text-sm">
              {configFieldByKey.get('title')?.label ?? '提测标题'}
              <Input
                value={title}
                onChange={(e) => {
                  setTitleTouched(true)
                  setTitle(e.target.value)
                }}
                placeholder="多个迭代项自动生成「xxx 等x个迭代」"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              {configFieldByKey.get('description')?.label ?? '详细说明'}
              {reservedRequired('description') && (
                <span className="text-xs text-foreground-muted">
                  已按当前迭代项预填上下文，可修改；留空表示使用自动生成内容
                </span>
              )}
              <Textarea
                rows={5}
                value={description}
                onChange={(e) => {
                  setDescriptionTouched(true)
                  setDescription(e.target.value)
                }}
                placeholder="补充提测背景、注意事项；留空自动生成迭代项上下文"
              />
            </label>

            <div className="flex flex-col gap-2">
              <span className="text-sm">提测端（至少 1 个）</span>
              <div className="flex flex-wrap items-center gap-4">
                {RELEASE_ENDS.map((end) => (
                  <label
                    key={end}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={ends.includes(end)}
                      onCheckedChange={(value) =>
                        toggleEnd(end, value === true)
                      }
                    />
                    {end}
                  </label>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-sm">测试人员（至少 1 人）</span>
              {testers.map((tester, index) => (
                <div key={index} className="flex items-center gap-2">
                  <div className="flex-1">
                    <Autocomplete
                      items={userNames}
                      value={tester}
                      onValueChange={(value) =>
                        setTesters((list) =>
                          list.map((item, i) =>
                            i === index ? (value as string) : item,
                          ),
                        )
                      }
                      clearable
                    >
                      <AutocompleteInput
                        placeholder="如 王五"
                        aria-label={`测试人员 ${index + 1}`}
                      />
                      <AutocompleteContent>
                        <AutocompleteEmpty>
                          未找到匹配的用户（须为登录过本平台的用户）
                        </AutocompleteEmpty>
                        <AutocompleteList>
                          {(item: string) => (
                            <AutocompleteItem key={item} value={item}>
                              {item}
                            </AutocompleteItem>
                          )}
                        </AutocompleteList>
                      </AutocompleteContent>
                    </Autocomplete>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setTesters((list) =>
                        list.length === 1
                          ? ['']
                          : list.filter((_, i) => i !== index),
                      )
                    }
                  >
                    移除
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTesters((list) => [...list, ''])}
                >
                  添加人员
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-sm">
                代码分支
                {reservedRequired('branch') ? '（必填，整单共用）' : '（可空，整单共用）'}
              </span>
              {branches.map((branch, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    className="flex-1"
                    placeholder="仓库，如 LitaGroup/lita-h5"
                    value={branch.repo}
                    onChange={(e) =>
                      setBranches((list) =>
                        list.map((row, i) =>
                          i === index ? { ...row, repo: e.target.value } : row,
                        ),
                      )
                    }
                  />
                  <Input
                    className="w-48"
                    placeholder="分支，如 test"
                    value={branch.branch}
                    onChange={(e) =>
                      setBranches((list) =>
                        list.map((row, i) =>
                          i === index
                            ? { ...row, branch: e.target.value }
                            : row,
                        ),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setBranches((list) =>
                        list.filter((_, i) => i !== index),
                      )
                    }
                  >
                    移除
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setBranches((list) => [...list, { repo: '', branch: '' }])
                  }
                >
                  添加分支
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-sm">
                访问地址
                {reservedRequired('url') ? '（必填，整单共用）' : '（可空，整单共用）'}
              </span>
              {urls.map((url, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    className="flex-1"
                    placeholder="https://…"
                    value={url}
                    onChange={(e) =>
                      setUrls((list) =>
                        list.map((item, i) =>
                          i === index ? e.target.value : item,
                        ),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setUrls((list) => list.filter((_, i) => i !== index))
                    }
                  >
                    移除
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setUrls((list) => [...list, ''])}
                >
                  添加地址
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-sm">
                各迭代项提测内容
                {reservedRequired('content') ? '（必填）' : ''}
              </span>
              {selectedRows.map((row) => (
                <label key={row.id} className="flex flex-col gap-1 text-sm">
                  <span className="text-xs text-foreground-muted">
                    {row.code} {row.title}
                  </span>
                  <Textarea
                    rows={3}
                    placeholder="本轮提测范围、注意事项、回归重点…"
                    value={contents[row.id] ?? ''}
                    onChange={(e) =>
                      setContents((map) => ({
                        ...map,
                        [row.id]: e.target.value,
                      }))
                    }
                  />
                </label>
              ))}
              {selectedRows.length === 0 && (
                <p className="text-xs text-foreground-muted">
                  先选择迭代项后填写提测内容
                </p>
              )}
            </div>

            {referenceFields.length > 0 && (
              <div className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-background-muted px-3 py-2 text-sm">
                {referenceFields.map((field) => (
                  <p key={field.key} className="text-xs text-foreground-muted">
                    {field.label}：{referenceSummary(field, selectedRows)}
                    <span className="ms-1">（随所选迭代项自动代入）</span>
                  </p>
                ))}
              </div>
            )}

            {dynamicFields.length > 0 && (
              <div className="flex flex-col gap-4">
                {dynamicFields.map((field) => (
                  <WorkflowField
                    key={field.key}
                    field={field}
                    value={dynamicValues[field.key] ?? ''}
                    onChange={(next) =>
                      setDynamicValues((map) => ({
                        ...map,
                        [field.key]: next,
                      }))
                    }
                  />
                ))}
              </div>
            )}

            {error && <p className="text-sm text-foreground-danger">{error}</p>}
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose>
            <Button variant="outline" size="sm">
              取消
            </Button>
          </DialogClose>
          <Button size="sm" onClick={submit} disabled={saving}>
            {saving ? '提测中…' : '发起提测'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}