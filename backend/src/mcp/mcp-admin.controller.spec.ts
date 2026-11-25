import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { UserRole, WorkerAccessLevel } from '../common/enums';
import { McpAdminController } from './mcp-admin.controller';

/** 构造被测 controller（mcp / auth / workers / evalToken / trace 全部 mock） */
function buildController(): {
  controller: McpAdminController;
  mcp: { handleRequest: jest.Mock };
  auth: { getPublicAgentByToken: jest.Mock; getUserById: jest.Mock };
  workers: { findByAgentToken: jest.Mock; findOne: jest.Mock };
  evalToken: { verify: jest.Mock };
} {
  const mcp = { handleRequest: jest.fn() };
  const auth = {
    getPublicAgentByToken: jest.fn(),
    getUserById: jest.fn(),
  };
  const workers = { findByAgentToken: jest.fn(), findOne: jest.fn() };
  const evalToken = { verify: jest.fn().mockReturnValue(null) };
  const controller = new McpAdminController(
    mcp as never,
    auth as never,
    workers as never,
    evalToken as never,
    { recordPlatformCall: jest.fn() } as never,
  );
  return { controller, mcp, auth, workers, evalToken };
}

/** 构造 express 风格请求（authenticate 只读 headers 与 originalUrl） */
function reqOf(options: {
  authorization?: string;
  agentToken?: string;
  workerToken?: string;
  url?: string;
}): never {
  const headers: Record<string, string> = {};
  if (options.authorization) headers.authorization = options.authorization;
  if (options.agentToken) headers['x-agent-token'] = options.agentToken;
  if (options.workerToken) headers['x-worker-token'] = options.workerToken;
  return {
    headers,
    originalUrl: options.url ?? '/api/mcp/work-admin',
  } as never;
}

function resOf(): never {
  return { on: jest.fn(), write: jest.fn() } as never;
}

describe('McpAdminController 鉴权（经 handlePost 验证）', () => {
  const adminUser = { id: 3, name: '管理员', role: UserRole.ADMIN };
  const memberUser = { id: 4, name: '普通成员', role: UserRole.MEMBER };
  const adminWorker = {
    id: 7,
    name: '管理员',
    humanUserId: 3,
    enabled: true,
  };
  const memberWorker = {
    id: 8,
    name: '普通成员',
    humanUserId: 4,
    enabled: true,
  };
  const aiWorker = {
    id: 9,
    name: '测试机器人',
    humanUserId: null,
    enabled: true,
  };
  const aiAdminWorker = {
    id: 10,
    name: '管理员机器人',
    humanUserId: null,
    enabled: true,
    accessLevel: WorkerAccessLevel.ADMIN,
  };

  function mockTokens(
    auth: { getPublicAgentByToken: jest.Mock; getUserById: jest.Mock },
    workers: { findByAgentToken: jest.Mock },
  ): void {
    auth.getPublicAgentByToken.mockReturnValue(null);
    auth.getUserById.mockImplementation((id: number) => {
      if (id === 3) return adminUser;
      if (id === 4) return memberUser;
      return null;
    });
    workers.findByAgentToken.mockImplementation((token: string) => {
      if (token === 'admin-worker-token') return adminWorker;
      if (token === 'member-worker-token') return memberWorker;
      if (token === 'ai-worker-token') return aiWorker;
      if (token === 'ai-admin-token') return aiAdminWorker;
      return null;
    });
  }

  async function post(
    controller: McpAdminController,
    req: never,
  ): Promise<void> {
    await controller.handlePost(req, resOf(), {});
  }

  function principalOf(mcp: { handleRequest: jest.Mock }): unknown {
    return (mcp.handleRequest.mock.calls as unknown[][])[0]?.[0];
  }

  it('公共 Agent 令牌（虚拟管理员）放行', async () => {
    const { controller, mcp, auth, workers } = buildController();
    const publicAgent = { id: 0, name: '公共 Agent', role: UserRole.ADMIN };
    auth.getPublicAgentByToken.mockReturnValue(publicAgent);
    workers.findByAgentToken.mockReturnValue(null);
    await post(controller, reqOf({ authorization: 'Bearer pmpub_token' }));
    expect(principalOf(mcp)).toEqual({ user: publicAgent });
  });

  it('管理员绑定的真人机器人令牌放行，同时挂载 worker 与 user', async () => {
    const { controller, mcp, auth, workers } = buildController();
    mockTokens(auth, workers);
    await post(controller, reqOf({ workerToken: 'admin-worker-token' }));
    expect(principalOf(mcp)).toEqual({
      worker: adminWorker,
      user: adminUser,
    });
  });

  it('普通成员真人机器人令牌 403', async () => {
    const { controller, mcp, auth, workers } = buildController();
    mockTokens(auth, workers);
    await expect(
      post(controller, reqOf({ workerToken: 'member-worker-token' })),
    ).rejects.toThrow(ForbiddenException);
    expect(mcp.handleRequest).not.toHaveBeenCalled();
  });

  it('纯 AI 机器人令牌（无绑定真人）403', async () => {
    const { controller, mcp, auth, workers } = buildController();
    mockTokens(auth, workers);
    await expect(
      post(controller, reqOf({ workerToken: 'ai-worker-token' })),
    ).rejects.toThrow(ForbiddenException);
    expect(mcp.handleRequest).not.toHaveBeenCalled();
  });

  it('AI 机器人 accessLevel=管理员 放行', async () => {
    const { controller, mcp, auth, workers } = buildController();
    mockTokens(auth, workers);
    await post(controller, reqOf({ workerToken: 'ai-admin-token' }));
    expect(principalOf(mcp)).toEqual({ worker: aiAdminWorker });
  });

  it('评估令牌 403（即使对应机器人绑定管理员）', async () => {
    const { controller, mcp, auth, workers, evalToken } = buildController();
    mockTokens(auth, workers);
    evalToken.verify.mockReturnValue({
      workerId: 7,
      evalItemId: 1,
      judge: false,
    });
    workers.findOne.mockResolvedValue(adminWorker);
    await expect(
      post(controller, reqOf({ workerToken: 'eval-token' })),
    ).rejects.toThrow(ForbiddenException);
    expect(mcp.handleRequest).not.toHaveBeenCalled();
  });

  it('无效令牌 401', async () => {
    const { controller, auth, workers } = buildController();
    mockTokens(auth, workers);
    await expect(
      post(controller, reqOf({ authorization: 'Bearer bad-token' })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('无令牌时 401', async () => {
    const { controller } = buildController();
    await expect(post(controller, reqOf({}))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
