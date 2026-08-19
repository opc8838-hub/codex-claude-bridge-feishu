[**中文**](./README.zh.md) | English

# Feishu Agent Bridge

**One repo. Three Feishu bots: Grok · Claude Code · Codex.**

> 📱💻 Latest: **Grok Build CLI** is a first-class agent. Same cards, same commands, same daemon — pick the bot with `CTI_AGENT`.

A Node.js daemon that bridges Feishu/Lark to a **local** coding agent. Send a message in Feishu; the agent runs in your project; replies stream back as CardKit v2 cards.

This is the **only** bridge you need. Do not run `feishu-grok-bridge` or the archived Claude-only repo as a second product — they redirect here.

| Feishu bot | `CTI_AGENT` | Local CLI | Auth |
|------------|-------------|-----------|------|
| **Grok** (latest) | `grok` | `grok` | `grok login` → `~/.grok/auth.json` |
| Claude Code | `claude` | `claude` | `claude auth login` or `ANTHROPIC_*` |
| OpenAI Codex | `codex` | `codex` | `codex login` or `OPENAI_API_KEY` |

**Three bots = three Feishu apps + three processes**, one codebase:

```bash
# Bot 1 — Grok
CTI_AGENT=grok   CTI_CONFIG_PATH=config.grok.env   CTI_HOME=.bridge-grok   node dist/daemon.mjs

# Bot 2 — Claude
CTI_AGENT=claude CTI_CONFIG_PATH=config.claude.env CTI_HOME=.bridge-claude node dist/daemon.mjs

# Bot 3 — Codex
CTI_AGENT=codex  CTI_CONFIG_PATH=config.codex.env  CTI_HOME=.bridge-codex  node dist/daemon.mjs
```

Each `config.*.env` has its **own** `CTI_FEISHU_APP_ID` / `SECRET` (do not share one bot across agents).

---

## ✨ Highlights

- **`/newchat`** — bot creates a group and binds a session (one topic, one chat)
- **Streaming cards** — tools, edits, usage live in CardKit v2
- **Permissions** — allow once / session / deny (`1` `2` `3`)
- **`/ws`** workspace bookmarks, **`/invite`** access control, **`/cot`** clean vs detailed output
- **Local-first** — agent stays on your machine

---

## 📦 Install

```bash
git clone https://github.com/opc8838-hub/codex-claude-bridge-feishu.git
cd codex-claude-bridge-feishu
npm install
npm run build
cp config.env.example config.env
```

Edit `config.env`:

```bash
CTI_AGENT=grok
CTI_FEISHU_APP_ID=cli_xxxxxxxx
CTI_FEISHU_APP_SECRET=xxxxxxxx
CTI_DEFAULT_WORKDIR=/path/to/project
CTI_AUTO_APPROVE=false
```

```bash
npm run dev      # or npm start
```

Or globally:

```bash
npm i -g codex-claude-bridge-feishu
codex-bridge setup && codex-bridge run
```

### Prerequisites

- Node.js >= 20
- The CLI for the agent you pick (`grok --version` / `claude --version` / `codex --version`)
- One Feishu enterprise self-built app **per bot** (Bot capability, long-connection events, `im.message.receive_v1`, `cardkit:card`, `im:chat*`, `im:resource`)

---

## 💬 Commands

`/newchat` `/new` `/list` `/resume` `/bind` `/cwd` `/ws` `/mode` `/mention` `/cot` `/invite` `/remove` `/access` `/status` `/usage` `/stop` `/perm` `/memory` `/help`

Resume the same Grok session in a terminal:

```bash
grok --resume <session-id>
```

---

## 🏗 How it works

```
Feishu bot  --WS-->  daemon (this repo)  --provider-->  grok | claude | codex
                         CTI_AGENT=
```

- `grok-provider.ts` — ACP `grok agent stdio`
- `claude-provider.ts` — `@anthropic-ai/claude-agent-sdk`
- `codex-provider.ts` — `@openai/codex-sdk`

All three emit the same SSE (`text`, `tool_use`, `tool_result`, `permission_request`, `result`). Cards and slash commands are shared.

---

## 🔒 Security

Keep App Secrets in `config.env` (gitignored). Prefer `CTI_AUTO_APPROVE=false` for Grok/Claude. Do not commit secrets.

---

## Family (redirects)

| Repo | Role |
|------|------|
| **This repo** | The product — 3 bots |
| [feishu-grok-bridge](https://github.com/opc8838-hub/feishu-grok-bridge) | Archived redirect |
| [feishu-claude-bridge](https://github.com/opc8838-hub/feishu-claude-bridge) | Archived redirect |

---

## License

MIT © opc8838-hub
