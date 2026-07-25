// pm2 ecosystem.config.cjs — cross-platform process manager config
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 status
//   pm2 logs codex-bridge-feishu
//   pm2 stop codex-bridge-feishu

const hiddenCodex = `${__dirname}/.bridge/bin/codex-hidden.exe`;
const realCodex = 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const powershellWrapperDir = 'C:\\Users\\Administrator\\.codex\\wrappers';
const cleanPath = (process.env.Path || process.env.PATH || '')
  .split(';')
  .filter((entry) => entry.toLowerCase() !== powershellWrapperDir.toLowerCase())
  .join(';');

module.exports = {
  apps: [
    {
      name: 'codex-1',
      script: 'dist/daemon.mjs',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        CTI_CODEX_EXECUTABLE: hiddenCodex,
        CODEX_REAL_EXECUTABLE: realCodex,
        Path: cleanPath,
      },
      // Log rotation
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '.bridge/logs/pm2-error.log',
      out_file: '.bridge/logs/pm2-out.log',
      merge_logs: true,
      watch: false,
    },
    {
      name: 'codex-2',
      script: 'dist/daemon.mjs',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        CODEX_HOME: 'C:\\Users\\Administrator\\.codex-terra',
        CTI_CONFIG_PATH: `${__dirname}/config.aabaa4883eb8dcfc.env`,
        CTI_HOME: `${__dirname}/.bridge-aabaa4883eb8dcfc`,
        CTI_CODEX_EXECUTABLE: hiddenCodex,
        CODEX_REAL_EXECUTABLE: realCodex,
        Path: cleanPath,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '.bridge-aabaa4883eb8dcfc/logs/pm2-error.log',
      out_file: '.bridge-aabaa4883eb8dcfc/logs/pm2-out.log',
      merge_logs: true,
      watch: false,
    },
  ],
};
