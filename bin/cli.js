#!/usr/bin/env node
/**
 * codex-claude-bridge CLI — global launcher.
 *
 * npm i -g codex-claude-bridge-feishu
 * codex-bridge run          → foreground mode
 * codex-bridge setup        → first-run wizard
 * codex-bridge start|stop|restart|status → service management (PM2)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(process.cwd(), 'config.env');
const DAEMON_PATH = path.join(PROJECT_DIR, 'dist', 'daemon.mjs');

const HELP = [
  'codex-claude-bridge — AI coding agent bridge for Feishu/Lark',
  '',
  'Commands:',
  '  run       Start in foreground (testing / first time)',
  '  setup     Create config.env template',
  '  start     Start as background service (PM2)',
  '  stop      Stop background service',
  '  restart   Restart background service',
  '  status    Show service status',
  '  logs      Show recent logs',
  '',
  'First time:',
  '  1. codex-bridge setup     → create config.env',
  '  2. Edit config.env with your Feishu app credentials',
  '  3. codex-bridge run       → test it works',
  '  4. codex-bridge start     → run in background',
].join('\n');

function findPm2() {
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const pm2Path = path.join(npmRoot, 'pm2', 'index.js');
    if (fs.existsSync(pm2Path)) return pm2Path;
  } catch { /* not found */ }
  try {
    const which = execSync('where pm2 2>nul || which pm2 2>/dev/null', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (which) return which;
  } catch { /* not found */ }
  return null;
}

async function runForeground() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log('⚠️  No config.env found. Run "codex-bridge setup" first.\n');
    process.exit(1);
  }
  if (!fs.existsSync(DAEMON_PATH)) {
    console.log('⚠️  Bridge not built. Run "npm run build" in the bridge directory first.\n');
    process.exit(1);
  }
  console.log('[bridge] Starting in foreground mode...');
  process.env.CTI_CONFIG_PATH = CONFIG_PATH;
  const child = spawn('node', [DAEMON_PATH], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, CTI_CONFIG_PATH: CONFIG_PATH },
  });
  child.on('exit', (code) => process.exit(code || 0));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

async function runSetup() {
  if (fs.existsSync(CONFIG_PATH)) {
    console.log(`✓ config.env already exists at ${CONFIG_PATH}`);
    console.log('  Edit it to change settings, or delete it to re-run setup.');
    return;
  }

  const template = [
    '# ── Required ──',
    `CTI_FEISHU_APP_ID=cli_xxxxxxxxxx`,
    `CTI_FEISHU_APP_SECRET=xxxxxxxxxxxxxx`,
    `CTI_DEFAULT_WORKDIR=${process.cwd().replace(/\\/g, '/')}`,
    '',
    '# ── Optional ──',
    'CTI_DEFAULT_MODE=code                   # code | plan | ask',
    'CTI_FEISHU_DOMAIN=feishu                # feishu | lark',
    'CTI_FEISHU_REQUIRE_MENTION=true         # Default for non-/newchat groups',
    'CTI_COT_MODE=off                        # off | brief | detailed',
    'CTI_AUTO_APPROVE=true',
    '',
    '# ── AI Agent (choose one) ──',
    '# Claude Code:',
    '# ANTHROPIC_AUTH_TOKEN=sk-xxx',
    '# ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic',
    '',
    '# OR Codex:',
    '# OPENAI_API_KEY=sk-xxx',
    '',
  ].join('\n');

  fs.writeFileSync(CONFIG_PATH, template, 'utf-8');

  console.log([
    '',
    '✅  Created config.env',
    '',
    'Next steps:',
    '',
    '1. Edit config.env with your credentials:',
    `   ${CONFIG_PATH}`,
    '',
    '2. Create a Feishu self-built app:',
    '   → https://open.feishu.cn/app',
    '   → Enable Bot capability',
    '   → Events & Callbacks → Persistent connection (WebSocket)',
    '   → Subscribe to im.message.receive_v1',
    '   → Add scopes: im:message, im:chat*, cardkit:card, etc.',
    '   (See README for full permission list)',
    '',
    '3. Start the bridge:',
    '   codex-bridge run',
    '',
    '4. Once verified, run in background:',
    '   codex-bridge start',
    '',
  ].join('\n'));
}

async function serviceCommand(cmd) {
  const confPath = path.join(PROJECT_DIR, 'ecosystem.config.cjs');
  if (!fs.existsSync(confPath)) {
    console.log('⚠️  No ecosystem.config.cjs found. Service management requires PM2 config.');
    process.exit(1);
  }

  const pm2 = findPm2();
  if (!pm2) {
    console.log('⚠️  PM2 not found. Install it: npm i -g pm2');
    process.exit(1);
  }

  if (cmd === 'start') {
    console.log('[bridge] Starting as background service...');
    execSync(`"${process.execPath}" "${pm2}" start "${confPath}"`, { stdio: 'inherit', env: { ...process.env, CTI_CONFIG_PATH: CONFIG_PATH } });
  } else if (cmd === 'stop') {
    console.log('[bridge] Stopping service...');
    execSync(`"${process.execPath}" "${pm2}" stop "${confPath}"`, { stdio: 'inherit' });
  } else if (cmd === 'restart') {
    console.log('[bridge] Restarting service...');
    execSync(`"${process.execPath}" "${pm2}" restart "${confPath}"`, { stdio: 'inherit', env: { ...process.env, CTI_CONFIG_PATH: CONFIG_PATH } });
  } else if (cmd === 'status') {
    execSync(`"${process.execPath}" "${pm2}" list`, { stdio: 'inherit' });
  } else if (cmd === 'logs') {
    execSync(`"${process.execPath}" "${pm2}" logs --lines 50`, { stdio: 'inherit' });
  }
}

// ── Main ──

const cmd = process.argv[2] || '';

(async () => {
  switch (cmd) {
    case 'run':
      await runForeground();
      break;
    case 'setup':
      await runSetup();
      break;
    case 'start':
    case 'stop':
    case 'restart':
    case 'status':
    case 'logs':
      await serviceCommand(cmd);
      break;
    case '--help':
    case '-h':
    case 'help':
    default:
      console.log(HELP);
      if (cmd && cmd !== 'help') {
        console.log(`\nUnknown command: ${cmd}`);
      }
      break;
  }
})();
