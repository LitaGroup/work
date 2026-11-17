import { useEffect, useRef, useState } from 'react'
import { Badge } from '@appica/ui-react/badge'
import { Button } from '@appica/ui-react/button'
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from '@appica/ui-react/alert-dialog'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@appica/ui-react/collapsible'
import { ChevronDown, ChevronRight } from '@appica/icons-react'
import {
  api,
  type Topic,
  type TopicPost,
  type Worker,
} from '../../lib/api'
import { useAuth } from '../../context/AuthContext'
import { TopicPriorityBadge, TopicStatusBadge } from '../StatusBadge'
import { MarkdownViewer } from '../MarkdownViewer'
import { TopicActions } from './TopicActions'
import { TopicReplyForm } from './TopicReplyForm'

interface TopicListProps {
  topics: Topic[]
  /** 可 @ 的机器人（回复框使用） */
  workers: Worker[]
  /** 全局列表展示主体（类型·标题） */
  showSubject?: boolean
  loading?: boolean
  emptyText?: string
  /** 话题/帖子变更后通知父级刷新列表 */
  onChanged?: () => void
  /** 焦点话题（话题详情深链）：自动展开并滚动定位 */
  focusId?: number
}

/**
 * 话题列表（折叠式）：每行展示「优先级 + 标题 + 作者」，
 * 展开后展示首楼、缩进的帖子列表与行内回复框；不提供独立话题详情页。
 */
export function TopicList({
  topics,
  workers,
  showSubject = false,
  loading = false,
  emptyText = '暂无话题',
  onChanged,
  focusId,
}: TopicListProps) {
  // 同一时间只展开一个话题（深链进入时默认展开焦点话题）
  const [openId, setOpenId] = useState<number | null>(focusId ?? null)
  // 已定位过的焦点话题：列表刷新（发帖/改状态）时不再重复滚动
  const scrolledRef = useRef<number | null>(null)

  // 话题异步加载完成后展开并滚动到焦点话题（旧链接跳转时 id 可能先到）
  useEffect(() => {
    if (focusId == null) return
    if (!topics.some((topic) => topic.id === focusId)) return
    setOpenId(focusId)
    if (scrolledRef.current === focusId) return
    scrolledRef.current = focusId
    document
      .getElementById(`topic-${focusId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [focusId, topics])

  if (loading) {
    return (
      <p className="px-4 py-6 text-center text-sm text-foreground-muted">
        加载中…
      </p>
    )
  }
  if (topics.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-foreground-muted">
        {emptyText}
      </p>
    )
  }
  return (
    <div>
      {topics.map((topic) => (
        <div
          key={topic.id}
          id={`topic-${topic.id}`}
          className={`scroll-mt-24 ${
            focusId === topic.id ? 'bg-background-muted' : ''
          }`}
        >
          <TopicListItem
            topic={topic}
            workers={workers}
            showSubject={showSubject}
            open={openId === topic.id}
            onOpenChange={(next) => setOpenId(next ? topic.id : null)}
            onChanged={onChanged}
          />
        </div>
      ))}
    </div>
  )
}

function TopicListItem({
  topic,
  workers,
  showSubject,
  open,
  onOpenChange,
  onChanged,
}: {
  topic: Topic
  workers: Worker[]
  showSubject: boolean
  /** 是否展开（由列表统一控制，同一时间只展开一个） */
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged?: () => void
}) {
  const { user } = useAuth()
  const isAdmin = user?.role === '管理员'
  const [posts, setPosts] = useState<TopicPost[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [quote, setQuote] = useState<TopicPost | null>(null)

  const loadPosts = (force = false) => {
    if (loading) return
    if (posts !== null && !force) return
    setLoading(true)
    setError(null)
    api
      .listTopicPosts(topic.id)
      .then(setPosts)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }

  const removePost = async (postId: number) => {
    try {
      await api.deleteTopicPost(topic.id, postId)
      loadPosts(true)
      onChanged?.()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (next) loadPosts()
      }}
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-left">
        <ChevronRight className="size-4 shrink-0 group-data-[panel-open]:hidden" />
        <ChevronDown className="hidden size-4 shrink-0 group-data-[panel-open]:block" />
        <TopicPriorityBadge priority={topic.priority} />
        <span className="min-w-0 truncate font-medium">{topic.title}</span>
        {showSubject && (
          <Badge variant="secondary" size="sm" className="shrink-0">
            {topic.subjectType}·{topic.subjectTitle}
          </Badge>
        )}
        <span className="shrink-0 text-xs text-foreground-muted">
          来自 {topic.creatorName}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-foreground-muted">
          <TopicStatusBadge status={topic.status} />
          <span>{topic.postCount} 条帖子</span>
          <span className="hidden sm:inline">
            {new Date(topic.lastPostAt ?? topic.createdAt).toLocaleString()}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-4 pb-4">
          {/* 首楼：话题正文 + 行内操作（关注/编辑/删除） */}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-foreground-muted">
              首楼 · {topic.creatorName} ·{' '}
              {new Date(topic.createdAt).toLocaleString()}
            </span>
            {open && (
              <TopicActions
                topic={topic}
                onChanged={() => onChanged?.()}
                onDeleted={() => onChanged?.()}
              />
            )}
          </div>
          <div className="pl-8">
            <MarkdownViewer text={topic.content} />
          </div>

          {/* 帖子：缩进表明属于当前话题 */}
          <div className="mt-3 flex flex-col gap-3 pl-8">
            {loading ? (
              <p className="text-sm text-foreground-muted">加载帖子…</p>
            ) : error ? (
              <p className="text-sm text-error">{error}</p>
            ) : !posts || posts.length === 0 ? (
              <p className="text-sm text-foreground-muted">
                暂无帖子，在下方回复第一条。
              </p>
            ) : (
              posts.map((post) => (
                <div key={post.id}>
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
                    <span className="font-medium text-foreground-intense">
                      #{post.id} {post.authorName}
                    </span>
                    <span>{new Date(post.createdAt).toLocaleString()}</span>
                    {post.source === '飞书群' && (
                      <Badge variant="soft" size="sm">
                        飞书群
                      </Badge>
                    )}
                    {post.authorWorkerId && (
                      <Badge variant="info" size="sm">
                        机器人
                      </Badge>
                    )}
                    <span className="ml-auto flex items-center gap-2">
                      <button
                        type="button"
                        className="underline underline-offset-2 hover:text-foreground-intense"
                        onClick={() => setQuote(post)}
                      >
                        回复
                      </button>
                      {isAdmin && (
                        <AlertDialog>
                          <AlertDialogTrigger
                            render={
                              <button
                                type="button"
                                className="underline underline-offset-2 hover:text-foreground-intense"
                              />
                            }
                          >
                            删除
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>删除帖子</AlertDialogTitle>
                              <AlertDialogDescription>
                                确定删除帖子 #{post.id} 吗？删除后不可恢复。
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogClose>
                                <Button
                                  variant="outline"
                                  type="button"
                                  size="sm"
                                >
                                  取消
                                </Button>
                              </AlertDialogClose>
                              <AlertDialogClose>
                                <Button
                                  variant="destructive"
                                  type="button"
                                  size="sm"
                                  onClick={() => void removePost(post.id)}
                                >
                                  确认删除
                                </Button>
                              </AlertDialogClose>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </span>
                  </div>
                  {post.replyTo && (
                    <div className="mb-1 border-l-2 border-border-strong bg-background-muted px-3 py-1 text-xs text-foreground-muted">
                      回复 #{post.replyTo.id} {post.replyTo.authorName}：
                      {post.replyTo.excerpt}
                    </div>
                  )}
                  <MarkdownViewer text={post.content} />
                </div>
              ))
            )}
          </div>

          {/* 回复框：与帖子同缩进 */}
          <div className="mt-3 pl-8">
            <TopicReplyForm
              topicId={topic.id}
              topicStatus={topic.status}
              workers={workers}
              quote={quote}
              onQuoteChange={setQuote}
              onPosted={() => {
                setQuote(null)
                loadPosts(true)
                onChanged?.()
              }}
            />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}