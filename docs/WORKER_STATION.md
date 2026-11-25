---
description: "> AI 助手提示：本文件定义平台机器人工位（worker station）的目录结构、内核适配物与运行时约定。初始化、派发、MCP 注入或新增执行内核前，必须先阅读本文件。"
version: 1.0.0
type: docs
---

# 工位目录规范（Worker Station）

> 工位是每个机器人的独立工作目录（production：`{WORKER_BASE_DIR}/worker/{id}`，其它环境：`{WORKER_BASE_DIR}/worker-dev/{id}`）。
> 目录按**执行内核对齐**设计：平台只维护「源」，内核差异由「适配物」承载，新增内核不需要改动工位源结构。

---

## 一、目录结构（内核无关）

```
worker/{id}/
├── AGENTS.md                      # 角色定义 + 平台固定协同协议（各内核原生读取）
├── .agents/                       # 通用 Agent 区
│   ├── skills/<name>/SKILL.md     # 技能源目录
│   ├── rules/…                    # 规范源目录
│   │   └── .standards-manifest.json
│   ├── .env                       # 平台注入的令牌与地址（600）
│   └── mcp.json                   # 内核无关 MCP 声明（600）
├── docs/                          # 机器人自行维护的知识文档
└── 〈内核适配物〉                  # 平台按执行器类型生成（受管，见下表）
```

### 平台注入内容（`.agents/`，权限 600，机器人不得读取展示、改写或删除）

| 文件 | 内容 |
|:---|:---|
| `.agents/.env` | `LITA_WORK_TOKEN`（机器人令牌，优先）、`LITA_PROJECT_TOKEN`（兼容旧名，同值）、`LITA_USER_TOKEN`（lita-api 等技能）、`LITA_APP_URL`（平台访问地址，含协议） |
| `.agents/mcp.json` | 平台 `lita-work` + 机器人勾选的自定义 MCP 的统一声明（内核无关，用于审计与排查；各内核配置由它派生） |

令牌明文落盘（600），只经服务端结构化写入，不进入 Prompt、SSE 进度或日志。调用平台接口前统一执行
`set -a; . .agents/.env; set +a`，请求头使用 `X-Worker-Token: $LITA_WORK_TOKEN` 或
`X-Agent-Token: ${LITA_WORK_TOKEN:-$LITA_PROJECT_TOKEN}`。

### 机器人维护内容

| 路径 | 说明 |
|:---|:---|
| `AGENTS.md` | 初始化时由平台直接生成（职责定义 + 协同协议 + 权限小节 + 目录结构），不经过模型转写 |
| `.agents/skills/` | 初始化时由平台按技能目录下载（含脚本、模板等资源）；移除清单之外的旧技能目录 |
| `.agents/rules/` | 初始化时由平台按规范清单下载，`.standards-manifest.json` 记录受管文件 |
| `.agents/.station-manifest.json` | 工位同步版本、源文件指纹与写入文件 SHA-256 清单；内容未变化时据此跳过同步 |
| `docs/` | 机器人自行维护的知识文档 |

### 保留目录：评估沙箱

`{WORKER_BASE_DIR}/worker/eval/`（开发 `worker-dev/eval/`）是评估（检测机器人）沙箱的保留目录，与各工位目录 `worker/{id}` 平级，不属于任何机器人：

- 机器人 ID 为数字，`eval` 不会与 `worker/{id}` 冲突，不得把它登记为工位；
- 沙箱必须位于执行器**工作区根段之内**：opencode 工位注入的 `external_directory` 边界以 `{WORKER_BASE_DIR}/worker` 判定，与 `worker` 平级的旧目录会被判越界，导致沙箱构建（mkdir/cp/env 写入）与评估会话全部被拒；
- 沙箱结构：`worker/eval/{runId}/{itemId}`（被测方）与 `worker/eval/judge/{itemId}/{round}`（判定方），由评估引擎创建、销毁并清理孤儿目录。

---

## 二、内核适配物

平台按执行器类型（`executors.type`）在初始化与派发时幂等生成，纳入受管文件，机器人不得改写。

| 内核 | MCP 配置 | 技能发现 | 规范发现 |
|:---|:---|:---|:---|
| `opencode` | `.opencode/opencode.json`（`mcp.servers` + `permissions` 工作区边界） | `.agents/skills` 原生 | 镜像 `.opencode/rules/` |
| `kiro` | `.kiro/settings/mcp.json`（`mcpServers`，remote 用 `url`+`headers`） | 镜像 `.kiro/skills/` | 镜像 `.kiro/steering/` |
| `devin` | `.devin/mcp_config.json`（`mcpServers`，http 用 `type`+`url`+`headers`） | `.agents/skills` 原生 | 无镜像；AGENTS.md 引导按需阅读 `.agents/rules/` |
| `droid` | `.factory/mcp.json`（`mcpServers`，`type: http` + `headers` + `oauth: false`） | 镜像 `.factory/skills/` | 镜像 `.factory/rules/` |
| `codex` / `claude-code` | 规划中：仅写 `.agents/mcp.json`，接入时补适配 | — | — |

- **镜像由平台同步器生成**：平台在发布工位文件时直接把 `.agents/skills`、`.agents/rules` 镜像到当前内核目录；`.agents` 永远是唯一源，不创建模型初始化会话。
- 各内核均原生支持项目级 remote HTTP MCP，无需额外代理；`lita-work` 指向 `{APP_URL}/api/mcp/work`，使用 `X-Worker-Token` 请求头鉴权。

### 已知差异

- 工作区强制边界（`external_directory: deny`）当前仅 opencode 生效；kiro / devin / droid 依赖 AGENTS.md 协议约束，平台未提供强制拦截。
- kiro-cli 的技能自动加载存在上游问题（kirodotdev/Kiro#4993），如技能不可见，需在初始化时补充 custom agent `resources`。
- Kiro 官方文档要求 remote MCP 使用 HTTPS（仅 localhost 允许 http）；生产 `APP_URL` 为 `http://work.cinta.team` 时，kiro 可能拒绝连接，需要为 MCP 提供 HTTPS 入口或用本机端口转发，接入前必须实测。
- devin `mcp_config.json` 的顶层结构（是否带 `mcpServers` 包装）以 `devin mcp add` 实际生成文件为准；接入前必须实测校准。
- droid `exec` 首回合对 AGENTS.md 的加载行为需在升级后实测。

---

## 三、初始化与派发

| 动作 | 平台写入 | 机器人写入 |
|:---|:---|:---|
| 初始化 | 骨架目录、`.agents/.env`、`.agents/mcp.json`、内核 MCP 配置、`AGENTS.md`、技能/规范与内核镜像、`.agents/.station-manifest.json` | — |
| 每次派发 | `.agents/.env`（令牌/地址）、`.agents/mcp.json`、内核 MCP 配置（幂等重写） | — |
| 令牌重置 | 个人 AGENT 首次对话前重写 `.agents/.env` 与内核 MCP 配置 | — |

初始化由平台确定性完成：后端生成最终 `AGENTS.md`，按技能/规范目录下载全部文件（技能包含脚本、模板等附属资源），写入受管 manifest 后发布到执行器。内容版本由机器人配置、权限、执行内核以及技能/规范文件的 Git blob SHA 组成；版本与 `.agents/.station-manifest.json` 一致时只刷新凭据/MCP 配置并跳过文件同步。协议文本中的「平台地址」与 `.md` 端点由 `APP_URL` 注入。

---

## 四、升级与迁移

- 工位布局为**直接切换**：平台不再写旧路径（`.opencode/agent-token`、`.opencode/.env`、`.opencode/skills`、`.opencode/docs`）。
- 发布后需**全量重新初始化**所有机器人工位，以生成新的 `AGENTS.md`、把技能/规范安装到 `.agents/` 并镜像到内核目录。
- 初始化同步器包含一次性迁移清理：删除旧版 `.opencode/agent-token`、`.opencode/.env`、`.opencode/skills/`、`.opencode/docs/`（`.opencode/opencode.json` 保留为 opencode 适配物）。
- 重新初始化前避免重置机器人令牌：旧工位 `AGENTS.md` 仍指向旧令牌路径。

---

## 五、排查清单

1. MCP 未连接：检查对应内核配置文件是否存在（如 `.devin/mcp_config.json`）、`url` 是否指向可达的 `{APP_URL}/api/mcp/work`、`X-Worker-Token` 是否为当前令牌。
2. `.md` 接口 401/404：先 `source .agents/.env` 确认令牌，再确认地址为 `{LITA_APP_URL}/api/...`（协议以变量为准，生产为 http）。
3. 技能不可见：确认技能在 `.agents/skills/`（kiro/droid 还需检查镜像目录）。
4. 规范未生效：确认 `.agents/rules/.standards-manifest.json` 与镜像目录一致。