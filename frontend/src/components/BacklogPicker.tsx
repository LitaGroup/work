import { useMemo } from 'react'
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  createComboboxItems,
} from '@appica/ui-react/combobox'
import { matchesPinyinSearch } from '../lib/pinyin-search'
import type { BacklogSummary } from '../lib/api'

/** 迭代项展示文本：标题已含 BL 编号时不再重复 */
export function backlogLabel(backlog: BacklogSummary): string {
  const title = backlog.title?.trim() ?? ''
  const label = title
    ? title.startsWith(backlog.code)
      ? title
      : `${backlog.code} ${title}`
    : backlog.code
  const iteration = backlog.iteration?.code ?? ''
  return `${label}${iteration ? `（${iteration}）` : ''}`
}

function filterBacklog(backlog: BacklogSummary, query: string): boolean {
  return matchesPinyinSearch(query, [
    backlog.code,
    backlog.title,
    backlog.iteration?.code ?? '',
    backlog.status,
  ])
}

/**
 * 迭代项单选（值为迭代项 ID 字符串）：输入框即搜索框，
 * 支持编号 / 标题 / 迭代标识模糊搜索。onChange 空串表示清空。
 */
export function BacklogPicker({
  backlogs,
  value,
  onChange,
  placeholder = '选择迭代项',
  clearable = true,
  size,
}: {
  backlogs: BacklogSummary[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  clearable?: boolean
  size?: 'sm' | 'md' | 'lg'
}) {
  const items = useMemo(
    () =>
      createComboboxItems(backlogs, {
        getValue: (backlog) => String(backlog.id),
        getLabel: (backlog) => backlogLabel(backlog),
      }),
    [backlogs],
  )
  return (
    <Combobox
      items={items}
      value={value || null}
      onValueChange={(next) => onChange(next == null ? '' : String(next))}
      filter={filterBacklog}
      clearable={clearable}
      size={size}
    >
      <ComboboxInput placeholder={placeholder} aria-label={placeholder} />
      <ComboboxContent className="w-[28rem]">
        <ComboboxEmpty>没有匹配的迭代项</ComboboxEmpty>
        <ComboboxList className="max-h-64 overflow-y-auto">
          {(backlog: BacklogSummary) => (
            <ComboboxItem key={backlog.id} value={String(backlog.id)}>
              <span className="truncate">{backlogLabel(backlog)}</span>
              <span className="ms-auto shrink-0 whitespace-nowrap ps-3 text-xs text-foreground-muted">
                {backlog.status}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

/** 迭代项多选（值为 ID 数组）：Chips 内联输入即搜索框。 */
export function BacklogMultiPicker({
  backlogs,
  value,
  onChange,
  placeholder = '选择迭代项',
  size,
}: {
  backlogs: BacklogSummary[]
  value: string[]
  onChange: (value: string[]) => void
  placeholder?: string
  size?: 'sm' | 'md' | 'lg'
}) {
  const items = useMemo(
    () =>
      createComboboxItems(backlogs, {
        getValue: (backlog) => String(backlog.id),
        getLabel: (backlog) => backlogLabel(backlog),
      }),
    [backlogs],
  )
  const labelById = useMemo(
    () => new Map(backlogs.map((backlog) => [String(backlog.id), backlogLabel(backlog)])),
    [backlogs],
  )
  return (
    <Combobox
      multiple
      items={items}
      value={value}
      onValueChange={(next) => onChange((next as string[]) ?? [])}
      filter={filterBacklog}
      size={size}
    >
      <ComboboxChips className="w-full" placeholder={placeholder}>
        <ComboboxValue>
          {(selected: string[]) =>
            selected.map((id) => (
              <ComboboxChip key={id} aria-label={id}>
                {labelById.get(id) ?? `#${id}`}
              </ComboboxChip>
            ))
          }
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent className="w-[28rem]">
        <ComboboxEmpty>没有匹配的迭代项</ComboboxEmpty>
        <ComboboxList className="max-h-64 overflow-y-auto">
          {(backlog: BacklogSummary) => (
            <ComboboxItem key={backlog.id} value={String(backlog.id)}>
              <span className="truncate">{backlogLabel(backlog)}</span>
              <span className="ms-auto shrink-0 whitespace-nowrap ps-3 text-xs text-foreground-muted">
                {backlog.status}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}