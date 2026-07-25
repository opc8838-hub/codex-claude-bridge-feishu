import { describe, it, expect } from 'vitest';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from '../validators.js';

describe('validateWorkingDirectory', () => {
  it('rejects empty string', () => {
    expect(validateWorkingDirectory('')).toBeNull();
    expect(validateWorkingDirectory('  ')).toBeNull();
  });

  it('rejects relative paths', () => {
    expect(validateWorkingDirectory('src')).toBeNull();
    expect(validateWorkingDirectory('./foo')).toBeNull();
  });

  it('accepts valid absolute paths', () => {
    const result = validateWorkingDirectory('/home/user/project');
    expect(result).not.toBeNull();
    expect(result!.endsWith('project')).toBe(true);
  });

  it('accepts Windows absolute paths', () => {
    const result = validateWorkingDirectory('C:\\Users\\test');
    expect(result).not.toBeNull();
  });

  it('rejects path traversal', () => {
    expect(validateWorkingDirectory('/etc/../passwd')).toBeNull();
    expect(validateWorkingDirectory('C:\\..\\Windows')).toBeNull();
  });

  it('rejects shell metacharacters', () => {
    expect(validateWorkingDirectory('/tmp/$(whoami)')).toBeNull();
    expect(validateWorkingDirectory('/tmp/`id`')).toBeNull();
    expect(validateWorkingDirectory('/tmp/foo;rm -rf /')).toBeNull();
  });
});

describe('validateSessionId', () => {
  it('accepts valid UUIDs', () => {
    expect(validateSessionId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
  });

  it('rejects short strings', () => {
    expect(validateSessionId('abc')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateSessionId('')).toBe(false);
  });
});

describe('isDangerousInput', () => {
  it('returns safe for normal text', () => {
    expect(isDangerousInput('hello world').dangerous).toBe(false);
    expect(isDangerousInput('/help').dangerous).toBe(false);
  });

  it('detects null bytes', () => {
    expect(isDangerousInput('foo\0bar').dangerous).toBe(true);
  });

  it('detects path traversal', () => {
    expect(isDangerousInput('../etc/passwd').dangerous).toBe(true);
    expect(isDangerousInput('..\\Windows').dangerous).toBe(true);
  });

  it('detects command substitution', () => {
    expect(isDangerousInput('$(whoami)').dangerous).toBe(true);
    expect(isDangerousInput('`id`').dangerous).toBe(true);
  });

  it('detects chained dangerous commands', () => {
    expect(isDangerousInput('; rm -rf /').dangerous).toBe(true);
    expect(isDangerousInput('; cat /etc/passwd').dangerous).toBe(true);
  });

  it('detects pipe to shell', () => {
    expect(isDangerousInput('| bash').dangerous).toBe(true);
    expect(isDangerousInput('| sh').dangerous).toBe(true);
  });
});

describe('sanitizeInput', () => {
  it('removes control characters', () => {
    const result = sanitizeInput('hello\x00world');
    expect(result.text).toBe('helloworld');
  });

  it('truncates long input', () => {
    const long = 'a'.repeat(40_000);
    const result = sanitizeInput(long);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(32_000);
  });

  it('returns empty for falsy input', () => {
    const result = sanitizeInput('');
    expect(result.text).toBe('');
    expect(result.truncated).toBe(false);
  });
});

describe('validateMode', () => {
  it('accepts valid modes', () => {
    expect(validateMode('code')).toBe(true);
    expect(validateMode('plan')).toBe(true);
    expect(validateMode('ask')).toBe(true);
  });

  it('rejects invalid modes', () => {
    expect(validateMode('')).toBe(false);
    expect(validateMode('chat')).toBe(false);
    expect(validateMode('CODING')).toBe(false);
  });
});
