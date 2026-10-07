import { describe, expect, it } from 'vitest';
import { FeishuClient } from '../feishu.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Feishu card streaming', () => {
  it('serializes and coalesces card content updates', async () => {
    const first = deferred();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const contents: string[] = [];

    // Test the private streaming scheduler with an in-memory REST client.
    const client = new FeishuClient({} as any, {} as any) as any;
    client.restClient = {
      cardkit: { v1: { cardElement: { content: ({ data }: any) => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        contents.push(data.content);
        const request = calls === 1 ? first.promise : Promise.resolve();
        return request.finally(() => { active--; });
      } } } },
    };
    client.activeCards.set('chat', {
      cardId: 'card',
      messageId: 'message',
      sequence: 0,
      startTime: Date.now(),
      toolCalls: [],
      thinking: true,
      pendingText: null,
      pendingRevision: 0,
      flushedRevision: 0,
      lastUpdateAt: 0,
      throttleTimer: null,
      updateInFlight: null,
    });

    client.updateCardContent('chat', 'one');
    client.updateCardContent('chat', 'two');
    client.updateCardContent('chat', 'three');

    expect(calls).toBe(1);
    expect(maxActive).toBe(1);

    first.resolve();
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
    expect(contents[1]).toContain('three');
  });
});
