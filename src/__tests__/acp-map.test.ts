import { describe, it, expect } from 'vitest';
import {
  extractAcpText,
  mapAcpUpdateToSse,
  usageFromNotification,
  buildAcpPrompt,
} from '../grok-acp.js';

describe('extractAcpText', () => {
  it('reads content.text objects', () => {
    expect(extractAcpText({ type: 'text', text: 'pong' })).toBe('pong');
  });

  it('returns empty string for missing content', () => {
    expect(extractAcpText(undefined)).toBe('');
    expect(extractAcpText(null)).toBe('');
  });
});

describe('mapAcpUpdateToSse', () => {
  it('maps agent_message_chunk to text', () => {
    const events = mapAcpUpdateToSse({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    });
    expect(events).toEqual([{ type: 'text', data: 'hello' }]);
  });

  it('drops thought chunks', () => {
    expect(
      mapAcpUpdateToSse({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking' },
      }),
    ).toEqual([]);
  });

  it('maps tool_call to tool_use', () => {
    const events = mapAcpUpdateToSse({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'read_file',
      rawInput: { target_file: 'a.ts' },
    });
    expect(events[0].type).toBe('tool_use');
    expect(JSON.parse(events[0].data as string)).toMatchObject({
      id: 't1',
      name: 'read_file',
    });
  });

  it('maps completed tool_call_update to tool_result', () => {
    const events = mapAcpUpdateToSse({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      rawOutput: { type: 'text', text: 'ok' },
    });
    expect(events[0].type).toBe('tool_result');
    expect(JSON.parse(events[0].data as string)).toMatchObject({
      tool_use_id: 't1',
      is_error: false,
    });
  });
});

describe('usageFromNotification', () => {
  it('extracts token counts from response_completed', () => {
    const usage = usageFromNotification({
      sessionUpdate: 'response_completed',
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    expect(usage).toEqual({
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it('returns null when usage is absent', () => {
    expect(usageFromNotification({ sessionUpdate: 'turn_completed' })).toBeNull();
  });
});

describe('buildAcpPrompt', () => {
  it('returns a single text block when there are no files', () => {
    expect(buildAcpPrompt('hi')).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('appends saved attachment paths because ACP image prompt is unsupported', () => {
    const blocks = buildAcpPrompt('see this', [
      {
        id: '1',
        name: 'shot.png',
        type: 'image/png',
        size: 4,
        data: 'aaaa',
        filePath: 'C:\\tmp\\shot.png',
      },
    ]);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('C:\\tmp\\shot.png');
    expect(blocks[0].text).toContain('see this');
  });
});
