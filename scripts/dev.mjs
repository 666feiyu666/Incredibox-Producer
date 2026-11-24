#!/usr/bin/env node
/**
 * 开发模式编排：
 *   1. packages/guest  vite build --watch  → dist/guest.bundle.js（Bridge 监听到变更后热注入）
 *   2. packages/bridge node src/server.ts  → HTTP + WebSocket + CDP
 *   3. packages/host   vite dev            → 5173（/host 代理到 Bridge）
 *
 * 环境变量：
 *   IC_NO_SIM=1     不自动拉起模拟器浏览器（已有真实游戏在跑时用）
 *   IC_CDP_PORT     真实游戏的远程调试端口（默认 9222）
 *   IC_WS_PORT      Bridge 端口（默认 9451）
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const children = [];

const COLOR = {
  guest: '\x1b[35m',
  bridge: '\x1b[36m',
  host: '\x1b[32m',
  reset: '\x1b[0m',
};

function run(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    // npm 在 Windows 上需要 shell 才能解析 npm.cmd；node 可执行文件路径带空格时不能过 shell
    shell: options.shell ?? false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  children.push(child);
  const prefix = `${COLOR[name] ?? ''}[${name}]${COLOR.reset}`;
  const pipe = (stream, isErr) =>
    stream.on('data', (chunk) => {
      const text = String(chunk).trimEnd();
      if (!text) return;
      for (const line of text.split(/\r?\n/)) {
        process.stdout.write(`${prefix} ${isErr ? '\x1b[31m' : ''}${line}${isErr ? COLOR.reset : ''}\n`);
      }
    });
  pipe(child.stdout, false);
  pipe(child.stderr, true);
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      process.stdout.write(`${prefix} 进程退出，code=${code}\n`);
    }
  });
  return child;
}

function shutdown() {
  for (const child of children) {
    if (child.exitCode === null) {
      if (isWin) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGTERM');
    }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const wsPort = process.env.IC_WS_PORT ?? '9451';
const cdpPort = process.env.IC_CDP_PORT ?? '9222';

console.log(`
  Incredibox Composer · dev
  ──────────────────────────────
  Host UI (vite)   http://127.0.0.1:5173/
  模拟器           http://127.0.0.1:${wsPort}/sim/
  Bridge           ws://127.0.0.1:${wsPort}/host
  CDP              http://127.0.0.1:${cdpPort}
`);

run('guest', 'npm', ['--prefix', 'packages/guest', 'run', 'watch'], { shell: isWin });
run('bridge', process.execPath, [
  'packages/bridge/src/server.ts',
  '--port',
  wsPort,
  '--cdp-port',
  cdpPort,
  ...(process.env.IC_NO_SIM === '1' ? [] : ['--launch-sim']),
]);
run('host', 'npm', ['--prefix', 'packages/host', 'run', 'dev'], { shell: isWin });
