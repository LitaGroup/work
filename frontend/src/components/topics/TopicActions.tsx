import { useEffect, useMemo, useState } from 'react'
import { Button } from '@appica/ui-react/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  DialogClose,
} from '@appica/ui-react/dialog'
import { Input } from '@appica/ui-react/input'
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
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@appica/ui-react/select'
import {
  api,
  TOPIC_PRIORITIES,
  TOPIC_STATUSES,
  type Topic,
  type TopicPriority,
  type TopicStatus,
} from '../../lib/api'
import { useAuth } from '../../context/AuthContext'

interface TopicActionsProps {
  topic: Topic
  /** 话题元信息/关注变化后刷新列表 */
  onChanged: () => void
  /** 话题删除后刷新列表 */
  onDeleted: () => void
}

/**
 * 话题行内操作（折叠内容区右上角）：关注 / 编辑（创建人或管理员）/ 删除（管理员）。
 * 话题不提供独立详情页，元信息维护集中在这里。
 */
export function TopicActions({
  topic,
  onChanged,
  onDeleted,
}: TopicActionsProps) {
  const { user } = useAuth()
  const isAdmin = user?.role === '管理员'
  const canEdit =
    isAdmin ||
    (topic.creatorUserId !== null && topic.creatorUserId === user?.id)

  const [following, setFollowing] = useState(false)
  const [followBusy, setFollowBusy] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [title, setTitle] = useState(topic.title)
  const [priority, setPriority] = useState<TopicPriority>(topic.priority)
  const [status, setStatus] = useState<TopicStatus>(topic.status)
  const [tags, setTags] = useState((topic.tags ?? []).join(', '))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const priorityItems = useMemo(
    () => Object.fromEntries(TOPIC_PRIORITIES.map((item) => [item, item])),
    [],
  )
  const statusItems = useMemo(
    () => Object.fromEntries(TOPIC_STATUSES.map((item) => [item, item])),
    [],
  )

  useEffect(() => {
    let cancelled = false
    api
      .getTopicFollow(topic.id)
      .then((result) => {
        if (!cancelled) setFollowing(result.following)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [topic.id])

  const toggleFollow = async () => {
    setFollowBusy(true)
    try {
      if (following) await api.unfollowTopic(topic.id)
      else await api.followTopic(topic.id)
      setFollowing(!following)
    } catch {
      // 关注失败保持原状态
    } finally {
      setFollowBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.updateTopic(topic.id, {
        title: title.trim() || undefined,
        priority,
        status,
        tags: tags
          .split(/[,，、\s]+/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      })
      setEditOpen(false)
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    try {
      await api.deleteTopic(topic.id)
      onDeleted()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <span className="flex shrink-0 items-center gap-2 text-xs">
      {user && (
        <button
          type="button"
          className="text-foreground-muted underline underline-offset-2 hover:text-foreground-intense disabled:opacity-60"
          disabled={followBusy}
          onClick={() => void toggleFollow()}
        >
          {following ? '已关注' : '关注'}
        </button>
      )}
      {canEdit && (
        <button
          type="button"
          className="text-foreground-muted underline underline-offset-2 hover:text-foreground-intense"
          onClick={() => {
            setTitle(topic.title)
            setPriority(topic.priority)
            setStatus(topic.status)
            setTags((topic.tags ?? []).join(', '))
            setEditOpen(true)
          }}
        >
          编辑
        </button>
      )}
      {isAdmin && (
        <AlertDialog>
          <AlertDialogTrigger
            render={
              <button
                type="button"
                className="text-foreground-muted underline underline-offset-2 hover:text-foreground-intense"
              />
            }
          >
            删除
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除话题</AlertDialogTitle>
              <AlertDialogDescription>
                确定删除「{topic.title}」及其全部帖子吗？删除后不可恢复。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose>
                <Button variant="outline" type="button" size="sm">
                  取消
                </Button>
              </AlertDialogClose>
              <AlertDialogClose>
                <Button
                  variant="destructive"
                  type="button"
                  size="sm"
                  onClick={() => void remove()}
                >
                  确认删除
                </Button>
              </AlertDialogClose>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑话题</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm text-foreground-muted">标题</label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm text-foreground-muted">优先级</label>
                <Select
                  value={priority}
                  onValueChange={(value) =>
                    setPriority(value as TopicPriority)
                  }
                  items={priorityItems}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TOPIC_PRIORITIES.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-sm text-foreground-muted">状态</label>
                <Select
                  value={status}
                  onValueChange={(value) => setStatus(value as TopicStatus)}
                  items={statusItems}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TOPIC_STATUSES.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-sm text-foreground-muted">
                标签（逗号分隔）
              </label>
              <Input value={tags} onChange={(e) => setTags(e.target.value)} />
            </div>
            {error && <p className="text-sm text-error">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <DialogClose>
              <Button variant="ghost" type="button">
                取消
              </Button>
            </DialogClose>
            <Button type="button" disabled={busy} onClick={() => void save()}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </span>
  )
}