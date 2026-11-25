import { ForbiddenException } from '@nestjs/common';
import { UserRole, WorkerAccessLevel } from '../common/enums';
import { assertMcpAccess, resolveAccessLevel } from './worker-access';

describe('resolveAccessLevel', () => {
  it('真人管理员 / 公共 Agent → 管理员', () => {
    expect(resolveAccessLevel({ user: { role: UserRole.ADMIN } })).toBe(
      WorkerAccessLevel.ADMIN,
    );
  });

  it('真人机器人跟随绑定真人（成员 → 普通，忽略自身字段）', () => {
    expect(
      resolveAccessLevel({
        user: { role: UserRole.MEMBER },
        worker: {
          humanUserId: 3,
          accessLevel: WorkerAccessLevel.ADMIN,
        },
      }),
    ).toBe(WorkerAccessLevel.NORMAL);
  });

  it('个人 AGENT 跟随真人（成员 → 普通）', () => {
    expect(
      resolveAccessLevel({
        user: { role: UserRole.MEMBER },
        worker: { personalAgentUserId: 3 },
      }),
    ).toBe(WorkerAccessLevel.NORMAL);
  });

  it('真人机器人绑定管理员 → 管理员', () => {
    expect(
      resolveAccessLevel({
        user: { role: UserRole.ADMIN },
        worker: { humanUserId: 3, accessLevel: WorkerAccessLevel.NONE },
      }),
    ).toBe(WorkerAccessLevel.ADMIN);
  });

  it('AI 机器人按自身 accessLevel', () => {
    expect(
      resolveAccessLevel({
        worker: { humanUserId: null, accessLevel: WorkerAccessLevel.ADMIN },
      }),
    ).toBe(WorkerAccessLevel.ADMIN);
    expect(
      resolveAccessLevel({
        worker: { humanUserId: null, accessLevel: WorkerAccessLevel.NONE },
      }),
    ).toBe(WorkerAccessLevel.NONE);
  });

  it('AI 机器人未设置时默认普通', () => {
    expect(resolveAccessLevel({ worker: { humanUserId: null } })).toBe(
      WorkerAccessLevel.NORMAL,
    );
  });
});

describe('assertMcpAccess', () => {
  it('无权限机器人禁止调用 MCP', () => {
    expect(() =>
      assertMcpAccess({
        worker: { humanUserId: null, accessLevel: WorkerAccessLevel.NONE },
      }),
    ).toThrow(ForbiddenException);
  });

  it('普通 / 管理员放行', () => {
    expect(() =>
      assertMcpAccess({
        worker: { humanUserId: null, accessLevel: WorkerAccessLevel.NORMAL },
      }),
    ).not.toThrow();
    expect(() =>
      assertMcpAccess({
        worker: { humanUserId: null, accessLevel: WorkerAccessLevel.ADMIN },
      }),
    ).not.toThrow();
  });
});
