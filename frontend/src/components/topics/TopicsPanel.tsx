import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@appica/ui-react/card'
import {
  api,
  TOPIC_TAB_LABELS,
  type Topic,
  type TopicSubjectType,
  type Worker,
} from '../../lib/api'
import { TopicCreateDialog } from './TopicCreateDialog'
import { TopicList } from './TopicList'

interface TopicsPanelProps {
  subjectType: TopicSubjectType
  subjectId: number
  subjectTitle: string
  /** 话题数量变化回调（供页签等外部展示计数） */
  onCountChange?: (count: number) => void
  /** 焦点话题（话题详情深链）：自动展开并滚动定位 */
  focusTopicId?: number
}

/** 主体详情页的「话题」分区：卡片 + 折叠话题列表，与信息/文档等分区样式一致 */
export function TopicsPanel({
  subjectType,
  subjectId,
  subjectTitle,
  onCountChange,
  focusTopicId,
}: TopicsPanelProps) {
  const label = TOPIC_TAB_LABELS[subjectType]
  const [topics, setTopics] = useState<Topic[] | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [workers, setWorkers] = useState<Worker[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const countRef = useRef(onCountChange)
  useEffect(() => {
    countRef.current = onCountChange
  }, [onCountChange])

  useEffect(() => {
    let cancelled = false
    api
      .listWorkers()
      .then((rows) => {
        if (cancelled) return
        setWorkers(
          rows.filter((worker) => worker.enabled && !worker.personalAgentUserId),
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    api
      .listTopics({
        subjectType,
        subjectId,
      })
      .then((rows) => {
        if (cancelled) return
        setTopics(rows)
        countRef.current?.(rows.length)
        setError(null)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [subjectType, subjectId, refresh])

  const reload = useCallback(() => setRefresh((value) => value + 1), [])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            {label}
            <Badge variant="soft">{topics?.length ?? 0}</Badge>
          </span>
          <span className="flex items-center gap-2 text-sm font-normal">
            <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
              新建{label}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={reload}>
              刷新
            </Button>
          </span>
        </CardTitle>
        <CardDescription>
          主体下的讨论串：帖子支持引用回复与 @ 机器人，关注后新帖经平台官方机器人飞书通知
        </CardDescription>
      </CardHeader>
      <div className="flex flex-col gap-4 px-4 pb-4 group-data-inset/card:px-4">
        {error && <p className="text-sm text-error">{error}</p>}
        <TopicList
          topics={topics ?? []}
          workers={workers}
          loading={topics === null}
          emptyText={`暂无${label}，点击「新建${label}」发起讨论`}
          onChanged={reload}
          focusId={focusTopicId}
        />
      </div>
      <TopicCreateDialog
        subjectType={subjectType}
        subjectId={subjectId}
        subjectTitle={subjectTitle}
        label={label}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => reload()}
        workers={workers}
      />
    </Card>
  )
}