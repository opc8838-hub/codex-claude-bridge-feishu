import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeStream } from '../conversation.js';

/** One SSE frame, in the same wire format claude-provider's sseEvent() emits. */
function frame(type: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${JSON.stringify({ type, data: payload })}\n`;
}

function controllableStream() {
  let controller!: ReadableStreamDefaultController<string>;
  const stream = new ReadableStream<string>({
    start(c) { controller = c; },
  });
  return { stream, controller };
}

const ctx = {
  store: {
    addMessage: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
  },
} as unknown as Parameters<typeof consumeStream>[0];

describe('consumeStream heartbeat', () => {
  afterEach(() => { vi.useRealTimers(); });

  // A tool call is silent by design: tool_use is emitted when the tool starts,
  // tool_result only when it finishes. Treating that silence as a hang killed
  // every command that ran longer than the idle timeout.
  it('keeps waiting while a tool call is in flight', async () => {
    vi.useFakeTimers();
    const { stream, controller } = controllableStream();
    const abort = new AbortController();

    const pending = consumeStream(ctx, stream, 'sess', abort);

    controller.enqueue(frame('tool_use', { id: 't1', name: 'Bash', input: {} }));
    // Far past the no-tool idle timeout — but still short of the tool one.
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

    expect(abort.signal.aborted).toBe(false);

    controller.enqueue(frame('tool_result', { tool_use_id: 't1', content: 'ok' }));
    controller.close();

    const result = await pending;
    expect(result.hasError).toBe(false);
  });

  // With no tool running, silence really does mean the CLI is stuck — and the
  // stolen process has to be killed, or it keeps writing to the SDK session
  // after the caller has released the session lock.
  it('aborts the CLI when idle with nothing in flight', async () => {
    vi.useFakeTimers();
    const { stream } = controllableStream();
    const abort = new AbortController();

    const pending = consumeStream(ctx, stream, 'sess', abort);
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

    const result = await pending;
    expect(result.hasError).toBe(true);
    expect(result.errorMessage).toBe('Heartbeat timeout: no output for 5 minutes');
    expect(abort.signal.aborted).toBe(true);
  });
});
