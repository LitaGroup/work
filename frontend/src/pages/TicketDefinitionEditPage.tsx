import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Badge } from '@appica/ui-react/badge'
import { Button, buttonVariants } from '@appica/ui-react/button'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@appica/ui-react/card'
import { Input } from '@appica/ui-react/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@appica/ui-react/select'
import { Switch } from '@appica/ui-react/switch'
import { Textarea } from '@appica/ui-react/textarea'
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
import { MermaidDiagram } from '../components/MermaidDiagram'
import { PageBreadcrumb } from '../components/PageBreadcrumb'
import {
  IterationMultiPicker,
  IterationPicker,
} from '../components/IterationPicker'
import {
  BacklogMultiPicker,
  BacklogPicker,
} from '../components/BacklogPicker'
import { matchesPinyinSearch } from '../lib/pinyin-search'
import {
  api,
  WORKFLOW_END_NODE,
  type BacklogSummary,
  type IterationSummary,
  type TaskTemplate,
  type TicketWorkflowDefinitionDetail,
  type TicketWorkflowInputField,
  type Worker,
  type WorkflowConditionOperator,
  type WorkflowConditionRule,
  type WorkflowEdgeDefinition,
  type WorkflowNodeDefinition,
  type WorkflowNodeKind,
  type WorkflowOutcome,
} from '../lib/api'

const NO_SELECTION = '__none__'

const NODE_KIND_LABEL: Record<WorkflowNodeKind, string> = {
  start: '起始节点',
  operation: '操作节点',
  approval: '审批节点',
  acceptance: '验收节点',
  condition: '判断节点',
  'feishu-message': '飞书群消息节点',
}

const OUTCOME_LABEL: Record<WorkflowOutcome, string> = {
  succeeded: '执行成功',
  failed: '执行失败',
  approved: '通过',
  rejected: '驳回',
}

const CONDITION_OPERATOR_LABEL: Record<WorkflowConditionOperator, string> = {
  eq: '等于',
  ne: '不等于',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
  contains: '包含',
  empty: '为空',
  notEmpty: '不为空',
}

function conditionNeedsValue(operator: WorkflowConditionOperator): boolean {
  return operator !== 'empty' && operator !== 'notEmpty'
}

function conditionOperatorsForType(
  type: TicketWorkflowInputField['type'],
): WorkflowConditionOperator[] {
  if (type === 'number' || type === 'date') {
    return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty']
  }
  if (type === 'text' || type === 'textarea') {
    return ['eq', 'ne', 'contains', 'empty', 'notEmpty']
  }
  if (type === 'select' || type === 'iteration' || type === 'backlog') {
    return ['eq', 'ne', 'empty', 'notEmpty']
  }
  if (
    type === 'multiselect' ||
    type === 'iteration_multi' ||
    type === 'backlog_multi'
  ) {
    return ['contains', 'empty', 'notEmpty']
  }
  return []
}

/** 迭代字段：值存迭代 ID */
function isIterationField(type: TicketWorkflowInputField['type'] | undefined): boolean {
  return type === 'iteration' || type === 'iteration_multi'
}

/** 迭代项字段：值存迭代项 ID */
function isBacklogField(type: TicketWorkflowInputField['type'] | undefined): boolean {
  return type === 'backlog' || type === 'backlog_multi'
}

/** 迭代 / 迭代项引用字段：单选、多选值形态不同 */
function isReferenceField(type: TicketWorkflowInputField['type'] | undefined): boolean {
  return isIterationField(type) || isBacklogField(type)
}

/** 单选 / 多选共用选项配置 */
function isChoiceField(type: TicketWorkflowInputField['type'] | undefined): boolean {
  return type === 'select' || type === 'multiselect'
}

/** 解析逗号分隔的选项：兼容中英文逗号，去空去重 */
function parseOptions(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[,，]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  )
}

/**
 * 选项编辑：聚焦期间保留原始文本，失焦或回车时才解析提交。
 * 若每次按键都 split/join，逗号会被立即吞掉，导致无法输入分隔符。
 */
function OptionsInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[]
  onChange: (options: string[]) => void
  placeholder?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (text: string) => {
    onChange(parseOptions(text))
    setDraft(null)
  }
  return (
    <Input
      value={draft ?? value.join(',')}
      placeholder={placeholder}
      onFocus={() => setDraft(value.join(','))}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit(event.currentTarget.value)
        }
      }}
    />
  )
}

function conditionSummary(
  edge: WorkflowEdgeDefinition,
  startFields: TicketWorkflowInputField[],
): string {
  const rules = edge.conditions ?? []
  if (rules.length === 0) return '默认分支'
  const labelByKey = new Map(startFields.map((field) => [field.key, field.label]))
  return rules
    .map((rule) => {
      const field = labelByKey.get(rule.field) ?? rule.field
      const operator = CONDITION_OPERATOR_LABEL[rule.operator] ?? rule.operator
      return conditionNeedsValue(rule.operator)
        ? `${field}${operator}${rule.value ?? ''}`
        : `${field}${operator}`
    })
    .join(' 且 ')
}

const FIELD_TYPE_LABEL: Record<TicketWorkflowInputField['type'], string> = {
  text: '单行文本',
  textarea: '多行文本',
  number: '数字',
  date: '日期',
  select: '单选',
  multiselect: '多选',
  file: '文件',
  iteration: '迭代（单选）',
  iteration_multi: '迭代（多选）',
  backlog: '迭代项（单选）',
  backlog_multi: '迭代项（多选）',
}

/** 消息模板可用变量（与后端 message-template.ts 保持一致） */
const MESSAGE_TEMPLATE_VARIABLES = [
  { expression: 'ticket.code', label: '工单编号' },
  { expression: 'ticket.title', label: '工单标题' },
  { expression: 'ticket.description', label: '工单描述' },
  { expression: 'ticket.category', label: '工单分类' },
  { expression: 'ticket.initiator', label: '发起人姓名（纯文本）' },
  { expression: 'initiator.mention', label: '实际发起机器人（真人机器人自动 @）' },
  { expression: 'ticket.createdAt', label: '创建时间' },
  { expression: 'ticket.url', label: '工单链接' },
  { expression: 'node.name', label: '当前节点名称' },
]

function formatTime(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', {
    hour12: false,
    timeZone: 'Asia/Shanghai',
  })
}

function optionalId(value: string): number | null {
  return value === NO_SELECTION ? null : Number(value)
}

function nextNodeKey(nodes: WorkflowNodeDefinition[]): string {
  const used = new Set(nodes.map((node) => node.key))
  let index = 1
  while (used.has(`node-${index}`)) index += 1
  return `node-${index}`
}

function outcomeOptions(kind: WorkflowNodeKind): WorkflowOutcome[] {
  if (kind === 'operation') return ['succeeded', 'failed']
  if (kind === 'approval' || kind === 'acceptance') {
    return ['approved', 'rejected']
  }
  return []
}

function edgeLabel(outcome: WorkflowOutcome | null): string {
  if (!outcome) return '无条件流转'
  return OUTCOME_LABEL[outcome]
}

function mermaidSafe(value: string): string {
  return value
    .replace(/["|\r\n]/g, ' ')
    .replace(/[{}[\]()<>]/g, ' ')
    .trim()
}

function buildFlowchart(
  nodes: WorkflowNodeDefinition[],
  edges: WorkflowEdgeDefinition[],
): string {
  if (nodes.length === 0) return 'flowchart TD\n  empty[暂无节点]'
  const startFields =
    nodes.find((node) => node.kind === 'start')?.inputFields ?? []
  const kindByKey = new Map(nodes.map((node) => [node.key, node.kind]))
  const shape = (node: WorkflowNodeDefinition): string => {
    const label = mermaidSafe(node.name)
    if (node.kind === 'start') return `${node.key}(["${label}"])`
    if (node.kind === 'condition') return `${node.key}[/"${label}"/]`
    if (node.kind === 'approval') return `${node.key}{"${label}"}`
    if (node.kind === 'acceptance') return `${node.key}{{"${label}"}}`
    if (node.kind === 'feishu-message') return `${node.key}[["${label}"]]`
    return `${node.key}["${label}"]`
  }
  const lines = ['flowchart TD']
  for (const node of nodes) lines.push(`  ${shape(node)}`)
  lines.push(`  ${WORKFLOW_END_NODE}(["流程结束"])`)
  for (const edge of edges) {
    const label =
      edge.label?.trim() ||
      (kindByKey.get(edge.from) === 'condition'
        ? conditionSummary(edge, startFields)
        : edgeLabel(edge.outcome))
    lines.push(
      `  ${edge.from} -->|"${mermaidSafe(label)}"| ${
        edge.to === WORKFLOW_END_NODE ? WORKFLOW_END_NODE : edge.to
      }`,
    )
  }
  return lines.join('\n')
}

/** 工单配置编辑：结构化配置起始字段、节点任务、负责机器人与流转规则 */
export function TicketDefinitionEditPage() {
  const { definitionId } = useParams<{ definitionId: string }>()
  const navigate = useNavigate()

  const [detail, setDetail] =
    useState<TicketWorkflowDefinitionDetail | null>(null)
  const [templates, setTemplates] = useState<TaskTemplate[]>([])
  const [workers, setWorkers] = useState<Worker[]>([])
  const [iterations, setIterations] = useState<IterationSummary[]>([])
  const [backlogs, setBacklogs] = useState<BacklogSummary[]>([])
  const [feishuChats, setFeishuChats] = useState<
    Array<{ chatId: string; name: string | null }>
  >([])
  const [feishuChatError, setFeishuChatError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [nodes, setNodes] = useState<WorkflowNodeDefinition[]>([])
  const [edges, setEdges] = useState<WorkflowEdgeDefinition[]>([])

  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const applyDetail = (value: TicketWorkflowDefinitionDetail) => {
    setDetail(value)
    setName(value.name)
    setDescription(value.description ?? '')
    setEnabled(value.enabled)
    setNodes(value.draft.nodes)
    setEdges(value.draft.edges)
  }

  useEffect(() => {
    if (!definitionId) return
    let alive = true
    Promise.all([
      api.getTicketWorkflowDefinition(Number(definitionId)),
      api.listTaskTemplates(),
      api.listWorkers(),
      api.listIterations(),
      api.listBacklogs(),
      api.listTicketWorkflowFeishuChats().catch((e: Error) => {
        if (alive) setFeishuChatError(e.message)
        return []
      }),
    ])
      .then(([definition, taskTemplates, publicWorkers, iterationRows, backlogRows, chats]) => {
        if (!alive) return
        setLoadError(null)
        applyDetail(definition)
        setTemplates(
          [...taskTemplates].sort((a, b) =>
            a.name.localeCompare(b.name, 'zh-CN'),
          ),
        )
        setWorkers(
          [...publicWorkers].sort((a, b) =>
            a.name.localeCompare(b.name, 'zh-CN'),
          ),
        )
        setIterations(iterationRows)
        setBacklogs(backlogRows)
        setFeishuChats(chats)
      })
      .catch((e: Error) => {
        if (alive) setLoadError(e.message)
      })
    return () => {
      alive = false
    }
  }, [definitionId])

  const templateItems = useMemo<Record<string, string>>(
    () => ({
      [NO_SELECTION]: '未选择任务定义',
      ...Object.fromEntries(
        templates.map((template) => [
          String(template.id),
          template.name,
        ]),
      ),
    }),
    [templates],
  )
  const workerItems = useMemo<Record<string, string>>(
    () => ({
      [NO_SELECTION]: '未选择负责机器人',
      ...Object.fromEntries(
        workers.map((worker) => [
          String(worker.id),
          worker.enabled ? worker.name : `${worker.name}（已停用）`,
        ]),
      ),
    }),
    [workers],
  )
  const nodeItems = useMemo<Record<string, string>>(
    () => ({
      ...Object.fromEntries(nodes.map((node) => [node.key, node.name])),
      [WORKFLOW_END_NODE]: '流程结束',
    }),
    [nodes],
  )
  /** 飞书群选择（「飞书群消息」节点） */
  const feishuChatItems = useMemo(
    () =>
      createComboboxItems(feishuChats, {
        getValue: (chat) => chat.chatId,
        getLabel: (chat) => chat.name ?? chat.chatId,
      }),
    [feishuChats],
  )
  const startNode = nodes.find((node) => node.kind === 'start')
  const conditionFields = (startNode?.inputFields ?? []).filter(
    (field) => conditionOperatorsForType(field.type).length > 0,
  )
  const acceptanceNodes = nodes.filter((node) => node.kind === 'acceptance')
  const acceptanceNode = acceptanceNodes[0]

  const updateNode = (
    index: number,
    patch: Partial<WorkflowNodeDefinition>,
  ) => {
    setNodes((current) =>
      current.map((node, i) => (i === index ? { ...node, ...patch } : node)),
    )
  }

  const addNode = () => {
    const key = nextNodeKey(nodes)
    const node: WorkflowNodeDefinition = {
      key,
      name: `新节点 ${nodes.length + 1}`,
      kind: 'operation',
      taskTemplateId: null,
      responsibleWorkerId: null,
      inputFields: null,
      autoAccept: false,
      feishuChatId: null,
      feishuChatName: null,
      messageTemplate: null,
      messageTitle: null,
      description: null,
    }
    const insertAt = acceptanceNode
      ? nodes.findIndex((item) => item.key === acceptanceNode.key)
      : nodes.length
    setNodes((current) => [
      ...current.slice(0, insertAt),
      node,
      ...current.slice(insertAt),
    ])
    // 首个业务节点自动接在起始节点后面，减少空配置
    if (startNode && !edges.some((edge) => edge.from === startNode.key)) {
      setEdges((current) => [
        ...current,
        {
          from: startNode.key,
          to: key,
          outcome: null,
          label: '开始处理',
        },
      ])
    }
  }

  const removeNode = (key: string) => {
    const node = nodes.find((item) => item.key === key)
    if (!node || node.kind === 'start') return
    if (
      node.kind === 'acceptance' &&
      nodes.filter((item) => item.kind === 'acceptance').length <= 1
    ) {
      return
    }
    setNodes(nodes.filter((item) => item.key !== key))
    setEdges((current) =>
      current.filter((edge) => edge.from !== key && edge.to !== key),
    )
  }

  const updateEdge = (
    index: number,
    patch: Partial<WorkflowEdgeDefinition>,
  ) => {
    setEdges((current) =>
      current.map((edge, i) => (i === index ? { ...edge, ...patch } : edge)),
    )
  }

  const addEdge = () => {
    const from = startNode?.key ?? nodes[0]?.key
    if (!from) return
    const source = nodes.find((node) => node.key === from)
    const options = source ? outcomeOptions(source.kind) : []
    const outcome = source?.kind === 'condition' ? null : (options[0] ?? null)
    setEdges((current) => [
      ...current,
      {
        from,
        to: acceptanceNode?.key ?? WORKFLOW_END_NODE,
        outcome,
        conditions: null,
        label: source?.kind === 'condition' ? '默认分支' : edgeLabel(outcome),
      },
    ])
  }

  const updateConditionRule = (
    edgeIndex: number,
    ruleIndex: number,
    patch: Partial<WorkflowConditionRule>,
  ) => {
    setEdges((current) =>
      current.map((edge, i) => {
        if (i !== edgeIndex) return edge
        return {
          ...edge,
          conditions: (edge.conditions ?? []).map((rule, j) =>
            j === ruleIndex ? { ...rule, ...patch } : rule,
          ),
        }
      }),
    )
  }

  const addConditionRule = (edgeIndex: number) => {
    const field = conditionFields[0]
    if (!field) return
    const operators = conditionOperatorsForType(field.type)
    const operator = operators[0] ?? 'eq'
    setEdges((current) =>
      current.map((edge, i) => {
        if (i !== edgeIndex) return edge
        return {
          ...edge,
          conditions: [
            ...(edge.conditions ?? []),
            {
              field: field.key,
              operator,
              value: isChoiceField(field.type)
                ? (field.options?.[0] ?? '')
                : conditionNeedsValue(operator)
                  ? ''
                  : null,
            },
          ],
        }
      }),
    )
  }

  const removeConditionRule = (edgeIndex: number, ruleIndex: number) => {
    setEdges((current) =>
      current.map((edge, i) => {
        if (i !== edgeIndex) return edge
        const conditions = (edge.conditions ?? []).filter(
          (_, j) => j !== ruleIndex,
        )
        return { ...edge, conditions: conditions.length ? conditions : null }
      }),
    )
  }

  const updateInputField = (
    nodeIndex: number,
    fieldIndex: number,
    patch: Partial<TicketWorkflowInputField>,
  ) => {
    setNodes((current) =>
      current.map((node, i) => {
        if (i !== nodeIndex) return node
        const fields = (node.inputFields ?? []).map((field, j) =>
          j === fieldIndex ? { ...field, ...patch } : field,
        )
        return { ...node, inputFields: fields }
      }),
    )
  }

  const addInputField = (nodeIndex: number) => {
    setNodes((current) =>
      current.map((node, i) => {
        if (i !== nodeIndex) return node
        const fields = node.inputFields ?? []
        let index = fields.length + 1
        const used = new Set(fields.map((field) => field.key))
        while (used.has(`field${index}`)) index += 1
        return {
          ...node,
          inputFields: [
            ...fields,
            {
              key: `field${index}`,
              label: `字段 ${index}`,
              type: 'text',
              required: false,
              placeholder: '',
              defaultValue: null,
            },
          ],
        }
      }),
    )
  }

  const removeInputField = (nodeIndex: number, fieldIndex: number) => {
    setNodes((current) =>
      current.map((node, i) => {
        if (i !== nodeIndex) return node
        return {
          ...node,
          inputFields: (node.inputFields ?? []).filter((_, j) => j !== fieldIndex),
        }
      }),
    )
  }

  const payload = () => ({
    name: name.trim(),
    description: description.trim() || null,
    enabled,
    definition: {
      startNode: startNode?.key ?? '',
      nodes,
      edges: edges.map((edge) => {
        const source = nodes.find((node) => node.key === edge.from)
        return {
          ...edge,
          label:
            edge.label?.trim() ||
            (source?.kind === 'condition'
              ? conditionSummary(edge, startNode?.inputFields ?? [])
              : edgeLabel(edge.outcome)),
        }
      }),
    },
  })

  const persist = (publish: boolean) => {
    if (!detail) return
    setSaving(true)
    setMessage(null)
    setError(null)
    const request = publish
      ? api.publishTicketWorkflow(detail.id, payload())
      : api.saveTicketWorkflowDraft(detail.id, payload())
    request
      .then((updated) => {
        applyDetail(updated)
        setMessage(
          publish
            ? `已发布 v${updated.latestPublishedVersion}，后续新建工单将使用该版本`
            : '草稿已保存；发布后才会生成新版本',
        )
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false))
  }

  const loadPublished = () => {
    if (!detail?.published) return
    const definition = detail.published.definition
    setName(detail.published.name)
    setDescription(detail.published.description ?? '')
    setNodes(definition.nodes)
    setEdges(definition.edges)
    setMessage(
      `已载入 v${detail.published.version} 的流程配置，保存草稿后不会影响已发布版本`,
    )
    setError(null)
  }

  if (!definitionId || Number.isNaN(Number(definitionId))) {
    return <p className="text-sm text-error-foreground">工单配置 ID 不正确</p>
  }
  if (loadError) {
    return (
      <div className="flex flex-col gap-4">
        <PageBreadcrumb
          items={[
            { label: '工单配置', to: '/admin/ticket-config' },
            { label: '编辑' },
          ]}
        />
        <p className="text-sm text-error-foreground">加载失败：{loadError}</p>
      </div>
    )
  }
  if (!detail) {
    return <p className="text-sm text-foreground-muted">加载中…</p>
  }

  const flowchart = buildFlowchart(nodes, edges)

  return (
    <div className="flex flex-col gap-4 pb-12">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageBreadcrumb
            items={[
              { label: '工单配置', to: '/admin/ticket-config' },
              { label: detail.category },
            ]}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{name || detail.category}</h1>
            {detail.builtIn && (
              <Badge variant="secondary" size="sm">
                系统内置
              </Badge>
            )}
            {detail.latestPublishedVersion ? (
              <Badge variant="outline" size="sm">
                当前发布 v{detail.latestPublishedVersion}
              </Badge>
            ) : (
              <Badge variant="soft" size="sm">
                未发布
              </Badge>
            )}
            {!enabled && (
              <Badge variant="soft" size="sm">
                已停用
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-foreground-muted">
            审批节点由负责机器人处理；操作节点按任务定义自动分配；判断节点按起始输入条件自动分发；飞书群消息节点以官方机器人通知后自动流转；验收只能由工单发起机器人操作
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/admin/ticket-config"
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            返回列表
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/tickets/wf/${detail.id}`)}
          >
            查看工单
          </Button>
          {detail.published && (
            <Button
              variant="outline"
              size="sm"
              onClick={loadPublished}
              disabled={saving}
            >
              载入已发布版本
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => persist(false)}
            disabled={saving}
          >
            {saving ? '处理中…' : '保存草稿'}
          </Button>
          <Button
            size="sm"
            onClick={() => persist(true)}
            disabled={saving || !enabled}
          >
            发布新版本
          </Button>
        </div>
      </div>

      {(message || error) && (
        <p
          className={`rounded-[var(--radius-md)] px-3 py-2 text-sm ${
            error
              ? 'bg-error-muted text-error-foreground'
              : 'bg-success-muted text-success-foreground'
          }`}
        >
          {error ?? message}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>基本信息</CardTitle>
          <CardDescription>
            配置编码由平台生成；流程发布后生成不可变版本
          </CardDescription>
        </CardHeader>
        <div className="grid gap-4 px-6 pb-6 md:grid-cols-2 xl:grid-cols-4">
          <label className="flex flex-col gap-1 text-sm">
            配置编码
            <div className="flex h-9 items-center rounded-[var(--radius-md)] border border-border-strong bg-background-muted px-3 font-mono text-xs">
              {detail.code}
            </div>
          </label>
          <label className="flex flex-col gap-1 text-sm md:col-span-2">
            配置名称
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="工单配置名称"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            启用状态
            <span className="flex h-9 items-center gap-2">
              <Switch
                size="sm"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
              <span className="text-foreground-muted">
                {enabled ? '启用（允许发布）' : '停用'}
              </span>
            </span>
          </label>
          <label className="flex flex-col gap-1 text-sm md:col-span-2 xl:col-span-3">
            配置说明
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="说明该工单流程的适用范围和验收目的"
              rows={2}
            />
          </label>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_28rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div>
                <CardTitle>流程节点</CardTitle>
                <CardDescription>
                  起始节点固定存在；至少保留一个验收节点，可添加审批、操作、判断、飞书群消息或更多验收节点
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={addNode}>
                新增节点
              </Button>
            </CardHeader>
            <div className="flex flex-col gap-4 px-6 pb-6">
              {nodes.map((node, index) => {
                const acceptanceCount = nodes.filter(
                  (item) => item.kind === 'acceptance',
                ).length
                const fixed =
                  node.kind === 'start' ||
                  (node.kind === 'acceptance' && acceptanceCount <= 1)
                return (
                  <div
                    key={node.key}
                    className="rounded-[var(--radius-lg)] border border-border-strong p-4"
                  >
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" size="sm">
                          {index + 1}
                        </Badge>
                        <span className="font-medium">{node.name}</span>
                        <Badge variant="secondary" size="sm">
                          {NODE_KIND_LABEL[node.kind]}
                        </Badge>
                        <span className="font-mono text-xs text-foreground-muted">
                          {node.key}
                        </span>
                      </div>
                      {!fixed && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeNode(node.key)}
                        >
                          删除节点
                        </Button>
                      )}
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="flex flex-col gap-1 text-sm">
                        节点名称
                        <Input
                          value={node.name}
                          onChange={(event) =>
                            updateNode(index, { name: event.target.value })
                          }
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        节点类型
                        {fixed ? (
                          <div className="flex h-9 items-center rounded-[var(--radius-md)] border border-border-strong bg-background-muted px-3">
                            {NODE_KIND_LABEL[node.kind]}
                          </div>
                        ) : (
                          <Select
                            value={node.kind}
                            onValueChange={(value) => {
                              const kind = value as WorkflowNodeKind
                              updateNode(index, {
                                kind,
                                taskTemplateId:
                                  kind === 'operation' || kind === 'approval'
                                    ? node.taskTemplateId
                                    : null,
                                responsibleWorkerId:
                                  kind === 'approval'
                                    ? node.responsibleWorkerId
                                    : null,
                                inputFields:
                                  kind === 'start' ? node.inputFields : null,
                                autoAccept: kind === 'acceptance' ? node.autoAccept : false,
                                feishuChatId:
                                  kind === 'feishu-message'
                                    ? (node.feishuChatId ?? null)
                                    : null,
                                feishuChatName:
                                  kind === 'feishu-message'
                                    ? (node.feishuChatName ?? null)
                                    : null,
                                messageTemplate:
                                  kind === 'feishu-message'
                                    ? (node.messageTemplate ?? null)
                                    : null,
                                messageTitle:
                                  kind === 'feishu-message'
                                    ? (node.messageTitle ?? null)
                                    : null,
                              })
                              const nextOptions = outcomeOptions(kind)
                              setEdges((current) =>
                                current.map((edge) =>
                                  edge.from === node.key
                                    ? {
                                        ...edge,
                                        outcome:
                                          kind === 'condition'
                                            ? null
                                            : (nextOptions[0] ?? null),
                                        conditions:
                                          kind === 'condition'
                                            ? (edge.conditions ?? null)
                                            : null,
                                        label:
                                          kind === 'condition'
                                            ? '默认分支'
                                            : edgeLabel(nextOptions[0] ?? null),
                                      }
                                    : edge,
                                ),
                              )
                            }}
                            items={{
                              operation: NODE_KIND_LABEL.operation,
                              approval: NODE_KIND_LABEL.approval,
                              acceptance: NODE_KIND_LABEL.acceptance,
                              condition: NODE_KIND_LABEL.condition,
                              'feishu-message': NODE_KIND_LABEL['feishu-message'],
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="operation">
                                {NODE_KIND_LABEL.operation}
                              </SelectItem>
                              <SelectItem value="approval">
                                {NODE_KIND_LABEL.approval}
                              </SelectItem>
                              <SelectItem value="acceptance">
                                {NODE_KIND_LABEL.acceptance}
                              </SelectItem>
                              <SelectItem value="condition">
                                {NODE_KIND_LABEL.condition}
                              </SelectItem>
                              <SelectItem value="feishu-message">
                                {NODE_KIND_LABEL['feishu-message']}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      </label>

                      {(node.kind === 'operation' || node.kind === 'approval') && (
                        <label className="flex flex-col gap-1 text-sm">
                          任务定义
                          <Select
                            value={node.taskTemplateId ? String(node.taskTemplateId) : NO_SELECTION}
                            onValueChange={(value) =>
                              updateNode(index, { taskTemplateId: optionalId(String(value)) })
                            }
                            items={templateItems}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="选择任务定义" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NO_SELECTION}>
                                未选择任务定义
                              </SelectItem>
                              {templates.map((template) => (
                                <SelectItem
                                  key={template.id}
                                  value={String(template.id)}
                                >
                                  {template.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </label>
                      )}

                      {node.kind === 'approval' && (
                        <label className="flex flex-col gap-1 text-sm">
                          负责机器人
                          <Select
                            value={
                              node.responsibleWorkerId
                                ? String(node.responsibleWorkerId)
                                : NO_SELECTION
                            }
                            onValueChange={(value) =>
                              updateNode(index, {
                                responsibleWorkerId: optionalId(String(value)),
                              })
                            }
                            items={workerItems}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="选择负责机器人" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NO_SELECTION}>
                                未选择负责机器人
                              </SelectItem>
                              {workers.map((worker) => (
                                <SelectItem
                                  key={worker.id}
                                  value={String(worker.id)}
                                >
                                  {worker.enabled
                                    ? worker.name
                                    : `${worker.name}（已停用）`}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </label>
                      )}

                      {node.kind === 'operation' && (
                        <div className="flex items-end text-sm text-foreground-muted">
                          处理机器人由任务定义自动分配
                        </div>
                      )}
                    </div>

                    {node.kind === 'feishu-message' && (
                      <div className="mt-4 rounded-[var(--radius-md)] bg-background-muted p-3">
                        <div className="grid gap-3 md:grid-cols-2">
                          <label className="flex flex-col gap-1 text-sm">
                            目标飞书群
                            <Combobox
                              items={feishuChatItems}
                              value={node.feishuChatId || null}
                              onValueChange={(value) => {
                                const chatId = value == null ? '' : String(value)
                                const chat = feishuChats.find(
                                  (item) => item.chatId === chatId,
                                )
                                updateNode(index, {
                                  feishuChatId: chatId || null,
                                  feishuChatName: chat?.name ?? null,
                                })
                              }}
                              filter={(chat: {
                                chatId: string
                                name: string | null
                              }, query: string) =>
                                matchesPinyinSearch(query, [
                                  chat.name ?? '',
                                  chat.chatId,
                                ])
                              }
                              icon={false}
                            >
                              <ComboboxTrigger aria-label="目标飞书群">
                                <ComboboxValue placeholder="选择群（平台官方机器人已加入）" />
                              </ComboboxTrigger>
                              <ComboboxContent>
                                <div className="px-2 pb-2 group-data-empty/combobox-content:pt-2">
                                  <ComboboxInput
                                    placeholder="搜索群名称"
                                    aria-label="搜索飞书群"
                                  />
                                </div>
                                <ComboboxEmpty>
                                  {feishuChatError ?? '没有匹配的群'}
                                </ComboboxEmpty>
                                <ComboboxList className="max-h-64 overflow-y-auto">
                                  {(chat: {
                                    chatId: string
                                    name: string | null
                                  }) => (
                                    <ComboboxItem
                                      key={chat.chatId}
                                      value={chat.chatId}
                                    >
                                      <span className="truncate">
                                        {chat.name ?? chat.chatId}
                                      </span>
                                    </ComboboxItem>
                                  )}
                                </ComboboxList>
                              </ComboboxContent>
                            </Combobox>
                            {feishuChatError && (
                              <span className="text-xs text-error-foreground">
                                {feishuChatError}
                              </span>
                            )}
                            {node.feishuChatName &&
                              node.feishuChatId &&
                              !feishuChats.some(
                                (chat) => chat.chatId === node.feishuChatId,
                              ) && (
                                <span className="text-xs text-foreground-muted">
                                  已选群：{node.feishuChatName}（当前不在清单中，发送可能失败）
                                </span>
                              )}
                          </label>
                          <div className="flex items-end text-xs text-foreground-muted">
                            进入节点后以平台官方机器人身份发送；发送失败只记录运行说明，不阻断流程
                          </div>
                        </div>
                        <label className="mt-3 flex flex-col gap-1 text-sm">
                          卡片标题（可选，Handlebars，纯文本）
                          <Input
                            value={node.messageTitle ?? ''}
                            onChange={(event) =>
                              updateNode(index, {
                                messageTitle: event.target.value,
                              })
                            }
                            placeholder="{{ ticket.code }} {{ values.title }}"
                          />
                          <span className="text-xs text-foreground-muted">
                            留空默认「工单编号 + 节点名称」；标题为纯文本（不支持
                            @ 与颜色标签），超过 80 字符自动截断
                          </span>
                        </label>
                        <label className="mt-3 flex flex-col gap-1 text-sm">
                          消息模板（Handlebars，Markdown）
                          <Textarea
                            value={node.messageTemplate ?? ''}
                            onChange={(event) =>
                              updateNode(index, {
                                messageTemplate: event.target.value,
                              })
                            }
                            rows={6}
                            placeholder={
                              '【{{ ticket.code }}】{{ ticket.title }}\n\n发起人：{{ ticket.initiator }}\n\n{{ ticket.url }}'
                            }
                          />
                        </label>
                        <p className="mt-2 text-xs text-foreground-muted">
                          可用变量：
                          {MESSAGE_TEMPLATE_VARIABLES.map(
                            (item) => `{{ ${item.expression} }}`,
                          ).join('、')}
                          、
                          {`{{ values.<字段标识> }}`}
                          （起始节点输入字段）
                        </p>
                        <p className="mt-1 text-xs text-foreground-muted">
                          成员与迭代循环：
                          {`{{#each testers}}{{mention}} {{/each}}`}（测试人员）、
                          {`{{#each developers}}{{mention}} {{/each}}`}（开发人员）、
                          {`{{#each demanders}}{{mention}} {{/each}}`}（需求方）、
                          {`{{#each backlogs}}{{requirementType}} {{requirementTitle}}{{/each}}`}
                          （关联迭代项，另有 code / title / status / url，以及所属迭代
                          iterationCode / iterationUrl 与需求链接 requirementUrl）；
                          {`迭代项与迭代可直接写成 [文本]({{ url }}) 形式的可点击链接`}；
                          成员来自起始节点选择的迭代项（选择「迭代」时按该迭代下全部迭代项），
                          真人机器人自动转飞书 @，AI 机器人显示名称
                        </p>
                      </div>
                    )}

                    {node.kind === 'condition' && (
                      <div className="mt-4 rounded-[var(--radius-md)] bg-background-muted px-3 py-2 text-sm text-foreground-muted">
                        判断节点不创建任务；进入后按「流转规则」中的条件自动分发，字段取自起始节点输入
                      </div>
                    )}

                    {node.kind === 'start' && (
                      <div className="mt-4 rounded-[var(--radius-md)] bg-background-muted p-3">
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <p className="text-sm font-medium">起始输入字段</p>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => addInputField(index)}
                          >
                            新增字段
                          </Button>
                        </div>
                        <div className="flex flex-col gap-3">
                          {(node.inputFields ?? []).map((field, fieldIndex) => (
                            <div
                              // 用下标做 key：标识可直接编辑，不能把可编辑值当 key，
                              // 否则每次按键都会重挂载输入框导致失焦
                              key={fieldIndex}
                              className="rounded-[var(--radius-md)] border border-border-strong bg-background p-3"
                            >
                              <div className="grid gap-2 md:grid-cols-4">
                                <label className="flex flex-col gap-1 text-xs">
                                  标识
                                  <Input
                                    value={field.key}
                                    onChange={(event) =>
                                      updateInputField(index, fieldIndex, {
                                        key: event.target.value,
                                      })
                                    }
                                  />
                                </label>
                                <label className="flex flex-col gap-1 text-xs">
                                  名称
                                  <Input
                                    value={field.label}
                                    onChange={(event) =>
                                      updateInputField(index, fieldIndex, {
                                        label: event.target.value,
                                      })
                                    }
                                  />
                                </label>
                                <label className="flex flex-col gap-1 text-xs">
                                  类型
                                  <Select
                                    value={field.type}
                                    onValueChange={(value) =>
                                      updateInputField(index, fieldIndex, {
                                        type: value as TicketWorkflowInputField['type'],
                                        ...(isChoiceField(
                                          value as TicketWorkflowInputField['type'],
                                        )
                                          ? { options: field.options ?? [] }
                                          : { options: undefined }),
                                      })
                                    }
                                    items={FIELD_TYPE_LABEL}
                                  >
                                    <SelectTrigger>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {(
                                        Object.entries(FIELD_TYPE_LABEL) as Array<
                                          [
                                            TicketWorkflowInputField['type'],
                                            string,
                                          ]
                                        >
                                      ).map(([value, label]) => (
                                        <SelectItem key={value} value={value}>
                                          {label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </label>
                                <label className="flex items-center gap-2 text-xs">
                                  <input
                                    type="checkbox"
                                    checked={field.required}
                                    onChange={(event) =>
                                      updateInputField(index, fieldIndex, {
                                        required: event.target.checked,
                                      })
                                    }
                                  />
                                  必填
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="ml-auto"
                                    onClick={() =>
                                      removeInputField(index, fieldIndex)
                                    }
                                  >
                                    删除
                                  </Button>
                                </label>
                                <label className="flex flex-col gap-1 text-xs md:col-span-2">
                                  占位提示
                                  <Input
                                    value={field.placeholder ?? ''}
                                    onChange={(event) =>
                                      updateInputField(index, fieldIndex, {
                                        placeholder: event.target.value,
                                      })
                                    }
                                  />
                                </label>
                                <label className="flex flex-col gap-1 text-xs md:col-span-2">
                                  {isChoiceField(field.type)
                                    ? '选项（逗号分隔）'
                                    : isReferenceField(field.type)
                                      ? isBacklogField(field.type)
                                        ? '默认迭代项（可空）'
                                        : '默认迭代（可空）'
                                      : '默认值'}
                                  {isChoiceField(field.type) ? (
                                    <OptionsInput
                                      value={field.options ?? []}
                                      placeholder="如：选项A,选项B"
                                      onChange={(options) =>
                                        updateInputField(index, fieldIndex, {
                                          options,
                                        })
                                      }
                                    />
                                  ) : field.type === 'iteration' ? (
                                    <IterationPicker
                                      iterations={iterations}
                                      size="sm"
                                      value={
                                        field.defaultValue == null
                                          ? ''
                                          : String(field.defaultValue)
                                      }
                                      onChange={(next) =>
                                        updateInputField(index, fieldIndex, {
                                          defaultValue: next || null,
                                        })
                                      }
                                      placeholder="选择默认迭代（可空）"
                                    />
                                  ) : field.type === 'iteration_multi' ? (
                                    <IterationMultiPicker
                                      iterations={iterations}
                                      size="sm"
                                      value={
                                        field.defaultValue == null
                                          ? []
                                          : String(field.defaultValue)
                                              .split(',')
                                              .filter(Boolean)
                                      }
                                      onChange={(next) =>
                                        updateInputField(index, fieldIndex, {
                                          defaultValue: next.length
                                            ? next.join(',')
                                            : null,
                                        })
                                      }
                                      placeholder="选择默认迭代（可空）"
                                    />
                                  ) : field.type === 'backlog' ? (
                                    <BacklogPicker
                                      backlogs={backlogs}
                                      size="sm"
                                      value={
                                        field.defaultValue == null
                                          ? ''
                                          : String(field.defaultValue)
                                      }
                                      onChange={(next) =>
                                        updateInputField(index, fieldIndex, {
                                          defaultValue: next || null,
                                        })
                                      }
                                      placeholder="选择默认迭代项（可空）"
                                    />
                                  ) : field.type === 'backlog_multi' ? (
                                    <BacklogMultiPicker
                                      backlogs={backlogs}
                                      size="sm"
                                      value={
                                        field.defaultValue == null
                                          ? []
                                          : String(field.defaultValue)
                                              .split(',')
                                              .filter(Boolean)
                                      }
                                      onChange={(next) =>
                                        updateInputField(index, fieldIndex, {
                                          defaultValue: next.length
                                            ? next.join(',')
                                            : null,
                                        })
                                      }
                                      placeholder="选择默认迭代项（可空）"
                                    />
                                  ) : (
                                    <Input
                                      value={
                                        field.defaultValue == null
                                          ? ''
                                          : String(field.defaultValue)
                                      }
                                      onChange={(event) =>
                                        updateInputField(index, fieldIndex, {
                                          defaultValue: event.target.value,
                                        })
                                      }
                                    />
                                  )}
                                </label>
                              </div>
                            </div>
                          ))}
                          {(node.inputFields ?? []).length === 0 && (
                            <p className="text-xs text-foreground-muted">
                              暂无输入字段；工单发起表单将只使用流程说明
                            </p>
                          )}
                        </div>
                      </div>
                    )}

                    {node.kind === 'acceptance' && (
                      <div className="mt-4 flex items-center gap-2 rounded-[var(--radius-md)] bg-background-muted px-3 py-2 text-sm">
                        <Switch
                          size="sm"
                          checked={node.autoAccept}
                          onCheckedChange={(checked) =>
                            updateNode(index, { autoAccept: checked })
                          }
                        />
                        自动验收：前序节点成功到达后直接验收通过并完成工单
                      </div>
                    )}

                    <label className="mt-4 flex flex-col gap-1 text-sm">
                      节点说明
                      <Textarea
                        value={node.description ?? ''}
                        onChange={(event) =>
                          updateNode(index, { description: event.target.value })
                        }
                        placeholder="作为节点任务上下文下发"
                        rows={2}
                      />
                    </label>
                  </div>
                )
              })}
            </div>
          </Card>

          <Card>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div>
                <CardTitle>流转规则</CardTitle>
                <CardDescription>
                  起始节点与飞书群消息节点只能无条件流出；审批/操作/验收按结果流转；判断节点按条件分流，并保留一条默认分支
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={addEdge}>
                新增流转
              </Button>
            </CardHeader>
            <div className="flex flex-col gap-3 px-6 pb-6">
              {edges.map((edge, index) => {
                const source = nodes.find((node) => node.key === edge.from)
                const options = source ? outcomeOptions(source.kind) : []
                return (
                  <div
                    key={`${edge.from}-${edge.outcome ?? 'none'}-${index}`}
                    className={`grid items-end gap-2 rounded-[var(--radius-md)] border border-border-strong p-3 ${
                      source?.kind === 'condition'
                        ? 'md:grid-cols-[9rem_9rem_minmax(0,1fr)_10rem_auto]'
                        : 'md:grid-cols-[10rem_10rem_10rem_minmax(0,1fr)_auto]'
                    }`}
                  >
                    <label className="flex flex-col gap-1 text-xs">
                      来源
                      <Select
                        value={edge.from}
                        onValueChange={(value) => {
                          const nextSource = nodes.find(
                            (node) => node.key === value,
                          )
                          const nextIsCondition =
                            nextSource?.kind === 'condition'
                          const nextOptions = nextSource
                            ? outcomeOptions(nextSource.kind)
                            : []
                          const nextOutcome =
                            nextSource?.kind === 'start' || nextIsCondition
                              ? null
                              : (nextOptions[0] ?? null)
                          updateEdge(index, {
                            from: String(value),
                            outcome: nextOutcome,
                            conditions: nextIsCondition
                              ? (edge.conditions ?? null)
                              : null,
                            label: nextIsCondition
                              ? '默认分支'
                              : edgeLabel(nextOutcome),
                          })
                        }}
                        items={nodeItems}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {nodes.map((node) => (
                            <SelectItem key={node.key} value={node.key}>
                              {node.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      目标
                      <Select
                        value={edge.to}
                        onValueChange={(value) =>
                          updateEdge(index, { to: String(value) })
                        }
                        items={nodeItems}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {nodes.map((node) => (
                            <SelectItem key={node.key} value={node.key}>
                              {node.name}
                            </SelectItem>
                          ))}
                          <SelectItem value={WORKFLOW_END_NODE}>
                            流程结束
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </label>
                    {source?.kind === 'condition' ? (
                      <div className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-background-muted p-2">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="font-medium">
                            条件（全部满足时命中该分支）
                          </span>
                          <span className="flex items-center gap-1">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => addConditionRule(index)}
                              disabled={conditionFields.length === 0}
                            >
                              添加条件
                            </Button>
                            {(edge.conditions ?? []).length > 0 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  updateEdge(index, { conditions: null })
                                }
                              >
                                设为默认
                              </Button>
                            )}
                          </span>
                        </div>
                        {conditionFields.length === 0 ? (
                          <p className="text-xs text-foreground-muted">
                            请先在起始节点配置可用于判断的输入字段（文件字段不支持判断）
                          </p>
                        ) : (edge.conditions ?? []).length === 0 ? (
                          <p className="text-xs text-foreground-muted">
                            默认分支：所有条件都不满足时走这里
                          </p>
                        ) : (
                          (edge.conditions ?? []).map((rule, ruleIndex) => {
                            const field = conditionFields.find(
                              (item) => item.key === rule.field,
                            )
                            const operators = field
                              ? conditionOperatorsForType(field.type)
                              : []
                            return (
                              <div
                                key={ruleIndex}
                                className="grid items-end gap-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1fr)_auto]"
                              >
                                <Select
                                  value={rule.field}
                                  onValueChange={(value) => {
                                    const nextField = conditionFields.find(
                                      (item) => item.key === value,
                                    )
                                    const nextOperators = nextField
                                      ? conditionOperatorsForType(nextField.type)
                                      : []
                                    updateConditionRule(index, ruleIndex, {
                                      field: String(value),
                                      operator: nextOperators[0] ?? 'eq',
                                      value:
                                        nextField && isChoiceField(nextField.type)
                                          ? (nextField.options?.[0] ?? '')
                                          : '',
                                    })
                                  }}
                                  items={Object.fromEntries(
                                    conditionFields.map((item) => [
                                      item.key,
                                      item.label,
                                    ]),
                                  )}
                                >
                                  <SelectTrigger>
                                    <SelectValue placeholder="选择字段" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {conditionFields.map((item) => (
                                      <SelectItem key={item.key} value={item.key}>
                                        {item.label}（{item.key}）
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <Select
                                  value={rule.operator}
                                  onValueChange={(value) => {
                                    const operator =
                                      value as WorkflowConditionOperator
                                    updateConditionRule(index, ruleIndex, {
                                      operator,
                                      value: conditionNeedsValue(operator)
                                        ? (rule.value ?? '')
                                        : null,
                                    })
                                  }}
                                  items={Object.fromEntries(
                                    operators.map((operator) => [
                                      operator,
                                      CONDITION_OPERATOR_LABEL[operator],
                                    ]),
                                  )}
                                >
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {operators.map((operator) => (
                                      <SelectItem
                                        key={operator}
                                        value={operator}
                                      >
                                        {CONDITION_OPERATOR_LABEL[operator]}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                {conditionNeedsValue(rule.operator) ? (
                                  field && isIterationField(field.type) ? (
                                    <IterationPicker
                                      iterations={iterations}
                                      size="sm"
                                      value={rule.value ?? ''}
                                      onChange={(next) =>
                                        updateConditionRule(index, ruleIndex, {
                                          value: next || null,
                                        })
                                      }
                                      placeholder="选择迭代"
                                      clearable={false}
                                    />
                                  ) : field && isBacklogField(field.type) ? (
                                    <BacklogPicker
                                      backlogs={backlogs}
                                      size="sm"
                                      value={rule.value ?? ''}
                                      onChange={(next) =>
                                        updateConditionRule(index, ruleIndex, {
                                          value: next || null,
                                        })
                                      }
                                      placeholder="选择迭代项"
                                      clearable={false}
                                    />
                                  ) : field && isChoiceField(field.type) ? (
                                    <Select
                                      value={rule.value ?? ''}
                                      onValueChange={(value) =>
                                        updateConditionRule(index, ruleIndex, {
                                          value: String(value),
                                        })
                                      }
                                      items={Object.fromEntries(
                                        (field.options ?? []).map((option) => [
                                          option,
                                          option,
                                        ]),
                                      )}
                                    >
                                      <SelectTrigger>
                                        <SelectValue placeholder="选择比较值" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {(field.options ?? []).map((option) => (
                                          <SelectItem key={option} value={option}>
                                            {option}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  ) : (
                                    <Input
                                      type={
                                        field?.type === 'number'
                                          ? 'number'
                                          : field?.type === 'date'
                                            ? 'date'
                                            : 'text'
                                      }
                                      value={rule.value ?? ''}
                                      placeholder="比较值"
                                      onChange={(event) =>
                                        updateConditionRule(index, ruleIndex, {
                                          value: event.target.value,
                                        })
                                      }
                                    />
                                  )
                                ) : (
                                  <div className="flex h-9 items-center text-xs text-foreground-muted">
                                    无需比较值
                                  </div>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    removeConditionRule(index, ruleIndex)
                                  }
                                >
                                  删除
                                </Button>
                              </div>
                            )
                          })
                        )}
                      </div>
                    ) : source?.kind === 'start' || source?.kind === 'feishu-message' ? (
                      <label className="flex flex-col gap-1 text-xs">
                        结果
                        <div className="flex h-9 items-center rounded-[var(--radius-md)] border border-border-strong bg-background-muted px-3">
                          无条件
                        </div>
                      </label>
                    ) : (
                      <label className="flex flex-col gap-1 text-xs">
                        结果
                        <Select
                          value={edge.outcome ?? NO_SELECTION}
                          onValueChange={(value) => {
                            const outcome =
                              value === NO_SELECTION
                                ? null
                                : (value as WorkflowOutcome)
                            updateEdge(index, {
                              outcome,
                              label: edgeLabel(outcome),
                            })
                          }}
                          items={{
                            [NO_SELECTION]: '无条件流转',
                            ...Object.fromEntries(
                              options.map((item) => [item, OUTCOME_LABEL[item]]),
                            ),
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NO_SELECTION}>
                              无条件流转
                            </SelectItem>
                            {options.map((item) => (
                              <SelectItem key={item} value={item}>
                                {OUTCOME_LABEL[item]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </label>
                    )}
                    <label className="flex flex-col gap-1 text-xs">
                      展示文案
                      <Input
                        value={edge.label ?? ''}
                        onChange={(event) =>
                          updateEdge(index, { label: event.target.value })
                        }
                      />
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setEdges(edges.filter((_, i) => i !== index))
                      }
                    >
                      删除
                    </Button>
                  </div>
                )
              })}
              {edges.length === 0 && (
                <div className="rounded-[var(--radius-md)] border border-dashed border-border-strong px-4 py-8 text-center text-sm text-foreground-muted">
                  暂无流转规则
                </div>
              )}
            </div>
          </Card>
        </div>

        <Card className="h-fit xl:sticky xl:top-4">
          <CardHeader>
            <CardTitle>实时流程图</CardTitle>
            <CardDescription>根据当前节点与流转规则即时生成</CardDescription>
          </CardHeader>
          <div className="overflow-auto px-4 pb-4">
            <MermaidDiagram code={flowchart} />
          </div>
          <div className="border-t border-border-strong px-4 py-3 text-xs text-foreground-muted">
            <p>最近草稿保存：{formatTime(detail.draftUpdatedAt)}</p>
            <p className="mt-1">
              最近发布：{formatTime(detail.latestPublishedAt)}
            </p>
          </div>
        </Card>
      </div>
    </div>
  )
}
