/**
 * PM2 Ecosystem Config — Hermes Teams Bridge
 * Modular architecture - delegates to src/index.js
 */

module.exports = {
  apps: [
    {
      name: 'hermes-teams-bridge',
      script: './dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',

      // Process management
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      exp_backoff_restart_delay: 100,

      // Logging
      out_file: process.env.HOME + '/.pm2/logs/hermes-teams-bridge-out.log',
      error_file: process.env.HOME + '/.pm2/logs/hermes-teams-bridge-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_size: '10M',
      merge_logs: true,

      // Environment
      env: {
        NODE_ENV: 'production',
      },

      // Graceful reload
      kill_timeout: 5000,
      listen_timeout: 10000,
    },
  ],
};
