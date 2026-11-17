# AGENTS.md

以 AI 为中心的项目管理平台。Agent 会话是核心参与者，设计与修改时优先考虑 Agent 的可读性、可操作性和身份边界。

本文件只维护**跨模块的稳定约定与业务不变量**，不复制页面、字段和接口的完整清单。实现任务时先阅读相关实体、控制器和服务；接口签名、页面结构等现状以源码为准。修改了本文件记载的行为或约定时，同步更新本文件。

## 技术栈与常用命令

- `frontend/`：Vite + React 19 + Appica UI（`@appica/ui-react`）+ Tailwind CSS v4。
- `backend/`：NestJS（strict TS）+ TypeORM + PostgreSQL；知识检索使用 PGVector。
- `appium-agent/`：独立 Appium Agent。
- 包管理：pnpm workspace，成员为 `frontend`、`backend`。
- 集成：飞书、GitHub、opencode、APIPOST、Appium。

| 操作 | 命令 |
|---|---|
| 启动后端 | `pnpm dev:backend` → `http://localhost:3100/api` |
| 启动前端 | `pnpm dev:frontend` → `http://localhost:5273`（`/api` 代理到 3100，strictPort） |
| 构建 | `pnpm build` |
| Lint | `pnpm lint`（后端 ESLint 会修复文件） |
| 后端单测 | `pnpm test` |
| 后端 E2E | `pnpm -C backend test:e2e` |
| 执行迁移 | `pnpm -C backend db:migration:run` |
| 回退迁移 | `pnpm -C backend db:migration:revert` |

## 环境、数据库与文件

- 环境变量加载优先级：进程环境变量 > `backend/.env` > `~/.env`。示例见 `backend/.env.example`，不要读取或提交真实凭据。
- 业务库使用 `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`。
- 知识库可用 `PROJECT_PG_HOST/PROJECT_PG_PORT/PROJECT_PG_USER/PROJECT_PG_PASSWORD/PROJECT_PG_DATABASE` 独立配置，缺省复用 `DB_*`，数据库需安装 pgvector。
- Embedding 使用 OpenAI 兼容接口：`PROJECT_KNOWLEDGE_EMBEDDING_BASE_URL/API_KEY/MODEL/DIMENSIONS`，维度默认 1024。纯向量召回最低余弦相似度为 `PROJECT_KNOWLEDGE_SEARCH_VECTOR_MIN_SIMILARITY`，默认 0.65，0 表示不过滤。
- TypeORM `synchronize` 仅在非 production 开启。**生产结构变更必须新增 migration**，配置见 `backend/src/data-source.ts`，迁移放在 `backend/src/migrations/`。
- **新增时间列统一显式使用 `timestamptz`，禁止无时区 `timestamp`**；节点日期、预期发布日期等纯日期仍使用 `date`。数据库会话时区固定 Asia/Shanghai。
- 不使用数据库物理外键和数据库级联删除；实体关系与删除后的清理由应用层维护。
- 历史 MySQL 数据可配置 `MYSQL_*` 后执行 `pnpm -C backend db:migrate:mysql`，仅导入空 PostgreSQL 库。
- 本地静态目录由 `DIR_IMAGE_WEBROOT`、`DIR_EXPORT_WEBROOT`、`DIR_FILE_WEBROOT` 配置，默认分别为项目根的 `images/`、`export-files/`、`files/`，由 `backend/src/common/paths.ts` 和 `main.ts` 挂载到 `/images`、`/export-files`、`/files`，不走 `/api` 前缀。
- `/files` 公开下载并带 CSP sandbox 与 nosniff；上传和静态路径处理不得放宽为主动内容可执行。

## 源码导航

### 前端

- `frontend/src/main.tsx`：入口与 `ThemeProvider`。
- `frontend/src/App.tsx`：react-router v7 路由、登录与管理员路由守卫。
- `frontend/src/components/Layout.tsx`：顶部导航、左侧分区导航、搜索和新建入口；导航配置集中在 `NAV_SECTIONS`。
- `frontend/src/lib/api.ts`：API 客户端与前端类型；枚举须与后端 `common/enums.ts` 同步。
- `frontend/src/pages/`：页面实现。修改页面时从路由定位，不在本文件维护页面快照。
- `frontend/src/components/MarkdownEditor.tsx`：Milkdown Crepe Markdown 编辑器；`MarkdownViewer.tsx` 为通用只读渲染，`MarkdownField.tsx` 为表单封装。
- `frontend/src/components/detail/`：详情页布局、我的 AI 面板和脚本运行详情。
- `frontend/src/components/task-detail/`：任务正文与需求方/执行方协作面板。
- `frontend/src/lib/event-source.ts`：统一 SSE 封装。
- `frontend/src/lib/pinyin-search.ts`：前端拼音搜索。
- `docs/UI_STANDARD.md`：按钮反馈与 Markdown 外框的完整 UI 规范。

### 后端

- `backend/src/main.ts`：全局 `/api` 前缀、CORS、静态目录。
- `backend/src/common/`：枚举、路径、Frontmatter、运行 Markdown、拼音搜索等公共能力。
- `backend/src/auth/`：飞书 OAuth、会话、用户同步、Agent 令牌和全局鉴权。
- `backend/src/sso/`：单点登录（OAuth2 授权码 IdP）：管理区「SSO 应用」登记接入方，authorize / token / userinfo 供其它网站接入平台登录。
- `backend/src/projects/`、`documents/`、`resources/`、`milestones/`：项目及项目资料。
- `backend/src/iterations/`：迭代（T0 / T7 / Tx）与迭代项（Backlog）；转入时负责人可暂不指定，指定/改派时创建或重建交付任务，迭代沟通群由 `feishu-bot/` 维护。
- `backend/src/checks/`、`tests/`、`exports/`、`schedules/`、`scripts/`：脚本登记、导入、运行、历史与调度。
- `backend/src/tasks/`：任务状态机、任务定义、派发、协同、文档、工作台和实时流。
- `backend/src/wakeups/`：机器人定时唤醒（任务会话与「我的 AI」会话共用，到期扫描投递并恢复会话）。
- `backend/src/tickets/`、`workflows/`：工单、工作流定义、发布版本和运行时流转。
- `backend/src/workers/`、`executors/`：机器人、个人 AGENT、工位初始化、调试会话、opencode 执行器。
- `backend/src/knowledge/`：知识树、全文/向量混合检索与 Embedding 队列。
- `backend/src/defects/`、`releases/`、`feedbacks/`：缺陷、项目提测与用户反馈（业务分区「反馈」，独立实体 `feedbacks`）；`ideas/`：灵感（业务分区「灵感」，采纳后关联需求池）。
- `backend/src/feishu/`、`feishu-bot/`：飞书只读导入、机器人长连接与任务群。
- `backend/src/model-config/`：管理区「模型配置」（固定场景的 OpenAI 兼容连接：baseUrl/apiKey/model/思考等级）与通用单次大模型调用（`LlmService`，工单/任务标题命名等后台任务）。
- `backend/src/github/`、`github-gateway/`：仓库/分支/提交集成与凭证网关。
- `backend/src/agent/`、`remote-run/`、`app-versions/`：Appium Agent、远程运行与 APP 包。
- `backend/src/files/`、`images/`、`settings/`、`mcp/`：上传、设置与 MCP 开放（`lita-bots` 调用机器人、`lita-work` 平台工具：需求/迭代项（含成员与状态流转）/知识/运行/缺陷/反馈/灵感/任务协同/工单/机器人/飞书会话历史与消息发送/定时唤醒）；`backend/src/mcp-servers/` 为管理区「MCP 配置」（机器人连接的外部 MCP 服务）。

其他入口：

- `docs/FEATURE-02-TASKS-PLAN.md`：任务处理中心设计背景。
- `docs/APPIUM-AGENT.md`：Appium Agent 协议。
- `docs/OP_GATEWAY.md`、`docs/OP_GATEWAY_API.md`：凭证网关。
- `MCP.md`：lita-work / lita-bots / lita-proxy 三个 MCP 服务接入总览（令牌、客户端配置与工具入口）。
- `docs/work-mcp.md`：lita-work MCP（`POST /api/mcp/work`）接入指南与工具清单。
- `docs/MCP_BOTS.md`：lita-bots MCP（`POST /api/mcp/bots`）会话、提问与工具说明。
- `docs/SSO.md`：单点登录（OAuth2 授权码）接入指南（authorize / token / userinfo）。
- `skills/`：已随 MCP 二期下线（lita-work / knowledge-search / file-upload 等平台能力技能不再随仓库发布）。

## 后端通用约定

### API、Markdown 与实时流

- JSON API 统一带 `/api` 前缀；实体枚举使用 `backend/src/common/enums.ts` 的中文原文，不要随意改名。
- `.md` URL 是 Agent 视图或操作入口，返回 `text/markdown`，并以 YAML Frontmatter 开头。Frontmatter 由 `backend/src/common/frontmatter.ts` 统一生成，至少含北京时间 `update`。
- 知识目录 URL 必须以 `/` 结尾，文章不带 `/`；对应 Markdown 视图分别为 `.../.md` 与 `....md`。
- 静态路由和 `.md` 路由必须声明在 `:id` 前，避免被参数路由捕获。
- 运行、初始化等长任务优先使用“立即返回运行记录 + SSE 推送快照/增量/终态”，避免同步长请求被网关超时切断。终态快照需支持晚订阅，心跳用于保活。
- 删除实体时检查应用层软引用、事件、运行记录、文档和产物清理；不要依赖数据库级联。

### 鉴权与身份

- 全局 `AuthGuard` 保护 JSON API；网页使用飞书 OAuth + HttpOnly JWT Cookie。登录流程和 `@Public()` 端点是例外。
- `.md` 端点支持网页会话，也支持 `X-Worker-Token`，或把机器人令牌放在 `X-Agent-Token` / `?token=`；显式提供错误令牌时直接 401，不回退 Cookie。
- **系统只有机器人令牌，没有用户级 agent 令牌**：个人中心「机器人令牌」就是该用户绑定真人机器人的 `workers.agentToken`，个人 AGENT 共用同一令牌；真人机器人令牌命中时同时挂载 `req.worker` 与 `req.user`。
- `PUBLIC_AGENT_TOKEN` 可映射为虚拟管理员「公共 Agent」，未配置则禁用；设置页只能展示是否配置，不能泄露明文。
- `X-Worker-Token` 用于识别机器人，挂载 `req.worker`；真人机器人额外挂载 `req.user`，这是真人身份的唯一来源，**不再有独立用户令牌**。机器人令牌不得出现在响应、日志或 `workers.md` 详情中。
- `lita-work` / `lita-bots` MCP 端点同样接受 `X-Worker-Token`（或把机器人令牌放在 Bearer / `X-Agent-Token` / `?token=`）识别机器人身份；`lita-bots` 的机器人调用会话优先落到机器人绑定的真人，未绑定真人的 AI 机器人使用负 ID 隔离，不与他人会话混用。
- 工位 `.opencode/.env` 中的 `LITA_WORK_TOKEN` 是机器人平台令牌，兼容旧名 `LITA_PROJECT_TOKEN`；`LITA_USER_TOKEN` 是 Lita 平台（`api.cinta.team`）用户令牌，供 lita-api 等技能使用。工位配置优先级高于进程环境和执行器宿主 `~/.env`。
- 个人 AGENT 使用其主人真人机器人的平台令牌，任务操作统一记为真人身份，个人 AGENT 本身不写入任务参与身份。
- 管理接口必须校验管理员；机器人执行动作必须校验当前执行机器人；需求方动作必须校验需求方身份。不要只依赖前端隐藏按钮。
- 飞书/GitHub 密钥、PAT、会话令牌等敏感列使用 `select:false`，只写不回显；审计不得记录原始 Token/PAT。

## 前端硬性规范

### Appica UI 与样式

- 权威组件文档：`https://appica.dev/llms.txt`，文档页可加 `.md` 获取 Markdown。
- `frontend/src/index.css` 必须同时保留 `@import '@appica/ui-react/styles.css'` 和 `@source '../node_modules/@appica/ui-react/dist';`。
- 必须 React 19；`ref` 是普通 prop，不使用 `forwardRef`。
- 组件使用子路径导入，例如 `import { Button } from '@appica/ui-react/button'`；组件库已有组件不要手写。
- 禁止手写色值、圆角、时长字面量和 hue 系类名，使用角色 token，如 `bg-background-muted`、`text-foreground-intense`、`border-border-strong`、`var(--radius-md)`。
- Select 的选项值与展示文案不一致时，根组件必须传 `items` 映射，避免触发器显示原始 value。
- 根节点 `ThemeProvider` 不得移除。
- 按钮结果反馈统一使用 Popover：成功停留 2 秒后进入下一步；失败展示具体原因并停留 5 秒。禁止 Toast、`alert()` 或失败静默，详见 `docs/UI_STANDARD.md`。
- 操作按钮统一右对齐：页面/分区/卡片标题行左侧标题与描述、右侧按钮组，主操作放最右；过滤器留在左侧，不与操作按钮混排；弹窗底部确认按钮在最右。详见 `docs/UI_STANDARD.md`。
- Markdown 编辑器与展示区的**外部框统一 `rounded-none`**；正文内部元素保持默认样式。这是通用圆角 token 规则的明确例外。

### 布局、Markdown 与搜索

- 详情页只允许两种布局：`DetailPageLayout` 传入 `ai` 时为“内容区 + 右侧 AI 区”，不传时为单栏。不得新增永久业务侧栏或第三栏；窄屏 AI 收为浮动入口和全屏抽屉。
- 普通详情页 AI 使用 `DetailAgentPanel`；任务/工单详情使用 `TaskWorkbenchPanel`，按 `workbenchRoles` 展示需求方、执行方与「我的 AI」。业务属性、历史、筛选、产物等全部留在内容区。
- 「我的 AI」会话按详情对象隔离：任务使用 `agent:task:{id}`，其他详情使用 `agent:page:{type}:{hash}`。新增详情上下文类型时同步扩展后端白名单；`contextReadUrl` 只允许站内只读 `/api/` 地址。
- `MarkdownEditor` 是非受控组件，切换内容用 `key` 重挂载；保存前通过 ref 的 `getMarkdown()` 取实时内容。Mermaid 统一走 `src/lib/mermaid.ts`，解析失败回退源码与错误。
- 任务定义、机器人相关的前端搜索和联想必须复用 `matchesPinyinSearch`；后端关键词过滤复用 `backend/src/common/pinyin-search.ts`。支持原文、无声调全拼和首字母，不要退回纯子串匹配。
- 前端 SSE 统一使用 `visibleEventSource`，不要直接 `new EventSource`。标签页隐藏时断开、恢复可见时重连；服务端重连后先推快照，不能依赖定时轮询补齐状态。

## 核心领域规则

以下名称和语义已确认，不要为了“统一命名”随意修改数据库表、实体、路由或中文枚举。

### 业务分区导航

- 顶级分区「业务」（原「项目」）左侧只保留五个业务栏目：需求 `/requirements`、迭代 `/iterations`、灵感 `/ideas`、调研（占位，未启用）、反馈 `/feedback`；落地页 `/` 重定向到需求池，概览页仅保留 `/overview` 路由不挂导航。
- 需求池复用项目实体（飞书需求池单向同步 + 平台内新建）。需求详情页为 `/requirements/{id}`，内容分区与 URL hash 一一对应：**详情**（`#details`，信息属性、需求摘要、需求描述三个纵向块，均可编辑）、**资料**（`#docs`，文档清单与新建/导入/按来源同步）、**讨论**（`#topics`，`TopicsPanel` 与迭代项「话题」一致并显示计数）、**操作**（`#ops`，仅删除需求）。迭代入口在标题右上角：存在未取消迭代项时「进入迭代」直达 `/backlogs/{id}`，否则管理员可见「移入迭代」（`TransferToIterationButton`）；需求状态为推导值，不可手动修改。不再展示任务/资源/节点/检查/测试/缺陷等研发过程数据，也没有「安排项目机器人」「提测」按钮（分别走 `POST /api/projects/{id}/delivery-task` 与迭代项详情提测）。需求不维护成员，只保留需求方（`projects.owner`），人员/成员统一由迭代项 `backlogs.members` 维护。
- 需求 Agent 视图：`GET /api/requirements/{id}.md`（基本信息 + 对应迭代 + 文档资料 + 少量需求级 AI 操作）、`GET /api/requirements/search.md`、`POST /api/requirements/{id}/update.md`；旧 `/api/projects/{id}.md`、`/api/projects/search.md`、`/api/projects/{id}/update.md` 视图已下线。JSON 接口仍为 `/api/projects*`，提测操作端点仍为 `POST /api/projects/{id}/release[.md]`。`/projects` 重定向到 `/requirements`，项目子路由（`/projects/:id/...`）保留；`/projects/:id` 详情路由已移除。
- 研发类操作指南（脚本运行、节点、代码分支、提测、缺陷）随系统任务定义 ID=7 / ID=9 的说明下发给执行机器人（`system-task-templates.ts` 的 `DEVELOPMENT_OPERATION_GUIDE`），不再放在需求详情 .md 中。
- 迭代独立建模（`iterations` + `backlogs`，见「迭代与 Backlog」）；`projects.iterationCycle` 仅保留为飞书同步的参考字段与需求筛选值（界面统一展示为「计划周(w)」，字段名不变），旧分组接口 `GET /api/projects/iterations` 不再作为迭代页数据源。
- 原全局工具页（缺陷/用例/检查/导出/定时任务/文档/资源/节点/提交/APP/设置）不再提供导航入口：管理分区「研发工具」仅保留「系统设置」（`/settings`），其余工具页路由与访问权限不变，仅可经深链或其它页面跳转进入；`TOOL_PATHS` 仍用于把这些路径的导航归属判定为管理分区。

### 迭代与 Backlog

- 迭代分三类：**T0 常驻快速通道**（单例，`code=T0`，无起止日期；需求确认可开发即进入、开发完成即可上线；不可创建、不可结束）、**T7 每周通道**（默认，由管理员创建，标识 `{yyyy}W{ww}` 按开始日期所在自然周生成——含 1 月 1 日的那周为第 1 周、周一起始，同一年内按序数周；同一周只允许一个 T7）与 **Tx 特殊通道**（用于同周追加或特殊情况，标识 `{yyyy}Tx{nn}`，nn 为开始日期当年内的递增序号）。T7/Tx 均须有起止日期。
- 新建迭代只填类型与起止日期，标识由后端自动生成（前端只读预览）；T7 改开始日期时重算标识，目标周已被其它 T7 占用则拒绝。允许**创建空迭代**（不选需求）后再从迭代详情页「添加需求」。新建页默认预填下一个区间：最新 T7 结束日 +1 天为开始、+6 天为结束（周二 → 下周一），无 T7 时取最近的周二。
- 迭代**描述** `iterations.description`（text，可空且默认空，最长 200 字）由管理员在迭代列表/迭代详情页起始日期前**点击就地编辑**（`PATCH /api/iterations/{id}` 的 `description`，普通成员只读），`.md` 详情视图在概要中返回；迭代列表页每个迭代行可展开为二级折叠，懒加载并内联展示该迭代的迭代项（只读，每次展开先显示缓存再后台刷新），不再默认进入迭代详情页。
- 迭代由 **Backlog** 组成，独立于需求池：`backlogs.projectId` 记录原始需求（`projects.id`，应用层软引用）。一个需求同时只允许一个未取消的 backlog；取消后可再次转入。
- 转入/追加的**负责人机器人**（AI 或真人）可暂不指定（不创建交付任务）；指定/改派由管理员操作，指定后按负责人创建交付任务（显式 `agentId=负责人`，系统任务定义 **ID=9「迭代-Backlog交付」**），改派先取消旧交付任务再重建。已完成的交付任务取消失败只告警，不阻断改派。
- 需求选择器（新建迭代 / 追加需求）默认过滤已进入迭代的需求（存在未取消迭代项），支持名称/类型/计划周(w) 过滤；转入接口仍兜底判重（未取消即拒绝）。
- 成员角色：产品 / 业务 / 项目 / 前端 / 后端 / 测试 / 客户端；成员由管理员或迭代项负责人维护（`PATCH /api/backlogs/{id}/members` 或 `lita-work` MCP `update_backlog_members`，支持 workerId 直接选机器人、userId 或姓名选真人），转入迭代时不从需求自动带入手动成员。
- **成员统一以机器人表示**：真人用其「真人机器人」（`workers.humanUserId`），AI 用「普通机器人」；`backlogs.members` 存 `{role, workerId, name}`，不再存 userId。手动选择器可选真人（映射真人机器人）或 AI 机器人。
- **负责人/需求方自动列入成员**（系统维护、不可手动移除、不授予成员操作权限）：负责人取 `ownerWorkerId`（真人或 AI 机器人），需求方取 `projects.owner` 姓名对应的真人机器人；自动行角色为 负责人/需求方，按 `(role, workerId)` 去重，同一人不同角色显示多次。需求方在需求编辑/飞书同步变更时联动刷新该需求全部未取消迭代项的成员行。
- 成员权限按机器人判定：仅「手动成员」授予操作权限（管理员与负责人既有规则不变），自动列入的负责人/需求方只展示不入权限。
- 迭代项飞书沟通群按成员机器人进群：真人机器人 → 绑定真人 open_id，AI 机器人 → 绑定的飞书应用 app_id；成员新增（含负责人/需求方自动列入）自动拉入已有群，**只加不减**（移除成员不踢人），`feishu_bot_backlog_chats.memberWorkerIds` 跟踪已入群机器人。升级前的存量群没有成员跟踪，不能假定成员已在群内：迁移 `1801300000000` 重置既有跟踪，对账（非终态）按当前全部成员实际补拉（飞书拉人接口忽略已入群成员，重复调用安全），上线后一轮对账补齐历史遗漏成员；对账校验群存活，飞书侧已解散（`chat_status=dissolved`）或 chat_id 失效（错误码 232006）时把绑定置为 `destroyed` 并记录原因，详情页重新提供「飞书建群」。
- `lita-work` MCP 的迭代项工具与网页写能力等价（权限复用成员/负责人/管理员规则）：`get_backlog`、`update_backlog_members`、`update_backlog`（预期上线时间、负责人改派）、`change_backlog_status`（状态 + 备注）、`move_backlog`（移动迭代）、`create_backlog_task`（子任务/交付任务）、`create_backlog_release_ticket`（发起提测工单）。
- 状态：等待 → 执行 → 测试 → 发布 → 完成，允许回退与取消；由成员或管理员手动流转，记录操作人与各阶段时间；取消时联动取消未结束的交付任务。状态与任务/需求状态解耦。推进走弹窗（选状态 + 备注可空，备注写入事件流），网页两处（迭代表格/迭代项详情）共用同一弹窗组件，不再使用行内下拉。
- 迭代项有自己的标题：转入后异步用 `title-naming` 场景生成 `「BL-{id}」+ 模型标题`（乐观条件更新，失败保留需求名快照兜底，不覆盖人工修改）；迭代表格展示迭代项标题并链接 `/backlogs/{id}`（需求仅保留 `#id` 提示）。
- 属性：预期上线时间到小时（`backlogs.expectedOnlineAt`，timestamptz，北京时间展示），成员或管理员可改（`PATCH /api/backlogs/{id}`）。
- 需求方：迭代项不存储需求方，接口读取时实时引用原始需求 `projects.owner`（与负责人 `ownerWorkerId`/`ownerName` 语义不同），详情与 `.md` 视图直接展示需求侧数据。
- 文档：原始需求下的全部文档默认自动关联到迭代项（转入时迁移 + 文档新增/导入/同步后自动绑定，取消的迭代项不绑定）；文档 Tab 不提供手动关联/取消关联，可继续新建、导入；删除文档时应用层清理关联，文档本体始终归属需求。
- 事件流：`backlog_events` append-only 记录 created / status（from/to/remark）/ moved / owner（负责人 from/to/taskId）/ release-ticket（提测工单）等，`GET /api/backlogs/{id}/events`；`.md` 视图附文档清单与最近事件。
- 任务与工单面板：`GET /api/backlogs/{id}/tasks` 返回交付任务为根的任务树（含全部子任务）与相关工单（`tickets.backlogId` ∪ `tickets.taskId` ∪ `ticket_workflow_runs.taskId` 去重）。
- 提测：迭代项详情页「提测」按钮按系统工作流 `release-ticket`（代码预置，启动与迁移均按规范定义幂等发布 v1）创建工单，描述自动填入迭代项上下文、人工可补充；`tickets.backlogId` 记录关联，创建成功写 `release-ticket` 事件。提测不与迭代项/迭代状态绑定，同一迭代项可多次发起提测工单（完成、取消后仍可提测）。
- 新建任务：迭代项详情页「任务」分区「新建任务」按 `POST /api/backlogs/{id}/tasks` 处理——已有交付任务时创建其子任务（成员或管理员）；无交付任务时按所选执行机器人创建交付任务（系统任务定义「迭代-Backlog交付」）并登记迭代项负责人（仅管理员，等价于指定负责人）。
- 迭代项详情页为标准双栏布局 + 右下角可收起 AI 面板（⌥A）；内容分区为 信息 / 文档 / 任务（任务树 + 相关工单）/ 缺陷（按 `backlogId` 关联，支持页内新建）/ 话题 / 事件 / 成员，分区与 URL hash 一一对应（如 `/backlogs/{id}#topics` 直达话题，切换分区同步 `history.replaceState`）；「话题」页签显示话题数（其他页面的 `TopicsPanel` 卡片标题也显示计数）。AI 页面上下文类型 `backlog`（`agent:page:backlog:*`），`contextReadUrl` 固定 `/api/backlogs/{id}.md`。
- 迭代项成员在详情页「成员」分区内直接维护（管理员）：角色 + 成员（真人或 AI 机器人）选择后「添加」、每个手动成员「移除」，均立即调用 `PATCH /api/backlogs/{id}/members`（整体替换手动成员，负责人/需求方自动维持）。
- 支持向已有迭代追加需求、移动 backlog 到其它迭代（移动不重建交付任务与沟通群）；周迭代到期未完成的 backlog 留在原迭代，由管理员手动结转到新迭代。
- backlog 不再自动建立飞书沟通群：由成员或管理员在迭代项详情页手动「飞书建群」（`POST /api/backlogs/{id}/feishu-chat`，群名 `LitaWork-迭代-{标题} 沟通群`），拉入成员真人与负责人机器人绑定的飞书应用（负责人后续绑定由对账补拉）；已建群直接「打开飞书群」（Feishu AppLink `applink.feishu.cn/client/chat/open?openChatId=...`，仅能打开已加入的群）；完成/取消后保留 7 天自动解散，建群失败保留绑定并由对账重试（每分钟、上限 30 次），终态不再建群；迁移清理从未建成群的残留绑定。
- Agent 视图：`GET /api/iterations.md`、`GET /api/iterations/{id}.md`、`GET /api/backlogs/{id}.md`。

### 项目、文档与项目资料

- 项目类型：活动 / 功能 / 游戏 / 数据 / 后台 / 技术 / 其它。
- 项目状态：待分配 / 开发中 / 已发布 / 已关闭，**读时推导**（`projects/project-status.ts`），落库值不作为展示依据，不可手动修改：不存在未取消迭代项时按创建时间（不超过 30 天 → 待分配，超过 → 已关闭），存在时按迭代项状态（完成 → 已发布，其余 → 开发中）。飞书「需求状态」不再同步；「测试中」「暂停中」已退役（枚举类型保留旧标签，应用不再写入）。
- 文档类型：需求 / 功能 / 测试 / 技术 / 接口 / 配置 / 设计；来源为飞书、`apipost` 或 `-`（平台编写）。
- 链接型文档：「设计」类型可只存外部链接（`documents.url`，不存正文与知识库，正文编辑被拒绝）。需求池「设计链接」字段在同步时提取完整 http(s) 链接并镜像维护：同步创建的文档记 `feishuUrl` 作为同步标识，源字段不再包含的链接会被删除；平台手动创建的链接文档（`feishuUrl` 为空）不受同步影响。文档列表标题对链接型直接外链打开。
- 飞书/APIPOST 导入文档正文只读，只能从来源重新同步；`remark` 可本地编辑。AI 文档按 `(projectId, fileName)` upsert，命中外部导入文档必须拒绝。
- 普通文档 Markdown 正文可只存知识库，业务库通过 `documents.knowledgeId` 关联 `/project/{projectId}/document/{documentId}` 镜像；列表查询不得带出大正文。
- 需求摘要（`projects.summary`，≤200 字）：需求创建/飞书同步后，或「需求」类文档新增/更新后，若摘要为空且无进行中的生成，后台按「需求名称 + 描述 + 需求类文档正文」调用 `requirement-summary` 模型场景生成（`projects/project-summary.service.ts`，进程内去重、失败只告警、条件更新不覆盖人工填写）；人工可经 `PATCH /api/projects/:id` 编辑，清空后恢复自动生成；场景未配置时跳过。摘要随需求 `.md` 视图返回。
- 需求描述（`projects.description`）：需求创建/飞书同步后，或「需求」类文档新增/更新后，若描述为空且无进行中的生成，后台按「需求名称 + 需求类文档正文」调用 `requirement-description` 模型场景生成结构化 Markdown 描述（`projects/project-description.service.ts`，进程内去重、失败只告警、条件更新不覆盖人工填写）。**同步只补空值、不清空不覆盖**：飞书「需求」列只有标题时保留平台已有描述，只有源侧提供了额外正文才覆盖。
- 项目人员（原 `projects.resources`）已下线：需求只保留需求方 `projects.owner`，飞书同步不再写入人员字段。资源实体关系 `projectResources` 是独立概念（需求方提供的素材/信息登记），与人员无关，禁止混用。
- 需求方 `projects.owner`：从需求池「需求方」人员字段单向同步（多姓名顿号连接），平台内可编辑（同样校验用户系统内），下次同步被飞书侧覆盖。
- 涉及方 `projects.involvedParties`：从需求池「涉及方」多选字段（Android/iOS/H5/Backend/Admin/Data）单向同步为字符串数组，平台内可编辑（顿号/逗号分隔，不做选项校验），下次同步被飞书侧覆盖；迭代项信息区与需求/迭代项 `.md` 视图实时引用展示，不落库到 `backlogs`。
- 需求备注 `projects.remark`：由飞书「排期优先级」+「排期备注」同步合成（单行、分号分隔，均为空时清空）；平台内可编辑，下次同步覆盖；迭代项信息区只读展示该备注（实时引用需求，不落库）。
- 资源类型：配置 / 多语言 / 文件资源 / UI / 其它；状态：缺失 / 草稿 / 确认 / 废弃。「废弃」是软删除，`DELETE` 是硬删除。配置与多语言凭据未提供时只能为「缺失」或「废弃」。
- 节点状态不落库，由达成标记、实际达成日期和计划日期按北京时间日粒度推导；`achieved=yes` 自动记录实际达成日期，撤销或取消时清除。
- 删除项目必须在应用层清理其文档、资源、节点、脚本登记、运行、定时任务、提测和缺陷等关联数据；代码事件按既有规则保留。

### 脚本、运行与定时任务

- 检查、测试、导出分别使用 `.check.ts`、`.test.ts`、`.export.ts`，脚本路径相对脚本根目录，拒绝绝对路径与 `..` 穿越。
- 项目 `scriptsPath` 是脚本根目录下的相对子目录。自动导入按 `scriptPath` 判重，编号由文件名生成并处理冲突。
- 导出脚本仅扫描项目脚本目录的 `exports/` 子目录，运行追加 `--output-dir={exportWebroot()}/{exportId}/{runId}`；产物通过 `[files]` 行协议登记并下载。
- 脚本通过逐行 JSON 协议上报进度，原始输出持续累积；检查/测试运行状态为 `running/success/fail/error`。运行历史与产物清理由应用层负责。
- 定时任务运行已登记检查，支持 5 段或 6 段 cron；停用的任务不参与计划调度，但可手动触发。`nextRunAt` 和运行统计实时计算，不重复落库。
- **检查运行不再发送任何飞书群 webhook 通知**（开始/终态卡片已随群 webhook 下线移除），运行结果只在平台内展示；提测仍向测试人员与迭代项成员发机器人私聊卡片。

### 知识库

- `knowledge_nodes` 维护目录/文章树，`path` 唯一；`knowledge_chunks` 按 Markdown 标题切片并保存全文向量和 Embedding。
- 检索为全文 + Embedding 的 RRF 混合检索，支持 `path/page/pageSize`，`pageSize` 最大 100。向量不可用时降级全文；低相似纯向量候选不进入 RRF。
- `/project/**` 是项目文档系统镜像，通用知识写接口只读；`/task/**` 同样只读，任务文档必须走任务流程，避免绕过版本控制。
- Agent 知识写操作按 path 定位；目录与文章的 URL 规则不可混淆。
- 飞书云文档实时搜索已下线，不要恢复为搜索依赖；飞书文档仍可通过只读转换接口导入。

### 机器人、执行器与个人 AGENT

- `workers.id < 1000` 为代码内置系统机器人，`id >= 1000` 为自定义机器人；系统机器人不可网页新增/删除。
- 系统机器人默认不能绑定飞书应用，唯一例外是 `systemKey=feedback-handler`「系统-反馈处理」：绑定飞书应用进入用户反馈群做话题采集与分发。
- 真人机器人通过 `workers.humanUserId` 与用户唯一绑定，`runtime=human`，以人为执行器，可并行执行多个任务，不走 opencode 会话。
- AI 机器人按 `workers.maxParallelTasks`（默认 3，1 为串行）并行执行任务，达到上限后新任务保持等待；等待、待验收等非执行状态不占用执行容量。
- 机器人可配置备用模型（`workers.backupProviderId/backupModelId/backupVariant`）：主模型命中 429/限流/配额/余额/Token 用尽等限额错误时自动切换。限额识别与冷却在 `executors/model-availability.ts`，冷却按「执行器 + 供应商 + 模型」共享并固定 30 分钟（进程内内存），到期自动回主模型；与主模型相同的备用配置视为未配置。任务会话在原会话 `switchModel` 后自动续跑（每轮最多切一次），一次性会话、调试/我的 AI、工位初始化同样优先使用未冷却的模型；未配置备用或备用也失败时保持原有失败流程。
- 一次性会话（需求方自动回复/提问答复/自动验收、提测通知）不占用任务的执行容量，同一需求方机器人同一时刻只运行一个一次性会话。
- 个人 AGENT 通过 `personalAgentUserId` 唯一绑定，只服务「我的 AI」对话，不出现在对外机器人清单，不承接任务分配或工单执行，不可网页删除。
- 工位目录：production 为 `{WORKER_BASE_DIR}/worker/{id}`，其他环境为 `{WORKER_BASE_DIR}/worker-dev/{id}`。
- 机器人工位同步 `AGENTS.md`、`.opencode/skills` 和规范到 `.opencode/rules/`；技能引用技能库 `SKILL.md`（lita-work / knowledge-search / file-upload 等平台能力技能已下线，目录不再展示、保存时自动丢弃），规范引用规范库目录的 `README.md`。取消规范只清理 manifest 记录的受管文件，保留机器人自有文档。
- 工位 `.opencode/opencode.json` 由平台初始化/派发时注入 MCP 配置：固定 `lita-work`（`{APP_URL}/api/mcp/work` + 机器人令牌）与机器人勾选的自定义 MCP（管理区「MCP 配置」，`workers.mcps`），权限 600，纳入受管文件，机器人不得读取展示、改写或删除；令牌只经服务端落盘。MCP 鉴权支持固定令牌（明文落盘）、环境变量（`{env:NAME}` 占位，凭据不落盘）与机器人自身 `LITA_WORK_TOKEN`。
- opencode 集成位于 `executors/`：HTTP Basic 鉴权、会话/prompt/interrupt、SSE 事件和提问。会话终态必须匹配当前 session，不能只凭进程或连接状态判断任务完成。
- 调试会话落 `worker_debug_sessions`，按 `userId + workerId + contextKey` 唯一绑定；机器人调试、通用我的 AI、每个任务会话相互隔离，7 天不活跃重置。

### 任务处理中心

- 主状态：等待中 / 进行中 / 已结束。
- 等待中子状态：待分配 / 待接受 / 待反馈 / 待继续 / 待申请验收 / 待验收。
- 进行中子状态：执行中；已结束子状态：完成 / 已拒绝 / 失败 / 取消。
- 任务类型：普通（默认）/ 审批。审批类型仅由工单审批节点产生：创建后自动接受（不存在不接受，AI 处理人接受后直接派发执行），停留在执行中等待通过/驳回；通过可填可选意见，驳回必须填写反馈意见；审批任务不生成交付文档，通过/驳回即推进工单节点。
- 创建后为待分配，平台按任务定义分配，机器人接受后才执行。拒绝仅发生在待接受阶段并需要理由与分发建议。
- 执行中提问进入待反馈，答复进入待继续；答复提问允许任务需求方或管理员操作（管理员不改写需求方归属，事件记录实际操作人），恢复时按并行上限占用 AI 机器人，达到上限则排队。
- 待接受卡住（分配后 10 分钟仍未接受/拒绝）只提醒机器人本身：AI 机器人经会话重发带提醒的邀约，真人机器人发飞书工作台卡片；每任务最多 3 次（计数落库，重新分配时清零），北京时间 22:00~08:00 静默顺延，发送失败不计数；不通知负责人，也不自动接受或改派。
- 执行器会话最终成功后进入待申请验收并释放机器人；**会话成功不等于任务完成**，执行方必须显式申请验收。
- 需求方可验收通过、验收不通过或判失败。验收不通过始终退回原执行机器人；历史上“多次不通过转负责人”的升级逻辑已移除。
- 曾申请过验收的任务，返工后需求方仍可直接验收；从未申请验收的任务不可直接完成。
- 任务未结束时需求方与当前真人执行方均可沟通，已结束禁止。待验收时需求方发送普通消息按验收不通过处理，不能绕过状态机。
- 子任务事件通过 `task_worker_inbox` 唤醒父机器人；queued/delivered 超时、会话失败和缺失事件由 LOOP 恢复，按 2/10/30 分钟退避持续重试，不因失败次数转移需求方或执行方。父任务等待用户答复期间子任务事件保持排队，父任务恢复后由父任务答复子任务。根任务、父任务已结束或需求方不是父任务执行方的 AI 需求方，其消息回复、提问答复和自动验收统一由需求方机器人一次性会话处理，事件保持开放并持续重试，不静默丢弃。
- 真人执行方给 AI 需求方子任务发消息时写入父机器人收件箱；AI 经消息回复接口响应，可多次往返且不改变任务状态。
- 任务列表、详情和对话使用 SSE：订阅先收快照，再收任务、实时行等增量；看板不恢复定时轮询。
- 任务执行中继续发送的消息直接投递当前 opencode 会话，由 opencode 按序处理；平台不维护发送队列。opencode 接受 prompt 后才写反馈事件。
- 任务外部事件（lita-proxy 工单回调）：执行机器人经 MCP `get_task_callback_url` 领取任务级回调地址（`POST /api/tasks/{id}/external-event`，纯内网免鉴权），建单时作为 `callbackUrl` 传给 proxy；回调按「任务 + 工单 + 状态」幂等落 `task_external_events`，回合仍在执行时直投当前会话，回合已结束转「待继续」由 LOOP 恢复，任务已结束只记录不复活，暂不可投递按 2/10/30 分钟退避重试。
- 定时唤醒（`wakeups`，MCP `schedule_task_wakeup` / `cancel_task_wakeup` / `schedule_agent_wakeup` / `cancel_agent_wakeup`）：机器人自主设置「多久后唤醒我」的回访提醒，用于等待人工确认/答复、等待工单或脚本结果等长任务场景。任务唤醒仅任务当前执行机器人可设置，落库后由 `WakeupsService` 每 15 秒扫描到期投递，投递规则与外部事件一致（回合在跑直投会话、回合结束转「待继续」由 LOOP 按容量恢复、任务结束只记录），**待反馈等暂不可接收状态按 2/10/30 分钟退避等待状态变化**；「我的 AI」会话唤醒经个人 AGENT 会话投递（`agent:global` / `agent:task:{id}` / `agent:page:{type}:{hash}`，会话繁忙时退避）。每任务 / 每会话范围只保留一条 scheduled，新设置覆盖旧的；`delayMinutes`（0.5~43200）与 `wakeAt`（ISO 8601，无时区按北京时间）二选一，`note` 随唤醒消息回传。

任务定义：

- `TaskTemplate` / `task_templates` / 相关路由标识保持不变，UI 名称为「任务定义」，不要改回「任务模板」或「任务包」。
- 系统任务定义 ID 段 `< 1000`：`ID=6` 是「未知任务」兜底定义，`ID=7` 是「技术-项目开发交付」，由 `POST /api/projects/{id}/delivery-task`（或 MCP）创建实施交付任务，说明内含研发操作指南；`ID=8` 是「用户反馈处理」，由飞书反馈收录自动派单，`ID=9` 是「迭代-Backlog交付」（说明同样附研发操作指南），`ID=16` 是「技术-迭代-交付」（迭代级整体交付，负责完成该迭代内全部 Backlog 的交付，AI 与真人机器人均可承接，默认处理机器人由管理员配置）；`ID=10-15` 为已退役工单调度定义，不复用。
- 项目交付任务通过 `tasks.projectId` 与项目关联；`GET /api/projects/{id}` 返回最新任务进展，创建接口幂等。读取时兼容 `projectId` 上线前按固定描述创建的任务并自动回填关联。
- 系统机器人 `ID=2`「技术-项目经理」是交付任务定义的默认处理机器人，负责读取项目、拆分并分派子任务、验收子任务和整合父任务交付；启动时置顶绑定，其它机器人可作为兜底保留。
- 任务定义处理机器人必须存在且启用；个人 AGENT 不承接任务，保存时剔除。

任务文档：

- 任务目录为 `/task/{yyyyMMdd}/{task.code}/`，知识路径不带 `.md`，阅读名使用 `X.md`。需求明确指定文档地址时以需求为准。
- `HANDOFF` 不在创建任务时生成，由执行方开始处理后显式创建，首次 `baseVersion=0`，执行方和需求方可持续维护。
- 更新交付文档必须提交完整 `content + baseVersion`，冲突返回 409；平台维护 Frontmatter 中的文档、任务、版本和更新人。
- 申请验收只校验有效正文并锁定 `handoffSubmittedVersion`；待验收期间文档锁定，撤销交付或返工后才可编辑。
- `REVIEW` 在验收通过后异步生成，固定覆盖同一路径；失败不影响任务完成。重新生成复盘不新建重复文档或消息。
- `API.md`、`TECH_DESIGN.md` 等普通文档走任务文档接口；HANDOFF/REVIEW 不得绕过任务流程写入。

### 工单与工作流

- 新工单一律携带 `workflowDefinitionId` 创建；旧 category + 默认调度任务定义模型已退役，不要恢复。
- 发起身份：网页会话与真人机器人令牌以「用户绑定的真人机器人」为发起机器人（`createdById` 记真人）；AI 机器人可经 `lita-work` MCP `create_ticket` 以自身为发起机器人，此时 `createdById` 为空、`createdByName` 记机器人名称快照，节点任务需求方为该机器人。验收节点仅发起机器人（或其绑定用户）可操作，MCP 提供 `accept_ticket`。
- `workflow_definitions` 保存草稿与最新发布版本号，`workflow_definition_versions` 保存不可变发布版本。创建工单固定使用最新发布版本，实例继续引用创建时版本。
- 起始节点输入字段类型为 `text/textarea/number/date/select/multiselect/file`；单选与多选共用英文逗号分隔的选项配置，多选值以英文逗号拼接存入 `tickets.inputValues`，MCP 可传字符串数组；判断节点对多选只支持 `contains`（选中项包含某选项，按整项精确匹配）/`empty`/`notEmpty`。
- 节点类型为 `start/operation/approval/acceptance/condition`；流转结果为 `succeeded/failed/approved/rejected`，`$end` 是流程结束虚拟节点。判断节点不创建任务，进入后按起始输入字段的结构化条件（字段 + 运算符 + 值，多条件「且」）自动分流，必须恰好配置一条默认（无条件）分支兜底，分支可直接流转到 `$end`；单次流转链对连续判断节点有循环上限保护。
- 审批节点创建的节点任务类型为「审批」：创建后自动接受并停留执行中，真人审批人可通过/驳回（通过意见可选、驳回意见必填），也可在飞书审批卡片内一键通过；飞书审批卡片携带工单链接、关键正文与通过/驳回/查看按钮，由平台官方机器人发送。
- 发布前校验引用存在、机器人启用且非个人 AGENT、节点可达并保证路径可结束。审批驳回直接结束记为工单失败；验收驳回不可直接结束。
- 工单交付文档独立存 `ticket_documents`，链接与正文两种形态互斥。只有来源任务当前执行机器人可写；交付文档不自动改变任务状态。
- 历史工单的 `tickets.taskId` 和工作流节点任务都需兼容；旧 `ticket-route` 仅服务存量调度工单。
- 节点拒绝/失败必须按当前节点和流转规则推进，不得仅修改展示状态。

### 模型配置与 AI 标题

- 管理区「模型配置」（`model_scenarios`）按固定场景维护 OpenAI 兼容连接：`baseUrl` / `apiKey` / `model` / 思考等级（`off/low/medium/high`）。场景来自 `backend/src/model-config/model-scenarios.ts` 代码注册表，新增场景无需迁移；`apiKey` 明文落库但 `select:false`，只写不回显，列表仅返回 `hasApiKey`。
- `LlmService` 提供通用单次调用 `ask`（非流式、20s 超时、全局并发 3）与标题生成 `generateTitle`；场景未配置返回 null，由调用方降级，失败不得影响主流程。
- 工单与根任务创建后异步生成标题 `「T-{id}」+ 模型生成内容`（`title-naming` 场景，`T-` 后为数字 ID，与 code `WO-/TK-` 并存），不阻塞创建、派发与节点流转，失败只告警。更新使用乐观条件（标题仍为创建时值），不覆盖人工修改。
- 仅工单与根任务入口（`POST /api/tickets` / MCP `create_ticket`、任务 `create.md` / MCP `create_task`、项目交付任务）触发生成；子任务、工单节点任务、缺陷自动派单任务保留原结构化标题。

### 单点登录（SSO）

- 平台可作为 OAuth2 授权码模式 IdP：接入方在管理区「SSO 应用」登记（`clientId` / `clientSecret` 只写不回显、仅创建与重置时一次性返回；回调地址白名单精确匹配，未登记的 `redirect_uri` 直接 400 不回跳）。
- 协议端点 `GET /api/sso/authorize`、`POST /api/sso/token`、`GET /api/sso/userinfo` 均 `@Public` 且各自鉴权；管理端点 `/api/sso/clients*` 走全局 Guard 并要求管理员。
- authorize 未登录时把接入方参数暂存短效 Cookie（`pmp_sso_ctx`）→ 飞书登录 → callback 据此回跳 authorize 续发授权码；回跳地址由 Cookie 重建并再次完整校验，无开放重定向风险。
- 授权码一次性、10 分钟有效、绑定 user/client/redirect_uri 三元组；`access_token` 为独立 JWT（`typ=sso_access`、`aud=clientId`、密钥优先 `SSO_JWT_SECRET`，缺省从 `AUTH_JWT_SECRET` 派生），与平台会话令牌互不通用，2 小时有效，无 refresh token。
- `userinfo` 返回登录真人绑定的**真人机器人身份**（`id/name/avatarUrl` 为 `workers`，`department` 取绑定真人部门，`humanUserId` 供接入方映射），不再返回真人邮箱与飞书标识；机器人经 `ensureHumanWorker` 幂等补齐，`access_token` 本身仍绑定真人 `users.id`。

### 提测与缺陷

- 提测是创建 `ProjectRelease` 记录；重复提测追加记录，不改变需求状态（状态由迭代项/创建时间推导）。提测状态：待冒烟 / 进行中 / 已通过 / 未通过。
- 提测至少需要一名用户系统内测试人员；测试人员 + 该需求全部未取消迭代项成员的机器人私聊卡片异步发送，失败不阻断提测。
- 真实提测状态变化后记录判定人/时间；切回待冒烟或进行中时清空。机器人提测的状态变化写入其收件箱，由 LOOP 在空闲时通知。
- 缺陷状态：开放 / 修复 / 关闭；优先级：高 / 中 / 低；端：前端 / 后端 / APP端 / 未知。缺陷仅平台内维护，不回写飞书。
- 缺陷可经 `defects.backlogId` 关联迭代项（应用层软引用，可为空）：迭代项详情页「缺陷」Tab 按 `backlogId` 过滤并支持页内新建（`GET /api/defects?backlogId=`、`POST /api/defects` 带 `backlogId`）；迭代项场景新建默认不关联项目级提测（`releaseId=null`），不触发自动派单；历史缺陷保持为空，仍按项目维度可查。
- 缺陷变更记录 append-only。改开放清空修复/验证时间，改关闭记验证时间；同项目、同脚本且为修复态的缺陷在测试脚本成功后自动关闭。
- 未显式传 `releaseId` 时，仅对项目最新且有效的机器人提测自动关联并派单；显式传 ID 或 `null` 时以用户选择为准，不走自动派单。派单失败不回滚缺陷，但须写变更记录。

### 用户反馈

- 反馈（`feedbacks`）是面向全员的 BUG REPORT，独立于研发内部缺陷，不回写飞书；飞书群收录的反馈由平台自动创建「用户反馈处理」任务派给采集机器人（见下），平台内提交的反馈不自动派单；类型：BUG（默认）/ 建议 / 其它；状态：待处理（默认）/ 处理中 / 已解决 / 已关闭。
- 提交需真人登录身份（机器人令牌未绑定真人时拒绝）；提交人可在「待处理」时编辑与撤销，进入处理后仅管理员可改内容与流转状态；置已解决/已关闭补记 `resolvedAt`，退回时清空。
- 正文为 Markdown，图片复用 `/api/images` 上传（最多 9 张）；列表查询不得带出正文大字段。
- 「系统-反馈处理」机器人绑定的飞书应用将反馈群配置为「反馈采集」后：一个话题（thread）= 一条反馈（`source=飞书群`，记录 `sourceChatId/sourceThreadId/sourceMessageId`；`sourceMessageId` 存 root_id 归一的话题根消息 id，话题内回复（含 @ 机器人）按它归并判重，`(sourceChatId, sourceThreadId)` 部分唯一仅兜底并发），首帖自动建反馈并在话题内英文回执平台反馈链接，同时自动创建「用户反馈处理」任务（定义 ID=8）指派该机器人、需求方为其负责人（未配置负责人时跳过建任务并告警，`feedbacks.taskId` 回写关联），话题内后续成员消息写入 `feedback_replies` 跟帖（按消息 id 去重、图片转存 `/images`）；采集由平台确定性完成，机器人只按 PROMPT 分发规则判断（规则由管理员编辑机器人 PROMPT 补充）。系统收录的反馈 `reporterId` 可空、仅 `reporterName` 快照；删除反馈时应用层清理跟帖。

### 灵感

- 灵感（`ideas`）是独立的想法收集区，收集想法/创意/待办/建议等；类型：想法（默认）/ 创意 / 待办 / 建议 / 其它；状态：构思（默认）/ 废弃 / 采纳。不是需求池实体，也不参与任务状态机。
- 创建需真人登录身份；机器人经 `lita-work` MCP `create_idea` 创建，创建人优先落到绑定真人，未绑定真人时 `creatorId` 为空、`creatorName` 记机器人名称快照。
- 正文为 Markdown（可为空，允许快速记一句话），图片复用 `/api/images` 上传（最多 9 张）；列表查询不得带出正文大字段。
- 写入页只维护 Markdown 正文，图片走编辑器内置上传，不单独采集标题/类型/图片数组；创建时标题先用正文首行兜底，后台用 `title-naming` 场景异步生成 `「I-{id}」+ 标题`，失败不影响保存。类型保持默认「想法」，`images` 字段保留兼容。
- **构思期任何登录用户可编辑**（协作完善）；进入采纳/废弃后仅管理员可改内容。状态流转仅管理员。
- 采纳即进入需求池：`ideas.projectId` 记录关联的 `projects.id`（应用层软引用，不建物理外键），二选一——用灵感标题/正文在需求池新建需求（项目类型可选，默认其它），或关联已有需求；记录 `adoptedAt`。退回构思/废弃时清空 `adoptedAt`，`projectId` 保留作历史关联，再次采纳可重选或复用。
- 删除：管理员可删任意；创建人仅能撤销「构思」中的灵感。
- 详情/编辑页右侧「我的 AI」上下文类型为 `idea`，`contextReadUrl` 指向 `/api/ideas/{id}.md`；AI 可通过 `lita-work` MCP `create_idea` 创建、`update_idea` 完善正文、`delete_idea` 删除（删除遵循管理员/创建人构思期权限），采纳动作走 `change_idea_status`（仅管理员身份可用）。新建页尚无真实 ID，使用 `idea:new` 临时会话并注入当前草稿，可先协助梳理/扩写，也可按用户明确要求调用 `create_idea`；保存后切换到真实灵感会话。

### 话题

- 话题（`topics`）是挂在主体（迭代项/缺陷/任务/工单/需求）下的讨论串，主体为 `subjectType + subjectId` 应用层软引用；缺陷/需求页展示为「讨论」，其余展示为「话题」，不新增业务分区导航入口（从主体详情与 `/topics` 深链进入）。话题详情深链为 `/{主体}/{主体ID}/topics/{话题ID}`（`backlogs` / `requirements` / `tasks` / `tickets` / `defects`，飞书卡片统一使用，由后端 `topicWebPath` 生成）：前端落在主体详情页的「话题/讨论」分区并自动展开定位焦点话题；缺陷短链由前端解析所属需求后跳到 `/projects/{projectId}/defects/{defectId}/topics/{topicId}`，旧链接 `/topics/{话题ID}` 按主体解析后重定向，不提供独立话题详情页。
- 标题可空：创建时用正文首行兜底，后台用 `title-naming` 场景异步生成 `「TP-{id}」+ 标题`（乐观条件更新不覆盖人工修改）；优先级 高/中/低（默认中）；标签自由输入（最多 10 个，前端联想已有标签）。
- 正文与帖子输入为纯文本（不提供 Markdown 编辑，图片随编辑器上传一并下线），展示侧按 Markdown 渲染；帖子 append-only，平铺楼层 + `replyToPostId` 引用；状态 开放/已解决/已关闭，已关闭禁止新帖，创建人或管理员可流转；删除话题/帖子仅管理员，应用层清理帖子、关注、机器人收件箱与飞书绑定。
- @ 机器人记录 `workers.id` 数组：@ 真人机器人给其绑定真人发官方机器人私聊卡片；@ AI 机器人写 `topic_worker_inbox`，`TopicLoopService` 用一次性会话（与任务需求方共用 per-worker 互斥锁）读取 `/api/topics/{id}.md` 后经 MCP `reply_topic` 回帖，未回帖按 2/10/30 分钟退避、5 次后置 dead。
- 关注（`topic_follows`）：新帖以官方机器人私聊卡片通知关注人（排除发帖人），个人中心「我关注的话题」可查；同一条帖子对同一用户只发一次（@ 优先）。
- 飞书双向同步：主体有群（迭代沟通群/任务群/需求项目沟通群；缺陷与工单无群）时，首楼作为群内话题根卡片，平台帖子以回复落入同一话题（图片上传为 image_key，失败降级链接）；绑定话题内的群消息回流为 `topic_posts`（来源=飞书群，按 `(topicId, sourceMessageId)` 去重，**不再回传**），@ 机器人同样触发通知/答复；机器人自身消息与飞书来源帖子不回传，防回声。
- 机器人身份：普通 AI 机器人以自身身份参与（`creatorWorkerId`/`authorWorkerId`）；个人 AGENT 与真人机器人落到绑定真人（`creatorUserId`/`authorUserId`）。
- Agent 视图：`GET /api/topics.md`、`GET /api/topics/{id}.md`，主体 `.md` 视图附话题清单；`lita-work` MCP 提供 `list_topics` / `get_topic` / `create_topic` / `reply_topic` / `update_topic`。前端话题列表为折叠式：展开后展示首楼、缩进帖子与行内回复框，关注/编辑/删除在折叠区内完成，不提供独立话题详情页；`TopicsPanel` 卡片标题与迭代项详情页「话题」页签均显示话题计数（`onCountChange` 回调）。

### GitHub 与凭证网关

- GitHub 仅支持 `GITHUB_ORG` 指定组织；忽略状态仓库不出现在仓库/分支联想和新登记候选中，存量登记与事件保留。
- 项目分支按 `(projectId, repo, branch)` 唯一；代码事件按 `(repo, branch, sha)` 唯一且 append-only，与项目无外键。
- 新提交先入库再发 `CODE_EVENT_BUS`；首次基线事件可被后续动作跳过。单目标失败不阻断其他目标。
- OP Gateway 凭证申请必须同时校验共享网关令牌和机器人令牌，按权限档位发放短租期凭证。响应与错误均 `no-store`，敏感响应不透传给 AI，审计不保存 Token/PAT。
- 资源网关权限存 `workers.resourcePermission`，与 `githubPermission` 独立：`write` 可访问全部资源、`read` 仅可访问 `readOnly` 资源、`none` 无权限且默认。内部验权接口只返回权限，不发放凭证；实时校验，不缓存结果。验权只接受机器人令牌，真人身份使用其真人机器人令牌并按该机器人的权限判定。

### 飞书与 Appium

- **飞书文档/项目同步永远单向：飞书 → 平台**。`FeishuService` 只读，任何回写飞书都是需求变更。
- 飞书 tenant token 与 OAuth 网页登录统一使用数据库配置的「平台官方机器人」应用凭据（`feishu_bot_configs` kind=official，Secret 加密落库），后端定时刷新；不再使用 LITA_USER_TOKEN、环境变量 `FEISHU_APP_ID`/`FEISHU_APP_SECRET` 或静态 token。官方机器人应用需在飞书后台开启「网页授权登录」并具备文档/多维表格/通讯录/消息权限。
- 文档导入统一转 Markdown；判重包含 doc/sheet/table 子标识。wiki 先解析实际资源，sheet/table/view 等查询参数需透传。
- bitable `records/search` 必须传 `automatic_fields: true`，增量同步依赖记录级修改时间。
- 文档评论导入失败、无权限或单条记录失败只告警，不阻断整体同步。
- 飞书 Bot 优先 WebSocket 长连接，公开回调为可选通道；事件需校验并去重。私聊网页会话与飞书会话隔离，未识别用户不投递 Agent。
- 任务通知（待处理、待验收、提醒、审批卡片）统一以平台官方机器人身份发送；官方机器人未配置或发送失败时不再回退旧自建应用通道，仅记录告警。审批卡片「通过」走卡片回调（身份映射为平台用户后复用工单审批权限），「驳回」跳转工单页填写必填意见。
- 升级兜底（执行失败、执行中长时间无进展、父机器人自动答复失败）在 AI 机器人需求方无绑定用户时，改为通知任务关联工单的创建人（节点任务经 `ticket_workflow_runs` 反查，兼容存量 `tickets.taskId`）；无工单关联或创建人无飞书 openId 时静默跳过，不再回退机器人负责人。
- 任务群仅覆盖当前支持的「一个真人 + 一个 AI 机器人」根任务；群消息仍进入任务状态机，不绕过任务操作接口。项目交付任务使用独立项目沟通群，不再创建双人任务群。
- 机器人绑定的飞书应用被拉入外部群（不含任务群/项目沟通群）时记录进/出群事件，并按群策略处理消息：默认「仅被@后反馈」，可逐群覆盖为「智能反馈」（AI 判定无需回复时仅输出 `[不回复]`，不发送群消息）或「仅记录」；「系统-反馈处理」机器人的飞书配置另支持「反馈采集」策略，仅在群策略页「收录群」勾选批量设置（不可设为默认策略、不走单群下拉）：一个话题自动收录为一条平台反馈、话题内后续成员消息收录为跟帖（见「用户反馈」），收录后按智能模式的批次唤起机器人判断分发，非话题消息仅记录；群会话按 `feishu:group:{chatId}` 共享（固定虚拟属主，与真人会话隔离），群记录保留 30 天。话题消息（事件带 `thread_id`）按话题独立会话 `feishu:group:{chatId}:t:{threadId}`，机器人回执与提问卡片统一走回复接口落回原话题（普通群的引用回复同样以引用形式回执）；会话首条注入通道/场景（群聊或话题）/群/话题上下文。智能反馈按时间片（5 秒）+ 条数（10 条）批量投递，格式为 `[发送者|消息ID] 内容`（多条用 `---` 分隔），回复用「`>>> 消息ID`」定向回复某条消息；「仅被 @」策略下触发时补拉最近的话题/群聊消息作为上文（只保留机器人最后一次回复之后的消息），需要应用具备消息读取权限（`im:message` 等），拉取失败只降级不阻断。`lita-work` 提供 `feishu_history` 工具，仅开放机器人所在会话最近 7 天的消息。
- **平台名义发送飞书消息**：`POST /api/feishu-bot/messages`（网页管理员）、`POST /api/feishu-bot/messages.md`（机器人令牌，返回 Markdown）与 `lita-work` MCP `feishu_send_message` 统一以平台官方机器人身份发送 Markdown 卡片，收件人为平台用户（自动解析官方应用 open_id，回退登录 openId）、指定 open_id 或群 chat_id；机器人令牌或管理员（含公共 Agent）可发送，普通成员不可。每次发送（含失败）写入 `feishu_bot_official_messages` 审计表，管理员可经 `GET /api/feishu-bot/messages` 分页查看（不含正文大字段）。
- 项目交付任务（`POST /api/projects/{id}/delivery-task` / MCP）创建后同步建立项目沟通群，群名为 `LitaWork-需求-{项目名} 沟通群`，拉入需求方、该需求未取消迭代项成员和可用的平台机器人。群内同步根任务与直接子任务状态；根任务进入完成/失败/取消/已拒绝任一终态后保留 7 天自动解散，建群和通知失败由定时对账重试。
- Appium Agent 通过 WS `/api/ws` 连接；远程运行前校验模拟器和 APP。APP 安装/卸载与远程任务互斥，Agent 错误映射为可读响应。

## 修改与验证

1. 先定位实体、服务、控制器和现有测试，遵循当前模块的结构与命名，不另起平行实现。
2. 修改枚举、身份、状态机、鉴权、文档版本或删除逻辑时，同时检查前后端、Agent `.md` 接口和存量数据兼容。
3. 修改生产数据结构必须提供 migration；修改共享 UI 行为时同步检查 `docs/UI_STANDARD.md`。
4. 优先运行覆盖变更的现有测试，再运行 `pnpm build`、`pnpm lint`；仅文档变更至少检查 diff 与格式。
5. 不为了通过检查删除测试、绕过鉴权或缩小需求；无法验证的部分明确说明。
