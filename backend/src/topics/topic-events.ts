import { Subject } from 'rxjs';

/**
 * 话题事件总线：话题/帖子写入后广播，飞书同步与关注通知等订阅方各自处理，
 * 避免 TopicsService 直接依赖飞书模块形成循环依赖。
 */
export const TOPIC_EVENT_BUS = Symbol('TOPIC_EVENT_BUS');

export type TopicEvent =
  | { kind: 'topic-created'; topicId: number }
  | { kind: 'topic-updated'; topicId: number }
  | { kind: 'post-created'; topicId: number; postId: number };

export type TopicEventBus = Subject<TopicEvent>;
