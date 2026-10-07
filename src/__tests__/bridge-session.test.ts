import { describe, expect, it } from 'vitest';
import { computeSdkSessionUpdate } from '../bridge.js';

describe('computeSdkSessionUpdate', () => {
  it('clears a resumed SDK session after an idle timeout', () => {
    expect(
      computeSdkSessionUpdate(
        'stale-thread-id',
        true,
        'Codex response timed out after 5 minutes without activity',
      ),
    ).toBe('');
  });

  it('keeps the SDK session after an unrelated transient error', () => {
    expect(
      computeSdkSessionUpdate('healthy-thread-id', true, 'Temporary network error'),
    ).toBe('healthy-thread-id');
  });

  it('clears a resumed SDK session when paginated thread history is unsupported', () => {
    expect(
      computeSdkSessionUpdate(
        'incompatible-thread-id',
        true,
        'thread/resume failed: paginated_threads is not supported yet (code -32601)',
      ),
    ).toBe('');
  });
});
