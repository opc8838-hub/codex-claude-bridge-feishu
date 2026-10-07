import * as esbuild from 'esbuild';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/daemon.mjs',
  external: [
    // SDK must stay external — it spawns a CLI subprocess and resolves
    // dist/cli.js relative to its own package location.
    '@openai/codex-sdk',
    '@anthropic-ai/claude-agent-sdk',
    // Feishu/Lark SDK uses __dirname which isn't available in bundled ESM
    '@larksuiteoapi/node-sdk',
    // Node.js built-ins
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
    'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
    'node:*',
  ],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});

console.log('Built dist/daemon.mjs');

if (process.platform === 'win32') {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('scripts/build-codex-hidden.ps1'), '-OutputPath', path.resolve('dist/codex-hidden.exe')],
  { stdio: 'inherit', windowsHide: true });
}
