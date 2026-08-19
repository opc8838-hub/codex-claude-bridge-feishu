[**English**](./README.md) | 中文

> **更新（2026-08-19）：** 飞书桥最新已支持 **Grok Build CLI**。  
> 新仓库 → **[feishu-grok-bridge](https://github.com/opc8838-hub/feishu-grok-bridge)**（独立机器人 + 独立进程）。  
> 本仓继续维护 Claude Code + Codex。

# codex-claude-bridge-feishu

> 📱💻 飞书/Lark AI 编程助手桥接 — 同时支持 **Claude Code** & **OpenAI Codex**。手机上写代码、修 Bug、重构项目。

一个轻量级 Node.js 守护进程，把飞书消息桥接到本地 AI 编程助手。飞书发消息，Agent 在项目目录里执行，思考和工具调用以实时流式卡片回传。

**双 Agent，一套桥接。** Claude Code 用 `@anthropic-ai/claude-agent-sdk`，Codex 用 `@openai/codex-sdk` — 命令相同、卡片相同、体验相同。

---

## ✨ 亮点

### 🚀 一条命令安装

```bash
npm i -g codex-claude-bridge-feishu
codex-bridge setup && codex-bridge run
```

不用 git clone，不用手动配置。交互式引导，一分钟跑起来。

### 🔗 共享你的 Agent

授权后别人也能和你的 Claude/Codex 聊天：

```
/invite user @张三     → 私信权限
/invite group          → 本群所有人可用
/invite admin @李四    → 管理权限
```

你的 Agent，你说了算。默认私有，只有创建者能用。

### 💬 `/newchat` — 自动拉群，一个话题一个群

```
/newchat 修复登录Bug
```

机器人**自动拉群**、拉你进群、绑定独立会话。一个话题一个群，不用手动建群。给 AI 群打标签，飞书就是你的终端。

### 🤖 双 Agent — Claude Code + Codex

| Agent | Provider | 说明 |
|-------|----------|------|
| **Claude Code** | `claude-provider.ts` | DeepSeek / Anthropic API 兼容 |
| **OpenAI Codex** | `codex-provider.ts` | ChatGPT / Codex 订阅 或 API Key |

一套安装，两个 Agent。命令相同、卡片相同、体验相同。

### 📌 工作区书签

```
/ws save 前端    → 收藏当前项目目录
/ws use 前端     → 一键切换
```

五个项目来回切，不用记路径。

### 🧠 智能输出 — COT 模式

```
/cot brief    → 卡片显示工具摘要，干净结果单独发
/cot detailed → 完整过程卡片 + 单独结果
```

不用在一堆工具调用里翻找最终答案。

### ⚡ 实时流式卡片

工具调用、文件编辑、命令输出 — 在飞书 CardKit v2 卡片里实时直播。看着 Agent 干活。

### 🔒 本地运行，不走云

Agent 在你电脑上跑。数据不出本机，不走云中转。访问控制、密钥脱敏、加密传输。

---

## 🏗️ 工作原理

```
┌──────────┐    WebSocket      ┌──────────────────┐    SDK spawn     ┌───────────┐
│  飞书 Bot │ ◀══════════════▶  │  Bridge Daemon   │ ──────────────▶ │  AI Agent │
│          │   长连接实时推送    │   (Node.js)      │   子进程        │  (本地)   │
│  📱→📤   │                   │                  │ ◀────────────── │           │
│  📥←📲   │   流式卡片+文本    │  config.env       │   JSON/SSE     │ Claude/   │
│          │                   │  session store    │   stream        │ Codex     │
│          │                   │  per-chat bindings│                 │           │
└──────────┘                   └──────────────────┘                 └───────────┘
```

### 详细流程

1. **消息到达** — 飞书通过 WebSocket 长连接推送 `im.message.receive_v1` 事件
2. **桥接路由** — `bridge.ts` 解析每群绑定（chatId → sessionId），检查斜杠命令，然后交给对话引擎
3. **启动 Agent** — Provider（`claude-provider.ts` 或 `codex-provider.ts`）通过 SDK 在工作目录启动 Agent
4. **事件流** — Agent 输出文字增量、工具调用、工具结果、用量信息
5. **SSE 转换** — Provider 把 Agent 事件转成统一 SSE 格式（`text`、`tool_use`、`tool_result`、`result`）
6. **卡片渲染** — `conversation.ts` 聚合 SSE 事件，构建流式 Feishu CardKit 卡片
7. **实时更新** — 卡片增量通过 REST API 推送飞书，用户看实时进度

### 技术栈

| 层 | 技术 |
|-------|-----------|
| 运行时 | Node.js >= 20 |
| 语言 | TypeScript (strict) |
| Agent SDK | `@anthropic-ai/claude-agent-sdk` 或 `@openai/codex-sdk` |
| 飞书 SDK | `@larksuiteoapi/node-sdk` |
| 打包 | esbuild (零配置) |
| 持久化 | JSON 文件 (`.bridge/data/`) |
| 流式 | Feishu CardKit v2 (流式卡片) |

---

## 📦 安装

### 前置条件

- **Node.js >= 20** — `node --version`
- **AI Agent CLI**（二选一）：
  - **Claude Code**：安装并配置 `claude --version`
  - **Codex CLI**：`npm install -g @openai/codex` 然后 `codex login`
- **飞书自建应用** — 见下方 [飞书配置](#-飞书应用配置)

### 快速安装（npm 全局安装）

```bash
npm i -g codex-claude-bridge-feishu
codex-bridge setup           # 创建 config.env
codex-bridge run             # 前台启动
codex-bridge start           # 后台服务（PM2）
```

### 手动安装（git clone）

```bash
git clone https://github.com/opc8838-hub/codex-claude-bridge-feishu.git
cd codex-claude-bridge-feishu
npm install
npm run build
```

### 配置

编辑生成的 `config.env`（或从示例复制）：

```bash
# ── 必填 ──
CTI_FEISHU_APP_ID=cli_xxxxxxxxxx
CTI_FEISHU_APP_SECRET=xxxxxxxxxxxxxx
CTI_DEFAULT_WORKDIR=/home/me/projects

# ── 可选 ──
CTI_DEFAULT_MODE=code                   # code | plan | ask
CTI_FEISHU_DOMAIN=feishu                # feishu | lark
CTI_FEISHU_REQUIRE_MENTION=true         # 非 /newchat 群的默认行为
CTI_COT_MODE=off                        # off | brief | detailed
CTI_AUTO_APPROVE=true

# ── AI Agent（二选一）──
# Claude Code：
ANTHROPIC_AUTH_TOKEN=sk-xxx
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic

# 或 Codex：
# OPENAI_API_KEY=sk-xxx
```

### 启动

```bash
# npm 全局安装
codex-bridge run

# 或 git 安装
npm start

# PM2（推荐生产环境）
pm2 start ecosystem.config.cjs
pm2 save
```

### 验证

```
[info]: client ready
[info]: event-dispatch is ready
[info]: ws client ready
```

---

## 🔧 飞书应用配置

1. [飞书开放平台](https://open.feishu.cn/app) → **创建企业自建应用**
2. 开启 **机器人** 能力
3. **事件与回调** → **使用长连接接收事件**（WebSocket）
4. 订阅事件：`im.message.receive_v1`
5. 添加权限：
   - `im:message` — 发送消息
   - `im:message.receive_v1` — 接收消息
   - `im:message:readonly` — 读取消息
   - `im:resource` — 上传/下载文件
   - `im:chat` / `im:chat:create` / `im:chat:read` / `im:chat:update` — 创建和管理群（`/newchat` 需要）
   - `im:chat.members:read` / `im:chat.members:write_only` — 管理群成员
   - `im:message.reactions:write_only` — 输入中状态
   - `cardkit:card` — 流式卡片
6. **发布** 并激活

---

## 📖 使用指南

### `/newchat` — 创建话题群

```
/newchat 视频封面生成器
/newchat 数据库优化 帮我分析慢查询并给出优化建议
```

创建新飞书群并绑定独立 Agent 会话。群内所有消息对 Agent 可见（无需 @提及）。每个群独立——五个群、五个并行会话。

### 每群 @提及 控制

```
/mention off   # Agent 看到所有消息（/newchat 群的默认行为）
/mention on    # Agent 只响应 @机器人 的消息
/status        # 显示当前设置，包括 @提及 状态
```

### 完整命令参考

| 命令 | 说明 |
|------|------|
| `/newchat <名称> [描述]` | **创建新群 + 会话** |
| `/new [路径]` | 在当前聊天中开启新会话 |
| `/mention on\|off` | 切换每群 @提及 要求 |
| `/resume <id>` | 恢复之前的会话 |
| `/list` | 查看最近会话 |
| `/bind <session_id>` | 绑定到已有会话 |
| `/cwd /路径` | 切换工作目录 |
| `/mode code\|plan\|ask` | 切换 Agent 模式 |
| `/status` | 显示会话状态、CWD、模型、@提及 |
| `/stop` | 停止当前运行中的任务 |
| `/perm allow\|deny <id>` | 响应权限请求 |
| `/help` | 显示所有命令 |

### 记忆层

桥接器维护 `~/.codex-bridge-memory.md`（Codex）或 Claude 原生记忆系统 — 跨会话持久上下文。Agent 自动读取和更新。

### 群聊协作

- **一个群 = 一个话题** — 用 `/newchat` 创建专属群
- **给群打标签** — 在飞书里给 AI 群加标签（如 "Claude"），一键筛选
- **多 Agent 并行** — Claude 和 Codex 机器人同时运行，各自在不同群里

---

## 🏛️ 架构

```
src/
├── main.ts              # 入口，进程生命周期，看门狗
├── config.ts            # config.env 加载器
├── types.ts             # 共享 TypeScript 类型和接口
├── claude-provider.ts   # Claude Code SDK → 统一 SSE 流
├── codex-provider.ts    # Codex SDK → 统一 SSE 流
├── conversation.ts      # SSE → 流式 CardKit 卡片（不依赖具体 Provider）
├── bridge.ts            # 消息路由，斜杠命令，/help
├── feishu.ts            # 飞书 WebSocket + REST API（建群、加成员）
├── feishu-markdown.ts   # Markdown → 飞书 CardKit JSON 转换
├── store.ts             # JSON 文件会话和绑定存储 (.bridge/data/)
├── permissions.ts       # 待处理权限/批准队列
├── delivery.ts          # 流式发送（限速/分块/重试）
├── validators.ts        # 输入验证和清理
├── session-scanner.ts   # 发现本地已有 CLI 会话
└── logger.ts            # 结构化日志（自动脱敏密钥）
```

### 设计原则

- **每群会话隔离** — `bindings.json` 映射 `feishu:{chatId}` → `sessionId`。每个私聊和群聊有独立的 Agent 会话，对话历史互不干扰。
- **Provider 抽象** — 切换 `claude-provider.ts` ↔ `codex-provider.ts`。两者输出相同的统一 SSE 格式。
- **卡片流式引擎** — `conversation.ts` 不依赖具体 Provider，只消费 SSE 事件渲染流式卡片。

---

## 🚀 对比

| 功能 | Bridge | 纯 CLI |
|------|--------|--------|
| 手机访问 | ✅ 飞书 | ❌ 仅终端 |
| `/newchat` — 一个话题一个群 | ✅ | ❌ |
| 群聊协作 | ✅ 拉机器人进群 | ❌ |
| 每群 @提及 控制 | ✅ `/mention on\|off` | ❌ |
| 多轮会话 | ✅ `/resume` | ✅ |
| 流式响应 | ✅ 实时卡片 | ✅ 终端 |
| 会话管理 | ✅ `/list`、`/bind`、`/status` | ❌ |
| 多 Agent（Claude + Codex） | ✅ 同一代码库 | ❌ |
| 跨会话记忆 | ✅ 持久上下文 | ❌ |

---

## 🔒 安全

- **本地执行** — AI Agent 在你本地运行，不走云中转。
- **密钥脱敏** — 日志自动过滤 `token`、`secret`、`password`、`api_key`。
- **访问控制** — `CTI_FEISHU_ALLOWED_USERS` 白名单。
- **自动批准** — 推荐 `CTI_AUTO_APPROVE=true`，适合无人值守使用。

---

## 📄 开源协议

MIT
