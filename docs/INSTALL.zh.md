# 新电脑安装指南（1.3.0）

苹果用户可先看 [macOS 安装与验证说明](INSTALL.macos.md)，包含 Apple Silicon / Intel 的安装命令和验证范围。

支持选择 Codex、Claude Code 或 Grok。先装一个机器人并验收，再增加第二个。桥接进程在你自己的电脑上运行，电脑必须开机并联网；无需公网 IP。模型请求仍会发给你选择的模型服务商。

## 1. 准备

- 安装 Git、Node.js 22（`node --version`、`npm --version`、`git --version` 均有输出）。
- 安装并登录你要使用的 Agent CLI。Codex 可执行 `npm install -g @openai/codex`，然后 `codex login`；Claude Code 按[官方说明](https://code.claude.com/docs/en/setup)安装，然后 `claude auth login`；Grok 按 [Grok Build](https://x.ai/build) 安装，然后 `grok login`。
- 在终端直接运行所选 CLI，确认能完成一次简单对话，再接飞书。
- 自己创建一个飞书企业自建应用。不要使用其他人的 App Secret、登录文件或会话目录。

## 2. 下载和初始化

以下命令可在 Windows PowerShell、macOS 或 Linux 终端逐行执行：

```text
git clone https://github.com/opc8838-hub/codex-claude-bridge-feishu.git
cd codex-claude-bridge-feishu
npm ci
npm run build
node bin/cli.js setup codex
```

安装 Claude 将最后一个参数换成 `claude`，Grok 换成 `grok`。Windows 构建会自动生成隐藏控制台启动器；不要复制作者电脑的可执行程序路径。

用文本编辑器打开生成的 `config.env`，至少填写：

```dotenv
CTI_AGENT=codex
CTI_FEISHU_APP_ID=cli_你的应用ID
CTI_FEISHU_APP_SECRET=你的应用密钥
CTI_DEFAULT_WORKDIR="D:/我的项目"
CTI_FEISHU_DOMAIN=feishu
CTI_FEISHU_REQUIRE_MENTION=true
CTI_AUTO_APPROVE=false
```

工作目录必须存在。macOS 可使用 `/Users/你的用户名/projects`。不要把中文示例值原样填进去。`setup` 不会覆盖已有配置。

使用 Codex / Claude 订阅登录时，无需填 API Key。使用 API 或兼容服务时，在同一文件填写对应的 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 或 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`，模型名称必须是该服务支持的名称。未填 `CTI_DEFAULT_MODEL` 时采用 CLI 默认模型。已有系统环境变量优先于配置文件；修改配置后重启桥接。

`CTI_AUTO_APPROVE=false` 保留 Provider 的权限检查。Claude / Grok 支持通过飞书处理审批；Codex SDK 暂不把交互审批转成飞书卡片，受限操作可能失败。改为 `true` 会允许 Agent 自动执行命令，Codex 同时使用完整本机权限；由电脑所有者自行选择。

## 3. 配置飞书应用

在[飞书开放平台](https://open.feishu.cn/app)创建企业自建应用并启用机器人。按机器人功能申请相应的应用权限：

| 功能 | 权限标识 |
| --- | --- |
| 接收私聊、群内 @ 消息 | `im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly` |
| 读取消息、机器人回复 | `im:message:readonly`、`im:message:send_as_bot` |
| 流式卡片 | `cardkit:card:read`、`cardkit:card:write` |
| 收发图片和文件 | `im:resource` |
| 消息表情状态 | `im:message.reactions:read`、`im:message.reactions:write_only` |
| `/newchat` 建群、成员管理 | `im:chat:create`、`im:chat:read`、`im:chat:update`、`im:chat.members:read`、`im:chat.members:write_only` |

要使用 `/mention off` 接收群内非 @ 消息，另申请 `im:message.group_msg`。不需要为了桥接一次申请知识库、邮箱、多维表格等全部权限。

配置事件与回调：

1. 接收方式选择**使用长连接接收事件**，不需要填公网回调 URL。
2. 订阅消息事件 `im.message.receive_v1`，使用审批按钮时订阅卡片回传 `card.action.trigger`。
3. 如果控制台提示尚未建立长连接，先执行下一节的启动命令，再回到控制台保存。
4. 创建版本并发布应用，设置可用范围包含自己或测试同事。群聊测试前，把机器人加入群。

## 4. 首次启动与验收

```text
node bin/cli.js run
```

保持窗口打开，依次确认：

1. 日志出现 CLI 检查成功、WebSocket 连接和 Bridge started。
2. 私聊机器人发送 `/status`，能收到状态回复。
3. 发一句“只回复：连接成功”，收到最终答案，卡片结束思考状态。
4. 再问一句“我上一条说了什么”，确认多轮上下文。
5. 群内 @机器人测试；执行任务中发送 `/stop`，确认能停止。

以上通过后，按 Ctrl+C 退出前台，再启用后台运行，避免同一飞书应用同时启动两份进程。

## 5. 后台运行

```text
npm install -g pm2
node bin/cli.js start
node bin/cli.js status
node bin/cli.js logs
```

关闭终端后 PM2 继续运行；**这不等于电脑重启后自动启动**。macOS / Linux 可按 PM2 的 `pm2 startup` 提示设置，再 `pm2 save`。Windows 可在任务计划程序中创建“用户登录时”任务，使用登录 Agent 的同一用户：程序填 `node.exe` 的完整路径，参数填 `"完整仓库路径\bin\cli.js" start`，起始目录填仓库目录。不要配置多个重复触发任务。

每个配置文件拥有独立进程名和 `.bridge-<标识>` 数据目录，`stop/restart/status/logs` 只针对当前配置：

```text
node bin/cli.js restart
node bin/cli.js stop
```

直接执行 `npm start` / `npm run dev` 时仍使用原来的 `.bridge` 默认目录；若要沿用已有会话，请在启动前设置 `CTI_HOME` 为旧数据目录的绝对路径，再统一使用 CLI 启停。

## 6. 两个机器人 / 多实例

每个实例用不同的飞书应用、配置文件。Windows PowerShell 示例：

```powershell
$env:CTI_CONFIG_PATH = Join-Path $PWD 'config.codex.env'
node bin/cli.js setup codex
# 编辑 config.codex.env 后：
node bin/cli.js start

$env:CTI_CONFIG_PATH = Join-Path $PWD 'config.claude.env'
node bin/cli.js setup claude
# 编辑 config.claude.env 后：
node bin/cli.js start
```

macOS / Linux 示例：

```sh
CTI_CONFIG_PATH="$PWD/config.claude.env" node bin/cli.js setup claude
# 编辑后：
CTI_CONFIG_PATH="$PWD/config.claude.env" node bin/cli.js start
```

管理哪个实例，就使用同一个 `CTI_CONFIG_PATH`。`CTI_CONFIG_PATH`、`CTI_HOME` 是启动环境变量，应在启动命令或进程管理器里设置。

## 7. 更新已有安装

先保存自己的配置与会话目录。使用本指南 CLI 启动的实例可执行：

```text
node bin/cli.js stop
git pull --ff-only
npm ci
npm run build
node bin/cli.js start
```

若以前使用作者旧版 `ecosystem.config.cjs` 的 `codex-1` / `codex-2`，先用 `pm2 list` 找到对应旧进程并停止，仅迁移自己要更新的实例。新版不再提供作者的第二套账号路径。设置 `CTI_CONFIG_PATH` 和 `CTI_HOME` 指向自己的旧配置、旧会话目录，再启动。配置有本地修改导致 Git 拒绝拉取时，先备份并处理差异，不要强制覆盖。

## 8. 常见问题

- **没有回复**：确认只运行一份实例、App ID / Secret 正确、应用已发布、长连接已连接、事件和消息权限已开通；群内默认需要 @机器人。
- **401 / refresh token revoked**：以运行桥接的同一系统用户重新登录对应 CLI，随后重启该实例。多账号使用自定义 `CODEX_HOME` 时，登录和桥接必须使用同一目录。
- **一直 thinking**：运行 `node bin/cli.js logs` 查看错误。空闲 5 分钟会报错并终止任务；工具执行允许更长等待，最多 60 分钟无输出。不会静默更换更贵的模型。
- **流式卡片没有结束**：核对 CardKit 权限和日志中的限流错误。新版串行更新卡片并对最终提交的限流错误做有限重试。
- **Windows 找不到 CLI**：先确保在同一用户终端里 `codex --version` 或 `claude --version` 可用。自定义安装位置可设置 `CTI_CODEX_EXECUTABLE` / `CTI_CLAUDE_CODE_EXECUTABLE`；Codex 应填写原生 `.exe` 路径。
- **从 npm 安装还是旧版**：npm registry 与 GitHub 发布独立。本次优先使用 GitHub 源码或 Release 附件；检查 `package.json` 是否为 `1.3.0`。

## 9. 给朋友的安装包

[Releases](https://github.com/opc8838-hub/codex-claude-bridge-feishu/releases) 中的 `.tgz` 是已构建 npm 安装包，可执行 `npm install -g ./codex-claude-bridge-feishu-1.3.0.tgz`，在自己的工作目录执行 `codex-bridge setup codex`，填写配置后 `codex-bridge run`。Windows 包包含隐藏启动器；macOS / Linux 使用本机 CLI。

源码 ZIP 解压后按第 2 节执行 `npm ci`、`npm run build`、`node bin/cli.js setup codex`。安装包需要联网安装 npm 依赖，不含模型账号、飞书密钥、聊天记录或作者的运行配置。
