import type { ReactNode } from 'react'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
  PopoverDescription,
} from '@appica/ui-react/popover'

/**
 * 按钮结果反馈（Popover）：成功展示提示后自动关闭进入下一步，
 * 失败展示具体原因；调用方用 success/error + open 控制，
 * 计时策略见 docs/UI_STANDARD.md（成功 2 秒 / 失败 5 秒）。
 */
export function PopoverNotice(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  success?: string | null
  error?: string | null
  children: ReactNode
  align?: 'start' | 'center' | 'end'
}) {
  const { open, onOpenChange, success, error, children } = props
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={<span className="inline-flex">{children}</span>}
      />
      <PopoverContent side="top" align={props.align ?? 'end'} className="max-w-80">
        <PopoverTitle>{error ? '操作失败' : '操作成功'}</PopoverTitle>
        <PopoverDescription>{error ?? success ?? ''}</PopoverDescription>
      </PopoverContent>
    </Popover>
  )
}

/** 反馈计时：成功 2 秒、失败 5 秒（配合 PopoverNotice 使用） */
export function noticeDurationMs(error: string | null | undefined): number {
  return error ? 5000 : 2000
}