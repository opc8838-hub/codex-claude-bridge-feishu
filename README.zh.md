[**English**](./README.md) | 中文

# Feishu Agent Bridge

**一个仓。三个飞书机器人：Grok · Claude Code · Codex。**

> 📱💻 最新：**Grok Build CLI** 已作为一等 Agent。卡片、命令、守护进程都是同一套 — 用 `CTI_AGENT` 选机器人。

Node.js 守护进程，把飞书/Lark 接到**本机**编程 Agent。飞书发消息，Agent 在项目目录执行，回复以 CardKit v2 流式卡片回来。

这是你需要的**唯一**桥接仓。不要把 `feishu-grok-bridge` 或已归档的 Claude 仓再当成第二个产品 — 它们都跳回这里。

| 飞书机器人 | `CTI_AGENT` | 本机 CLI | 登录 |
|------------|-------------|----------|------|
| **Grok**（最新） | `grok` | `grok` | `grok login` → `~/.grok/auth.json` |
| Claude Code | `claude` | `claude` | `claude auth login` 或 `ANTHROPIC_*` |
| OpenAI Codex | `codex` | `codex` | `codex login` 或 `OPENAI_API_KEY` |

**三个 BOT = 三个飞书应用 + 三个进程**，代码只有这一份：

```bash
# 机器人 1 — Grok
CTI_AGENT=grok   CTI_CONFIG_PATH=config.grok.env   CTI_HOME=.bridge-grok   node dist/daemon.mjs

# 机器人 2 — Claude
CTI_AGENT=claude CTI_CONFIG_PATH=config.claude.env CTI_HOME=.bridge-claude node dist/daemon.mjs

# 机器人 3 — Codex
CTI_AGENT=codex  CTI_CONFIG_PATH=config.codex.env  CTI_HOME=.bridge-codex  node dist/daemon.mjs
```

每个 `config.*.env` 用**各自的** `CTI_FEISHU_APP_ID` / `SECRET`（三个 Agent 不要共用一个飞书机器人）。

---

## ✨ 亮点

- **`/newchat`** — 自动建群并绑会话（一个话题一个群）
- **流式卡片** — 工具、改文件、用量实时刷
- **权限卡** — 允许一次 / 本会话 / 拒绝（`1` `2` `3`）
- **`/ws` 书签、`/invite` 授权、`/cot` 干净/详细输出**
- **本地优先** — Agent 跑在你电脑上

---

## 📦 安装

```bash
git clone https://github.com/opc8838-hub/codex-claude-bridge-feishu.git
cd codex-claude-bridge-feishu
npm install
npm run build
cp config.env.example config.env
```

编辑 `config.env`：

```bash
CTI_AGENT=grok
CTI_FEISHU_APP_ID=cli_xxxxxxxx
CTI_FEISHU_APP_SECRET=xxxxxxxx
CTI_DEFAULT_WORKDIR=/path/to/project
CTI_AUTO_APPROVE=false
```

```bash
npm run dev      # 或 npm start
```

或全局安装：

```bash
npm i -g codex-claude-bridge-feishu
codex-bridge setup && codex-bridge run
```

### 前置

- Node.js >= 20
- 你选的那个 Agent 的 CLI（`grok` / `claude` / `codex`）
- **每个 BOT 一个**飞书企业自建应用（机器人、长连接、`im.message.receive_v1`、`cardkit:card`、`im:chat*`、`im:resource`）

---

## 💬 命令

`/newchat` `/new` `/list` `/resume` `/bind` `/cwd` `/ws` `/mode` `/mention` `/cot` `/invite` `/remove` `/access` `/status` `/usage` `/stop` `/perm` `/memory` `/help`

终端恢复同一 Grok 会话：

```bash
grok --resume <session-id>
```

---

## 🏗 原理

```
飞书机器人  --WS-->  本仓守护进程  --provider-->  grok | claude | codex
                          CTI_AGENT=
```

- `grok-provider.ts` — ACP `grok agent stdio`
- `claude-provider.ts` — `@anthropic-ai/claude-agent-sdk`
- `codex-provider.ts` — `@openai/codex-sdk`

三套都吐同一份 SSE。卡片和斜杠命令共用。

---

## 🔒 安全

App Secret 只放 `config.env`（已 gitignore）。Grok/Claude 建议 `CTI_AUTO_APPROVE=false`。不要提交密钥。

---

## 家族（跳转）

| 仓库 | 角色 |
|------|------|
| **本仓** | 正品 — 三个 BOT |
| [feishu-grok-bridge](https://github.com/opc8838-hub/feishu-grok-bridge) | 归档跳转 |
| [feishu-claude-bridge](https://github.com/opc8838-hub/feishu-claude-bridge) | 归档跳转 |

---

## License

MIT © opc8838-hub
