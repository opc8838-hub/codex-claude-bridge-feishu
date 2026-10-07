// Run only on disposable GitHub-hosted macOS runners, never on a user's PM2 host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

assert.equal(process.platform, 'darwin');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-macos-'));
const publishedTarball = path.resolve(process.argv[2]);
assert.ok(fs.existsSync(publishedTarball));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(CTI_|ANTHROPIC_|OPENAI_|CODEX_|GROK_|PM2_)/.test(key)));
const run = (file, args, options = {}) => execFileSync(file, args, {
  cwd: temp, env, encoding: 'utf8', timeout: 120_000, ...options,
});
const sourcePackage = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temp], { cwd: root }))[0];
const report = {
  platform: process.platform, arch: process.arch, node: process.version,
  macos: run('sw_vers', ['-productVersion']).trim(),
  commit: process.env.GITHUB_SHA, checks: [],
  liveFeishuAndModelCalls: false,
};
const reportPath = path.join(root, 'macos-verification.json');
const passed = (name) => {
  report.checks.push(name);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`PASS: ${name}`);
};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(200);
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  for (const [label, tarball] of [
    ['source', path.join(temp, sourcePackage.filename)],
    ['release-1.3.0', publishedTarball],
  ]) {
    const prefix = path.join(temp, `${label}-prefix`);
    run('npm', ['install', '--global', '--prefix', prefix, tarball, 'pm2@7.0.4', '--no-audit', '--no-fund']);
    const installed = path.join(prefix, 'lib/node_modules/codex-claude-bridge-feishu');
    const cli = path.join(prefix, 'bin/codex-bridge');
    const cliEnv = { ...env, PATH: `${prefix}/bin:${env.PATH}`, npm_config_prefix: prefix };
    for (const name of ['config.env.example', 'docs/INSTALL.zh.md', 'dist/daemon.mjs']) {
      assert.ok(fs.existsSync(path.join(installed, name)), name);
    }
    run(cli, ['--help'], { env: cliEnv });
    for (const agent of ['codex', 'claude', 'grok']) {
      const work = path.join(temp, `${label} 中文 workspace ${agent}`);
      fs.mkdirSync(work);
      run(cli, ['setup', agent], { cwd: work, env: cliEnv });
      const config = path.join(work, 'config.env');
      const text = fs.readFileSync(config, 'utf8');
      assert.ok(text.includes(`CTI_AGENT=${agent}`));
      assert.ok(text.includes(`CTI_DEFAULT_WORKDIR="${work}"`));
      assert.equal(fs.statSync(config).mode & 0o777, 0o600);
      run(cli, ['setup', agent], { cwd: work, env: cliEnv });
      assert.equal(fs.readFileSync(config, 'utf8'), text);
    }
    passed(`${label}: npm global command, all three setup modes, Unicode/space paths, config permissions and preservation`);

    // Use the packaged launchers with a harmless stand-in daemon. No accounts needed.
    const fixture = path.join(temp, `${label} service fixture`);
    for (const subdir of ['bin', 'dist']) fs.mkdirSync(path.join(fixture, subdir), { recursive: true });
    for (const name of ['bin/cli.js', 'ecosystem.config.cjs', 'config.env.example']) {
      fs.copyFileSync(path.join(installed, name), path.join(fixture, name));
    }
    fs.writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(fixture, 'dist/daemon.mjs'), `
      import fs from 'node:fs'; import path from 'node:path';
      fs.mkdirSync(process.env.CTI_HOME, {recursive:true});
      fs.writeFileSync(path.join(process.env.CTI_HOME, 'fixture.pid'), String(process.pid));
      setInterval(() => {}, 1000);
      process.on('SIGINT', () => process.exit(0));
      process.on('SIGTERM', () => process.exit(0));
    `);
    const fixtureCli = path.join(fixture, 'bin/cli.js');
    const configs = [path.join(fixture, 'one.env'), path.join(fixture, 'two.env')];
    const serviceNames = configs.map(config => `feishu-bridge-${createHash('sha256').update(config).digest('hex').slice(0, 10)}`);
    const serviceEnv = { ...cliEnv, PM2_HOME: path.join(temp, `${label}-pm2`) };
    const command = (args, index = 0) => run(process.execPath, [fixtureCli, ...args], {
      cwd: fixture, env: { ...serviceEnv, CTI_CONFIG_PATH: configs[index] },
    });
    const pm2 = path.join(prefix, 'lib/node_modules/pm2/bin/pm2');
    const pm2Command = (args) => run(process.execPath, [pm2, ...args], { env: serviceEnv });
    const list = () => JSON.parse(pm2Command(['jlist']));
    let foreground;
    let childPid;
    try {
      pm2Command(['ping']);
      assert.equal(list().length, 0, 'Disposable PM2 daemon must be empty');
      command(['setup', 'codex']);
      command(['setup', 'claude'], 1);
      const foregroundHome = path.join(temp, `${label}-foreground`);
      foreground = spawn(process.execPath, [fixtureCli, 'run'], {
        cwd: fixture, env: { ...serviceEnv, CTI_CONFIG_PATH: configs[0], CTI_HOME: foregroundHome },
        stdio: 'ignore',
      });
      const childPidFile = path.join(foregroundHome, 'fixture.pid');
      await waitFor(() => fs.existsSync(childPidFile), 'foreground daemon startup');
      childPid = Number(fs.readFileSync(childPidFile, 'utf8'));
      foreground.kill('SIGTERM');
      await waitFor(() => foreground.exitCode !== null || foreground.signalCode !== null, 'foreground launcher exit');
      await waitFor(() => {
        try { process.kill(childPid, 0); return false; } catch { return true; }
      }, 'foreground child exit');
      passed(`${label}: foreground startup and SIGTERM propagation`);

      command(['start']);
      command(['start'], 1);
      await waitFor(() => list().length === 2 && list().every(app => app.pm2_env.status === 'online'), 'two PM2 instances');
      let apps = list();
      assert.notEqual(apps[0].pm2_env.CTI_HOME, apps[1].pm2_env.CTI_HOME);
      const secondPid = apps.find(app => app.name === serviceNames[1]).pid;
      command(['restart']);
      command(['status']);
      command(['logs']);
      command(['stop']);
      apps = list();
      assert.equal(apps.find(app => app.name === serviceNames[0]).pm2_env.status, 'stopped');
      assert.equal(apps.find(app => app.name === serviceNames[1]).pid, secondPid);
      assert.equal(apps.find(app => app.name === serviceNames[1]).pm2_env.status, 'online');
      passed(`${label}: PM2 start/restart/status/logs/stop and independent second instance`);
    } finally {
      if (foreground && foreground.exitCode === null && foreground.signalCode === null) foreground.kill('SIGTERM');
      if (childPid) { try { process.kill(childPid, 'SIGTERM'); } catch { /* exited */ } }
      for (const app of list()) {
        assert.ok(serviceNames.includes(app.name));
        assert.equal(app.pm2_env.pm_exec_path, path.join(fixture, 'dist/daemon.mjs'));
        pm2Command(['delete', app.name]);
      }
      assert.equal(list().length, 0);
      pm2Command(['kill']);
    }
  }
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}
