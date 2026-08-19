/**
 * CLI Session Scanner — discovers local Grok Build sessions.
 *
 * Walks ~/.grok/sessions/<encoded-cwd>/<session-id>/summary.json
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CliSessionInfo } from './types.js';

interface ScanOptions {
  limit?: number;
  maxAgeDays?: number;
  grokHome?: string;
}

interface GrokSummary {
  info?: { id?: string; cwd?: string };
  generated_title?: string;
  session_summary?: string;
  last_turn_summary?: string;
  updated_at?: string;
  created_at?: string;
  last_active_at?: string;
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

function defaultGrokHome(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), '.grok');
}

function projectName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cwd || 'project';
}

export function scanGrokSessions(opts?: ScanOptions): CliSessionInfo[] {
  const limit = opts?.limit ?? 20;
  const maxAgeDays = opts?.maxAgeDays ?? 30;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const root = path.join(opts?.grokHome || defaultGrokHome(), 'sessions');

  if (!fs.existsSync(root)) return [];

  const results: CliSessionInfo[] = [];

  let groups: string[] = [];
  try {
    groups = fs.readdirSync(root);
  } catch {
    return [];
  }

  for (const group of groups) {
    const groupPath = path.join(root, group);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(groupPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    let sessionDirs: string[] = [];
    try {
      sessionDirs = fs.readdirSync(groupPath);
    } catch {
      continue;
    }

    for (const sessionId of sessionDirs) {
      const summaryPath = path.join(groupPath, sessionId, 'summary.json');
      if (!fs.existsSync(summaryPath)) continue;
      let summary: GrokSummary;
      try {
        summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8')) as GrokSummary;
      } catch {
        continue;
      }
      const stamp = summary.last_active_at || summary.updated_at || summary.created_at;
      const timestamp = stamp ? Date.parse(stamp) : 0;
      if (!timestamp || timestamp < cutoff) continue;

      const cwd = summary.info?.cwd || '';
      const title = summary.generated_title || summary.session_summary || summary.last_turn_summary || 'Untitled';
      results.push({
        sdkSessionId: summary.info?.id || sessionId,
        project: projectName(cwd),
        cwd,
        firstPrompt: title,
        slug: title,
        timestamp,
        isOpen: false,
      });
    }
  }

  results.sort((a, b) => b.timestamp - a.timestamp);
  return results.slice(0, limit);
}
