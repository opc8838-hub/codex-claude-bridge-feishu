/**
 * Bridge — message orchestrator for the Feishu-Codex bridge.
 *
 * Consumes inbound messages from FeishuClient, routes slash commands,
 * handles numeric permission shortcuts, and dispatches to the conversation engine.
 * Uses per-session locks for concurrency control.
 */

import type {
  AppContext,
  InboundMessage,
  ChannelBinding,
  CliSessionInfo,
  ToolCallInfo,
} from './types.js';
import * as conversation from './conversation.js';
import { deliver } from './delivery.js';
import {
  forwardPermissionRequest,
  handlePermissionCallback,
} from './permissions.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './validators.js';
import { formatRelativeTime } from './session-scanner.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { htmlToFeishuMarkdown } from './feishu-markdown.js';

// ── Memory layer ─────────────────────────────────────────────

const MEMORY_FILE = path.join(os.homedir(), '.codex-bridge-memory.md');

function readMemory(): string {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return fs.readFileSync(MEMORY_FILE, 'utf-8').trim();
    }
  } catch { /* file read error — return empty */ }
  return '';
}

function buildCotCardSummary(
  toolNames: string[],
  toolCount: number,
  tokenUsage: { input_tokens: number; output_tokens: number; cost_usd?: number } | null,
): string {
  const lines: string[] = [];
  if (toolCount > 0) {
    const unique = [...new Set(toolNames)];
    const toolList = unique.slice(0, 6).join(', ');
    const more = unique.length > 6 ? ` +${unique.length - 6} more` : '';
    lines.push(`🔧 ${toolCount} tool call${toolCount > 1 ? 's' : ''}: ${toolList}${more}`);
  } else {
    lines.push('✓ Completed');
  }
  if (tokenUsage) {
    const total = tokenUsage.input_tokens + tokenUsage.output_tokens;
    lines.push(`📊 ${total.toLocaleString()} tokens`);
  }
  lines.push('');
  lines.push('_See message below for details_');
  return lines.join('\n');
}

function wrapPromptWithMemory(text: string): string {
  const memory = readMemory();
  if (!memory) return text;
  return `[持久记忆 — 关于用户偏好、项目上下文、常用设置]\n${memory}\n\n---\n\n[用户消息]\n${text}`;
}

// ── /list cache (per-chat, 5 min TTL) ───────────────────────

interface ListCacheEntry {
  sessions: CliSessionInfo[];
  cachedAt: number;
}

const LIST_CACHE_TTL = 5 * 60 * 1000;
const listCache = new Map<string, ListCacheEntry>();

function getCachedList(chatId: string): CliSessionInfo[] | null {
  const entry = listCache.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > LIST_CACHE_TTL) {
    listCache.delete(chatId);
    return null;
  }
  return entry.sessions;
}

// ── Session locks ────────────────────────────────────────────

const sessionLocks = new Map<string, Promise<void>>();

function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const prev = sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  sessionLocks.set(sessionId, current);
  current.finally(() => {
    if (sessionLocks.get(sessionId) === current) {
      sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

// ── Active tasks ─────────────────────────────────────────────

const activeTasks = new Map<string, AbortController>();

// ── Numeric permission shortcut check ────────────────────────

function isNumericPermissionShortcut(ctx: AppContext, rawText: string, chatId: string): boolean {
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const pending = ctx.store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0;
}

// ── Resolve binding ──────────────────────────────────────────

function resolveBinding(ctx: AppContext, chatId: string): ChannelBinding {
  const existing = ctx.store.getChannelBinding(chatId);
  if (existing) {
    const session = ctx.store.getSession(existing.codepilotSessionId);
    if (session) return existing;
  }
  return createNewBinding(ctx, chatId);
}

function createNewBinding(
  ctx: AppContext,
  chatId: string,
  workDir?: string,
  requireMention?: boolean,
): ChannelBinding {
  const cwd = workDir || ctx.config.defaultWorkDir || os.homedir();
  const model = ctx.config.defaultModel || '';
  const session = ctx.store.createSession(`Bridge: ${chatId}`, model, undefined, cwd);
  return ctx.store.upsertChannelBinding({
    chatId,
    codepilotSessionId: session.id,
    workingDirectory: cwd,
    model,
    requireMention,
  });
}

// ── SDK Session Update Logic ─────────────────────────────────

function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
  errorMessage: string,
): string | null {
  // A timeout, auth failure, or transient provider error does not invalidate the
  // underlying thread. Keep it so the next message can resume its context.
  if (sdkSessionId) return sdkSessionId;
  if (hasError && /\b(?:session|thread)\b.*\b(?:not found|does not exist|unknown|invalid|expired)\b/i.test(errorMessage)) {
    return '';
  }
  return null;
}

// ── CLI Session Helpers ──────────────────────────────────────

function findCliSession(ctx: AppContext, query: string): CliSessionInfo | null {
  const sessions = ctx.store.listCliSessions({ limit: 50 });
  const q = query.toLowerCase();
  const byId = sessions.find(s => s.sdkSessionId.toLowerCase().startsWith(q));
  if (byId) return byId;
  const bySlug = sessions.find(s => s.slug.toLowerCase() === q);
  return bySlug || null;
}

function resumeCliSession(ctx: AppContext, chatId: string, target: CliSessionInfo): string {
  const model = ctx.config.defaultModel || '';
  const session = ctx.store.createSession(
    `Resume: ${target.slug || target.sdkSessionId.slice(0, 8)}`,
    model,
    undefined,
    target.cwd,
  );

  const binding = ctx.store.upsertChannelBinding({
    chatId,
    codepilotSessionId: session.id,
    workingDirectory: target.cwd,
    model,
  });

  ctx.store.updateChannelBinding(binding.id, { sdkSessionId: target.sdkSessionId });

  const icon = target.isOpen ? '🟢' : '⚪';
  const prompt = target.firstPrompt.length > 40 ? target.firstPrompt.slice(0, 40) + '...' : target.firstPrompt;
  return [
    `${icon} 已恢复 CLI 会话`,
    '',
    `Project: \`${target.project}\``,
    `CWD: \`${target.cwd}\``,
    target.slug ? `Slug: \`${target.slug}\`` : '',
    `"${prompt}"`,
    '',
    `终端恢复: \`codex exec resume ${target.sdkSessionId}\``,
    '',
    '现在可以直接发消息继续对话。',
  ].filter(Boolean).join('\n');
}

// ── Main loop ────────────────────────────────────────────────

export async function runBridgeLoop(ctx: AppContext): Promise<void> {
  while (ctx.feishu.isRunning()) {
    try {
      const msg = await ctx.feishu.consumeOne();
      if (!msg) continue;

      if (
        msg.callbackData ||
        msg.text.trim().startsWith('/') ||
        isNumericPermissionShortcut(ctx, msg.text.trim(), msg.chatId)
      ) {
        await handleMessage(ctx, msg);
      } else {
        const binding = resolveBinding(ctx, msg.chatId);
        processWithSessionLock(binding.codepilotSessionId, () =>
          handleMessage(ctx, msg),
        ).catch(err => {
          console.error(`[bridge] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
        });
      }
    } catch (err) {
      console.error('[bridge] Error in loop:', err);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ── Message handler ──────────────────────────────────────────

async function handleMessage(ctx: AppContext, msg: InboundMessage): Promise<void> {
  // Handle callback queries (permission buttons)
  if (msg.callbackData) {
    const handled = handlePermissionCallback(ctx, msg.callbackData, msg.chatId, msg.callbackMessageId);
    if (handled) {
      await deliver(ctx, msg.chatId, 'Permission response recorded.');
    }
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  if (!rawText && !hasAttachments) return;

  // Numeric shortcut for permission replies (1/2/3)
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (/^[123]$/.test(normalized)) {
    const pendingLinks = ctx.store.listPendingPermissionLinksByChat(msg.chatId);
    if (pendingLinks.length === 1) {
      const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
      const action = actionMap[normalized];
      const permId = pendingLinks[0].permissionRequestId;
      const callbackData = `perm:${action}:${permId}`;
      const handled = handlePermissionCallback(ctx, callbackData, msg.chatId);
      const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
      if (handled) {
        await deliver(ctx, msg.chatId, `${label}: recorded.`);
      } else {
        await deliver(ctx, msg.chatId, 'Permission not found or already resolved.');
      }
      return;
    }
    if (pendingLinks.length > 1) {
      await deliver(ctx, msg.chatId,
        `Multiple pending permissions (${pendingLinks.length}). Use /perm allow|allow_session|deny <id>`,
      );
      return;
    }
    // No pending → fall through as normal message
  }

  // Slash commands
  if (rawText.startsWith('/')) {
    await handleCommand(ctx, msg, rawText);
    return;
  }

  // Sanitize
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge] Input truncated from ${rawText.length} to ${text.length} chars`);
  }

  if (!text && !hasAttachments) return;

  // Regular message → conversation engine
  const binding = resolveBinding(ctx, msg.chatId);

  ctx.feishu.onMessageStart(msg.chatId);

  const taskAbort = new AbortController();
  activeTasks.set(binding.codepilotSessionId, taskAbort);

  // Tool call tracker for streaming card
  const toolCallTracker = new Map<string, ToolCallInfo>();

  const onPartialText = (fullText: string) => {
    try { ctx.feishu.onStreamText(msg.chatId, fullText); } catch { /* non-critical */ }
  };

  const onToolEvent = (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => {
    if (toolName) {
      toolCallTracker.set(toolId, { id: toolId, name: toolName, status });
    } else {
      const existing = toolCallTracker.get(toolId);
      if (existing) existing.status = status;
    }
    try {
      ctx.feishu.onToolEvent(msg.chatId, Array.from(toolCallTracker.values()));
    } catch { /* non-critical */ }
  };

  try {
    const promptText = wrapPromptWithMemory(text || (hasAttachments ? 'Describe this image.' : ''));

    const result = await conversation.processMessage(
      ctx,
      binding,
      promptText,
      async (perm) => {
        await forwardPermissionRequest(
          ctx,
          msg.chatId,
          perm.permissionRequestId,
          perm.toolName,
          perm.toolInput,
          binding.codepilotSessionId,
          perm.suggestions,
          msg.messageId,
        );
      },
      taskAbort.signal,
      hasAttachments ? msg.attachments : undefined,
      onPartialText,
      onToolEvent,
    );

    // Upload any files generated by Codex back to Feishu
    if (result.fileOutputs && result.fileOutputs.length > 0) {
      for (const fo of result.fileOutputs) {
        try {
          const sr = await ctx.feishu.sendFileAsMessage(msg.chatId, fo.path);
          if (!sr.ok) {
            console.warn(`[bridge] File upload failed: ${fo.path} — ${sr.error}`);
          }
        } catch (err) {
          console.warn(
            `[bridge] File upload error for ${fo.path}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    // Finalize streaming card
    const cotMode = binding.cotMode || 'off';
    const cotEnabled = cotMode === 'brief' || cotMode === 'detailed';
    let cardFinalized = false;

    // Build tool summary for COT card
    const toolNames = Array.from(toolCallTracker.values()).map(t => t.name).filter(Boolean);
    const cardText = cotEnabled
      ? buildCotCardSummary(toolNames, toolCallTracker.size, result.tokenUsage)
      : result.responseText;

    try {
      const status = result.hasError ? 'error' : 'completed';
      cardFinalized = await ctx.feishu.onStreamEnd(msg.chatId, status, cardText, result.tokenUsage);
    } catch (err) {
      console.warn('[bridge] Card finalize failed:', err instanceof Error ? err.message : err);
    }

    // Send response text
    if (result.responseText) {
      if (cotEnabled) {
        // COT: always send clean answer as separate message
        await deliver(ctx, msg.chatId, result.responseText, {
          sessionId: binding.codepilotSessionId,
          parseMode: 'Markdown',
          replyToMessageId: msg.messageId,
        });
      } else if (!cardFinalized) {
        // Default: only send if card wasn't finalized
        await deliver(ctx, msg.chatId, result.responseText, {
          sessionId: binding.codepilotSessionId,
          parseMode: 'Markdown',
          replyToMessageId: msg.messageId,
        });
      }
    } else if (result.hasError) {
      const errorText = `**Error:** ${result.errorMessage}`;
      await deliver(ctx, msg.chatId, errorText, {
        sessionId: binding.codepilotSessionId,
        parseMode: 'Markdown',
        replyToMessageId: msg.messageId,
      });
    }

    // Persist SDK session ID
    if (binding.id) {
      try {
        const update = computeSdkSessionUpdate(
          result.sdkSessionId,
          result.hasError,
          result.errorMessage,
        );
        if (update !== null) {
          ctx.store.updateChannelBinding(binding.id, { sdkSessionId: update });
        }
      } catch { /* best effort */ }
    }
  } finally {
    if (taskAbort.signal.aborted) {
      try {
        await ctx.feishu.onStreamEnd(msg.chatId, 'interrupted', '');
      } catch { /* best effort */ }
    }
    activeTasks.delete(binding.codepilotSessionId);
    ctx.feishu.onMessageEnd(msg.chatId);
  }
}

// ── Slash commands ───────────────────────────────────────────

async function handleCommand(
  ctx: AppContext,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Dangerous input check
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    console.warn(`[bridge] Blocked dangerous input: ${dangerCheck.reason}`);
    await deliver(ctx, msg.chatId, 'Command rejected: invalid input detected.');
    return;
  }

  let response = '';

  switch (command) {
    case '/start':
    case '/help':
      response = [
        '**Feishu-Codex Bridge**',
        '',
        'Send any message to interact with Codex.',
        '',
        '**Commands:**',
        '/newchat <name> [desc] - Create new group & session',
        '/new [path] - Start new session in current chat',
        '/bind <session_id> - Bind to existing session',
        '/list - Discover local CLI sessions',
        '/resume <编号或ID> - Resume a CLI session',
        '/cwd /path - Change working directory',
        '/ws save|use|list|remove <name> - Workspace bookmarks',
        '/mode plan|code|ask - Change mode',
        '/mention on|off - Toggle @mention requirement',
        '/cot off|brief|detailed - Chain-of-thought display',
        '/invite user|admin|group - Authorize access',
        '/remove user|admin|group - Revoke access',
        '/config [setting] [value] - View/change settings',
        '/access - Show access control list',
        '/status - Show current status',
        '/usage - Show token usage for current session',
        '/usage_all - Show token usage across all sessions',
        '/stop - Stop current session',
        '/memory - View cross-session memory',
        '/sendfile <path> - Upload a file to this chat',
        '/perm allow|allow_session|deny <id> - Permission response',
        '1/2/3 - Quick permission reply (single pending)',
        '/help - Show this help',
      ].join('\n');
      break;

    case '/memory': {
      const mem = readMemory();
      if (!mem) {
        response = [
          '**Memory (empty)**',
          '',
          'No cross-session memory yet. Codex reads `~/.codex-bridge-memory.md` before each conversation.',
          '',
          'To add memory, tell Codex something like:',
          '"记住：我的项目在 C:\\\\projects 下，用 TypeScript，缩进 2 空格"',
          'Codex will update the memory file for future sessions.',
        ].join('\n');
      } else {
        response = [
          `**Cross-Session Memory** (${mem.split('\n').length} lines)`,
          '',
          '```',
          mem.slice(0, 2000),
          '```',
          '',
          mem.length > 2000 ? '(truncated — file is larger)' : '',
          'Codex reads this before every conversation. Update it by telling Codex your preferences.',
        ].join('\n');
      }
      break;
    }

    case '/new': {
      const oldBinding = resolveBinding(ctx, msg.chatId);
      const oldTask = activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        oldTask.abort();
        activeTasks.delete(oldBinding.codepilotSessionId);
      }

      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      }
      const binding = createNewBinding(ctx, msg.chatId, workDir);
      response = [
        'New session created.',
        `Session: \`${binding.codepilotSessionId.slice(0, 8)}...\``,
        `CWD: \`${binding.workingDirectory || '~'}\``,
      ].join('\n');
      break;
    }

    case '/newchat': {
      if (!args) {
        response = 'Usage: /newchat <group name> [description]\n\nCreates a new Feishu group with the bot, binds a fresh Codex session to it.';
        break;
      }
      const firstSpace = args.indexOf(' ');
      const groupName = firstSpace > 0 ? args.slice(0, firstSpace).trim() : args;
      const safeName = groupName.slice(0, 256);
      const groupDesc = firstSpace > 0 ? args.slice(firstSpace + 1).trim() : '';
      const result = await ctx.feishu.createGroupChat(safeName, groupDesc, msg.userId);
      if (!result) {
        response = 'Failed to create group. Check bot permissions (need `im:chat` and `im:chat:members` scopes).';
        break;
      }
      const binding = createNewBinding(ctx, result.chatId, undefined, false);
      response = [
        `Group **${result.name}** created.`,
        '',
        `You've been added — all messages are visible to Codex (no @mention needed).`,
        '',
        `Session: \`${binding.codepilotSessionId.slice(0, 8)}...\``,
        `CWD: \`${binding.workingDirectory || '~'}\``,
        `Use /mention on|off to toggle @mention requirement.`,
      ].join('\n');
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind <session_id>';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format.';
        break;
      }
      const session = ctx.store.getSession(args);
      if (session) {
        ctx.store.upsertChannelBinding({
          chatId: msg.chatId,
          codepilotSessionId: args,
          workingDirectory: session.working_directory,
          model: session.model,
        });
        response = `Bound to session \`${args.slice(0, 8)}...\``;
      } else {
        const cliSession = findCliSession(ctx, args);
        if (cliSession) {
          response = resumeCliSession(ctx, msg.chatId, cliSession);
        } else {
          response = 'Session not found.';
        }
      }
      break;
    }

    case '/cwd': {
      if (!args) {
        response = 'Usage: /cwd /path/to/directory';
        break;
      }
      const validatedPath = validateWorkingDirectory(args);
      if (!validatedPath) {
        response = 'Invalid path.';
        break;
      }
      const binding = resolveBinding(ctx, msg.chatId);
      ctx.store.updateChannelBinding(binding.id, { workingDirectory: validatedPath });
      response = `Working directory set to \`${validatedPath}\``;
      break;
    }

    case '/ws': {
      const wsParts = args.split(/\s+/);
      const wsAction = wsParts[0]?.toLowerCase();
      const wsName = wsParts.slice(1).join(' ').trim();

      switch (wsAction) {
        case 'save': {
          if (!wsName) {
            response = 'Usage: /ws save <name>\nSaves current working directory as a named workspace.';
            break;
          }
          const binding = resolveBinding(ctx, msg.chatId);
          const cwd = binding.workingDirectory || ctx.config.defaultWorkDir || os.homedir();
          ctx.store.saveWorkspace(wsName, cwd);
          response = `Workspace **${wsName}** saved → \`${cwd}\``;
          break;
        }
        case 'use': {
          if (!wsName) {
            response = 'Usage: /ws use <name>\nSwitches to a saved workspace directory.';
            break;
          }
          const ws = ctx.store.getWorkspace(wsName);
          if (!ws) {
            response = `Workspace **${wsName}** not found. Use /ws list to see saved workspaces.`;
            break;
          }
          if (!fs.existsSync(ws.path)) {
            response = `Workspace **${wsName}** path no longer exists:\n\`${ws.path}\`\nUse /ws remove ${wsName} to delete it.`;
            break;
          }
          const binding = resolveBinding(ctx, msg.chatId);
          ctx.store.updateChannelBinding(binding.id, { workingDirectory: ws.path });
          response = `Switched to **${wsName}** → \`${ws.path}\``;
          break;
        }
        case 'list': {
          const workspaces = ctx.store.listWorkspaces();
          if (workspaces.length === 0) {
            response = [
              '**Workspaces** (empty)',
              '',
              'Use `/ws save <name>` to bookmark your current working directory.',
              'Then `/ws use <name>` to quickly switch between projects.',
            ].join('\n');
            break;
          }
          const lines = ['**Workspaces:**', ''];
          for (const w of workspaces) {
            const exists = fs.existsSync(w.path) ? '' : ' ⚠️';
            lines.push(`• **${w.name}** → \`${w.path}\`${exists}`);
          }
          lines.push('', '/ws use <name> to switch');
          response = lines.join('\n');
          break;
        }
        case 'remove':
        case 'rm': {
          if (!wsName) {
            response = 'Usage: /ws remove <name>\nDeletes a saved workspace bookmark.';
            break;
          }
          const removed = ctx.store.removeWorkspace(wsName);
          response = removed
            ? `Workspace **${wsName}** removed.`
            : `Workspace **${wsName}** not found.`;
          break;
        }
        default:
          response = [
            '**Workspace Commands:**',
            '',
            '`/ws save <name>` — Bookmark current directory',
            '`/ws use <name>` — Switch to saved directory',
            '`/ws list` — List all workspaces',
            '`/ws remove <name>` — Delete a bookmark',
          ].join('\n');
      }
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = resolveBinding(ctx, msg.chatId);
      ctx.store.updateChannelBinding(binding.id, { mode: args as 'code' | 'plan' | 'ask' });
      response = `Mode set to **${args}**`;
      break;
    }

    case '/mention': {
      const valid = args === 'on' || args === 'off';
      if (!valid) {
        response = 'Usage: /mention on|off\n\nWhen off, all messages in group are sent to Codex (no @mention needed).';
        break;
      }
      const binding = resolveBinding(ctx, msg.chatId);
      const newVal = args === 'on';
      ctx.store.updateChannelBinding(binding.id, { requireMention: newVal });
      response = newVal
        ? '@mention required — only @bot messages go to Codex.'
        : '@mention disabled — all messages go to Codex. Use /mention on to re-enable.';
      break;
    }

    case '/cot': {
      const valid = args === 'off' || args === 'brief' || args === 'detailed';
      if (!valid) {
        response = [
          '**COT (Chain of Thought) Modes:**',
          '',
          '`/cot off` — Everything in one card (default)',
          '`/cot brief` — Tool summary card + clean answer message',
          '`/cot detailed` — Full tool details card + clean answer message',
          '',
          'When enabled, agent tool calls and process are shown in the streaming card,',
          'and the final answer is sent as a separate clean message.',
        ].join('\n');
        break;
      }
      const binding = resolveBinding(ctx, msg.chatId);
      ctx.store.updateChannelBinding(binding.id, { cotMode: args as 'off' | 'brief' | 'detailed' });
      const labels: Record<string, string> = {
        off: 'COT disabled — everything in one card.',
        brief: 'COT brief — tool summary in card, clean answer as message.',
        detailed: 'COT detailed — full process in card, clean answer as message.',
      };
      response = labels[args];
      break;
    }

    case '/config': {
      const configParts = args.split(/\s+/);
      const configKey = configParts[0]?.toLowerCase();
      const configVal = configParts[1]?.toLowerCase();

      if (!configKey) {
        // Show all settings
        const binding = resolveBinding(ctx, msg.chatId);
        const globalAuto = ctx.config.autoApprove;
        const bindingAuto = binding.autoApprove;
        const effectiveAuto = bindingAuto !== null ? bindingAuto : globalAuto;
        const access = ctx.store.getAccess();

        response = [
          '**Current Settings**',
          '',
          `Mode: **${binding.mode}**     /mode code|plan|ask`,
          `COT: **${binding.cotMode}**     /cot off|brief|detailed`,
          `@Mention: **${binding.requireMention ? 'on' : 'off'}**     /mention on|off`,
          `Auto-Approve: **${effectiveAuto ? 'on' : 'off'}**     /config auto_approve on|off`,
          `CWD: \`${binding.workingDirectory || '~'}\``,
          `Model: \`${binding.model || 'default'}\``,
          binding.sdkSessionId ? `SDK Session: \`${binding.sdkSessionId.slice(0, 16)}...\`` : '',
          '',
          `Creator: \`${access.creator || '(not set)'}\``,
          `Admins: ${access.admins.length}`,
          `Allowed Users: ${access.allowedUsers.length}`,
          `Allowed Chats: ${access.allowedChats.length}`,
        ].filter(Boolean).join('\n');
        break;
      }

      switch (configKey) {
        case 'auto_approve':
        case 'autoapprove': {
          if (configVal !== 'on' && configVal !== 'off') {
            response = 'Usage: /config auto_approve on|off\n\nWhen on, the agent auto-approves tool permissions (no approval cards).';
            break;
          }
          const binding = resolveBinding(ctx, msg.chatId);
          ctx.store.updateChannelBinding(binding.id, { autoApprove: configVal === 'on' });
          response = configVal === 'on'
            ? 'Auto-approve **on** — agent will execute tools without asking.'
            : 'Auto-approve **off** — agent will ask before running tools.';
          break;
        }
        default:
          response = [
            '**Configurable Settings:**',
            '',
            '`/config` — Show all settings',
            '`/config auto_approve on|off` — Toggle auto-approve',
          ].join('\n');
      }
      break;
    }

    case '/invite': {
      const inviteParts = args.split(/\s+/);
      const inviteTarget = inviteParts[0]?.toLowerCase();
      const isCreator = ctx.store.isCreatorOrAdmin(msg.userId);

      if (!isCreator) {
        response = 'Only the bot creator or admins can manage access.';
        break;
      }

      switch (inviteTarget) {
        case 'user': {
          // Get user ID from @mention in original message
          const mentionId = msg.mentionIds?.[0];
          if (!mentionId) {
            response = 'Usage: /invite user @某人\n\n@mention the person you want to authorize.';
            break;
          }
          const added = ctx.store.addAllowedUser(mentionId);
          response = added
            ? `User authorized. They can now DM the bot and use it in authorized groups.`
            : 'User is already authorized.';
          break;
        }
        case 'group': {
          const added = ctx.store.addAllowedChat(msg.chatId);
          response = added
            ? 'This group is now authorized. Everyone in the group can use the bot.'
            : 'This group is already authorized.';
          break;
        }
        case 'admin': {
          const mentionId = msg.mentionIds?.[0];
          if (!mentionId) {
            response = 'Usage: /invite admin @某人\n\n@mention the person you want to make an admin.';
            break;
          }
          const added = ctx.store.addAdmin(mentionId);
          // Also ensure they're in allowed users
          ctx.store.addAllowedUser(mentionId);
          response = added
            ? 'Admin added. They can manage access and use the bot anywhere.'
            : 'User is already an admin.';
          break;
        }
        default:
          response = [
            '**Access Control:**',
            '',
            '`/invite user @某人` — Authorize a user',
            '`/invite group` — Authorize this group',
            '`/invite admin @某人` — Add admin (can manage access)',
            '',
            '`/remove user @某人` `/remove group` `/remove admin @某人` — Revoke',
            '`/access` — Show current access list',
          ].join('\n');
      }
      break;
    }

    case '/remove': {
      const removeParts = args.split(/\s+/);
      const removeTarget = removeParts[0]?.toLowerCase();
      const isCreator = ctx.store.isCreatorOrAdmin(msg.userId);

      if (!isCreator) {
        response = 'Only the bot creator or admins can manage access.';
        break;
      }

      switch (removeTarget) {
        case 'user': {
          const mentionId = msg.mentionIds?.[0];
          if (!mentionId) {
            response = 'Usage: /remove user @某人';
            break;
          }
          const removed = ctx.store.removeAllowedUser(mentionId);
          response = removed ? 'User removed from access list.' : 'User not found in access list.';
          break;
        }
        case 'group': {
          const removed = ctx.store.removeAllowedChat(msg.chatId);
          response = removed ? 'Group removed from access list.' : 'Group not found in access list.';
          break;
        }
        case 'admin': {
          const mentionId = msg.mentionIds?.[0];
          if (!mentionId) {
            response = 'Usage: /remove admin @某人';
            break;
          }
          const removed = ctx.store.removeAdmin(mentionId);
          response = removed ? 'Admin removed.' : 'Admin not found.';
          break;
        }
        default:
          response = 'Usage: /remove user|group|admin\nUse /invite for details.';
      }
      break;
    }

    case '/access': {
      const access = ctx.store.getAccess();
      const lines = ['**Access Control:**', ''];
      lines.push(`Creator: \`${access.creator || '(not set)'}\``);
      lines.push('');
      lines.push(`Admins (${access.admins.length}):`);
      for (const a of access.admins) lines.push(`  • \`${a}\``);
      lines.push('');
      lines.push(`Allowed Users (${access.allowedUsers.length}):`);
      for (const u of access.allowedUsers) lines.push(`  • \`${u}\``);
      lines.push('');
      lines.push(`Allowed Chats (${access.allowedChats.length}):`);
      for (const c of access.allowedChats) lines.push(`  • \`${c}\``);
      lines.push('');
      if (!access.allowedUsers.length && !access.allowedChats.length) {
        lines.push('⚠️ Access lists are empty — everyone can use the bot.');
        lines.push('Use `/invite user @某人` or `/invite group` to restrict access.');
      }
      response = lines.join('\n');
      break;
    }

    case '/status': {
      const binding = resolveBinding(ctx, msg.chatId);
      const lines = [
        '**Bridge Status**',
        '',
        `CWD: \`${binding.workingDirectory || '~'}\``,
        `Mode: **${binding.mode}**`,
        `Model: \`${binding.model || 'default'}\``,
      ];
      if (binding.sdkSessionId) {
        lines.push('', `SDK Session (用于终端 \`codex exec resume\`):`);
        lines.push(`\`${binding.sdkSessionId}\``);
      } else {
        lines.push('', 'SDK Session: 尚未建立（发一条消息后生成）');
      }
      response = lines.join('\n');
      break;
    }

    case '/usage': {
      const binding = resolveBinding(ctx, msg.chatId);
      const usage = ctx.store.getSessionUsage(binding.codepilotSessionId);
      if (!usage) {
        response = 'No usage data yet. Send a message to Codex first.';
        break;
      }
      const totalTokens = usage.input_tokens + usage.output_tokens;
      const lines = [
        '**Session Token Usage**',
        '',
        `Input: ${usage.input_tokens.toLocaleString()} tokens`,
        `Output: ${usage.output_tokens.toLocaleString()} tokens`,
        `Cache Read: ${(usage.cache_read_input_tokens ?? 0).toLocaleString()} tokens`,
        `**Total: ${totalTokens.toLocaleString()} tokens**`,
      ];
      if (usage.cost_usd) {
        lines.push('', `Estimated cost: $${usage.cost_usd.toFixed(4)}`);
      }
      response = lines.join('\n');
      break;
    }

    case '/usage_all': {
      const allUsage = ctx.store.getAllUsage();
      if (allUsage.size === 0) {
        response = 'No usage data yet. Send messages to Codex first.';
        break;
      }
      let totalInput = 0;
      let totalOutput = 0;
      let totalCache = 0;
      let totalCost = 0;
      let sessionCount = 0;
      for (const [, u] of allUsage) {
        totalInput += u.input_tokens;
        totalOutput += u.output_tokens;
        totalCache += u.cache_read_input_tokens ?? 0;
        totalCost += u.cost_usd ?? 0;
        sessionCount++;
      }
      const grandTotal = totalInput + totalOutput;
      const lines = [
        '**All-Time Token Usage**',
        '',
        `Sessions: ${sessionCount}`,
        `Input: ${totalInput.toLocaleString()} tokens`,
        `Output: ${totalOutput.toLocaleString()} tokens`,
        `Cache Read: ${totalCache.toLocaleString()} tokens`,
        `**Total: ${grandTotal.toLocaleString()} tokens**`,
      ];
      if (totalCost > 0) {
        lines.push('', `Estimated total cost: $${totalCost.toFixed(4)}`);
      }
      response = lines.join('\n');
      break;
    }

    case '/stop': {
      const binding = resolveBinding(ctx, msg.chatId);
      const taskAbort = activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        activeTasks.delete(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/perm': {
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny <permission_id>';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = handlePermissionCallback(ctx, callbackData, msg.chatId);
      response = handled
        ? `Permission ${permAction}: recorded.`
        : 'Permission not found or already resolved.';
      break;
    }

    case '/list': {
      const sessions = ctx.store.listCliSessions({ limit: 20 });
      if (sessions.length === 0) {
        response = 'No local CLI sessions found.';
        break;
      }
      listCache.set(msg.chatId, { sessions, cachedAt: Date.now() });

      const lines = ['**本地 CLI 会话:**', ''];
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const icon = s.isOpen ? '🟢' : '⚪';
        const prompt = s.firstPrompt.length > 40 ? s.firstPrompt.slice(0, 40) + '...' : s.firstPrompt;
        const timeAgo = formatRelativeTime(s.timestamp);
        lines.push(`${i + 1}. ${icon} \`${s.sdkSessionId.slice(0, 8)}\`  ${s.project}`);
        lines.push(`   "${prompt}" (${timeAgo})`);
      }
      lines.push('');
      lines.push('发送 /resume <编号> 恢复会话');
      response = lines.join('\n');
      break;
    }

    case '/resume': {
      if (!args) {
        response = 'Usage: /resume <编号或ID>\n先发送 /list 查看可用会话。';
        break;
      }

      let target: CliSessionInfo | null = null;

      const num = parseInt(args, 10);
      if (!isNaN(num) && num > 0 && String(num) === args.trim()) {
        const cached = getCachedList(msg.chatId);
        if (cached && num <= cached.length) {
          target = cached[num - 1];
        } else {
          const freshSessions = ctx.store.listCliSessions({ limit: 20 });
          listCache.set(msg.chatId, { sessions: freshSessions, cachedAt: Date.now() });
          if (num <= freshSessions.length) {
            target = freshSessions[num - 1];
          }
        }
        if (!target) {
          response = `编号 ${num} 超出范围。发送 /list 查看可用会话。`;
          break;
        }
      }

      if (!target) {
        target = findCliSession(ctx, args);
      }

      if (!target) {
        response = `未找到匹配 "${args}" 的会话。\n发送 /list 查看可用会话。`;
        break;
      }

      // Abort running task
      const oldBinding = resolveBinding(ctx, msg.chatId);
      const oldTask = activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        oldTask.abort();
        activeTasks.delete(oldBinding.codepilotSessionId);
      }

      response = resumeCliSession(ctx, msg.chatId, target);
      break;
    }

    case '/sendfile': {
      const filePath = args.trim();
      if (!filePath) {
        response = [
          '**Send File**',
          '',
          'Usage: `/sendfile <file path>`',
          '',
          'Uploads a local file and sends it to this chat.',
          'Supports images (PNG/JPEG/GIF/WebP) and files (MP4/PDF/DOC/PPT/etc.).',
          '',
          'Example:',
          '`/sendfile C:\\Users\\me\\video.mp4`',
        ].join('\n');
        break;
      }

      // Expand ~ to home directory
      const resolvedPath = filePath.startsWith('~')
        ? path.join(os.homedir(), filePath.slice(1))
        : filePath;

      if (!fs.existsSync(resolvedPath)) {
        response = `File not found: ${resolvedPath}`;
        break;
      }

      const sr = await ctx.feishu.sendFileAsMessage(msg.chatId, resolvedPath);
      response = sr.ok
        ? `File sent: ${path.basename(resolvedPath)}`
        : `Upload failed: ${sr.error || 'unknown error'}`;
      break;
    }

    default:
      response = `Unknown command: ${command}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(ctx, msg.chatId, response, {
      parseMode: 'Markdown',
      replyToMessageId: msg.messageId,
    });
  }
}
