import { useCallback, useEffect, useState } from 'react'
import { Button } from '@appica/ui-react/button'
import { Input } from '@appica/ui-react/input'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@appica/ui-react/select'
import {
  api,
  TOPIC_SUBJECT_TYPES,
  type Topic,
  type TopicSubjectType,
  type Worker,
} from '../lib/api'
import { TopicList } from '../components/topics/TopicList'

/** 全局话题列表：按主体/关键词筛选，支持「我关注的」 */
export function TopicsPage() {
  const [topics, setTopics] = useState<Topic[] | null>(null)
  const [keyword, setKeyword] = useState('')
  const [search, setSearch] = useState('')
  const [subjectType, setSubjectType] = useState<'all' | TopicSubjectType>('all')
  const [following, setFollowing] = useState(false)
  const [workers, setWorkers] = useState<Worker[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

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
    const timer = setTimeout(() => setSearch(keyword.trim()), 300)
    return () => clearTimeout(timer)
  }, [keyword])

  useEffect(() => {
    let cancelled = false
    api
      .listTopics({
        subjectType: subjectType === 'all' ? undefined : subjectType,
        q: search || undefined,
        following: following || undefined,
      })
      .then((rows) => {
        if (cancelled) return
        setTopics(rows)
        setError(null)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [subjectType, search, following, refresh])

  const reload = useCallback(() => setRefresh((value) => value + 1), [])

  const subjectItems = Object.fromEntries(
    ['all', ...TOPIC_SUBJECT_TYPES].map((item) => [
      item,
      item === 'all' ? '不限主体' : item,
    ]),
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">话题</h1>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant={following ? 'outline' : 'ghost'}
            size="sm"
            onClick={() => setFollowing((value) => !value)}
          >
            {following ? '仅看我关注的' : '我关注的'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            刷新
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="w-56"
          value={keyword}
          placeholder="搜索标题/创建人/主体（支持拼音）"
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Select
          value={subjectType}
          onValueChange={(value) =>
            setSubjectType(value as 'all' | TopicSubjectType)
          }
          items={subjectItems}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {['all', ...TOPIC_SUBJECT_TYPES].map((item) => (
              <SelectItem key={item} value={item}>
                {subjectItems[item]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error && <p className="text-sm text-error">{error}</p>}
      <div className="rounded-md border border-border">
        <TopicList
          topics={topics ?? []}
          workers={workers}
          showSubject
          loading={topics === null}
          emptyText="暂无话题"
          onChanged={reload}
        />
      </div>
    </div>
  )
}