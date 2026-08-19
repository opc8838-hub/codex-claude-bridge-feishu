# Changelog

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
