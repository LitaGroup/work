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
import type { IterationSummary } from '../lib/api'

/** 迭代展示文本：code（起止日期），T0 显示常驻 */
export function iterationLabel(
  iteration: Pick<IterationSummary, 'code' | 'startAt' | 'endAt'>,
): string {
  const range =
    iteration.startAt && iteration.endAt
      ? `${iteration.startAt} ~ ${iteration.endAt}`
      : '常驻'
  return `${iteration.code}（${range}）`
}

function filterIteration(iteration: IterationSummary, query: string): boolean {
  return matchesPinyinSearch(query, [
    iteration.code,
    iteration.startAt ?? '',
    iteration.endAt ?? '',
    iteration.status,
  ])
}

/**
 * 迭代单选（值为迭代 ID 字符串）：输入框即搜索框（官方 country select 组合），
 * 支持标识 / 日期模糊搜索（原文、全拼、首字母）。onChange 空串表示清空。
 */
export function IterationPicker({
  iterations,
  value,
  onChange,
  placeholder = '选择迭代',
  clearable = true,
  size,
}: {
  iterations: IterationSummary[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  clearable?: boolean
  size?: 'sm' | 'md' | 'lg'
}) {
  const items = useMemo(
    () =>
      createComboboxItems(iterations, {
        getValue: (iteration) => String(iteration.id),
        getLabel: (iteration) => iterationLabel(iteration),
      }),
    [iterations],
  )
  return (
    <Combobox
      items={items}
      value={value || null}
      onValueChange={(next) => onChange(next == null ? '' : String(next))}
      filter={filterIteration}
      clearable={clearable}
      size={size}
    >
      <ComboboxInput placeholder={placeholder} aria-label={placeholder} />
      <ComboboxContent className="w-[28rem]">
        <ComboboxEmpty>没有匹配的迭代</ComboboxEmpty>
        <ComboboxList className="max-h-64 overflow-y-auto">
          {(iteration: IterationSummary) => (
            <ComboboxItem key={iteration.id} value={String(iteration.id)}>
              <span className="truncate">{iterationLabel(iteration)}</span>
              <span className="ms-auto shrink-0 whitespace-nowrap ps-3 text-xs text-foreground-muted">
                {iteration.status}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

/**
 * 迭代多选（值为 ID 数组）：Chips 内联输入即搜索框（官方 multiple 组合），
 * 弹层内不再放输入框，避免锚点错位。
 */
export function IterationMultiPicker({
  iterations,
  value,
  onChange,
  placeholder = '选择迭代',
  size,
}: {
  iterations: IterationSummary[]
  value: string[]
  onChange: (value: string[]) => void
  placeholder?: string
  size?: 'sm' | 'md' | 'lg'
}) {
  const items = useMemo(
    () =>
      createComboboxItems(iterations, {
        getValue: (iteration) => String(iteration.id),
        getLabel: (iteration) => iterationLabel(iteration),
      }),
    [iterations],
  )
  const labelById = useMemo(
    () =>
      new Map(
        iterations.map((iteration) => [
          String(iteration.id),
          iterationLabel(iteration),
        ]),
      ),
    [iterations],
  )
  return (
    <Combobox
      multiple
      items={items}
      value={value}
      onValueChange={(next) => onChange((next as string[]) ?? [])}
      filter={filterIteration}
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
        <ComboboxEmpty>没有匹配的迭代</ComboboxEmpty>
        <ComboboxList className="max-h-64 overflow-y-auto">
          {(iteration: IterationSummary) => (
            <ComboboxItem key={iteration.id} value={String(iteration.id)}>
              <span className="truncate">{iterationLabel(iteration)}</span>
              <span className="ms-auto shrink-0 whitespace-nowrap ps-3 text-xs text-foreground-muted">
                {iteration.status}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}