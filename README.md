# codex-claude-bridge-feishu

> 📱💻 AI coding agent bridge for Feishu/Lark — supports **OpenAI Codex** & **Claude Code**. Code, debug, and refactor from your phone.

A lightweight Node.js daemon that bridges Feishu/Lark to your local AI coding agent. Send a message in Feishu, the agent executes in your project directory, and responses stream back as real-time cards with live progress, tool calls, and token usage.

**Now supports Claude Code** (`@anthropic-ai/claude-code`) with the same feature set — just swap `codex-provider.ts` for `claude-provider.ts`.

---

## ✨ Highlights

### 🆕 `/newchat` — One Topic, One Group, One Session

No more messy terminal tabs. In Feishu:

```
/newchat 修复登录Bug
```

The bot **creates a new group**, adds you, and binds a fresh agent session — one topic per group. Tag all your AI groups for one-click filtering. Your Feishu becomes your terminal.

### 🆕 `/mention on|off` — Per-Group @ Control

Each group can independently toggle the @mention requirement:

```
/mention off   # All messages visible to the agent — full context awareness
/mention on    # Only @bot messages trigger responses
```

Groups created via `/newchat` default to `off` — the agent sees everything.

### 🆕 Dual Agent Support — Claude Code + Codex

| Agent | Provider | Notes |
|-------|----------|-------|
| **Claude Code** | `claude-provider.ts` | DeepSeek / Anthropic API compatible |
| **OpenAI Codex** | `codex-provider.ts` | ChatGPT / Codex subscription or API key |

Same bridge codebase, same commands, same streaming cards. Swap agents by running from a different directory with a different `config.env`.

---

## 🏗️ How It Works

```
┌──────────┐    WebSocket      ┌──────────────────┐    SDK spawn     ┌───────────┐
│  Feishu  │ ◀══════════════▶  │  Bridge Daemon   │ ──────────────▶ │  AI Agent │
│   Bot    │   persistent      │   (Node.js)      │   subprocess    │  (local)  │
│          │   connection      │                  │ ◀────────────── │           │
│  📱→📤   │                   │  config.env       │   JSON/SSE     │ Claude/   │
│  📥←📲   │   streaming       │  session store    │   stream        │ Codex     │
│          │   cards + text    │  per-chat bindings│                 │           │
└──────────┘                   └──────────────────┘                 └───────────┘
```

### Detailed Flow

1. **Message arrives** — Feishu pushes `im.message.receive_v1` event through persistent WebSocket
2. **Bridge routes** — `bridge.ts` resolves the per-chat binding (chatId → sessionId), checks slash commands, then delegates to the conversation engine
3. **Agent starts** — Provider (`claude-provider.ts` or `codex-provider.ts`) spawns the agent via its SDK in the working directory
4. **Events stream** — Agent emits text deltas, tool calls, tool results, and usage info
5. **SSE conversion** — Provider translates agent events into a unified SSE format (`text`, `tool_use`, `tool_result`, `result`)
6. **Card rendering** — `conversation.ts` aggregates SSE events and builds streaming Feishu CardKit cards
7. **Real-time updates** — Each card patch is delivered to Feishu via REST API, giving users live progress

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js >= 20 |
| Language | TypeScript (strict) |
| Agent SDK | `@anthropic-ai/claude-agent-sdk` or `@openai/codex-sdk` |
| Feishu SDK | `@larksuiteoapi/node-sdk` |
| Bundler | esbuild (zero-config) |
| Persistence | JSON files in `.bridge/data/` |
| Streaming | Feishu CardKit v2 (streaming cards) |

---

## 📦 Installation

### Prerequisites

- **Node.js >= 20** — `node --version`
- **AI Agent CLI** (pick one):
  - **Claude Code**: install and configure via `claude --version`
  - **Codex CLI**: `npm install -g @openai/codex` then `codex login`
- **Feishu self-built app** — see [Feishu Setup](#-feishu-app-setup) below

### Install

```bash
git clone https://github.com/opc8838-hub/codex-claude-bridge-feishu.git
cd codex-claude-bridge-feishu
npm install
npm run build
```

### Configure

```bash
cp config.env.example config.env
```

Edit `config.env`:

```bash
# ── Required ──
CTI_FEISHU_APP_ID=cli_xxxxxxxxxx
CTI_FEISHU_APP_SECRET=xxxxxxxxxxxxxx
CTI_DEFAULT_WORKDIR=/home/me/projects

# ── Optional ──
CTI_DEFAULT_MODE=code                   # code | plan | ask
CTI_FEISHU_DOMAIN=feishu                # feishu | lark
CTI_FEISHU_REQUIRE_MENTION=true         # Default for non-/newchat groups
CTI_AUTO_APPROVE=true

# ── AI Agent (choose one) ──
# Claude Code:
ANTHROPIC_AUTH_TOKEN=sk-xxx
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic

# OR Codex:
# OPENAI_API_KEY=sk-xxx
```

### Start

```bash
# Foreground (testing)
npm start

# PM2 (recommended for production)
pm2 start ecosystem.config.cjs
pm2 save
```

### Verify

```
[info]: client ready
[info]: event-dispatch is ready
[info]: ws client ready
```

---

## 🔧 Feishu App Setup

1. [Feishu Open Platform](https://open.feishu.cn/app) → **Create enterprise self-built app**
2. Enable **Bot** capability
3. **Events & Callbacks** → **Use persistent connection** (WebSocket)
4. Subscribe to event: `im.message.receive_v1`
5. Add permissions:
   - `im:message` — Send messages
   - `im:message.receive_v1` — Receive messages
   - `im:message:readonly` — Read messages
   - `im:resource` — Upload/download files
   - `im:chat` / `im:chat:create` / `im:chat:read` / `im:chat:update` — Create & manage groups (for `/newchat`)
   - `im:chat.members:read` / `im:chat.members:write_only` — Manage group members
   - `im:message.reactions:write_only` — Typing indicator
   - `cardkit:card` — Streaming cards
6. **Publish** and activate

---

## 📖 Usage

### `/newchat` — Create Topic Groups

```
/newchat 视频封面生成器
/newchat 数据库优化 帮我分析慢查询并给出优化建议
```

Creates a new Feishu group with a dedicated agent session. All messages in the group are visible to the agent (no @mention needed). Each group is independent — five groups, five parallel sessions.

### Per-Group @Mention Control

```
/mention off   # Agent sees all messages (default for /newchat groups)
/mention on    # Agent only responds when @mentioned
/status        # Shows current settings including @mention status
```

### Full Command Reference

| Command | Action |
|---------|--------|
| `/newchat <name> [desc]` | **Create new group + session** |
| `/new [path]` | Start fresh session in current chat |
| `/mention on\|off` | Toggle @mention requirement per group |
| `/resume <id>` | Resume a previous session |
| `/list` | Show recent sessions |
| `/bind <session_id>` | Bind to existing session |
| `/cwd /path` | Change working directory |
| `/mode code\|plan\|ask` | Switch agent mode |
| `/status` | Show session status, CWD, model, @mention |
| `/stop` | Stop current running task |
| `/perm allow\|deny <id>` | Respond to permission request |
| `/help` | Show all commands |

### Memory Layer (Codex)

The bridge maintains `~/.codex-bridge-memory.md` — persistent cross-session context. The agent reads and updates it automatically.

### Group Collaboration

- **One group = one topic** — use `/newchat` to spin up dedicated groups
- **Tag your groups** — add a label (e.g. "Claude") in Feishu for one-click filtering
- **Multi-agent** — run both Claude and Codex bots simultaneously, each in their own groups

---

## 🏛️ Architecture

```
src/
├── main.ts              # Entry point, process lifecycle, watchdog
├── config.ts            # config.env loader
├── types.ts             # Shared TypeScript types & interfaces
├── claude-provider.ts   # Claude Code SDK → unified SSE stream
├── codex-provider.ts    # Codex SDK → unified SSE stream
├── conversation.ts      # SSE → streaming CardKit cards (provider-agnostic)
├── bridge.ts            # Message router, slash commands, /help
├── feishu.ts            # Feishu WebSocket + REST API (chat create, members)
├── feishu-markdown.ts   # Markdown → Feishu CardKit JSON converter
├── store.ts             # JSON-file session & binding store (.bridge/data/)
├── permissions.ts       # Pending permission/approval queue
├── delivery.ts          # Stream delivery with rate limiting
├── validators.ts        # Input validation & sanitization
├── session-scanner.ts   # Discover existing CLI sessions on disk
└── logger.ts            # Structured logging with secret redaction
```

### Key Design

- **Per-chat session isolation** — `bindings.json` maps `feishu:{chatId}` → `sessionId`. Every DM and group has an independent agent session with isolated conversation history.
- **Provider abstraction** — swap `claude-provider.ts` ↔ `codex-provider.ts`. Both emit the same unified SSE format.
- **Card streaming engine** — `conversation.ts` is provider-agnostic, consuming SSE events and rendering streaming CardKit cards.

---

## 🚀 Quick Comparison

| Feature | Bridge | CLI Alone |
|---------|--------|-----------|
| Access from phone | ✅ Feishu | ❌ Terminal only |
| `/newchat` — one topic per group | ✅ | ❌ |
| Group collaboration | ✅ Invite bot | ❌ |
| Per-group @mention control | ✅ `/mention on\|off` | ❌ |
| Multi-turn sessions | ✅ `/resume` | ✅ |
| Streaming response | ✅ Real-time cards | ✅ Terminal |
| Session management | ✅ `/list`, `/bind`, `/status` | ❌ |
| Multi-agent (Claude + Codex) | ✅ Same codebase | ❌ |
| Cross-session memory | ✅ Persistent context | ❌ |

---

## 🔒 Security

- **Local execution** — AI agent runs on your machine. No cloud proxy.
- **Secret redaction** — Logger strips `token`, `secret`, `password`, `api_key` from logs.
- **Access control** — `CTI_FEISHU_ALLOWED_USERS` whitelist.
- **Auto-approve** — `CTI_AUTO_APPROVE=true` recommended for unattended use.

---

## 📄 License

MIT
