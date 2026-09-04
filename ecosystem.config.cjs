module.exports = {
  apps: [{
    name: 'hevy-coach',
    script: 'node_modules/.bin/tsx',
    args: 'src/index.ts',
    cwd: '/Users/danmunz/projects/hevy-coach',
    env: {
      NODE_ENV: 'production',
    },
    // Auto-restart
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
    // Logging
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    // Memory guard
    max_memory_restart: '256M',
    // Watch (disabled — manual restart only)
    watch: false,
  }],
};
