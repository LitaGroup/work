import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, ExternalLink } from '@appica/icons-react'
import { Badge } from '@appica/ui-react/badge'
import {
  api,
  type BacklogSummary,
  type Project,
  type ProjectTicketSummary,
  type TaskPackage,
} from '../../lib/api'
import { TicketStatusBadge } from '../StatusBadge'
import { ChatMarkdown } from '../ChatMarkdown'

/** 从任务现有 Markdown 字段中提取可直接访问的链接（Markdown 链接 + 裸 URL）。 */
function extractRequirementLinks(fields: Array<string | null | undefined>) {
  const links = new Map<string, string>()
  const markdownLink = /(!?)\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)/g
  const bareUrl = /https?:\/\/[^\s<>()[\]"']+/g

  for (const field of fields) {
    if (!field?.trim()) continue

    for (const match of field.matchAll(markdownLink)) {
      // 图片不是需求资料链接，跳过 `![alt](url)`
      if (match[1]) continue
      const url = normalizeUrl(match[3])
      if (!url) continue
      links.set(url, match[2].trim() || url)
    }

    for (const match of field.matchAll(bareUrl)) {
      const url = normalizeUrl(match[0])
      if (!url || links.has(url)) continue
      links.set(url, url)
    }
  }

  return Array.from(links, ([url, label]) => ({ url, label }))
}

function normalizeUrl(value: string) {
  const trimmed = value.trim().replace(/[.,;:!?，。；：！？]+$/, '')
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : null
  } catch {
    return null
  }
}

function nonEmpty(...values: Array<string | null | undefined>) {
  return values.find((value) => Boolean(value?.trim())) ?? null
}

function formatDateTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : null
}

/**
 * 任务详情「需求」Tab：把任务现有字段整理为只读需求视图。
 * 不新增持久化字段，链接从已有 Markdown 中提取；任务关联需求时附需求/迭代项/工单跳转。
 */
export function TaskRequirementPanel({
  task,
  fallbackProjectId = null,
}: {
  task: TaskPackage
  /** 根任务所属需求（子任务自身 projectId 为空时兜底） */
  fallbackProjectId?: number | null
}) {
  const originalRequirement = nonEmpty(task.input, task.description)
  const organizedRequirement = nonEmpty(task.content)
  const links = extractRequirementLinks([
    task.input,
    task.description,
    task.content,
  ])
  const projectId = task.projectId ?? fallbackProjectId ?? null

  /** 关联数据与请求的 projectId 绑定，切换需求时自然回到加载态，避免旧数据串场 */
  const [related, setRelated] = useState<{
    projectId: number
    project: Project | null
    backlogs: BacklogSummary[]
    tickets: ProjectTicketSummary[]
  } | null>(null)

  useEffect(() => {
    if (projectId === null) return
    let cancelled = false
    const requestedFor = projectId
    Promise.allSettled([
      api.getProject(projectId),
      api.listBacklogs({ projectId, includeCanceled: true }),
      api.listProjectTickets(projectId),
    ]).then(([projectResult, backlogResult, ticketResult]) => {
      if (cancelled) return
      setRelated({
        projectId: requestedFor,
        project:
          projectResult.status === 'fulfilled' ? projectResult.value : null,
        backlogs:
          backlogResult.status === 'fulfilled' ? backlogResult.value : [],
        tickets: ticketResult.status === 'fulfilled' ? ticketResult.value : [],
      })
    })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const relatedData = related?.projectId === projectId ? related : null
  const project = relatedData?.project ?? null
  const backlogs = relatedData?.backlogs ?? null
  const tickets = relatedData?.tickets ?? null

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground-intense">
            任务需求
          </h2>
          <p className="mt-1 break-words text-xs text-foreground-muted">
            {task.title}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={originalRequirement ? 'soft' : 'outline'} size="sm">
            原始需求
          </Badge>
          <Badge variant={organizedRequirement ? 'success' : 'outline'} size="sm">
            {organizedRequirement ? '已整理' : '待整理'}
          </Badge>
          <Badge variant="secondary" size="sm">
            {links.length} 个链接
          </Badge>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 p-4">
          <dl className="grid gap-x-5 gap-y-3 rounded-[var(--radius-md)] bg-background-muted px-3 py-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
            <RequirementMeta label="任务编号" value={task.code} mono />
            <RequirementMeta
              label="任务定义"
              value={task.templateName ?? '未设置'}
            />
            <RequirementMeta
              label="创建时间"
              value={formatDateTime(task.createdAt) ?? '—'}
            />
          </dl>

          {projectId !== null && (
            <RelatedRequirementLinks
              projectId={projectId}
              project={project}
              backlogs={backlogs}
              tickets={tickets}
            />
          )}

          <RequirementSection
            title="原始需求"
            emptyText="暂未记录原始需求"
            value={originalRequirement}
          />

          {links.length > 0 && (
            <section>
              <SectionTitle title="相关链接" count={links.length} />
              <ul className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-border p-2">
                {links.map((link) => (
                  <li key={link.url}>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-w-0 items-start gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 no-underline transition-colors hover:bg-background-muted"
                    >
                      <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-foreground-subtle" />
                      <span className="min-w-0">
                        <span className="block break-words text-sm text-foreground-intense underline decoration-border-strong underline-offset-2">
                          {link.label}
                        </span>
                        {link.label !== link.url && (
                          <span className="mt-0.5 block break-all font-mono text-[11px] text-foreground-subtle">
                            {link.url}
                          </span>
                        )}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <RequirementSection
            title="整理后的需求"
            emptyText="暂未生成整理后的需求，可由执行机器人或 AI 补充"
            value={organizedRequirement}
            emphasized
          />
        </div>
      </div>
    </section>
  )
}

/** 任务所属需求的快速跳转：需求本体 + 未取消迭代项 + 需求相关工单 */
function RelatedRequirementLinks({
  projectId,
  project,
  backlogs,
  tickets,
}: {
  projectId: number
  project: Project | null
  backlogs: BacklogSummary[] | null
  tickets: ProjectTicketSummary[] | null
}) {
  const activeBacklogs = (backlogs ?? []).filter(
    (backlog) => backlog.status !== '取消',
  )

  return (
    <section>
      <SectionTitle title="关联需求" />
      <div className="flex flex-col rounded-[var(--radius-md)] border border-border">
        <Link
          to={`/requirements/${projectId}`}
          className="flex min-w-0 items-center justify-between gap-2 rounded-t-[var(--radius-md)] px-3 py-2 no-underline transition-colors hover:bg-background-muted"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Badge variant="outline" size="sm">
              需求
            </Badge>
            <span className="truncate text-sm text-foreground-intense underline decoration-border-strong underline-offset-2">
              {project ? project.name : `#${projectId}`}
            </span>
          </span>
          <ChevronRight className="size-3.5 shrink-0 text-foreground-subtle" />
        </Link>

        <div className="border-t border-border px-2 py-2">
          <GroupTitle
            label="迭代项"
            count={backlogs === null ? undefined : activeBacklogs.length}
          />
          {backlogs === null ? (
            <p className="px-1 text-xs text-foreground-subtle">加载中…</p>
          ) : activeBacklogs.length === 0 ? (
            <p className="px-1 text-xs text-foreground-subtle">暂无迭代项</p>
          ) : (
            <ul className="flex flex-col">
              {activeBacklogs.map((backlog) => (
                <li key={backlog.id}>
                  <Link
                    to={`/backlogs/${backlog.id}`}
                    className="flex min-w-0 items-center justify-between gap-2 rounded-[var(--radius-sm)] px-1 py-1 no-underline transition-colors hover:bg-background-muted"
                  >
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 font-mono text-[11px] text-foreground-subtle">
                        {backlog.iteration?.code ?? `#${backlog.id}`}
                      </span>
                      <span className="truncate text-sm text-foreground-emphasis underline decoration-border underline-offset-2 hover:decoration-border-strong">
                        {backlog.title}
                      </span>
                    </span>
                    <ChevronRight className="size-3.5 shrink-0 text-foreground-subtle" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-border px-2 py-2">
          <GroupTitle
            label="工单"
            count={tickets === null ? undefined : tickets.length}
          />
          {tickets === null ? (
            <p className="px-1 text-xs text-foreground-subtle">加载中…</p>
          ) : tickets.length === 0 ? (
            <p className="px-1 text-xs text-foreground-subtle">暂无关联工单</p>
          ) : (
            <ul className="flex flex-col">
              {tickets.map((ticket) => (
                <li key={ticket.id}>
                  <Link
                    to={`/tickets/${ticket.id}`}
                    className="flex min-w-0 items-center justify-between gap-2 rounded-[var(--radius-sm)] px-1 py-1 no-underline transition-colors hover:bg-background-muted"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 font-mono text-[11px] text-foreground-subtle">
                        {ticket.code}
                      </span>
                      <span className="truncate text-sm text-foreground-emphasis underline decoration-border underline-offset-2 hover:decoration-border-strong">
                        {ticket.title}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <TicketStatusBadge
                        status={ticket.workflowStatus ?? '处理中'}
                      />
                      <ChevronRight className="size-3.5 text-foreground-subtle" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}

function GroupTitle({ label, count }: { label: string; count?: number }) {
  return (
    <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] text-foreground-subtle">
      <span>{label}</span>
      {typeof count === 'number' && <span>({count})</span>}
    </div>
  )
}

function RequirementMeta({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <dt className="text-foreground-subtle">{label}</dt>
      <dd
        className={`mt-0.5 break-words text-foreground-emphasis ${mono ? 'font-mono text-[11px]' : ''}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  )
}

function SectionTitle({ title, count }: { title: string; count?: number }) {
  return (
    <h3 className="mb-1 flex items-center gap-2 text-xs font-medium text-foreground-muted">
      <span>{title}</span>
      {typeof count === 'number' && (
        <span className="text-foreground-subtle">({count})</span>
      )}
    </h3>
  )
}

function RequirementSection({
  title,
  value,
  emptyText,
  emphasized = false,
}: {
  title: string
  value: string | null
  emptyText: string
  emphasized?: boolean
}) {
  return (
    <section className="min-w-0">
      <SectionTitle title={title} />
      <div
        className={`rounded-none px-3 py-2.5 text-sm text-foreground-emphasis ${
          emphasized
            ? 'border border-border bg-background'
            : 'bg-background-muted'
        }`}
      >
        {value ? (
          <ChatMarkdown text={value} />
        ) : (
          <span className="text-xs text-foreground-subtle">{emptyText}</span>
        )}
      </div>
    </section>
  )
}
