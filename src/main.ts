/**
 * Entry point for the Feishu-Codex Bridge daemon.
 *
 * Assembles AppContext, resolves Codex CLI, starts FeishuClient,
 * runs the bridge loop, and handles graceful shutdown.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { loadConfig, CTI_HOME } from './config.js';
import type { AppContext } from './types.js';
import { JsonFileStore } from './store.js';
import { CodexProvider, resolveCodexCliPath, preflightCheck } from './codex-provider.js';
import { PendingPermissions } from './permissions.js';
import { FeishuClient } from './feishu.js';
import { setupLogger } from './logger.js';
import { runBridgeLoop } from './bridge.js';

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  lastExitReason?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* first write */ }
  const merged = { ...existing, ...info };
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();

  const runId = crypto.randomUUID();
  console.log(`[codex-bridge] Starting (run_id: ${runId})`);

  // Validate Feishu config
  if (!config.feishuAppId || !config.feishuAppSecret) {
    console.error('[codex-bridge] FATAL: CTI_FEISHU_APP_ID and CTI_FEISHU_APP_SECRET must be set in config.env');
    process.exit(1);
  }

  // Resolve Codex CLI
  const cliPath = resolveCodexCliPath();
  if (!cliPath) {
    console.error(
      '[codex-bridge] FATAL: Cannot find the `codex` CLI executable.\n' +
      '  Tried: CTI_CODEX_EXECUTABLE env, PATH, well-known locations.\n' +
      '  Fix: Install Codex CLI or set CTI_CODEX_EXECUTABLE=/path/to/codex',
    );
    process.exit(1);
  }

  const check = preflightCheck(cliPath);
  if (check.ok) {
    console.log(`[codex-bridge] CLI preflight OK: ${cliPath} (${check.version})`);
  } else {
    console.error(
      `[codex-bridge] FATAL: Codex CLI preflight failed.\n` +
      `  Path: ${cliPath}\n` +
      `  Error: ${check.error}`,
    );
    process.exit(1);
  }

  // Assemble AppContext
  const store = new JsonFileStore(config);
  const pendingPerms = new PendingPermissions();
  const provider = new CodexProvider(cliPath, config.autoApprove);
  const feishu = new FeishuClient(config, store);

  const ctx: AppContext = {
    config,
    store,
    provider,
    permissions: pendingPerms,
    feishu,
  };

  // Start Feishu WebSocket
  await feishu.start();

  // Write PID and status
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
  writeStatus({
    running: true,
    pid: process.pid,
    runId,
    startedAt: new Date().toISOString(),
  });

  console.log(`[codex-bridge] Bridge started (PID: ${process.pid})`);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[codex-bridge] Shutting down (${reason})...`);
    pendingPerms.denyAll();
    await feishu.stop();
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  process.on('unhandledRejection', (reason) => {
    console.error('[codex-bridge] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
    writeStatus({ running: false, lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}` });
  });
  process.on('uncaughtException', (err) => {
    console.error('[codex-bridge] uncaughtException:', err.stack || err.message);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });

  // Keep event loop alive
  setInterval(() => { /* keepalive */ }, 45_000);

  // Watchdog: exit if WebSocket stays disconnected too long so launchd restarts us
  const HEALTH_CHECK_INTERVAL = 2 * 60 * 1000;
  const MAX_UNHEALTHY_MS = 10 * 60 * 1000;
  let unhealthySince: number | null = null;

  setInterval(() => {
    const state = feishu.getWsReadyState();
    if (state === 1) { // WebSocket.OPEN
      unhealthySince = null;
      return;
    }
    if (!unhealthySince) {
      unhealthySince = Date.now();
      console.warn(`[watchdog] WebSocket not connected (readyState=${state}), monitoring...`);
      return;
    }
    const downMs = Date.now() - unhealthySince;
    if (downMs > MAX_UNHEALTHY_MS) {
      console.error(`[watchdog] WebSocket down for ${Math.round(downMs / 1000)}s, exiting for launchd restart`);
      writeStatus({ running: false, lastExitReason: `watchdog: ws down ${Math.round(downMs / 1000)}s` });
      process.exit(1);
    }
    console.warn(`[watchdog] WebSocket still down (${Math.round(downMs / 1000)}s / ${MAX_UNHEALTHY_MS / 1000}s threshold)`);
  }, HEALTH_CHECK_INTERVAL);

  // Run bridge loop (blocks until feishu stops)
  await runBridgeLoop(ctx);
}

main().catch((err) => {
  console.error('[codex-bridge] Fatal error:', err instanceof Error ? err.stack || err.message : err);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});
