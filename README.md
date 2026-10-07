[**中文**](./README.zh.md) | English

# Feishu Agent Bridge

[Grok Build](https://x.ai/build) · [Grok docs](https://docs.x.ai/build/overview) · [Claude Code](https://docs.anthropic.com/en/docs/claude-code) · [Codex](https://github.com/openai/codex) · [Feishu Open Platform](https://open.feishu.cn)

Bridge Feishu / Lark to a **local** coding agent. Mention the bot in a group; it reads code, edits files, and runs commands on your machine. Replies stream back as CardKit v2 cards.

**One repo. Grok · Claude Code · Codex share the same commands, cards, and sessions. The bridge process runs locally without an author-operated relay; model requests still go to your chosen provider.**

---

## Highlights

### Group collaboration
Each Feishu group has its own session. `/newchat` creates a group and binds a fresh session — one topic, one chat. Teammates can join, watch the run, and send follow-ups.

### Per-group @mention control
Groups require @mention by default so chatter does not wake the agent. `/mention off` sends every message in that group to the agent; `/mention on` restores the gate. DMs always go through. The setting is stored per chat.

### Multi-turn conversations
The same DM or group keeps talking to the same local CLI session. `/stop` aborts the current turn; the next message continues the thread.

### Streaming replies
CardKit v2 updates live: text, tool calls, file edits, token usage. `/cot brief|detailed` splits the process card from a clean answer; `/cot off` keeps everything in one card.

### Session management
| Command | What it does |
|---------|----------------|
| `/new` `/newchat` | New session here, or a new group + session |
| `/list` `/resume` | Discover local CLI sessions and resume one |
| `/bind` | Bind this chat to an existing session id |
| `/cwd` `/ws` | Change cwd; bookmark project paths |
| `/status` `/usage` | Live status and token usage |
| Terminal | `grok --resume` / `claude --resume` / `codex resume` on the same session |

### Multiple agents
One codebase, three engines. Pick with `CTI_AGENT`. Cards and slash commands stay the same:

| Agent | `CTI_AGENT` | Local CLI | Auth |
|-------|-------------|---------|------|
| **[Grok](https://x.ai/build)** (latest) | `grok` | `grok` | `grok login` → `~/.grok/auth.json` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `claude` | `claude` | `claude auth login` or `ANTHROPIC_*` |
| [OpenAI Codex](https://github.com/openai/codex) | `codex` | `codex` | `codex login` or `OPENAI_API_KEY` |

Give each agent its own Feishu app and process. Do not share one bot across agents.

### Cross-session memory
Before each turn the agent reads `~/.codex-bridge-memory.md` (preferences, project paths, conventions). `/memory` shows it in Feishu. Tell the agent “remember: …” and it updates the file for the next session.

### Also included

- **Permission cards** — Claude / Grok support allow once / allow this session / deny; see the installation guide for Codex SDK approval limitations
- **Access control** — `/invite` `/remove` `/access` for users, admins, and whole groups
- **Modes** — `/mode code|plan|ask`
- **Workspace bookmarks** — `/ws save|use|list|remove`
- **File send** — `/sendfile` uploads a local file back to the chat
- **Local-first** — agent, code, and sessions stay on disk; Feishu only carries chat and cards

---

## Runs locally. No cloud relay.

The agent process and session records live on your machine, without an author-operated backend. Feishu handles chat and cards; the agent sends prompts and relevant code/file context to your chosen model provider.

- **Access control** — `/invite` `/remove` `/access` for users, admins, and whole groups
- **Secret masking** — `config.env` is gitignored; tokens, Bearer headers, and App Secrets are redacted in logs
- **Encrypted transport** — Feishu WebSocket / REST over TLS; the daemon talks to the agent as a local child process, not over the public internet

---

## How it works

```mermaid
flowchart LR
  subgraph FEISHU["Feishu Bot"]
    U["Phone / Desktop"]
  end
  subgraph DAEMON["Bridge Daemon · Node.js"]
    D["config.env<br/>session store<br/>per-chat bindings"]
  end
  subgraph AGENT["AI Agent · local"]
    A["Grok / Claude / Codex"]
  end
  FEISHU -->|"WebSocket · live push"| DAEMON
  DAEMON -->|"streaming cards + text"| FEISHU
  DAEMON -->|"SDK spawn child"| AGENT
  AGENT -->|"JSON / SSE stream"| DAEMON
```

```
Feishu Bot (phone / desktop)
        │  WebSocket long-lived · live push
        │  streaming cards + text
        ▼
Bridge Daemon (Node.js)
  config.env · session store · per-chat bindings
        │  SDK spawn child process
        ▼
AI Agent (local)  Grok / Claude / Codex
        │  JSON / SSE stream
        └──────────▶ Daemon updates the Feishu card
```

### Flow

1. **Message in** — Feishu pushes `im.message.receive_v1` over the WebSocket
2. **Route** — `bridge.ts` resolves the per-chat binding (`chatId → sessionId`), handles slash commands, then hands off to the conversation engine
3. **Spawn agent** — the provider (`grok-provider.ts` / `claude-provider.ts` / `codex-provider.ts`) starts the local agent in the working directory via SDK
4. **Event stream** — the agent emits text deltas, tool calls, tool results, and usage
5. **SSE normalize** — the provider maps those events to one SSE shape (`text`, `tool_use`, `tool_result`, `permission_request`, `result`)
6. **Card render** — `conversation.ts` folds SSE into a live Feishu CardKit card
7. **Live update** — card patches go back over the REST API so the group sees progress; approval behavior depends on the agent and permission configuration

---

## Install (1.3.0)

See the [step-by-step installation guide](docs/INSTALL.zh.md) for Windows setup, Feishu permissions, multiple instances and migration.

```text
git clone https://github.com/opc8838-hub/codex-claude-bridge-feishu.git
cd codex-claude-bridge-feishu
npm ci
npm run build
node bin/cli.js setup codex
```

Use `setup claude` or `setup grok` for another agent. Edit the generated `config.env` with your own Feishu credentials and working directory. Log in to the selected CLI, then run:

```text
node bin/cli.js run
```

After a successful foreground test, stop with Ctrl+C, then:

```text
npm install -g pm2
node bin/cli.js start
node bin/cli.js status
```

Each config has its own process and runtime data. No author-specific paths or accounts are required. Use `CTI_CONFIG_PATH` to select another config and `CTI_HOME` to retain an existing data directory. Reboot startup requires separate configuration.

Prebuilt packages: [Releases](https://github.com/opc8838-hub/codex-claude-bridge-feishu/releases). **The npm registry version is independent of GitHub releases; use this checkout or the release 1.3.0 tarball.**

Prerequisites: Node.js 22 recommended (minimum 20.19), an installed/logged-in agent CLI, and one Feishu self-built app per bot. Windows builds include the hidden launcher automatically.

---

## Commands

`/newchat` `/new` `/list` `/resume` `/bind` `/cwd` `/ws` `/mode` `/mention` `/cot` `/invite` `/remove` `/access` `/status` `/usage` `/stop` `/perm` `/memory` `/sendfile` `/help`

Resume the same Grok session in a terminal:

```bash
grok --resume <session-id>
```

---

## Security

Keep App Secrets in `config.env` (gitignored). Prefer `CTI_AUTO_APPROVE=false` for Grok / Claude. Do not commit secrets.

---

## License

MIT © opc8838-hub
