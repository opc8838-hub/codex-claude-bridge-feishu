# CLAUDE.md — codex-claude-bridge-feishu

## What this project does

A Node.js daemon that bridges Feishu/Lark to local OpenAI Codex CLI.
Users chat with a Feishu bot → daemon spawns Codex → streams replies back as cards.

Full architecture and setup: see [README.md](./README.md).

## Do NOT introduce

- New framework dependencies (Express, Next.js, etc.) — keep it a single daemon process
- Alternative AI providers baked into core — use the provider pattern (`codex-provider.ts`)
- Any cloud service requirement — the daemon runs locally, zero cloud deps
- New npm scripts without updating this file

## Quick commands

```bash
npm run dev          # Foreground, tsx hot-reload
npm run build        # esbuild bundle → dist/daemon.mjs
npm run typecheck    # tsc --noEmit
npm start            # Run built bundle
```

## Key files

| File | Role |
|------|------|
| `src/main.ts` | Entry: load config, resolve CLI, start Feishu, run loop |
| `src/codex-provider.ts` | Wrap `@openai/codex-sdk` → unified SSE stream |
| `src/conversation.ts` | SSE events → streaming Feishu CardKit cards |
| `src/feishu.ts` | Feishu WebSocket + REST via `@larksuiteoapi/node-sdk` |
| `src/bridge.ts` | Message router, slash commands, `/help` |
| `src/store.ts` | JSON file session store (`.bridge/data/`) |
| `src/config.ts` | `config.env` parser |

## Provider pattern

Only `codex-provider.ts` knows about Codex. It exports:
- `CodexProvider.streamChat(params)` → `ReadableStream<string>` (SSE events)
- `resolveCodexCliPath()` / `preflightCheck()` — CLI discovery
- `classifyAuthError()` — detect auth vs other errors

The SSE format (`text`, `tool_use`, `tool_result`, `result`, `error`, `status`) is consumed by `conversation.ts`, which is provider-agnostic.
To add a new AI agent: write one file like `codex-provider.ts`, nothing else changes.

## Code conventions

- TypeScript strict, all types in `src/types.ts`
- No `any` without a comment explaining why
- SSE events use `sseEvent(type, data)` helper — always JSON-stringified `data` field
- Config from `config.env`, never hardcode paths or secrets
- Logger (`src/logger.ts`) auto-redacts `token`, `secret`, `password`, `api_key` patterns
- Graceful shutdown: catch signals, close threads, deny pending permissions, write status
- Windows-compatible: avoid Unix-only assumptions, test `process.platform` where needed

## Important gotchas

- **ChatGPT Plus users must NOT set CTI_DEFAULT_MODEL** — Codex auto-select fails otherwise
- **config.toml leftover model settings** cause "not supported with ChatGPT account" errors
- **`codexPathOverride`** must be resolved in CodexProvider constructor, not inside ReadableStream start callback (Windows ENOENT otherwise)
- **daemon.sh is macOS-only** (launchd). Windows/Linux users: pm2 or systemd
- **`spawn EINVAL` on Windows**: the SDK's `createRequire` chain finds the native `.exe` — pass it as `codexPathOverride`

## Auth modes

| Mode | Setup |
|------|-------|
| ChatGPT/Codex subscription | `codex login`, leave `OPENAI_API_KEY` empty |
| API key | Set `OPENAI_API_KEY` in `config.env` |
| Third-party | Set both `OPENAI_API_KEY` + `OPENAI_BASE_URL` |

Long docs: [README.md](./README.md).
