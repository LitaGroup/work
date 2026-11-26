import { UserRole, WorkerAccessLevel } from '../common/enums';
import {
  assertCanManageSystemKnowledge,
  assertCanReadSystemKnowledge,
  knowledgeSearchExcludes,
} from './knowledge.access';

describe('系统知识访问控制', () => {
  const member = { user: { role: UserRole.MEMBER } };
  const admin = { user: { role: UserRole.ADMIN } };
  const adminWorker = {
    worker: {
      accessLevel: WorkerAccessLevel.ADMIN,
      humanUserId: null,
      personalAgentUserId: null,
    },
  };

  it('普通成员不能读取或维护 /99-system，搜索时排除该系统目录', () => {
    expect(() => assertCanReadSystemKnowledge(member, '/99-system')).toThrow(
      '仅管理员',
    );
    expect(() =>
      assertCanManageSystemKnowledge(member, '/99-system/design'),
    ).toThrow('仅管理员');
    expect(knowledgeSearchExcludes(member)).toEqual(['/99-system']);
  });

  it('管理员可读取和维护系统设计目录', () => {
    expect(() =>
      assertCanReadSystemKnowledge(admin, '/99-system/workers/1/README'),
    ).not.toThrow();
    expect(() =>
      assertCanManageSystemKnowledge(adminWorker, '/99-system/design'),
    ).not.toThrow();
    expect(knowledgeSearchExcludes(adminWorker)).toEqual([]);
  });

  it('普通知识与任务、需求文档不受管理员限制', () => {
    expect(() =>
      assertCanReadSystemKnowledge(member, '/98-tasks/20261126/1/API'),
    ).not.toThrow();
    expect(() =>
      assertCanReadSystemKnowledge(member, '/01-backlogs/20261126/7'),
    ).not.toThrow();
  });
});
