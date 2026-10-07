#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, execSync, execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.resolve(process.env.CTI_CONFIG_PATH || 'config.env');
const DAEMON_PATH = path.join(PROJECT_DIR, 'dist', 'daemon.mjs');
const CONF_PATH = path.join(PROJECT_DIR, 'ecosystem.config.cjs');
process.env.CTI_CONFIG_PATH = CONFIG_PATH;
const instance = require(CONF_PATH).apps[0];
const instanceEnv = { ...process.env, ...instance.env };

const HELP = `Feishu Agent Bridge

  setup [codex|claude|grok]  Create config.env (default: codex)
  run                       Run in foreground
  start|stop|restart|status  Manage this config's PM2 process
  logs                      Show this config's recent logs

First run: setup -> edit config.env -> run
Background: npm i -g pm2, then start
CTI_CONFIG_PATH selects a different configuration; CTI_HOME overrides its data directory.
`;

function requireConfig() {
  if (!fs.existsSync(CONFIG_PATH)) throw new Error(`No config at ${CONFIG_PATH}. Run setup first.`);
  if (!fs.existsSync(DAEMON_PATH)) throw new Error('Bridge not built. Run npm run build in the source directory.');
  fs.mkdirSync(path.join(instance.env.CTI_HOME, 'logs'), { recursive: true });
}

function runSetup(agent = 'codex') {
  if (!['codex', 'claude', 'grok'].includes(agent)) throw new Error('Agent must be codex, claude, or grok.');
  if (fs.existsSync(CONFIG_PATH)) {
    console.log(`Config already exists: ${CONFIG_PATH} (kept unchanged)`);
    return;
  }
  const template = fs.readFileSync(path.join(PROJECT_DIR, 'config.env.example'), 'utf8')
    .replace(/^CTI_AGENT=.*$/m, `CTI_AGENT=${agent}`)
    .replace(/^CTI_DEFAULT_WORKDIR=.*$/m, () => `CTI_DEFAULT_WORKDIR="${process.cwd().replaceAll('\\', '/')}"`);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, template, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.log(`Created ${CONFIG_PATH}\nEdit Feishu credentials, log in to ${agent}, then run:\n  node "${path.join(PROJECT_DIR, 'bin', 'cli.js')}" run\nSee docs/INSTALL.zh.md for Feishu setup and background startup.`);
}

function runForeground() {
  requireConfig();
  const child = spawn(process.execPath, [DAEMON_PATH], {
    cwd: instance.cwd, stdio: 'inherit', env: instanceEnv, windowsHide: true,
  });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1); });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

function serviceCommand(cmd) {
  const npmRoot = execSync('npm root -g', { encoding: 'utf8', windowsHide: true }).trim();
  const pm2 = path.join(npmRoot, 'pm2', 'bin', 'pm2');
  if (!fs.existsSync(pm2)) throw new Error('PM2 is missing. Install it with: npm i -g pm2');
  if (cmd === 'start' || cmd === 'restart') requireConfig();
  const args = cmd === 'start' ? ['start', CONF_PATH]
    : cmd === 'restart' ? ['restart', CONF_PATH, '--update-env']
    : cmd === 'status' ? ['describe', instance.name]
    : cmd === 'logs' ? ['logs', instance.name, '--lines', '50', '--nostream']
    : ['stop', instance.name];
  execFileSync(process.execPath, [pm2, ...args], { stdio: 'inherit', env: instanceEnv, windowsHide: true });
}

try {
  const cmd = process.argv[2];
  if (cmd === 'setup') runSetup(process.argv[3]);
  else if (cmd === 'run') runForeground();
  else if (['start', 'stop', 'restart', 'status', 'logs'].includes(cmd)) serviceCommand(cmd);
  else if (!cmd || ['help', '--help', '-h'].includes(cmd)) console.log(HELP);
  else throw new Error(`Unknown command: ${cmd}\n${HELP}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
