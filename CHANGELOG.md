# Changelog

## 1.3.0 — 2026-10-07

- Portable setup and PM2 configuration: no author-specific paths or accounts; each config gets its own process and runtime directory.
- One shared config template, explicit `setup codex|claude|grok`, preserved existing configs, environment overrides and provider credential forwarding.
- Codex SDK pinned to 0.153.4; idle watchdog, stale/incompatible thread recovery, and Windows hidden launcher with child-process cleanup.
- Distinguish idle models from running tools; abort timed-out streams rather than leaving background work alive.
- Serialize/coalesce Feishu card updates and retry rate-limited finalization.
- Include configuration template, Windows build helper and installation guide in distributable packages.
- Add new-computer installation and runtime regression tests; CI on Windows and Linux.

This GitHub release is separate from the npm registry version. Use the source checkout or the release `.tgz` for 1.3.0.

## 1.2.1 — 2026-08-19

- README: full product highlights (group chat, per-chat @mention, multi-turn, streaming, session management, multi-agent, cross-session memory)
- README: local-first section + 3-box architecture diagram + 7-step flow
- Sibling repos `feishu-grok-bridge` and `feishu-claude-bridge` deleted — this is the only public bridge

## 1.2.0 — 2026-08-19

**Latest: Grok is a first-class agent.** One repo, three Feishu bots.

- `CTI_AGENT=grok|claude|codex` selects the provider
- `grok-provider.ts` — ACP `grok agent stdio`
- `claude-provider.ts` restored (Claude Code SDK)
- Session `/list` scans `~/.grok/sessions`, `~/.claude/projects`, or Codex index
- Docs: one product, three bots; sibling repos become redirects

### 中文

**最新：Grok 成为一等 Agent。** 一个仓，三个飞书机器人。

- `CTI_AGENT=grok|claude|codex` 选引擎
- 命令和卡片共用，三个 BOT 三个飞书应用、三个进程
