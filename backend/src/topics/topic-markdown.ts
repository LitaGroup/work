import type { Repository } from 'typeorm';
import { beijingTime } from '../common/frontmatter';
import type { TopicSubjectType } from '../common/enums';
import { Topic } from './topic.entity';

/** Markdown 表格单元格转义（换行与竖线） */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

/**
 * 主体详情 `.md` 视图附带的「话题」清单小节。
 * 独立为纯函数（只依赖 Topic 仓储），避免各主体模块与 TopicsModule 循环依赖；
 * 无话题时返回空串，调用方直接拼接即可。
 */
export async function topicSectionFor(
  topics: Repository<Topic>,
  subjectType: TopicSubjectType,
  subjectId: number,
): Promise<string> {
  const rows = await topics.find({
    where: { subjectType, subjectId },
    order: { id: 'DESC' },
    take: 20,
  });
  if (rows.length === 0) return '';
  const lines: string[] = [
    '',
    '## 话题',
    '',
    `共 ${rows.length} 条（详情：GET /api/topics/{id}.md）。`,
    '',
    '| ID | 标题 | 优先级 | 状态 | 帖子 | 创建人 | 最近活动 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const topic of rows) {
    lines.push(
      `| ${topic.id} | ${escapeCell(topic.title)} | ${topic.priority} | ${topic.status} | ${topic.postCount} | ${escapeCell(
        topic.creatorName,
      )} | ${beijingTime(topic.lastPostAt ?? topic.createdAt)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}
