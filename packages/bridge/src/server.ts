import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { SERVER_VERSION, type GuestCommand, type GuestMessage, type HostCommand } from '@ic/shared';
import { CdpManager, type CdpTarget } from './cdp.ts';
import { parseConfig } from './config.ts';
import { Hub } from './hub.ts';
import { createStaticHandler } from './static.ts';
import { findChrome, launchSimulator } from './sim-launcher.ts';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const config = parseConfig(process.argv.slice(2), rootDir);
const hub = new Hub();

const guestSockets = new Set<WebSocket>();

const cdp = new CdpManager(
  {
    host: config.cdpHost,
    port: config.cdpPort,
    bundlePath: config.bundlePath,
    watch: config.watch,
  },
  {
    onStatus(connected: boolean, detail: { target?: CdpTarget; error?: string }) {
      hub.setCdpConnected(connected);
      if (connected && detail.target) {
        hub.log('info', 'bridge', `目标页面：${detail.target.title || detail.target.url}`);
      }
    },
    onGuestMessage(payload: string) {
      let msg: GuestMessage;
      try {
        msg = JSON.parse(payload) as GuestMessage;
      } catch {
        hub.log('warn', 'bridge', 'Guest 传来无法解析的消息');
        return;
      }
      // 手势执行请求：Guest 算好坐标，Bridge 用真实 CDP 输入执行（真机只认这个）
      if (msg.type === 'input:exec') {
        void cdp.executeInputs(msg.ops);
        return;
      }
      const wasOnline = hub.snapshot.guest !== null;
      hub.handleGuestMessage(msg);
      if (msg.type === 'hello' && !wasOnline) {
        // 新注入 / 重连的 Guest：把当前运行时参数补发过去
        void forward({ type: 'options:set', options: hub.runtimeOptions });
        if (hub.projectRef) void forward({ type: 'project:sync', project: hub.projectRef });
        hub.broadcastStatus();
      }
    },
    log(level, message) {
      hub.log(level, 'bridge', message);
    },
  },
);

async function forward(command: GuestCommand): Promise<boolean> {
  let delivered = false;
  if (cdp.connected) delivered = await cdp.send(command);
  const payload = JSON.stringify(command);
  for (const socket of guestSockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(payload);
      delivered = true;
    }
  }
  if (!delivered) hub.log('warn', 'bridge', 'Guest 不在线，指令已丢弃');
  return delivered;
}

async function handleHostCommand(command: HostCommand, socket: WebSocket): Promise<void> {
  switch (command.type) {
    case 'version:select': {
      const base = { versionId: command.versionId, versionIndex: command.versionIndex };
      hub.broadcast({ type: 'version', state: { ...base, phase: 'selecting' } });
      const result = await cdp.selectVersion(command.versionIndex, command.versionId, (state) => {
        hub.broadcast({ type: 'version', state: { ...base, ...state } });
      });
      hub.broadcast({
        type: 'version',
        state: {
          ...base,
          phase: result.ok ? 'ready' : 'error',
          ...(result.detected ? { detected: result.detected } : {}),
          ...(result.error ? { message: result.error } : {}),
        },
      });
      if (!result.ok) hub.log('error', 'bridge', `切换版本失败：${result.error ?? '未知原因'}`);
      return;
    }
    case 'hello':
      hub.addHost(socket);
      return;
    case 'ping':
      socket.send(
        JSON.stringify({ type: 'status', cdpConnected: hub.snapshot.cdpConnected, guest: hub.snapshot.guest }),
      );
      return;
    case 'project:sync':
      hub.setProject(command.project);
      await forward(command);
      return;
    case 'transport:play':
      hub.setProject(command.project);
      if (command.options) hub.setOptions(command.options);
      await forward(command);
      return;
    case 'options:set':
      hub.setOptions(command.options);
      await forward(command);
      return;
    case 'mix:start':
      hub.setProject(command.project);
      await forward(command);
      return;
    case 'stage:sync':
      hub.setProject(command.project);
      await forward(command);
      return;
    case 'transport:stop':
    case 'stage:clear':
    case 'record:start':
    case 'record:stop':
    case 'mix:abort':
    case 'probe':
    case 'adapter:command':
      await forward(command);
      return;
    default:
      hub.log('warn', 'bridge', `未知 Host 指令：${String((command as { type?: string }).type)}`);
  }
}

const serveStatic = createStaticHandler({ simDir: config.simDir, hostDist: config.hostDist });

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) {
        reject(new Error('body 过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify(
        {
          ok: true,
          version: SERVER_VERSION,
          cdp: { connected: cdp.connected, target: cdp.currentTarget, error: cdp.lastErrorMessage },
          guest: hub.snapshot.guest,
          hosts: hub.hostCount,
          bundle: { path: config.bundlePath, hash: cdp.bundleHash, injectedAt: cdp.agentInjectedAt },
        },
        null,
        2,
      ),
    );
    return;
  }
  if (url.pathname === '/state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ...hub.snapshot, options: hub.runtimeOptions, project: hub.projectRef }, null, 2));
    return;
  }
  if (url.pathname === '/eval') {
    const expr = url.searchParams.get('expr');
    const target = expr ?? (req.method === 'POST' ? await readBody(req) : null);
    if (!target) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '需要 expr 参数或 POST body' }));
      return;
    }
    const result = await cdp.evaluate(target);
    res.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return;
  }
  if (url.pathname === '/screenshot') {
    const shot = await cdp.screenshot();
    if (!shot.ok || !shot.data) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: shot.error ?? '截图失败' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    res.end(Buffer.from(shot.data, 'base64'));
    return;
  }
  if (url.pathname === '/reload') {
    const result = await cdp.reload();
    res.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return;
  }
  if (url.pathname === '/input' && req.method === 'POST') {
    let parsed: {
      kind?: string;
      x?: number;
      y?: number;
      from?: { x: number; y: number };
      to?: { x: number; y: number };
      steps?: number;
      holdMs?: number;
    };
    try {
      parsed = JSON.parse(await readBody(req)) as typeof parsed;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'body 必须是 JSON' }));
      return;
    }
    // 真实鼠标事件：合成 DOM 事件被框架忽略时用它点界面 / 拖音色图标
    const result =
      parsed.kind === 'touch' && parsed.from && parsed.to
        ? await cdp.touchDrag(parsed.from, parsed.to, parsed.steps ?? 14, parsed.holdMs ?? 0)
        : parsed.kind === 'drag' && parsed.from && parsed.to
          ? await cdp.drag(parsed.from, parsed.to, parsed.steps ?? 12, parsed.holdMs ?? 0)
          : typeof parsed.x === 'number' && typeof parsed.y === 'number'
            ? await cdp.click(parsed.x, parsed.y)
            : { ok: false, error: '需要 {kind:"click",x,y} / {kind:"drag"|"touch",from,to}' };
    res.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return;
  }
  if (serveStatic(req, res, url)) return;
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  if (url.pathname !== '/host' && url.pathname !== '/guest') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === '/host') handleHost(ws);
    else handleGuest(ws);
  });
});

function handleHost(ws: WebSocket): void {
  hub.addHost(ws);
  hub.log('info', 'bridge', `Host UI 已连接（当前 ${hub.hostCount} 个）`);
  ws.on('message', (data) => {
    let command: HostCommand;
    try {
      command = JSON.parse(String(data)) as HostCommand;
    } catch {
      hub.log('warn', 'bridge', '收到无法解析的 Host 消息');
      return;
    }
    void handleHostCommand(command, ws);
  });
  ws.on('close', () => {
    hub.removeHost(ws);
    hub.log('info', 'bridge', `Host UI 已断开（剩余 ${hub.hostCount} 个）`);
  });
  ws.on('error', () => undefined);
}

function handleGuest(ws: WebSocket): void {
  guestSockets.add(ws);
  hub.log('info', 'bridge', 'Guest 通过 WebSocket 兜底通道接入');
  ws.on('message', (data) => {
    try {
      hub.handleGuestMessage(JSON.parse(String(data)) as GuestMessage);
    } catch {
      /* ignore */
    }
  });
  ws.on('close', () => {
    guestSockets.delete(ws);
  });
  ws.on('error', () => undefined);
}

server.listen(config.port, '127.0.0.1', () => {
  console.log('');
  console.log('  ╭──────────────────────────────────────────────╮');
  console.log('  │  Incredibox Composer · CDP Bridge            │');
  console.log('  ╰──────────────────────────────────────────────╯');
  console.log(`  Host UI / 静态资源   http://127.0.0.1:${config.port}/`);
  console.log(`  内置模拟器           http://127.0.0.1:${config.port}/sim`);
  console.log(`  健康检查             http://127.0.0.1:${config.port}/health`);
  console.log(`  WebSocket            ws://127.0.0.1:${config.port}/host`);
  console.log(`  CDP 目标             http://${config.cdpHost}:${config.cdpPort}`);
  console.log(`  Guest bundle         ${config.bundlePath}`);
  console.log('');

  hub.log('info', 'bridge', `Bridge ${SERVER_VERSION} 监听 127.0.0.1:${config.port}`);

  if (config.launchSim) {
    const chrome = findChrome(config.chromePath);
    if (!chrome) {
      hub.log('warn', 'bridge', '没找到 Chrome / Edge，无法自动拉起模拟器，请手动打开 /sim');
    } else {
      launchSimulator({
        chromePath: chrome,
        cdpPort: config.cdpPort,
        url: `http://127.0.0.1:${config.port}/sim`,
        headless: config.headless,
      });
      hub.log('info', 'bridge', `已启动 ${chrome} 打开模拟器（调试端口 ${config.cdpPort}）`);
    }
  }

  void cdp.start();
});

function shutdown(): void {
  hub.log('info', 'bridge', 'Bridge 正在关闭…');
  cdp.stop();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
