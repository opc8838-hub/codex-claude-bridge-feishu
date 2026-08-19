/**
 * Pure ACP → SSE helpers. No process I/O — unit-tested.
 */

import type { FileAttachment, TokenUsage } from './types.js';

export interface SsePiece {
  type: string;
  data: string;
}

export function extractAcpText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'object' && content !== null && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function toolNameFromUpdate(update: Record<string, unknown>): string {
  const title = update.title;
  if (typeof title === 'string' && title.trim()) return title;
  const kind = update.kind;
  if (typeof kind === 'string' && kind.trim()) return kind;
  const meta = asRecord(update._meta);
  const tool = asRecord(meta['x.ai/tool']);
  if (typeof tool.name === 'string') return tool.name;
  return 'tool';
}

function toolOutputText(update: Record<string, unknown>): string {
  const raw = update.rawOutput ?? update.content ?? update.result;
  if (typeof raw === 'string') return raw;
  const rec = asRecord(raw);
  const text = extractAcpText(rec.content ?? rec);
  if (text) return text;
  try {
    return JSON.stringify(raw ?? '');
  } catch {
    return String(raw ?? '');
  }
}

export function mapAcpUpdateToSse(update: unknown): SsePiece[] {
  const rec = asRecord(update);
  const kind = rec.sessionUpdate;
  if (kind === 'agent_message_chunk') {
    const text = extractAcpText(rec.content);
    return text ? [{ type: 'text', data: text }] : [];
  }
  if (kind === 'agent_thought_chunk' || kind === 'user_message_chunk' || kind === 'available_commands_update') {
    return [];
  }
  if (kind === 'tool_call') {
    const id = String(rec.toolCallId ?? rec.id ?? '');
    return [{
      type: 'tool_use',
      data: JSON.stringify({
        id,
        name: toolNameFromUpdate(rec),
        input: rec.rawInput ?? rec.locations ?? {},
      }),
    }];
  }
  if (kind === 'tool_call_update') {
    const id = String(rec.toolCallId ?? rec.id ?? '');
    const status = String(rec.status ?? '');
    const isError = status === 'failed' || status === 'error';
    const done = status === 'completed' || status === 'failed' || status === 'error';
    if (!done) {
      return [{
        type: 'tool_output',
        data: JSON.stringify({ tool_use_id: id, content: toolOutputText(rec) }),
      }];
    }
    const events: SsePiece[] = [{
      type: 'tool_result',
      data: JSON.stringify({
        tool_use_id: id,
        content: toolOutputText(rec),
        is_error: isError,
      }),
    }];
    const locations = Array.isArray(rec.locations) ? rec.locations : [];
    for (const loc of locations) {
      const path = asRecord(loc).path;
      if (typeof path === 'string' && path) {
        events.push({
          type: 'file_output',
          data: JSON.stringify({ path, kind: 'update' }),
        });
      }
    }
    return events;
  }
  if (kind === 'plan') {
    return [{ type: 'status', data: JSON.stringify({ plan: rec }) }];
  }
  return [];
}

export function usageFromNotification(update: unknown): TokenUsage | null {
  const rec = asRecord(update);
  const usage = asRecord(rec.usage);
  const input = usage.input_tokens ?? usage.inputTokens;
  const output = usage.output_tokens ?? usage.outputTokens;
  if (typeof input !== 'number' && typeof output !== 'number') return null;
  return {
    input_tokens: typeof input === 'number' ? input : 0,
    output_tokens: typeof output === 'number' ? output : 0,
    cache_read_input_tokens: typeof usage.cache_read_input_tokens === 'number'
      ? usage.cache_read_input_tokens
      : 0,
    cache_creation_input_tokens: typeof usage.cache_creation_input_tokens === 'number'
      ? usage.cache_creation_input_tokens
      : 0,
  };
}

export function buildAcpPrompt(
  text: string,
  files?: FileAttachment[],
): { type: 'text'; text: string }[] {
  const paths = (files ?? [])
    .map((f) => f.filePath)
    .filter((p): p is string => !!p);
  if (paths.length === 0) {
    return [{ type: 'text', text }];
  }
  const listed = paths.map((p) => `- ${p}`).join('\n');
  const body = [
    text.trim(),
    '',
    'The user attached local files. Read them with your file tools if needed:',
    listed,
  ].filter((line, i, arr) => !(line === '' && i === 0)).join('\n');
  return [{ type: 'text', text: body }];
}

export function sseEvent(type: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${JSON.stringify({ type, data: payload })}\n`;
}

export function modeRules(mode?: string): string | undefined {
  if (mode === 'plan') {
    return 'You are in plan mode. Do not edit files or run mutating shell commands. Propose a plan only.';
  }
  if (mode === 'ask' || mode === 'default') {
    return 'Read-only. Do not write files or run commands that change system state.';
  }
  return undefined;
}
