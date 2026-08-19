/**
 * CLI Session Scanner — discovers local Codex CLI sessions.
 *
 * Scans ~/.codex/session_index.jsonl to extract session metadata
 * from Codex thread history.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CliSessionInfo } from './types.js';
import { scanGrokSessions } from './session-scanner-grok.js';
import { scanClaudeSessions } from './session-scanner-claude.js';

const CODEX_SESSION_INDEX = path.join(os.homedir(), '.codex', 'session_index.jsonl');

interface CodexSessionIndexEntry {
  id: string;
  thread_name: string;
  updated_at: string;
}

interface ScanOptions {
  limit?: number;
  maxAgeDays?: number;
  agent?: string;
}

export function formatRelativeTime(timestampMs: number): string {
  const diffMs = Date.now() - timestampMs;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}天前`;
}

function readCodexSessionIndex(): CodexSessionIndexEntry[] {
  try {
    const content = fs.readFileSync(CODEX_SESSION_INDEX, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines
      .map((line) => {
        try {
          return JSON.parse(line) as CodexSessionIndexEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is CodexSessionIndexEntry => entry !== null);
  } catch {
    return [];
  }
}

export function scanCliSessions(opts?: ScanOptions): CliSessionInfo[] {
  const agent = (opts?.agent || process.env.CTI_AGENT || 'codex').toLowerCase();
  if (agent === 'grok') return scanGrokSessions(opts);
  if (agent === 'claude') return scanClaudeSessions(opts);

  const limit = opts?.limit ?? 20;
  const maxAgeDays = opts?.maxAgeDays ?? 30;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  const entries = readCodexSessionIndex();

  const results: CliSessionInfo[] = [];

  for (const entry of entries) {
    const timestamp = new Date(entry.updated_at).getTime();
    if (isNaN(timestamp) || timestamp < cutoff) continue;

    const threadName = entry.thread_name || 'Untitled';
    const project = threadName.length > 30
      ? threadName.slice(0, 30) + '...'
      : threadName;

    results.push({
      sdkSessionId: entry.id,
      project,
      cwd: '',
      firstPrompt: threadName,
      slug: '',
      timestamp,
      isOpen: false,
      gitBranch: undefined,
    });
  }

  results.sort((a, b) => b.timestamp - a.timestamp);
  return results.slice(0, limit);
}
