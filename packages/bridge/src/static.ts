import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function sendFile(res: ServerResponse, file: string): boolean {
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
  return true;
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

const PLACEHOLDER = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Incredibox Composer Bridge</title>
<style>body{font-family:ui-sans-serif,system-ui;background:#0b1020;color:#e2e8f0;padding:48px;line-height:1.7}
code{background:#1e293b;padding:2px 6px;border-radius:4px}a{color:#22d3ee}</style></head><body>
<h1>Incredibox Composer Bridge 已启动</h1>
<p>Host UI 还没构建。开发时用 <code>npm run dev</code>（Vite），或先跑 <code>npm run build</code>。</p>
<p>内置模拟器：<a href="/sim">/sim</a></p>
<p>健康检查：<a href="/health">/health</a></p>
</body></html>`;

/**
 * 静态资源服务：
 *   /sim, /sim/*  → 内置模拟游戏页（无游戏时用它跑通全链路）
 *   /*            → packages/host/dist（生产模式；不存在时给占位页）
 */
export function createStaticHandler(opts: { simDir: string; hostDist: string }) {
  const simDir = resolve(opts.simDir);
  const hostDist = resolve(opts.hostDist);
  return (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/sim') {
      // 必须带斜杠，否则页面里的 ./sim.js 会被解析到 /sim.js
      res.writeHead(302, { location: '/sim/' });
      res.end();
      return true;
    }
    if (pathname === '/sim/') {
      return sendFile(res, join(simDir, 'index.html'));
    }
    if (pathname.startsWith('/sim/')) {
      const relative = normalize(pathname.slice('/sim/'.length)).replace(/^(\.\.[/\\])+/, '');
      const file = join(simDir, relative);
      if (!file.startsWith(simDir)) {
        res.writeHead(403).end('forbidden');
        return true;
      }
      if (sendFile(res, file)) return true;
      res.writeHead(404).end('not found');
      return true;
    }
    if (existsSync(join(hostDist, 'index.html'))) {
      if (pathname === '/' || pathname === '/index.html') {
        return sendFile(res, join(hostDist, 'index.html'));
      }
      const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      const file = join(hostDist, relative);
      if (file.startsWith(hostDist) && sendFile(res, file)) return true;
      // SPA 回退
      return sendFile(res, join(hostDist, 'index.html'));
    }
    sendHtml(res, 200, PLACEHOLDER);
    return true;
  };
}
