import { useEffect, useRef, useState } from 'react'
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
import { Input } from '@appica/ui-react/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@appica/ui-react/select'
import { Textarea } from '@appica/ui-react/textarea'
import { api, DOCUMENT_TYPES, type DocumentType } from '../lib/api'
import { PopoverNotice, noticeDurationMs } from './PopoverNotice'

/** 文档类型选择（创建/导入弹窗共用） */
export function DocumentTypeSelect({
  value,
  onChange,
}: {
  value: DocumentType
  onChange: (v: DocumentType) => void
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as DocumentType)}>
      <SelectTrigger>
        <SelectValue placeholder="选择文档类型" />
      </SelectTrigger>
      <SelectContent>
        {DOCUMENT_TYPES.map((t) => (
          <SelectItem key={t} value={t}>
            {t}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** 创建文档（平台内直接编写）；创建后回调（含新文档 id），由调用方决定后续动作 */
export function CreateDocumentDialog({
  projectId,
  onCreated,
}: {
  projectId: number
  onCreated: (documentId?: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [type, setType] = useState<DocumentType>('需求')
  const [content, setContent] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  const isDesignLink = type === '设计'

  const submit = () => {
    setError(null)
    api
      .createDocument({
        projectId,
        title,
        type,
        content: isDesignLink ? undefined : content || undefined,
        url: isDesignLink ? url.trim() : undefined,
      })
      .then((doc) => {
        setOpen(false)
        setTitle('')
        setContent('')
        setUrl('')
        onCreated(doc.id)
      })
      .catch((e: Error) => setError(e.message))
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>创建文档</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建文档</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm">
              文档类型
              <DocumentTypeSelect value={type} onChange={setType} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              标题
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="文档标题"
              />
            </label>
            {isDesignLink ? (
              <label className="flex flex-col gap-1 text-sm">
                设计链接（必填，http(s) 完整链接）
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://…"
                />
                <span className="text-xs text-foreground-muted">
                  链接型文档只保存链接，不存正文
                </span>
              </label>
            ) : (
              <label className="flex flex-col gap-1 text-sm">
                内容（Markdown，可稍后补充）
                <Textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="# 标题&#10;&#10;正文…"
                  rows={6}
                />
              </label>
            )}
            {error && <p className="text-sm">创建失败:{error}</p>}
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose>
            <Button variant="outline" size="sm">取消</Button>
          </DialogClose>
          <Button
            size="sm"
            onClick={submit}
            disabled={!title.trim() || (isDesignLink && !url.trim())}
          >
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 按链接识别导入来源（决定走哪个同步端点）；未识别时交由飞书端点校验报错 */
function detectImportSource(url: string): 'apipost' | 'feishu' {
  if (/apipost\.net/i.test(url)) return 'apipost'
  return 'feishu'
}

/** 飞书 / APIPOST 导入弹窗：需求资料与知识库共用，实际导入请求由调用方提供 */
export function ExternalDocumentImportDialog<T extends { id: number | string }>({
  onImport,
  onImported,
  showDocumentType = true,
  showDescription = true,
  showTitle = false,
}: {
  onImport: (input: {
    url: string
    type?: DocumentType
    description?: string
    title?: string
  }) => Promise<T>
  onImported: (document: T) => void
  showDocumentType?: boolean
  showDescription?: boolean
  showTitle?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [type, setType] = useState<DocumentType>('需求')
  const [description, setDescription] = useState('')
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [feedback, setFeedback] = useState<{
    success?: string
    error?: string
  } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const source = detectImportSource(url)

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => clearTimer, [])

  const showFeedback = (
    next: NonNullable<typeof feedback>,
    after?: () => void,
  ) => {
    clearTimer()
    setFeedback(next)
    timerRef.current = setTimeout(() => {
      setFeedback(null)
      after?.()
    }, noticeDurationMs(next.error))
  }

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) {
      clearTimer()
      setFeedback(null)
    }
  }

  const handleUrlChange = (value: string) => {
    setUrl(value)
    // APIPOST 是接口文档，识别到后类型自动切为「接口」
    if (showDocumentType && detectImportSource(value) === 'apipost') {
      setType('接口')
    }
  }

  const submit = () => {
    if (!url.trim() || loading) return
    setLoading(true)
    onImport({
      url: url.trim(),
      type: showDocumentType ? type : undefined,
      description: showDescription
        ? description.trim() || undefined
        : undefined,
      title: showTitle ? title.trim() || undefined : undefined,
    })
      .then((document) => {
        showFeedback({ success: '文档已导入' }, () => {
          setOpen(false)
          setUrl('')
          setDescription('')
          setTitle('')
          onImported(document)
        })
      })
      .catch((e: Error) =>
        showFeedback({ error: e.message || '导入失败' }),
      )
      .finally(() => setLoading(false))
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button size="sm" />}>导入文档</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>导入文档</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            {showDocumentType && (
              <label className="flex flex-col gap-1 text-sm">
                文档类型
                <DocumentTypeSelect value={type} onChange={setType} />
              </label>
            )}
            <label className="flex flex-col gap-1 text-sm">
              文档链接
              <Input
                value={url}
                onChange={(e) => handleUrlChange(e.target.value)}
                placeholder="支持 飞书（文档/表格/多维表格/知识库）或 APIPOST 链接"
              />
              {url.trim() && (
                <span className="text-xs text-foreground-muted">
                  {source === 'apipost'
                    ? '已识别为 APIPOST 链接，将转换为 Markdown 并参与知识检索'
                    : '已识别为飞书链接，将单向同步为 Markdown'}
                </span>
              )}
            </label>
            {showTitle && (
              <label className="flex flex-col gap-1 text-sm">
                标题（可不填）
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="不填则使用来源文档标题"
                />
              </label>
            )}
            {showDescription && (
              <label className="flex flex-col gap-1 text-sm">
                文档描述（可不填）
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="简单描述这份文档的用途…"
                  rows={3}
                />
              </label>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose>
            <Button variant="outline" size="sm">取消</Button>
          </DialogClose>
          <PopoverNotice
            open={feedback !== null}
            success={feedback?.success}
            error={feedback?.error}
            onOpenChange={(next) => {
              if (!next && feedback?.error) {
                clearTimer()
                setFeedback(null)
              }
            }}
          >
            <Button
              size="sm"
              onClick={submit}
              disabled={!url.trim() || loading || !!feedback?.success}
            >
              {loading ? '导入中…' : '导入'}
            </Button>
          </PopoverNotice>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 需求资料导入：按链接自动选择飞书 / APIPOST 同步接口 */
export function ImportDocumentDialog({
  projectId,
  onImported,
}: {
  projectId: number
  onImported: (documentId?: number) => void
}) {
  return (
    <ExternalDocumentImportDialog
      onImport={({ url, type = '需求', description }) =>
        detectImportSource(url) === 'apipost'
          ? api.importApipostDocument({ projectId, url, type, description })
          : api.importFeishuDocument({ projectId, type, url, description })
      }
      onImported={(doc) => onImported(doc.id)}
    />
  )
}
