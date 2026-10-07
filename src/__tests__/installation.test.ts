import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = process.cwd();
const cli = path.join(root, 'bin', 'cli.js');
const tempDirs: string[] = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge install '));
  tempDirs.push(dir);
  return dir;
}
function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CTI_|ANTHROPIC_|OPENAI_|CODEX_|GROK_)/.test(key)));
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('new computer installation', () => {
  it('creates a parseable config for each agent and preserves existing credentials', async () => {
    const { parseEnvFile } = await import('../config.js');
    for (const agent of ['codex', 'claude', 'grok']) {
      const dir = tempDir();
      execFileSync(process.execPath, [cli, 'setup', agent], { cwd: dir, env: cleanEnv() });
      const configPath = path.join(dir, 'config.env');
      const config = parseEnvFile(fs.readFileSync(configPath, 'utf8'));
      expect(config.get('CTI_AGENT')).toBe(agent);
      expect(config.get('CTI_DEFAULT_WORKDIR')).toBe(dir.replaceAll('\\', '/'));
      expect(config.get('CTI_AUTO_APPROVE')).toBe('false');
      fs.writeFileSync(configPath, 'CTI_FEISHU_APP_SECRET=keep-me');
      execFileSync(process.execPath, [cli, 'setup', agent], { cwd: dir, env: cleanEnv() });
      expect(fs.readFileSync(configPath, 'utf8')).toBe('CTI_FEISHU_APP_SECRET=keep-me');
    }
  });

  it('honors an explicit config path outside the package', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'instance', 'custom.env');
    execFileSync(process.execPath, [cli, 'setup', 'claude'], {
      cwd: dir, env: { ...cleanEnv(), CTI_CONFIG_PATH: configPath },
    });
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'config.env'))).toBe(false);
  });

  it('isolates process names and runtime data for two configs', () => {
    const require = createRequire(import.meta.url);
    const ecosystem = path.join(root, 'ecosystem.config.cjs');
    const read = (configPath: string) => {
      vi.stubEnv('CTI_CONFIG_PATH', configPath);
      vi.stubEnv('CTI_HOME', '');
      delete require.cache[require.resolve(ecosystem)];
      return require(ecosystem).apps[0];
    };
    const dir = tempDir();
    const first = read(path.join(dir, 'config.one.env'));
    const second = read(path.join(dir, 'config.two.env'));
    expect(first.name).not.toBe(second.name);
    expect(first.env.CTI_HOME).not.toBe(second.env.CTI_HOME);
    expect(first.cwd).toBe(dir);
    expect(first.script).toBe(path.join(root, 'dist', 'daemon.mjs'));
    expect(first.env.CTI_CODEX_EXECUTABLE).toBeUndefined();
  });

  it('fails clearly for a missing config instead of starting a daemon', () => {
    const result = spawnSync(process.execPath, [cli, 'run'], { cwd: tempDir(), env: cleanEnv(), encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Run setup first');
  });

  it('parses inline comments without corrupting quoted keys or URL fragments', async () => {
    const { parseEnvFile } = await import('../config.js');
    const config = parseEnvFile('CTI_AUTO_APPROVE=false # comment\nOPENAI_API_KEY="test # key" # note\nOPENAI_BASE_URL=https://example.test/v1#fragment');
    expect(config.get('CTI_AUTO_APPROVE')).toBe('false');
    expect(config.get('OPENAI_API_KEY')).toBe('test # key');
    expect(config.get('OPENAI_BASE_URL')).toBe('https://example.test/v1#fragment');
  });

  it('passes credentials to providers and lets process env override the config', async () => {
    const configPath = path.join(tempDir(), 'config.env');
    fs.writeFileSync(configPath, 'CTI_AGENT=claude\nOPENAI_API_KEY=test-key\nANTHROPIC_BASE_URL=https://example.test\nCTI_AUTO_APPROVE=false\nCTI_FEISHU_APP_ID=app-test');
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_BASE_URL', 'CTI_AUTO_APPROVE', 'CTI_FEISHU_APP_ID']) vi.stubEnv(key, undefined);
    vi.stubEnv('CTI_CONFIG_PATH', configPath);
    vi.stubEnv('CTI_AGENT', 'codex');
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    const config = loadConfig();
    expect(config.agent).toBe('codex');
    expect(config.feishuAppId).toBe('app-test');
    expect(config.autoApprove).toBe(false);
    expect(process.env.OPENAI_API_KEY).toBe('test-key');
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://example.test');
  });
});
