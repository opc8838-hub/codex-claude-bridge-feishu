# macOS 安装与验证

适用于 Apple Silicon（M 系列）和 Intel Mac。推荐使用与电脑架构匹配的 Node.js 22；在终端执行 `node --version` 和 `node -p process.arch`，M 系列原生 Node 应显示 `arm64`，Intel 显示 `x64`。

## 安装

先安装 Git、Node.js，并按[完整安装指南](INSTALL.zh.md)安装和登录所选 Agent CLI，然后逐行执行：

```sh
mkdir -p "$HOME/projects"
cd "$HOME/projects"
git clone https://github.com/opc8838-hub/codex-claude-bridge-feishu.git
cd codex-claude-bridge-feishu
npm ci
npm run build
node bin/cli.js setup codex
```

使用 Claude 时将最后的 `codex` 换成 `claude`，Grok 换成 `grok`。编辑生成的 `config.env`：填写自己的飞书 App ID、App Secret，工作目录填写 Mac 上真实存在的路径，例如 `/Users/你的用户名/projects`。

按[飞书配置与验收步骤](INSTALL.zh.md#3-配置飞书应用)发布机器人，然后前台运行：

```sh
node bin/cli.js run
```

确认 `/status` 和普通对话均有回复后，按 Ctrl+C 退出，再启动后台：

```sh
npm install -g pm2
node bin/cli.js start
node bin/cli.js status
node bin/cli.js logs
```

停止或重启使用 `node bin/cli.js stop` / `node bin/cli.js restart`。登录后自动启动可按 `pm2 startup` 输出的系统安装命令完成设置，再执行 `pm2 save`；更换 Node 安装路径后需重新检查启动项。自动化验收不包含电脑重启测试。

## 自动化验证范围

仓库 CI 在 macOS 15 的 Apple Silicon 和 Intel 环境分别运行 Node 20、22 检查，报告记录实际系统版本、CPU 架构和每项结果。

- `npm ci`、类型检查、回归测试、构建。
- 每次提交检查源码构建的 npm 包；发布后手动触发 CI，还会下载 GitHub Release 的安装包，在干净目录复验并核对版本。1.3.1 修复了 Mac 安装路径含空格时 PM2 后台启动失败的问题。
- 全局命令、三种 Agent 初始化、中文及空格路径、配置文件权限、已有配置保留。
- 随包 Codex / Claude CLI 的 `--version` 启动检查。
- 前台退出信号传递；PM2 两个实例的启动、重启、状态、日志和停止。

后台测试使用无业务行为的测试进程。CI 不使用任何人的飞书密钥或模型账号，不代表已验证真实账号登录、模型回答或飞书收发；安装者仍需完成上面的首次对话验收。Grok 的初始化模板有测试，Grok CLI 未做实机调用。

最新结果和 JSON 报告见仓库 [Actions](https://github.com/opc8838-hub/codex-claude-bridge-feishu/actions/workflows/ci.yml)。
