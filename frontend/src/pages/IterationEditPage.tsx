import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button, buttonVariants } from '@appica/ui-react/button'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@appica/ui-react/card'
import { Input } from '@appica/ui-react/input'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@appica/ui-react/select'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
  PopoverDescription,
} from '@appica/ui-react/popover'
import {
  api,
  type IterationSummary,
  type IterationType,
  type Project,
  type Worker,
} from '../lib/api'
import { PageBreadcrumb } from '../components/PageBreadcrumb'
import { BacklogSelection } from '../components/BacklogSelection'
import { useAuth } from '../context/AuthContext'

/** 成功反馈停留时长 */
const SUCCESS_STAY_MS = 2_000
/** 失败反馈停留时长 */
const FAILURE_STAY_MS = 5_000

/** 一天毫秒数（日期运算统一走 UTC 日差） */
const DAY_MS = 24 * 60 * 60 * 1000

/** 可创建的类型：T0 为平台常驻单例，不可创建 */
type CreateIterationType = Exclude<IterationType, 'T0'>

type ActionFeedback =
  | { kind: 'success'; message: string }
  | { kind: 'failure'; message: string }
  | null

function parseDateUtc(value: string): number {
  const [year, month, day] = value.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

function formatDateUtc(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** 浏览器本地今天 YYYY-MM-DD */
function todayString(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** T7 每周通道标识（与后端一致）：含 1 月 1 日的那周为第 1 周（周一起始） */
function iterationWeekCode(startAt: string): string {
  const year = Number(startAt.slice(0, 4))
  const jan1 = Date.UTC(year, 0, 1)
  const jan1Weekday = new Date(jan1).getUTCDay()
  const week1Monday = jan1 - ((jan1Weekday + 6) % 7) * DAY_MS
  const week = Math.floor((parseDateUtc(startAt) - week1Monday) / DAY_MS / 7) + 1
  return `${year}W${String(week).padStart(2, '0')}`
}

/** Tx 特殊通道标识：{yyyy}Tx{nn}，nn 为当年内递增序号 */
function nextTxCode(iterations: IterationSummary[], startAt: string): string {
  const year = startAt.slice(0, 4)
  let max = 0
  for (const iteration of iterations) {
    if (iteration.type !== 'Tx') continue
    const match = /^(\d{4})Tx(\d+)$/.exec(iteration.code)
    if (match && match[1] === year) max = Math.max(max, Number(match[2]))
  }
  return `${year}Tx${String(max + 1).padStart(2, '0')}`
}

/**
 * 默认起止：取现有 T7 最晚结束日 +1 天为开始（周二），结束为开始 +6 天（下周一）；
 * 没有 T7 时取最近的周二（今天是周二则取今天）。
 */
function defaultRange(iterations: IterationSummary[]): {
  startAt: string
  endAt: string
} {
  const latestEnd = iterations
    .filter((iteration) => iteration.type === 'T7' && iteration.endAt)
    .map((iteration) => iteration.endAt as string)
    .sort()
    .at(-1)
  let startMs: number
  if (latestEnd) {
    startMs = parseDateUtc(latestEnd) + DAY_MS
  } else {
    const todayMs = parseDateUtc(todayString())
    const weekday = new Date(todayMs).getUTCDay()
    const offset = (2 - weekday + 7) % 7
    startMs = todayMs + offset * DAY_MS
  }
  return {
    startAt: formatDateUtc(startMs),
    endAt: formatDateUtc(startMs + 6 * DAY_MS),
  }
}

/**
 * 新建迭代：选择类型（T7 每周通道 / Tx 特殊通道）、起止日期，
 * 标识由后端按开始日期自动生成；可从需求池勾选需求并逐条指定负责人，
 * 也可以先不添加需求直接创建。
 */
export function IterationEditPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === '管理员'

  const [iterations, setIterations] = useState<IterationSummary[] | null>(null)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [workers, setWorkers] = useState<Worker[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [type, setType] = useState<CreateIterationType>('T7')
  const [startAt, setStartAt] = useState('')
  const [endAt, setEndAt] = useState('')
  const [drafts, setDrafts] = useState<Map<number, number | null>>(new Map())
  const [pending, setPending] = useState(false)
  const [createdId, setCreatedId] = useState<number | null>(null)
  const [feedback, setFeedback] = useState<ActionFeedback>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.listIterations(),
      api.listProjects(),
      api.listWorkers({ role: '工作者' }),
    ])
      .then(([iterationRows, projectRows, workerRows]) => {
        if (cancelled) return
        setIterations(iterationRows)
        setProjects(projectRows)
        setWorkers(
          workerRows.filter(
            (worker) =>
              worker.enabled && !worker.personalAgentUserId,
          ),
        )
        const range = defaultRange(iterationRows)
        setStartAt((prev) => prev || range.startAt)
        setEndAt((prev) => prev || range.endAt)
        setLoadError(null)
      })
      .catch((e: Error) => {
        if (!cancelled) setLoadError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }
  useEffect(() => clearTimer, [])

  const showFeedback = (
    next: NonNullable<ActionFeedback>,
    stayMs: number,
    after?: () => void,
  ) => {
    clearTimer()
    setFeedback(next)
    timerRef.current = setTimeout(() => {
      setFeedback(null)
      after?.()
    }, stayMs)
  }

  const selectedItems = useMemo(
    () =>
      [...drafts.entries()].map(([projectId, ownerWorkerId]) => ({
        projectId,
        ownerWorkerId,
      })),
    [drafts],
  )

  /** 标识预览：T7 由开始日期所在周生成，Tx 为当年下一个递增序号 */
  const previewCode = useMemo(() => {
    if (!startAt) return ''
    return type === 'T7'
      ? iterationWeekCode(startAt)
      : nextTxCode(iterations ?? [], startAt)
  }, [type, startAt, iterations])

  /** 该周是否已有 T7 迭代（同周追加须改用 Tx） */
  const weekTakenByCode = useMemo(() => {
    if (type !== 'T7' || !previewCode) return null
    return (
      (iterations ?? []).find(
        (iteration) =>
          iteration.type === 'T7' && iteration.code === previewCode,
      )?.code ?? null
    )
  }, [type, previewCode, iterations])

  if (!isAdmin) {
    return (
      <div>
        <PageBreadcrumb
          items={[{ label: '迭代', to: '/iterations' }, { label: '新建迭代' }]}
        />
        <p className="mt-4 text-sm">仅管理员可创建迭代。</p>
        <Link to="/iterations" className="mt-2 inline-block text-sm underline">
          返回迭代列表
        </Link>
      </div>
    )
  }

  const submit = () => {
    if (pending) return
    if (!startAt || !endAt) {
      showFeedback({ kind: 'failure', message: '请填写开始日期与结束日期' }, FAILURE_STAY_MS)
      return
    }
    if (startAt > endAt) {
      showFeedback({ kind: 'failure', message: '开始日期不能晚于结束日期' }, FAILURE_STAY_MS)
      return
    }
    if (weekTakenByCode) {
      showFeedback(
        {
          kind: 'failure',
          message: `该周已有 T7 迭代 ${weekTakenByCode}，同周追加请改用 Tx 特殊通道`,
        },
        FAILURE_STAY_MS,
      )
      return
    }

    setPending(true)
    api
      .createIteration({ type, startAt, endAt })
      .then((iteration) =>
        selectedItems.length === 0
          ? iteration
          : api
              .createBacklogs(iteration.id, selectedItems)
              .then(() => iteration)
              .catch((error: Error) => {
                setCreatedId(iteration.id)
                throw error
              }),
      )
      .then((iteration) => {
        showFeedback(
          { kind: 'success', message: '迭代已创建' },
          SUCCESS_STAY_MS,
          () => navigate(`/iterations/${iteration.id}`, { replace: true }),
        )
      })
      .catch((e: Error) => {
        showFeedback(
          { kind: 'failure', message: e.message || '创建失败，请稍后重试' },
          FAILURE_STAY_MS,
        )
      })
      .finally(() => setPending(false))
  }

  const typeItems: Record<string, string> = {
    T7: 'T7 每周通道（默认）',
    Tx: 'Tx 特殊通道',
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageBreadcrumb
            items={[{ label: '迭代', to: '/iterations' }, { label: '新建迭代' }]}
          />
          <h1 className="mt-2 text-2xl font-semibold">新建迭代</h1>
          <p className="mt-1 text-sm text-foreground-muted">
            唯一标识按开始日期自动生成；可先创建空迭代，之后再从迭代详情添加需求
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/iterations"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            取消
          </Link>
          <Popover
            open={feedback !== null}
            onOpenChange={(open) => {
              if (!open && feedback?.kind === 'failure') {
                clearTimer()
                setFeedback(null)
              }
            }}
          >
            <PopoverTrigger
              render={
                <Button
                  size="sm"
                  onClick={submit}
                  disabled={pending || feedback?.kind === 'success'}
                >
                  {pending ? '创建中…' : '创建迭代'}
                </Button>
              }
            />
            <PopoverContent side="top" align="center">
              {feedback?.kind === 'success' && (
                <>
                  <PopoverTitle>成功</PopoverTitle>
                  <PopoverDescription>{feedback.message}</PopoverDescription>
                </>
              )}
              {feedback?.kind === 'failure' && (
                <>
                  <PopoverTitle>失败</PopoverTitle>
                  <PopoverDescription>{feedback.message}</PopoverDescription>
                </>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {createdId !== null && (
        <p className="mb-4 text-sm">
          迭代已创建但迭代项转入失败，可前往{' '}
          <Link to={`/iterations/${createdId}`} className="underline">
            迭代详情
          </Link>{' '}
          继续添加需求。
        </p>
      )}
      {loadError && <p className="mb-4 text-sm">加载失败:{loadError}</p>}

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>迭代信息</CardTitle>
            <CardDescription>
              每周通道同一周只允许一个，标识为「年 + W + 周数」；特殊通道标识为「年 + Tx + 递增序号」。
              T0 快速通道为平台常驻单例，无需创建
            </CardDescription>
          </CardHeader>
          <div className="grid grid-cols-1 gap-4 px-4 pb-4 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              迭代类型
              <Select
                value={type}
                onValueChange={(v) => setType(v as CreateIterationType)}
                items={typeItems}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择迭代类型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="T7">T7 每周通道（默认）</SelectItem>
                  <SelectItem value="Tx">Tx 特殊通道</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              唯一标识（自动生成）
              <Input value={previewCode} readOnly placeholder="填写开始日期后自动生成" />
            </label>
            {weekTakenByCode && (
              <p className="text-sm md:col-span-2">
                该周已有 T7 迭代 {weekTakenByCode}，同周追加请改用 Tx 特殊通道
              </p>
            )}
            <label className="flex flex-col gap-1 text-sm">
              开始日期
              <Input
                type="date"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              结束日期
              <Input
                type="date"
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
              />
            </label>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>选择需求（可选）</CardTitle>
            <CardDescription>
              可先跳过，创建后在迭代详情页「添加需求」；已进入迭代的需求不再出现，支持按类型与计划周(w)筛选，
              负责人可暂不指定（指定后自动创建交付任务）
            </CardDescription>
          </CardHeader>
          <div className="px-4 pb-4">
            {projects && workers ? (
              <BacklogSelection
                projects={projects}
                workers={workers}
                drafts={drafts}
                onChange={setDrafts}
              />
            ) : (
              !loadError && <p className="text-sm text-foreground-muted">加载中…</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}