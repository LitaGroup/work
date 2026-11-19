import { useRef } from 'react'
import { Badge } from '@appica/ui-react/badge'
import { Input } from '@appica/ui-react/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@appica/ui-react/select'
import type {
  BacklogSummary,
  IterationSummary,
  TicketWorkflowInputField,
} from '../lib/api'
import { IterationMultiPicker, IterationPicker } from './IterationPicker'
import { BacklogMultiPicker, BacklogPicker } from './BacklogPicker'
import { MarkdownEditor } from './MarkdownEditor'

/** 单选「未选择」占位值（Appica Select 不接受空字符串 value） */
const NO_OPTION = '__none__'

/** 上传工单文件字段：返回站内 /files 路径（/files/...） */
export async function uploadWorkflowFile(file: File): Promise<string> {
  const body = new FormData()
  body.append('file', file)
  const response = await fetch('/api/files/upload.md', {
    method: 'POST',
    body,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(text || '文件上传失败')
  const match = text.match(/\(\/(files\/[^)\s]+)\)/)
  if (!match) throw new Error('上传结果中缺少文件地址')
  return `/${match[1]}`
}

/** 字段类型徽标文案 */
export function workflowFieldTypeLabel(
  type: TicketWorkflowInputField['type'],
): string {
  switch (type) {
    case 'text':
      return '文本'
    case 'textarea':
      return '多行文本'
    case 'number':
      return '数字'
    case 'date':
      return '日期'
    case 'select':
      return '单选'
    case 'multiselect':
      return '多选'
    case 'file':
      return '文件'
    case 'iteration':
      return '迭代'
    case 'iteration_multi':
      return '迭代（多选）'
    case 'backlog':
      return '迭代项'
    case 'backlog_multi':
      return '迭代项（多选）'
    default:
      return '文本'
  }
}

/**
 * 工单起始节点单个输入字段（标签 + 类型徽标 + 按类型渲染的控件）。
 * 新建工单页与迭代项提测弹窗共用，保证两处字段渲染一致。
 */
export function WorkflowField({
  field,
  value,
  onChange,
  iterations = [],
  backlogs = [],
  onUploadFile,
  uploading = false,
}: {
  field: TicketWorkflowInputField
  value: string
  onChange: (value: string) => void
  iterations?: IterationSummary[]
  backlogs?: BacklogSummary[]
  /** 文件字段上传：返回站内路径；未提供时禁用上传 */
  onUploadFile?: (file: File) => Promise<string>
  uploading?: boolean
}) {
  const fileRef = useRef<HTMLInputElement | null>(null)

  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-sm">
      <span className="flex items-center gap-1">
        {field.label}
        {field.required && <span className="text-error-foreground">*</span>}
        <Badge variant="outline" size="sm">
          {workflowFieldTypeLabel(field.type)}
        </Badge>
      </span>
      {field.type === 'textarea' ? (
        <div className="h-56 md-editor-scroll rounded-none border border-border-strong bg-background-muted">
          <MarkdownEditor
            key={field.key}
            value={value}
            compact
            appica
            onChange={(markdown) => onChange(markdown)}
          />
        </div>
      ) : field.type === 'select' ? (
        <Select
          value={value || NO_OPTION}
          onValueChange={(next) =>
            onChange(next === NO_OPTION ? '' : String(next))
          }
          items={{
            [NO_OPTION]: field.placeholder ?? '请选择',
            ...Object.fromEntries(
              (field.options ?? []).map((option) => [option, option]),
            ),
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder={field.placeholder ?? '请选择'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_OPTION}>
              {field.placeholder ?? '请选择'}
            </SelectItem>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === 'multiselect' ? (
        <Select
          multiple
          value={value.split(',').filter(Boolean)}
          onValueChange={(next) =>
            onChange((next as string[]).join(','))
          }
          items={Object.fromEntries(
            (field.options ?? []).map((option) => [option, option]),
          )}
        >
          <SelectTrigger clearable>
            <SelectValue placeholder={field.placeholder ?? '请选择'}>
              {(selected: string[]) =>
                selected.length === 0
                  ? (field.placeholder ?? '请选择')
                  : selected.join('、')
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === 'iteration' ? (
        <IterationPicker
          iterations={iterations}
          value={value}
          onChange={onChange}
          placeholder={field.placeholder ?? '选择迭代'}
        />
      ) : field.type === 'iteration_multi' ? (
        <IterationMultiPicker
          iterations={iterations}
          value={value.split(',').filter(Boolean)}
          onChange={(next) => onChange(next.join(','))}
          placeholder={field.placeholder ?? '选择迭代'}
        />
      ) : field.type === 'backlog' ? (
        <BacklogPicker
          backlogs={backlogs}
          value={value}
          onChange={onChange}
          placeholder={field.placeholder ?? '选择迭代项'}
        />
      ) : field.type === 'backlog_multi' ? (
        <BacklogMultiPicker
          backlogs={backlogs}
          value={value.split(',').filter(Boolean)}
          onChange={(next) => onChange(next.join(','))}
          placeholder={field.placeholder ?? '选择迭代项'}
        />
      ) : field.type === 'file' ? (
        <span className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            className="text-sm"
            disabled={!onUploadFile || uploading}
            onChange={async (event) => {
              const file = event.target.files?.[0]
              if (!file || !onUploadFile) return
              try {
                onChange(await onUploadFile(file))
              } catch {
                // 上传失败提示由调用方处理，这里只负责清理 input
              } finally {
                if (fileRef.current) fileRef.current.value = ''
              }
            }}
          />
          {uploading && (
            <span className="text-xs text-foreground-muted">上传中…</span>
          )}
        </span>
      ) : (
        <Input
          type={
            field.type === 'date'
              ? 'date'
              : field.type === 'number'
                ? 'number'
                : 'text'
          }
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder ?? ''}
        />
      )}
      {field.type === 'file' && value && (
        <span className="truncate text-xs text-foreground-muted">
          已上传：{value}
        </span>
      )}
    </label>
  )
}