import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStreamIdleWatchdog, isUserVisibleProgress } from '../codex-provider.js';

describe('createStreamIdleWatchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows a longer deadline while a tool runs, then restores the idle deadline', async () => {
    vi.useFakeTimers();
    const watchdog = createStreamIdleWatchdog(1_000);
    watchdog.reset(60_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(watchdog.signal.aborted).toBe(false);
    watchdog.reset();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watchdog.didTimeout()).toBe(true);
    watchdog.dispose();
  });

  it('aborts a Codex turn after the stream stays idle', async () => {
    vi.useFakeTimers();
    const watchdog = createStreamIdleWatchdog(1_000);

    watchdog.reset();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.didTimeout()).toBe(true);
    expect(watchdog.signal.reason).toMatchObject({
      message: 'Codex stream idle for 1000ms',
    });

    watchdog.dispose();
  });

  it('resets the idle deadline when a new event arrives', async () => {
    vi.useFakeTimers();
    const watchdog = createStreamIdleWatchdog(1_000);

    watchdog.reset();
    await vi.advanceTimersByTimeAsync(750);
    watchdog.reset();
    await vi.advanceTimersByTimeAsync(750);

    expect(watchdog.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(250);
    expect(watchdog.signal.aborted).toBe(true);

    watchdog.dispose();
  });
});

describe('isUserVisibleProgress', () => {
  it('does not treat internal reasoning updates as visible progress', () => {
    expect(isUserVisibleProgress({ type: 'reasoning' }, false)).toBe(false);
    expect(isUserVisibleProgress({ type: 'agent_message' }, false)).toBe(false);
    expect(isUserVisibleProgress({ type: 'agent_message' }, true)).toBe(true);
    expect(isUserVisibleProgress({ type: 'command_execution' }, false)).toBe(true);
  });
});

const windowsIt = process.platform === 'win32' ? it : it.skip;

windowsIt('builds the hidden launcher without a console window', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launcher-build-test-'));
  const launcherPath = path.join(tempDir, 'codex-hidden.exe');
  const buildScript = path.resolve('scripts', 'build-codex-hidden.ps1');
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );

  try {
    const built = spawnSync(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', buildScript, '-OutputPath', launcherPath],
      { encoding: 'utf8' },
    );
    expect(built.status, built.stderr || built.stdout).toBe(0);

    const executable = fs.readFileSync(launcherPath);
    const peHeaderOffset = executable.readUInt32LE(0x3c);
    const optionalHeaderOffset = peHeaderOffset + 24;
    const subsystem = executable.readUInt16LE(optionalHeaderOffset + 68);

    expect(subsystem).toBe(2); // IMAGE_SUBSYSTEM_WINDOWS_GUI
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}, 15_000);

windowsIt('preserves stdio and the exit code without a console window', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launcher-stdio-test-'));
  const launcherPath = path.join(tempDir, 'codex-hidden.exe');
  const helperScript = path.join(tempDir, 'stdio.ps1');
  const buildScript = path.resolve('scripts', 'build-codex-hidden.ps1');
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );

  fs.writeFileSync(
    helperScript,
    "$line = [Console]::In.ReadLine()\n[Console]::Out.WriteLine(\"out:$line\")\n[Console]::Error.WriteLine('err')\nexit 7\n",
  );

  try {
    const built = spawnSync(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', buildScript, '-OutputPath', launcherPath],
      { encoding: 'utf8' },
    );
    expect(built.status, built.stderr || built.stdout).toBe(0);

    const result = spawnSync(
      launcherPath,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helperScript],
      {
        env: { ...process.env, CODEX_REAL_EXECUTABLE: powershell },
        input: 'hello\n',
        encoding: 'utf8',
        windowsHide: false,
      },
    );

    expect(result.stdout).toContain('out:hello');
    expect(result.stderr).toContain('err');
    expect(result.status).toBe(7);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}, 15_000);

windowsIt('terminates the real child when the hidden launcher is killed', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launcher-test-'));
  const launcherPath = path.join(tempDir, 'codex-hidden.exe');
  const pidFile = path.join(tempDir, 'child.pid');
  const helperScript = path.join(tempDir, 'child.ps1');
  const buildScript = path.resolve('scripts', 'build-codex-hidden.ps1');
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );

  fs.writeFileSync(
    helperScript,
    `Set-Content -LiteralPath '${pidFile.replaceAll("'", "''")}' -Value $PID\nStart-Sleep -Seconds 60\n`,
  );

  const compiled = spawnSync(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', buildScript, '-OutputPath', launcherPath],
    { encoding: 'utf8' },
  );
  expect(compiled.status, compiled.stderr || compiled.stdout).toBe(0);

  let realChildPid = 0;
  const launcher = spawn(
    launcherPath,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helperScript],
    {
      env: { ...process.env, CODEX_REAL_EXECUTABLE: powershell },
      stdio: 'ignore',
      windowsHide: true,
    },
  );

  try {
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(fs.existsSync(pidFile)).toBe(true);
    realChildPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(realChildPid).toBeGreaterThan(0);

    const launcherExit = new Promise<void>((resolve) => launcher.once('exit', () => resolve()));
    launcher.kill();
    await launcherExit;
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(isProcessAlive(realChildPid)).toBe(false);
  } finally {
    if (!launcher.killed) launcher.kill();
    if (realChildPid && isProcessAlive(realChildPid)) {
      spawnSync('taskkill.exe', ['/PID', String(realChildPid), '/T', '/F'], { stdio: 'ignore' });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}, 15_000);

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
