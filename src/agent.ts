/**
 * Agent factory — one process, one of three bots: claude | codex | grok.
 */

import type { Config } from './config.js';
import type { PendingPermissions } from './permissions.js';
import type { StreamChatParams } from './types.js';
import { CodexProvider, resolveCodexCliPath, preflightCheck as preflightCodex } from './codex-provider.js';
import { ClaudeProvider, resolveClaudeCliPath, preflightCheck as preflightClaude } from './claude-provider.js';
import { GrokProvider, resolveGrokCliPath, preflightCheck as preflightGrok } from './grok-provider.js';
import type { AgentName } from './agent-name.js';

export type { AgentName } from './agent-name.js';
export { parseAgent } from './agent-name.js';

export interface AgentProvider {
  streamChat(params: StreamChatParams): ReadableStream<string>;
  close?(): void;
}

export function createProvider(
  config: Config,
  pendingPerms: PendingPermissions,
): { provider: AgentProvider; cliPath: string; version?: string } {
  const agent = config.agent;

  if (agent === 'grok') {
    const cliPath = resolveGrokCliPath();
    if (!cliPath) {
      throw new Error(
        'Cannot find the `grok` CLI. Install Grok Build CLI or set CTI_GROK_EXECUTABLE.',
      );
    }
    const check = preflightGrok(cliPath);
    if (!check.ok) throw new Error(`Grok CLI preflight failed: ${check.error}`);
    return {
      provider: new GrokProvider(cliPath, config.autoApprove, pendingPerms, config.defaultModel),
      cliPath,
      version: check.version,
    };
  }

  if (agent === 'claude') {
    const cliPath = resolveClaudeCliPath();
    if (!cliPath) {
      throw new Error(
        'Cannot find the `claude` CLI. Install Claude Code or set CTI_CLAUDE_CODE_EXECUTABLE.',
      );
    }
    const check = preflightClaude(cliPath);
    if (!check.ok) throw new Error(`Claude CLI preflight failed: ${check.error}`);
    return {
      provider: new ClaudeProvider(pendingPerms, cliPath, config.autoApprove),
      cliPath,
      version: check.version,
    };
  }

  const cliPath = resolveCodexCliPath();
  if (!cliPath) {
    throw new Error(
      'Cannot find the `codex` CLI. Install Codex CLI or set CTI_CODEX_EXECUTABLE.',
    );
  }
  const check = preflightCodex(cliPath);
  if (!check.ok) throw new Error(`Codex CLI preflight failed: ${check.error}`);
  return {
    provider: new CodexProvider(cliPath, config.autoApprove),
    cliPath,
    version: check.version,
  };
}
