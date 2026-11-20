---
description: "> AI 助手提示：本文件定义平台与工位侧 executor-bridge 之间的执行器桥接协议（HTTP + SSE，protocol 1）。实现 bridge、新增执行内核或调用 bridge 端点前，必须先阅读本协议。"
version: 1.1.0
type: docs
---

# 执行器桥接协议（Executor Bridge Protocol）

> AI 助手提示：平台（`backend/src/executors/bridge-client.ts`）经本协议连接工位侧 `executor-bridge/`；bridge 把执行内核（kiro-cli / codex app-server / Claude Agent SDK）统一为本协议。DTO 形态与平台 `ExecutorClient` 接口（`backend/src/executors/executor-client.ts`）一一对应。

---

## 一、总览与角色

```
平台机 (backend)                       工位机
┌────────────────────┐
│ BridgeClient ──────┼── HTTP+SSE ──▶ executor-bridge（本协议）
└────────────────────┘                 └─ kernels/
                                       ├─ kiro  （kiro-cli ACP，spawn per turn + --resume-id）
                                       ├─ codex （codex app-server JSON-RPC，规划中）
                                       └─ claude（Claude Agent SDK，规划中）
```

- **一个工位（一条 executors 记录）一个 bridge 实例**：独立端口 + Bearer 令牌，内核子进程 `cwd` 为该工位目录。
- opencode 执行器不经 bridge（平台直连 opencode server）。
- bridge 无状态持久化要求：会话状态在内存，进程重启后会话失效（平台按离线对账重建）。

---

## 二、传输与鉴权

- HTTP JSON：请求/响应体均为 `application/json`；错误响应 `{"message": "..."}` + 恰当状态码（404 用于「不存在」，调用方据此降级）。
- 鉴权：`Authorization: Bearer <token>`；bridge 未配置令牌时可不带（本机回环场景）。
- SSE：`GET /events`，**全执行器单连接**推送全部会话事件；每 15 秒发送 `: heartbeat` 注释行保活。事件信封与 opencode 对齐：

  ```
  data: {"id":"evt_1","type":"message.updated","data":{...}}
  ```

---

## 三、端点清单（protocol 1）

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| GET | `/health` | `{ version, protocol, kernel, capabilities }`，健康检查与能力协商 |
| GET | `/location` | `{ directory }` 默认工作目录 |
| GET | `/providers` | 供应商清单 `[{id,name}]` |
| GET | `/models` | 模型清单（含 `providerID/modelID/variants`） |
| POST | `/sessions` | 建会话，body 同 `OpencodeCreateSessionInput`，返回 `{id,title,location}` |
| GET | `/sessions/active` | `{ "<sessionId>": {type:"running"} }` |
| GET | `/sessions/:id` | `{id, outcome?, time:{idle?}, location?}`（**幂等**，断线对账用） |
| DELETE | `/sessions/:id` | 删除会话并终止当前回合 |
| POST | `/sessions/:id/prompt` | 投递消息，body `{text}`；**忙时由 bridge 排队**，立即返回 `{id,sessionID,time:{created}}` |
| POST | `/sessions/:id/interrupt` | 中断当前回合（outcome=failed，队列保留） |
| POST | `/sessions/:id/wait?timeoutMs=` | 等待会话空闲（队列清空且无运行回合） |
| POST | `/sessions/:id/model` | body `{model}`；下一回合生效 |
| POST | `/sessions/:id/agent` | body `{agent}`；存储并下一回合生效（内核不支持时 204 兼容） |
| GET | `/sessions/:id/questions` | 待答提问（**幂等**；v1 恒 `[]`） |
| POST | `/sessions/:id/questions/:qid/reply` | body `{answers}`（v1 no-op 204） |
| POST | `/sessions/:id/questions/:qid/reject` | （v1 no-op 204） |
| POST | `/sessions/:id/permission/:rid/reply` | （v1 no-op 204） |
| GET | `/sessions/:id/messages` | 消息列表（user/assistant 文本） |
| GET | `/sessions/:id/messages/:mid` | 单条消息详情 `{content:[{type:"text",text}]}` |
| POST | `/fs/ensure-dir` | body `{directory}`，路径必须位于 BRIDGE_ROOT 内 |
| POST | `/fs/write-file` | body `{directory,path,contentBase64,mode?}`，同上路径约束，mode 可选（如 0o600） |
| POST | `/fs/upsert-env` | body `{directory,path,entries}`；按键合并 env 文件（保留其他键，权限 600） |
| GET | `/events` | SSE 事件流（见二） |

bridge 不提供 shell（`capabilities.exec=false`）；令牌与 MCP 配置写入只走 `/fs/*`。

---

## 四、语义约定（实现必须满足）

1. **promptQueueing（强制）**：会话回合运行中新 prompt 不拒绝、不并发，入 per-session 队列；当前回合到达终态后按序投递下一条。平台不维护发送队列，全部依赖本语义。
2. **outcome 粘性与新鲜度基准**：`GET /sessions/:id` 的 `outcome` 保留最近一次回合结果；调用方以「本轮用户消息创建时间」为基准，仅采信 `time.idle >= 本轮消息时间` 的终态（与 opencode `isFreshOutcome` 同构）。bridge 在每回合终态时刷新 `time.idle`（执行器时钟）。
3. **幂等查询**：`/sessions/:id`、`/sessions/:id/questions` 可重复调用且无副作用，供平台断线重连后对账。
4. **中断**：interrupt 终止当前回合（outcome=failed），会话与队列保留，可继续投递。
5. **消息时间**：`prompt` 返回的 `time.created` 与消息列表时间同源（bridge 时钟，毫秒）。

---

## 五、事件词汇表（v1）

| type | data | 说明 |
|:---|:---|:---|
| `message.updated` | `{sessionID, messageID, role, part:{type:"text",text}}` | assistant 增量文本（chunk 为累积片段） |
| `question.asked` / `question.replied` / `question.rejected` | 同平台 `OpencodeQuestionRequest` 形态 | v1 未触发（questions=false），预留 |
| `session.deleted` | `{sessionID}` | 会话删除 |

---

## 六、能力协商

`/health` 返回 `protocol`（当前 1）与 `capabilities`（字段与 `backend/src/executors/executor-capabilities.ts` 一致）。平台按能力降级：`questions=false` 时提问回路整体不启用（飞书审批卡片不渲染按钮）；`switchModel=false` 时调试页提示「重置会话后生效」；`maxSessions` 限制并发会话上限（null = 未提供）。

kiro 内核 v1 上报：`questions=false, interrupt=true, switchModel=true（下一回合生效）, agents=false, exec=false, maxSessions=null`。

---

## 七、内核路线

| 内核 | 通道 | 状态 |
|:---|:---|:---|
| kiro | `kiro-cli chat --no-interactive --output-format stream-json`（ACP 事件流）+ `--resume-id` 续聊 | v1 已实现 |
| kiro（优化） | `kiro-cli serve`（KAS，ACP over WebSocket，默认 8082） | 待研：WS 握手含 acp-callback 鉴权，未探明 |
| codex | `codex app-server` JSON-RPC（stdio） | 规划 |
| claude-code | Claude Agent SDK（进程内 `query()` + streaming input） | 规划 |

---

## 文件清单

| 文件名 | 路径 | 描述 | 类型 |
|:---|:---|:---|:---|
| `package.json` | `./executor-bridge/package.json` | bridge 独立包（零运行时依赖，Node 标准库） | 配置 |
| `main.ts` | `./executor-bridge/src/main.ts` | 入口：环境变量、内核选择、HTTP/SSE 启动 | 脚本 |
| `http.ts` | `./executor-bridge/src/server/http.ts` | 协议端点路由与鉴权 | 脚本 |
| `sessions.ts` | `./executor-bridge/src/core/sessions.ts` | 会话状态机：队列、终态、消息日志 | 脚本 |
| `kiro.kernel.ts` | `./executor-bridge/src/kernels/kiro/kiro.kernel.ts` | kiro ACP 内核（spawn per turn） | 脚本 |

---

**维护人**: Lita R&D Team
