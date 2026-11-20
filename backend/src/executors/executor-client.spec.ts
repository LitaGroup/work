import { ExecutorType } from '../common/enums';
import { createExecutorClient, type ExecutorClient } from './executor-client';
import { OpencodeClient } from './opencode-client';
import { BridgeClient } from './bridge-client';

describe('createExecutorClient', () => {
  it('type 缺省时创建 opencode 客户端', () => {
    const client: ExecutorClient = createExecutorClient({
      ip: '127.0.0.1',
      port: 4096,
    });
    expect(client).toBeInstanceOf(OpencodeClient);
  });

  it('type=opencode 时创建 opencode 客户端（直连 opencode server）', () => {
    const client = createExecutorClient({
      ip: '127.0.0.1',
      port: 4096,
      type: ExecutorType.OPENCODE,
    });
    expect(client).toBeInstanceOf(OpencodeClient);
  });

  it('bridge 执行器类型（codex / claude-code / kiro）统一创建 BridgeClient', () => {
    expect(
      createExecutorClient({
        ip: '127.0.0.1',
        port: 4590,
        type: ExecutorType.CODEX,
      }),
    ).toBeInstanceOf(BridgeClient);
    expect(
      createExecutorClient({
        ip: '127.0.0.1',
        port: 4590,
        type: ExecutorType.CLAUDE_CODE,
      }),
    ).toBeInstanceOf(BridgeClient);
    expect(
      createExecutorClient({
        ip: '127.0.0.1',
        port: 8082,
        type: ExecutorType.KIRO,
      }),
    ).toBeInstanceOf(BridgeClient);
  });
});
