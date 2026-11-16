import type { Worker } from '../../lib/api'

/** 末尾 @ 片段：@ 后不能有空白，允许正文末尾的换行（Milkdown 输出常带尾换行） */
const MENTION_TAIL = /@([^\s@，。！？、,.!?]{0,30})(\n*)$/

/** 取正文/标题末尾正在输入的 @ 关键词（无则返回 null） */
export function trailingMentionQuery(text: string): string | null {
  const match = MENTION_TAIL.exec(text ?? '')
  return match ? match[1] : null
}

/** 用选中的机器人名称替换末尾 @ 关键词，并补一个空格继续输入（保留尾部换行） */
export function replaceTrailingMention(text: string, name: string): string {
  return (text ?? '').replace(MENTION_TAIL, `@${name} $2`)
}

/**
 * 从正文/标题解析 @ 机器人：按机器人名称从长到短匹配 `@名称`，
 * 命中后从剩余文本中移除，避免短名称命中长名称的前缀。
 */
export function collectMentions(
  content: string,
  workers: Worker[],
): number[] {
  let rest = content ?? ''
  const ids: number[] = []
  const sorted = [...workers].sort((a, b) => b.name.length - a.name.length)
  for (const worker of sorted) {
    const token = `@${worker.name}`
    if (!token || !rest.includes(token)) continue
    ids.push(worker.id)
    rest = rest.split(token).join('\n')
  }
  return ids
}