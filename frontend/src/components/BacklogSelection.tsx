import { useEffect, useMemo, useState } from 'react'
import { Input } from '@appica/ui-react/input'
import { Checkbox } from '@appica/ui-react/checkbox'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@appica/ui-react/table'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@appica/ui-react/select'
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
  api,
  PROJECT_TYPES,
  type Project,
  type Worker,
} from '../lib/api'
import { matchesPinyinSearch } from '../lib/pinyin-search'

/** 未排期（需求内计划周为空 / '-'）统一分组键 */
const UNSCHEDULED_WEEK = '-'

/** 需求内计划周取值：飞书同步的 w 字段，空值归为未排期 */
function weekOf(project: Project): string {
  return project.iterationCycle && project.iterationCycle !== '-'
    ? project.iterationCycle
    : UNSCHEDULED_WEEK
}

/**
 * 需求选择器（新建迭代 / 向已有迭代追加需求共用）：
 * - 已进入迭代（存在未取消迭代项）的需求自动过滤，不可重复选择；
 * - 支持名称（拼音）/ 类型 / 计划周(w) 过滤，已选项始终保留在列表顶部；
 * - 勾选后负责人可暂不指定，后续在迭代项详情补指定。
 */
export function BacklogSelection({
  projects,
  workers,
  drafts,
  onChange,
}: {
  projects: Project[]
  workers: Worker[]
  /** projectId -> ownerWorkerId（null 表示已选但未指定负责人） */
  drafts: Map<number, number | null>
  onChange: (next: Map<number, number | null>) => void
}) {
  const [keyword, setKeyword] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [weekFilter, setWeekFilter] = useState('all')
  /** 已进入迭代的需求（存在未取消迭代项），加载失败时不阻断选择 */
  const [occupied, setOccupied] = useState<Set<number>>(new Set())

  useEffect(() => {
    let cancelled = false
    api
      .listBacklogs()
      .then((rows) => {
        if (!cancelled) setOccupied(new Set(rows.map((row) => row.projectId)))
      })
      .catch(() => {
        // 过滤失败只降级为展示全部；转入接口仍会兜底判重
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 负责人机器人：数量多，用可搜索 Combobox（原文 + 拼音）
  const workerOptions = useMemo(
    () =>
      createComboboxItems(workers, {
        getValue: (worker: Worker) => String(worker.id),
        getLabel: (worker: Worker) => worker.name,
      }),
    [workers],
  )

  /** 可转入的需求：排除已进入迭代的 */
  const available = useMemo(
    () => projects.filter((project) => !occupied.has(project.id)),
    [projects, occupied],
  )

  /** 计划周筛选选项：按周编号倒序，未排期置底 */
  const weekOptions = useMemo(() => {
    const values = new Set<string>()
    for (const project of available) values.add(weekOf(project))
    return [...values].sort((a, b) => {
      if (a === UNSCHEDULED_WEEK) return 1
      if (b === UNSCHEDULED_WEEK) return -1
      const matchA = /^w(\d+)/.exec(a)
      const matchB = /^w(\d+)/.exec(b)
      if (matchA && matchB) return Number(matchB[1]) - Number(matchA[1])
      if (matchA) return -1
      if (matchB) return 1
      return a.localeCompare(b)
    })
  }, [available])

  const visible = useMemo(() => {
    const q = keyword.trim()
    // 已选项无视筛选始终展示，避免被筛掉后无法取消勾选
    const selected = available.filter((project) => drafts.has(project.id))
    const rest = available
      .filter((project) => {
        if (drafts.has(project.id)) return false
        if (typeFilter !== 'all' && project.type !== typeFilter) return false
        if (weekFilter !== 'all' && weekOf(project) !== weekFilter) return false
        return !q || matchesPinyinSearch(q, [project.name])
      })
      .slice(0, q ? 100 : 40)
    return [...selected, ...rest]
  }, [available, keyword, typeFilter, weekFilter, drafts])

  const toggle = (projectId: number, checked: boolean) => {
    const next = new Map(drafts)
    if (checked) next.set(projectId, next.get(projectId) ?? null)
    else next.delete(projectId)
    onChange(next)
  }

  /** 表头全选只作用于当前显示的行（含置顶的已选项） */
  const allChecked =
    visible.length > 0 && visible.every((project) => drafts.has(project.id))
  const someChecked = visible.some((project) => drafts.has(project.id))

  /** 全选/取消全选当前显示行；保留已有负责人选择 */
  const toggleAll = (checked: boolean) => {
    const next = new Map(drafts)
    for (const project of visible) {
      if (checked) next.set(project.id, next.get(project.id) ?? null)
      else next.delete(project.id)
    }
    onChange(next)
  }

  const setOwner = (projectId: number, ownerWorkerId: number) => {
    const next = new Map(drafts)
    next.set(projectId, ownerWorkerId)
    onChange(next)
  }

  const typeItems = Object.fromEntries([
    ['all', '不限类型'],
    ...PROJECT_TYPES.map((type) => [type, type]),
  ])
  const weekItems = Object.fromEntries([
    ['all', '不限计划周'],
    ...weekOptions.map((week) => [
      week,
      week === UNSCHEDULED_WEEK ? '未排期' : week,
    ]),
  ])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="w-64"
          placeholder="搜索需求名称（支持拼音）…"
          clearable
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onClear={() => setKeyword('')}
        />
        <Select
          value={typeFilter}
          onValueChange={(v) => setTypeFilter(v as string)}
          items={typeItems}
        >
          <SelectTrigger className="w-36" aria-label="按需求类型筛选">
            <SelectValue placeholder="类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">不限类型</SelectItem>
            {PROJECT_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={weekFilter}
          onValueChange={(v) => setWeekFilter(v as string)}
          items={weekItems}
        >
          <SelectTrigger className="w-44" aria-label="按计划周筛选">
            <SelectValue placeholder="计划周(w)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">不限计划周</SelectItem>
            {weekOptions.map((week) => (
              <SelectItem key={week} value={week}>
                {week === UNSCHEDULED_WEEK ? '未排期' : week}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm text-foreground-muted">
          已选 {drafts.size} 条
        </span>
      </div>
      <div className="max-h-[60vh] overflow-y-auto">
        <Table hoverableRows>
          <TableHeader className="sticky top-0 z-10">
            <TableRow>
              <TableHead className="w-14 text-center">
                <Checkbox
                  className="cursor-pointer"
                  checked={allChecked}
                  indeterminate={someChecked && !allChecked}
                  disabled={visible.length === 0}
                  onCheckedChange={(value) => toggleAll(value === true)}
                  aria-label="全选当前显示的需求"
                />
              </TableHead>
              <TableHead className="w-16">ID</TableHead>
              <TableHead>需求</TableHead>
              <TableHead className="w-20 text-center">类型</TableHead>
              <TableHead className="w-44 text-center">计划周(w)</TableHead>
              <TableHead className="w-52 text-center">负责人</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((project) => {
              const checked = drafts.has(project.id)
              const owner = drafts.get(project.id)
              return (
                <TableRow key={project.id}>
                  <TableCell className="text-center">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(value) =>
                        toggle(project.id, value === true)
                      }
                    />
                  </TableCell>
                  <TableCell>{project.id}</TableCell>
                  <TableCell className="max-w-md truncate" title={project.name}>
                    {project.name}
                  </TableCell>
                  <TableCell className="text-center text-sm text-foreground-muted">
                    {project.type}
                  </TableCell>
                  <TableCell className="text-center text-sm text-foreground-muted">
                    {weekOf(project) === UNSCHEDULED_WEEK ? '未排期' : weekOf(project)}
                  </TableCell>
                  <TableCell className="text-center">
                    <Combobox
                      items={workerOptions}
                      value={owner ? String(owner) : null}
                      onValueChange={(value) => {
                        if (value != null) setOwner(project.id, Number(value))
                      }}
                      filter={(worker: Worker, query: string) =>
                        matchesPinyinSearch(query, [worker.name])
                      }
                      disabled={!checked}
                    >
                      <ComboboxTrigger
                        className="w-full"
                        aria-label="选择负责人机器人"
                      >
                        <ComboboxValue
                          placeholder={checked ? '暂不指定' : '先勾选'}
                        />
                      </ComboboxTrigger>
                      <ComboboxContent>
                        <div className="px-2 pb-2 group-data-empty/combobox-content:pt-2">
                          <ComboboxInput
                            placeholder="搜索机器人名称"
                            aria-label="搜索负责人机器人"
                          />
                        </div>
                        <ScrollArea className="max-h-64">
                          <ComboboxEmpty>没有匹配的机器人</ComboboxEmpty>
                          <ComboboxList className="overflow-y-visible">
                            {(worker: Worker) => (
                              <ComboboxItem
                                key={worker.id}
                                value={String(worker.id)}
                              >
                                <span className="truncate">{worker.name}</span>
                                {worker.runtime === 'human' && (
                                  <span className="ms-auto ps-3 text-xs text-foreground-muted">
                                    真人
                                  </span>
                                )}
                              </ComboboxItem>
                            )}
                          </ComboboxList>
                        </ScrollArea>
                      </ComboboxContent>
                    </Combobox>
                  </TableCell>
                </TableRow>
              )
            })}
            {visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={6}>没有匹配的需求</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}