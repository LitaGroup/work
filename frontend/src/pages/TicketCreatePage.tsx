import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@appica/ui-react/card'
import { api, type BacklogSummary, type IterationSummary } from '../lib/api'
import { WorkflowField, uploadWorkflowFile } from '../components/WorkflowFieldInput'
import { PageBreadcrumb } from '../components/PageBreadcrumb'

/** 新建工作流工单：按工单配置起始节点的结构化字段发起 */
export function TicketCreatePage() {
  const { definitionId } = useParams<{ definitionId: string }>()
  const id = Number(definitionId)
  const navigate = useNavigate()
  const [detail, setDetail] = useState<
    Awaited<ReturnType<typeof api.getTicketWorkflowDefinition>> | null
  >(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [iterations, setIterations] = useState<IterationSummary[]>([])
  const [backlogs, setBacklogs] = useState<BacklogSummary[]>([])
  const [uploading, setUploading] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!Number.isInteger(id) || id <= 0) {
      setError('工单配置 ID 不正确')
      return
    }
    api
      .getTicketWorkflowDefinition(id)
      .then(async (row) => {
        setDetail(row)
        const defaults: Record<string, string> = {}
        const startFields =
          row.published?.definition.nodes.find((node) => node.kind === 'start')
            ?.inputFields ?? []
        for (const field of startFields) {
          defaults[field.key] =
            field.defaultValue == null ? '' : String(field.defaultValue)
        }
        setValues(defaults)
        setError(null)
        // 迭代 / 迭代项字段需要可选清单（标识与标题）才能选择
        const needIterations = startFields.some(
          (field) =>
            field.type === 'iteration' || field.type === 'iteration_multi',
        )
        const needBacklogs = startFields.some(
          (field) =>
            field.type === 'backlog' || field.type === 'backlog_multi',
        )
        if (needIterations) {
          try {
            setIterations(await api.listIterations())
          } catch {
            // 迭代清单加载失败不阻塞表单，迭代字段会提示无选项
          }
        }
        if (needBacklogs) {
          try {
            setBacklogs(await api.listBacklogs())
          } catch {
            // 迭代项清单加载失败不阻塞表单，迭代项字段会提示无选项
          }
        }
      })
      .catch((e: Error) => setError(e.message))
  }, [id])

  const published = detail?.published?.definition ?? null
  const start = useMemo(
    () => published?.nodes.find((node) => node.kind === 'start') ?? null,
    [published],
  )
  const fields = start?.inputFields ?? []
  const publishable = Boolean(detail?.enabled && detail.latestPublishedVersion)
  const missingRequired = fields.some(
    (field) => field.required && !(values[field.key] ?? '').trim(),
  )

  const submit = () => {
    if (!detail) return
    setError(null)
    setSaving(true)
    api
      .createTicket({
        workflowDefinitionId: detail.id,
        title: values.title?.trim() || undefined,
        inputValues: values,
      })
      .then((ticket) => navigate(`/tickets/${ticket.id}`))
      .catch((e: Error) => setError(`创建失败：${e.message}`))
      .finally(() => setSaving(false))
  }

  const update = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }))

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageBreadcrumb
            items={[
              { label: '工单', to: `/tickets/wf/${id}` },
              { label: detail?.name ?? '新建' },
            ]}
          />
          <h1 className="mt-2 text-2xl font-semibold">
            发起{detail?.name ?? '工单'}
          </h1>
          <p className="mt-1 text-sm text-foreground-muted">
            工单创建后固定使用 v{detail?.latestPublishedVersion ?? '-'} 工作流；由发起机器人负责最终验收
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate(`/tickets/wf/${id}`)}>
            取消
          </Button>
          <Button size="sm" onClick={submit} disabled={saving || !publishable || missingRequired}>
            {saving ? '创建中…' : '创建工单'}
          </Button>
        </div>
      </div>

      {error && (
        <p className="rounded-[var(--radius-md)] bg-error-muted px-3 py-2 text-sm text-error-foreground">
          {error}
        </p>
      )}
      {!detail && !error && <p className="text-sm text-foreground-muted">加载中…</p>}
      {detail && !publishable && (
        <p className="rounded-[var(--radius-md)] bg-error-muted px-3 py-2 text-sm text-error-foreground">
          该工单配置还没有发布版本，请先在「管理 → 工单配置」发布。
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <Card className="min-w-0 flex-1">
          <CardHeader className="flex-none">
            <CardTitle>工单信息</CardTitle>
            <CardDescription>
              由起始节点定义；必填字段完整后才能创建
            </CardDescription>
          </CardHeader>
          <div className="grid gap-4 px-4 pb-4">
            {fields.map((field) => (
              <WorkflowField
                key={field.key}
                field={field}
                value={values[field.key] ?? ''}
                onChange={(next) => update(field.key, next)}
                iterations={iterations}
                backlogs={backlogs}
                uploading={uploading === field.key}
                onUploadFile={async (file) => {
                  setUploading(field.key)
                  setError(null)
                  try {
                    return await uploadWorkflowFile(file)
                  } catch (e) {
                    setError((e as Error).message)
                    throw e
                  } finally {
                    setUploading(null)
                  }
                }}
              />
            ))}
            {fields.length === 0 && (
              <p className="text-sm text-foreground-muted">
                该流程起始节点未配置输入字段
              </p>
            )}
          </div>
        </Card>

        <Card className="w-full shrink-0 lg:w-[24rem]">
          <CardHeader className="flex-none">
            <CardTitle>处理流程</CardTitle>
            <CardDescription>创建后按发布版本自动推进节点任务</CardDescription>
          </CardHeader>
          <div className="flex flex-col gap-2 px-4 pb-4 text-sm">
            {(published?.nodes ?? []).map((node) => (
              <div
                key={node.key}
                className="rounded-[var(--radius-md)] bg-background-muted px-3 py-2"
              >
                <p className="flex items-center gap-2 font-medium">
                  {node.name}
                  <Badge variant="secondary" size="sm">
                    {node.kind === 'start' && '起始'}
                    {node.kind === 'operation' && '操作'}
                    {node.kind === 'approval' && '审批'}
                    {node.kind === 'acceptance' && '验收'}
                    {node.kind === 'condition' && '判断'}
                    {node.kind === 'feishu-message' && '飞书群消息'}
                  </Badge>
                </p>
                {node.description && (
                  <p className="mt-1 line-clamp-3 text-xs text-foreground-muted">
                    {node.description}
                  </p>
                )}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
