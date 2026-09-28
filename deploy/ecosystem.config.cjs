/**
 * pm2 process definitions for the single deploy target.
 *
 * The whole workspace is one codebase but three long-running processes:
 *   - job-agent-api     NestJS HTTP API + Kafka consumers
 *   - job-agent-worker  Temporal activity worker
 *   - job-agent-web     Vite's preview server, which also proxies /api to the API
 *
 * `node dist/main.js` and `node dist/temporal/worker.js` are the compiled ESM
 * entrypoints; `vite preview` serves apps/web/dist and reuses the proxy in
 * vite.config.ts, so the browser only ever calls /api.
 *
 *   pm2 startOrReload deploy/ecosystem.config.cjs --update-env
 */

const path = require('node:path');

const appDir = path.resolve(__dirname, '..');
const apiDir = path.join(appDir, 'apps/job-agent');
const webDir = path.join(appDir, 'apps/web');

module.exports = {
  apps: [
    {
      name: 'job-agent-api',
      cwd: apiDir,
      script: 'dist/main.js',
      // One replica: the Kafka consumer group is shared, but a second instance
      // would also mean a second Temporal client and a second port 3000.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production', PORT: 3000 },
    },
    {
      name: 'job-agent-worker',
      cwd: apiDir,
      script: 'dist/temporal/worker.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'job-agent-web',
      cwd: webDir,
      script: path.join(webDir, 'node_modules/vite/bin/vite.js'),
      args: 'preview --host 0.0.0.0 --port 5173',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '256M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
