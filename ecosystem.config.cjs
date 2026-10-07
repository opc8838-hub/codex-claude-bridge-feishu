// Portable PM2 configuration. Each config file gets a separate process/data dir.
const path = require('node:path');
const { createHash } = require('node:crypto');

const configPath = path.resolve(process.env.CTI_CONFIG_PATH || path.join(__dirname, 'config.env'));
const instanceId = createHash('sha256').update(configPath).digest('hex').slice(0, 10);
const runtimeDir = path.resolve(process.env.CTI_HOME || path.join(path.dirname(configPath), `.bridge-${instanceId}`));

module.exports = {
  apps: [{
    name: `feishu-bridge-${instanceId}`,
    // PM2 interprets a script path containing spaces as a shell command on POSIX.
    // Start Node directly and pass the daemon path as a separate argument.
    script: process.execPath,
    args: [path.join(__dirname, 'dist', 'daemon.mjs')],
    cwd: path.dirname(configPath),
    interpreter: 'none',
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      CTI_CONFIG_PATH: configPath,
      CTI_HOME: runtimeDir,
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: path.join(runtimeDir, 'logs', 'pm2-error.log'),
    out_file: path.join(runtimeDir, 'logs', 'pm2-out.log'),
    merge_logs: true,
    watch: false,
  }],
};
