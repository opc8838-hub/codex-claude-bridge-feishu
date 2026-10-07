/**
 * Configuration loader.
 *
 * Reads ./config.env from the project root directory by default.
 * Runtime data (sessions, logs, PID files) lives in .bridge/ under the project root.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseAgent, type AgentName } from './agent-name.js';

export interface Config {
  agent: AgentName;
  defaultWorkDir: string;
  defaultModel?: string;
  defaultMode: string;
  cotMode: 'off' | 'brief' | 'detailed';
  feishuAppId: string;
  feishuAppSecret: string;
  feishuDomain: string;
  feishuAllowedUsers?: string[];
  feishuRequireMention: boolean;
  autoApprove: boolean;
}

/**
 * Project root — launchd sets WorkingDirectory to the project dir,
 * and `npm run dev` also runs from the project dir, so cwd() is reliable.
 */
const PROJECT_DIR = process.cwd();

/** All data lives under the project directory by default. Override with CTI_HOME env var. */
export const CTI_HOME = process.env.CTI_HOME || path.join(PROJECT_DIR, '.bridge');
export const CONFIG_PATH = process.env.CTI_CONFIG_PATH || path.join(PROJECT_DIR, 'config.env');

export function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const end = value.indexOf(value[0], 1);
      if (end !== -1) value = value.slice(1, end);
    } else {
      value = value.replace(/\s+#.*$/, '').trimEnd();
    }
    entries.set(key, value);
  }
  return entries;
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  let env = new Map<string, string>();
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    env = parseEnvFile(content);
  } catch {
    // Config file doesn't exist yet — use defaults
  }

  // Providers spawn CLI processes. Pass their configured credentials and paths
  // through, while keeping explicit process environment overrides authoritative.
  for (const [key, value] of env) {
    if (/^(CTI_|ANTHROPIC_|OPENAI_|CODEX_|GROK_)/.test(key) && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  const get = (key: string): string | undefined => process.env[key] ?? env.get(key);
  const agent = parseAgent(get('CTI_AGENT'));
  process.env.CTI_AGENT = agent;

  return {
    agent,
    defaultWorkDir: get('CTI_DEFAULT_WORKDIR') || process.cwd(),
    defaultModel: get('CTI_DEFAULT_MODEL') || undefined,
    defaultMode: get('CTI_DEFAULT_MODE') || 'code',
    feishuAppId: get('CTI_FEISHU_APP_ID') || '',
    feishuAppSecret: get('CTI_FEISHU_APP_SECRET') || '',
    feishuDomain: get('CTI_FEISHU_DOMAIN') || 'feishu',
    feishuAllowedUsers: splitCsv(get('CTI_FEISHU_ALLOWED_USERS')),
    feishuRequireMention: get('CTI_FEISHU_REQUIRE_MENTION') !== undefined
      ? get('CTI_FEISHU_REQUIRE_MENTION') !== 'false'
      : true,
    autoApprove: get('CTI_AUTO_APPROVE') === 'true',
    cotMode: (get('CTI_COT_MODE') as 'off' | 'brief' | 'detailed') || 'off',
  };
}
