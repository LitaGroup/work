---
description: "> AI 助手提示：本文件定义平台与工位侧 executor-bridge 之间的执行器桥接协议（HTTP + SSE，protocol 1）。实现 bridge、新增执行内核或调用 bridge 端点前，必须先阅读本协议。"
version: 1.4.0
type: docs
---

# 执行器桥接协议（Executor Bridge Protocol）

> AI 助手提示：平台（`backend/src/executors/bridge-client.ts`）经本协议连接工位侧 `executor-bridge/`；bridge 把执行内核（kiro-cli / devin acp / droid exec / codex app-server / Claude Agent SDK）统一为本协议。DTO 形态与平台 `ExecutorClient` 接口（`backend/src/executors/executor-client.ts`）一一对应。

---

## 一、总览与角色

```
平台机 (backend)                       工位机
┌────────────────────┐
│ BridgeClient ──────┼── HTTP+SSE ──▶ executor-bridge（本协议）
└────────────────────┘                 └─ kernels/
                                       ├─ kiro  （kiro-cli ACP，spawn per turn + --resume-id）
                                       ├─ devin （devin acp，JSON-RPC over stdio，spawn per turn + session/load）
                                       ├─ droid （droid exec -o stream-json，spawn per turn + -s 续聊）
                                       ├─ codex （codex app-server JSON-RPC，规划中）
                                       └─ claude（Claude Agent SDK，规划中）
```

- **一个工位（一条 executors 记录）一个 bridge 实例**：独立端口 + Bearer 令牌，内核子进程 `cwd` 为该工位目录。
- opencode 执行器不经 bridge（平台直连 opencode server）。
- **会话持久化**：稳定会话状态（bridge session id、内核原生 `externalId`、消息日志、模型、工位目录与最近回合终态）落本地 JSON 快照，默认 `{BRIDGE_ROOT}/.executor-bridge/{KERNEL}-{PORT}.json`，可用 `BRIDGE_STATE_FILE` 覆盖；启动时先恢复快照再监听 HTTP。快照原子写入且权限 600。重启前仍在运行或排队的回合**不自动重放**，恢复为 `failed`（`error=bridge restarted`），避免重复产生写操作；下一次新 prompt 继续复用恢复出的 `externalId` 续聊内核原生会话。
- **并发回合上限**：`BRIDGE_MAX_TURNS`（缺省 10）。同一执行器同时运行的回合不超过上限，超出的回合按 `prompt` 下发顺序排队，回合结束后由 bridge 补位；`/health` 的 `capabilities.maxSessions` 上报该值。会话内仍严格串行（`promptQueueing`）。
- **会话回收**：`BRIDGE_SESSION_TTL_MS`（缺省 24 小时）无回合且队列为空的会话由 bridge 定期淘汰，平台按 404 对账重建；`DELETE /sessions/:id` 立即丢弃会话及其排队回合。

---

## 二、传输与鉴权

- HTTP JSON：请求/响应体均为 `application/json`；错误响应 `{"message": "..."}` + 恰当状态码（404 用于「不存在」，调用方据此降级）。
- 鉴权：`Authorization: Bearer <token>`；bridge 未配置令牌时可不带（本机回环场景）。
- SSE：`GET /events`，**全执行器单连接**推送全部会话事件；每 15 秒发送 `: heartbeat` 注释行保活。事件信封与 opencode 对齐：

  ```
  data: {"id":"evt_1","type":"session.text.delta","data":{...}}
  ```

### 端口规范

executor-bridge 统一占用 **16000-17000** 段，一执行器一实例一端口；`BRIDGE_PORT` 显式设置时覆盖下表缺省值。

| 内核 | 缺省端口 | 说明 |
|:---|:---|:---|
| kiro | 16010 | |
| devin | 16020 | |
| droid | 16030 | |
| 其它（未分配） | 16000 | 段内兜底 |

opencode 执行器不经 bridge，端口不受本规范约束（当前本机 4096）。

---

## 三、端点清单（protocol 1）

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| GET | `/health` | `{ version, bridgeVersion, protocol, kernel, capabilities }`，健康检查与能力协商；`version` 为内核（Agent CLI）自身版本（平台执行器「版本」展示），`bridgeVersion` 为 bridge 版本；`capabilities.maxSessions` 为并发回合上限 |
| GET | `/location` | `{ directory }` 默认工作目录 |
| GET | `/providers` | 供应商清单 `[{id,name}]` |
| GET | `/models` | 模型清单（含 `providerID/modelID/variants`） |
| POST | `/sessions` | 建会话，body 同 `OpencodeCreateSessionInput`，返回 `{id,title,location}` |
| GET | `/sessions/active` | `{ "<sessionId>": {type:"running"} }` |
| GET | `/sessions/:id` | `{id, outcome?, error?, time:{idle?}, location?}`（**幂等**，断线对账用；`error` 为最近一回合失败的真实原因，成功/未运行时为 `null`） |
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
| POST | `/fs/read-file` | body `{directory,path}`；返回 `{contentBase64}`，不存在返回 404，路径约束同上 |
| POST | `/fs/remove-files` | body `{directory,paths}`；删除受管文件，不存在时忽略，路径约束同上 |
| POST | `/fs/upsert-env` | body `{directory,path,entries}`；按键合并 env 文件（保留其他键，权限 600） |
| POST | `/fs/copy-dir` | body `{source,target,exclude?}`；递归复制目录（替代 `cp -a`），source/target 均须位于 BRIDGE_ROOT 内，`target` 不得位于 `source` 内，`exclude` 为相对 source 的路径整项（文件或目录）不复制 |
| POST | `/fs/rm-dir` | body `{directory}`；递归删除目录（替代 `rm -rf`），同上路径约束，禁止删除 BRIDGE_ROOT 本身 |
| GET | `/events` | SSE 事件流（见二） |

bridge 不提供 shell（`capabilities.exec=false`）；令牌与 MCP 配置写入只走 `/fs/*`。工位目录布局与各内核适配物见 `docs/WORKER_STATION.md`（平台按执行器类型生成 `.opencode/opencode.json`、`.kiro/settings/mcp.json`、`.devin/mcp_config.json`、`.factory/mcp.json` 与 `.agents/mcp.json`，bridge 内核按各自原生配置自动连接）。

`/fs/copy-dir` 与 `/fs/rm-dir` 供评估沙箱构建/销毁使用（复制真实工位时用 `exclude` 剔除 `docs/`、`.agents/.env`、`.agents/mcp.json` 与各内核 MCP 配置，真实令牌不进入沙箱），平台侧对应 `ExecutorClient.copyDir/removeDir`；opencode 适配器内部以 shell 实现同一语义。

评估沙箱位于 `{WORKER_BASE_DIR}/{worker|worker-dev}/eval/**`（与工位目录平级），因此 bridge 的 `BRIDGE_ROOT` 必须指向工位根段（`{WORKER_BASE_DIR}/worker` 或 `{WORKER_BASE_DIR}/worker-dev`），不能指向单个工位目录；否则 `/fs/*` 会因越界返回 403「路径越界」，评估项直接失败。升级顺序：先升级工位侧 bridge（新增两个 `/fs` 端点），再升级平台后端；bridge 未升级时平台复制沙箱会得到 404 `not found: POST /fs/copy-dir`。

---

## 四、语义约定（实现必须满足）

1. **promptQueueing（强制）**：会话回合运行中新 prompt 不拒绝、不并发，入 per-session 队列；当前回合到达终态后按序投递下一条。平台不维护发送队列，全部依赖本语义。
2. **outcome 粘性与新鲜度基准**：`GET /sessions/:id` 的 `outcome` 保留最近一次回合结果；调用方以「本轮用户消息创建时间」为基准，仅采信 `time.idle >= 本轮消息时间` 的终态（与 opencode `isFreshOutcome` 同构）。bridge 在每回合终态时刷新 `time.idle`（执行器时钟）。失败回合同时返回 `error`（内核失败原因），平台据此展示真实失败信息；成功回合清空。
3. **幂等查询**：`/sessions/:id`、`/sessions/:id/questions` 可重复调用且无副作用，供平台断线重连后对账。
4. **中断**：interrupt 终止当前回合（outcome=failed），会话与队列保留，可继续投递。
5. **消息时间**：`prompt` 返回的 `time.created` 与消息列表时间同源（bridge 时钟，毫秒）。
6. **回合终态事件（强制）**：每个回合结束都要发 `session.execution.succeeded` 或 `session.execution.failed`，带 `sessionID`、`time.idle`（本回合结束时间）与失败时的 `error`。平台以 `time.idle` 与「本轮 prompt 的 `time.created`」比较判断终态是否属于最新一轮，更早回合的终态（会话里还排着后续 prompt）不得被采信。
7. **并发与排队（强制）**：跨会话并行受 `BRIDGE_MAX_TURNS` 限制，排队会话不是「运行中」（`/sessions/active` 不返回），`wait` 在队列清空且无运行回合前不返回。

---

## 五、事件词汇表（v1.2）

事件类型与 opencode 原生（`/api/event`）一致，平台任务会话与机器人调试对话直接消费，bridge 无需额外的后端适配：

| type | data | 说明 |
|:---|:---|:---|
| `session.reasoning.started` | `{sessionID, assistantMessageID}` | 思考块开始（如 kiro / devin `agent_thought_chunk`） |
| `session.reasoning.delta` | `{sessionID, assistantMessageID, delta}` | 思考增量（delta） |
| `session.reasoning.ended` | `{sessionID, assistantMessageID}` | 思考块结束 |
| `session.text.started` | `{sessionID, assistantMessageID}` | 正文块开始 |
| `session.text.delta` | `{sessionID, assistantMessageID, delta}` | 正文增量（delta） |
| `session.text.ended` | `{sessionID, assistantMessageID}` | 正文块结束 |
| `question.asked` / `question.replied` / `question.rejected` | 同平台 `OpencodeQuestionRequest` 形态 | v1 未触发（questions=false），预留 |
| `session.deleted` | `{sessionID}` | 会话删除 |
| `session.execution.succeeded` | `{sessionID, time:{idle}}` | 回合成功结束 |
| `session.execution.failed` | `{sessionID, error:{type,message}, time:{idle}}` | 回合失败结束；`error.message` 为内核失败原因（含 interrupted） |

同一回合内思考与正文可能多次交错：每次切换先补发旧块 `ended`、再发新块 `started`；回合终态关闭未闭合的块。最终产出语义不变，仍取 `runFinished` 的 `finalText`（缺省回退 bridge 消息日志的 `turnBuffer`）。

> v1.1 及更早版本的 `message.updated`（`part:{type:"text",text}`）已下线：平台全链路无消费方，由上述 `session.text.*` 取代。

---

## 六、能力协商

`/health` 返回 `protocol`（当前 1）与 `capabilities`（字段与 `backend/src/executors/executor-capabilities.ts` 一致）。平台按能力降级：`questions=false` 时提问回路整体不启用（飞书审批卡片不渲染按钮）；`switchModel=false` 时调试页提示「重置会话后生效」；`maxSessions` 为 bridge 实际生效的并发回合上限（`BRIDGE_MAX_TURNS`，缺省 10）。

kiro / devin / droid 内核 v1 均上报：`questions=false, interrupt=true, switchModel=true（下一回合生效）, agents=false, exec=false`，`maxSessions` 由 bridge 按 `BRIDGE_MAX_TURNS` 覆盖上报。

---

## 七、内核路线

| 内核 | 通道 | 状态 |
|:---|:---|:---|
| kiro | `kiro-cli chat --no-interactive --output-format stream-json`（ACP 事件流：正文 `agent_message_chunk` + 思考 `agent_thought_chunk`）+ `--resume-id` 续聊 | v1 已实现 |
| kiro（优化） | `kiro-cli serve`（KAS，ACP over WebSocket，默认 8082） | 待研：WS 握手含 acp-callback 鉴权，未探明 |
| devin | `devin acp --process-model in-process`（ACP JSON-RPC over stdio，每回合 spawn）：`initialize` → `session/load`（续聊）/ `session/new` → `session/set_config_option`（`mode`/`model`/`thought_level`）→ `session/prompt`；正文 `agent_message_chunk`、思考 `agent_thought_chunk`；无 cancel 方法，中断即杀进程。**方言**：`mcpServers` 传数组、`prompt` 传内容块数组、响应无 finalText（正文由 bridge turnBuffer 兜底） | v1 已实现 |
| droid | `droid exec --cwd <工位目录> -o stream-json`（JSONL：`system/init` 带 `session_id` → `message`/`reasoning`/`tool_call`/`error` → 终态 `result`；思考为独立 `reasoning` 事件，每段一条全量文本，可与工具调用交错）；`-s <sessionId>` 续聊、`-m` 模型、`-r` 思考等级；模型清单解析 `droid exec --help`（Available Models / Model details）。**自治**：默认 `--skip-permissions-unsafe`，`DROID_PERMISSION_MODE=low\|medium\|high` 改走 `--auto` | v1 已实现 |
| codex | `codex app-server` JSON-RPC（stdio） | 规划 |
| claude-code | Claude Agent SDK（进程内 `query()` + streaming input） | 规划 |

内核环境变量：

- `KIRO_CLI_PATH`（默认 `kiro-cli`）
- `DEVIN_CLI_PATH`（默认 `devin`）、`DEVIN_SESSION_MODE`（默认 `bypass`，无人值守工位全自治）
- `DROID_CLI_PATH`（默认 `droid`）、`DROID_PERMISSION_MODE`（默认 `unsafe`；`low`/`medium`/`high` 走 `--auto`）

bridge 环境变量：

- `BRIDGE_PORT` / `BRIDGE_TOKEN` / `BRIDGE_ROOT`：监听端口、Bearer 令牌、工位根目录
- `BRIDGE_MAX_TURNS`（默认 10）：同一执行器同时运行的回合上限
- `BRIDGE_SESSION_TTL_MS`（默认 86400000，即 24 小时）：空闲会话回收时间，启动恢复后立即执行一次清理
- `BRIDGE_STATE_FILE`（默认 `{BRIDGE_ROOT}/.executor-bridge/{KERNEL}-{PORT}.json`）：会话快照文件；损坏或版本不兼容时记录错误并以空状态启动，由平台按 404 对账重建

---

## 文件清单

| 文件名 | 路径 | 描述 | 类型 |
|:---|:---|:---|:---|
| `package.json` | `./executor-bridge/package.json` | bridge 独立包（零运行时依赖，Node 标准库） | 配置 |
| `main.ts` | `./executor-bridge/src/main.ts` | 入口：环境变量、内核选择、快照恢复、HTTP/SSE 启动与优雅退出 | 脚本 |
| `http.ts` | `./executor-bridge/src/server/http.ts` | 协议端点路由与鉴权 | 脚本 |
| `sessions.ts` | `./executor-bridge/src/core/sessions.ts` | 会话状态机：队列、终态、消息日志、快照恢复、事件翻译（session.text.* / session.reasoning.*） | 脚本 |
| `session-store.ts` | `./executor-bridge/src/core/session-store.ts` | 会话快照的原子读写、版本校验与串行落盘 | 脚本 |
| `kiro.kernel.ts` | `./executor-bridge/src/kernels/kiro/kiro.kernel.ts` | kiro ACP 内核（spawn per turn） | 脚本 |
| `devin.kernel.ts` | `./executor-bridge/src/kernels/devin/devin.kernel.ts` | devin ACP 内核（spawn per turn + session/load 续聊） | 脚本 |
| `droid.kernel.ts` | `./executor-bridge/src/kernels/droid/droid.kernel.ts` | droid exec 内核（spawn per turn + -s 续聊） | 脚本 |

---

**维护人**: Lita R&D Team
