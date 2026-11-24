import { createHash } from 'node:crypto';
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { dirname, basename } from 'node:path';
import { AGENT_GLOBAL, type GuestCommand } from '@ic/shared';

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
}

export interface CdpCallbacks {
  onStatus(connected: boolean, detail: { target?: CdpTarget; error?: string }): void;
  onGuestMessage(payload: string): void;
  log(level: 'info' | 'warn' | 'error' | 'success', message: string): void;
}

const SKIP_URL = /^(devtools:|chrome-extension:|about:blank|chrome:|edge:)/i;

/** 在 CDP target 列表里挑出「游戏主渲染页面」 */
export function pickGameTarget(targets: CdpTarget[]): CdpTarget | null {
  const pages = targets.filter((t) => t.type === 'page' && !SKIP_URL.test(t.url));
  if (pages.length === 0) return null;
  const preferred = pages.find((t) => /incredibox|steam|electron/i.test(`${t.url} ${t.title}`));
  if (preferred) return preferred;
  const sim = pages.find((t) => /\/sim|\/simulator/i.test(t.url));
  if (sim) return sim;
  return pages[0] ?? null;
}

/**
 * CDP 连接管理：定位目标页面 → 装 binding → 注入 bundle → 断线自动重连。
 *
 * 之所以用 `Runtime.addBinding` 而不是让 Guest 主动连 WebSocket：
 * 这是 Chrome 官方支持的双向通道，即使游戏页面有 CSP 限制脚本发起新连接也照常工作。
 */
export class CdpManager {
  private client: CdpSession | null = null;
  private connecting = false;
  private stopped = true;
  private pollTimer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private target: CdpTarget | null = null;
  private injectedHash: string | null = null;
  private injectedAt = 0;
  private injectRetries = 0;
  private earlyScriptId: string | null = null;
  /** 手势执行串行链（避免多个拖拽互相打断） */
  private inputChain: Promise<void> = Promise.resolve();

  private readonly opts: {
    host: string;
    port: number;
    bundlePath: string;
    watch: boolean;
  };
  private readonly cb: CdpCallbacks;

  // 注意：Node 的 TS 类型擦除（strip-only 模式）不支持参数属性，
  // 因此这里显式声明字段 + 赋值，才能 `node src/server.ts` 直接跑。
  constructor(
    opts: {
      host: string;
      port: number;
      bundlePath: string;
      watch: boolean;
    },
    cb: CdpCallbacks,
  ) {
    this.opts = opts;
    this.cb = cb;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  get currentTarget(): CdpTarget | null {
    return this.target;
  }

  get bundleHash(): string | null {
    return this.injectedHash;
  }

  get lastErrorMessage(): string | null {
    return this.lastError;
  }

  get agentInjectedAt(): number {
    return this.injectedAt;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.tick();
    this.pollTimer = setInterval(() => {
      void this.tick();
    }, 1000);
    if (this.opts.watch) this.startWatch();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    this.watcher?.close();
    this.watcher = null;
    void this.client?.close();
    this.client = null;
  }

  private startWatch(): void {
    const dir = dirname(this.opts.bundlePath);
    const file = basename(this.opts.bundlePath);
    if (!existsSync(dir)) return;
    try {
      this.watcher = watch(dir, (_event, changed) => {
        if (changed && changed !== file) return;
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          void this.inject('文件变更');
        }, 120);
      });
      this.cb.log('info', `已监听热注入源：${this.opts.bundlePath}`);
    } catch (err) {
      this.cb.log('warn', `无法监听 bundle 变更：${String(err)}`);
    }
  }

  /** 每 1s 尝试一次连接，实现「游戏重启后 3 秒内自动恢复」 */
  private async tick(): Promise<void> {
    if (this.stopped || this.client || this.connecting) return;
    await this.connect();
  }

  private async connect(): Promise<void> {
    this.connecting = true;
    try {
      const targets = (await this.listTargets()) as CdpTarget[];
      const target = pickGameTarget(targets);
      if (!target) {
        this.setError(`未找到游戏页面 Target（已探测 ${targets.length} 个）`);
        this.cb.onStatus(false, { error: this.lastError ?? undefined });
        return;
      }
      const client = await this.openSession(target);
      this.client = client;
      this.target = target;
      this.lastError = null;
      this.cb.log('success', `已连接 CDP 目标：${target.title || target.url}`);
      this.cb.onStatus(true, { target });
      await this.inject('初始化');
    } catch (err) {
      this.setError(`连接 ${this.opts.host}:${this.opts.port} 失败：${String(err)}`);
      this.cb.onStatus(false, { error: this.lastError ?? undefined });
    } finally {
      this.connecting = false;
    }
  }

  private setError(message: string): void {
    if (this.lastError !== message) this.cb.log('warn', message);
    this.lastError = message;
  }

  private async listTargets(): Promise<unknown[]> {
    // 直接用 HTTP 探测，避免 chrome-remote-interface 的 List 在无端口时抛异常链
    const url = `http://${this.opts.host}:${this.opts.port}/json/list`;
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as unknown;
    return Array.isArray(json) ? json : [];
  }

  private async openSession(target: CdpTarget): Promise<CdpSession> {
    const { default: CDP } = await import('chrome-remote-interface');
    const client = (await CDP({
      target: target.id,
      host: this.opts.host,
      port: this.opts.port,
    })) as unknown as CdpSession;

    client.on('disconnect', () => {
      if (this.client === client) {
        this.client = null;
        this.injectedHash = null;
        this.target = null;
        this.cb.log('warn', 'CDP 连接断开，等待游戏重启后自动重连…');
        this.cb.onStatus(false, { error: 'disconnected' });
      }
    });

    await client.Runtime.enable();
    await client.Page.enable().catch(() => undefined);
    await client.Runtime.addBinding({ name: '__INCREDIBOX_AGENT_EMIT__' });

    client.on('Runtime.bindingCalled', (event: { name: string; payload: string }) => {
      if (event.name === '__INCREDIBOX_AGENT_EMIT__') this.cb.onGuestMessage(event.payload);
    });

    // 页面刷新 / 导航后上下文重建，需要重新注入
    client.on('Runtime.executionContextsCleared', () => {
      this.injectedHash = null;
      this.cb.log('info', '页面上下文已重建，准备重新注入');
      setTimeout(() => void this.inject('上下文重建'), 250);
    });

    return client;
  }

  /** 把 bundle 注入目标页面（幂等：先 dispose 旧实例） */
  async inject(reason: string): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    let source: string;
    try {
      source = readFileSync(this.opts.bundlePath, 'utf8');
    } catch (err) {
      this.cb.log('error', `读取 guest bundle 失败：${String(err)}（先执行 npm run build:guest）`);
      return false;
    }
    // 页面还没 load 完就注入，会错过游戏自己挂到 window 上的全局对象（AudioContext、游戏 API），
    // 适配层会退化成纯 DOM 推断。所以先等 readyState 变 complete。
    const ready = await this.evaluate('document.readyState');
    if (ready.ok && ready.value !== 'complete') {
      if (this.injectRetries < 20) {
        this.injectRetries += 1;
        setTimeout(() => void this.inject(reason), 250);
        return false;
      }
      this.cb.log('warn', '页面长时间未完成加载，仍然注入');
    }
    this.injectRetries = 0;

    const hash = createHash('sha1').update(source).digest('hex').slice(0, 12);

    // 关键：AudioContext 往往在页面加载时就创建好了，而注入发生在那之后 ——
    // 只 patch 构造器会永远抓不到已存在的 ctx。用 addScriptToEvaluateOnNewDocument
    // 让 hook 在文档创建时（游戏脚本之前）就装上去，刷新/导航后也自动生效。
    await this.installEarlyHook(source);
    const expression = `(() => {
  try {
    if (window.${AGENT_GLOBAL} && typeof window.${AGENT_GLOBAL}.dispose === 'function') {
      window.${AGENT_GLOBAL}.dispose();
    }
  } catch (e) { console.warn('[IB·Bridge] 旧实例卸载失败', e); }
  try {
${source}
    return 'ok';
  } catch (err) {
    return 'ERR:' + ((err && err.stack) || String(err));
  }
})()`;

    try {
      const result = await client.Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise: false,
        userGesture: true,
        includeCommandLineAPI: true,
      });
      const value = result.result?.value;
      if (result.exceptionDetails) {
        this.cb.log('error', `注入异常：${result.exceptionDetails.text ?? ''}`);
        return false;
      }
      if (typeof value === 'string' && value.startsWith('ERR:')) {
        this.cb.log('error', `注入失败：${value.slice(4).split('\n')[0]}`);
        return false;
      }
      this.injectedHash = hash;
      this.injectedAt = Date.now();
      this.cb.log('success', `guest.bundle.js 已注入（${reason}，hash=${hash}）`);
      return true;
    } catch (err) {
      this.cb.log('error', `注入调用失败：${String(err)}`);
      return false;
    }
  }

  /** 在页面里求值（调试 / e2e 断言用） */
  async evaluate(expression: string): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    const client = this.client;
    if (!client) return { ok: false, error: 'CDP 未连接' };
    try {
      const result = await client.Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        return { ok: false, error: result.exceptionDetails.text ?? 'exception' };
      }
      return { ok: true, value: result.result?.value };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /**
   * 截图（调试真机适配：看清游戏当前界面）。
   * Electron 窗口被遮挡/最小化时合成器不会产出新帧，captureScreenshot 会一直挂起，
   * 所以先 bringToFront，再优先用 fromSurface=false（直接从渲染器抓），并加硬超时。
   */
  async screenshot(format: 'png' | 'jpeg' = 'png'): Promise<{ ok: boolean; data?: string; error?: string }> {
    const client = this.client;
    if (!client) return { ok: false, error: 'CDP 未连接' };
    let lastError: string | undefined;
    // bringToFront 在部分 Electron 版本上也会挂起，一律给硬超时
    await Promise.race([
      client.Page.bringToFront().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    for (const fromSurface of [false, true]) {
      try {
        const result = await Promise.race([
          client.Page.captureScreenshot({ format, fromSurface }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
        ]);
        if (result?.data) return { ok: true, data: result.data };
      } catch (err) {
        lastError = String(err);
      }
    }
    return { ok: false, error: lastError ?? '截图超时（窗口可能被遮挡/最小化，先切到游戏窗口）' };
  }

  /** 在每一个新文档创建时（游戏脚本之前）注入 hook 代码 */
  private async installEarlyHook(source: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      if (this.earlyScriptId) {
        await client.Page.removeScriptToEvaluateOnNewDocument({ identifier: this.earlyScriptId }).catch(
          () => undefined,
        );
        this.earlyScriptId = null;
      }
      const result = await client.Page.addScriptToEvaluateOnNewDocument({
        source: `try{
${source}
}catch(e){console.warn('[IB·Bridge] 早注入失败',e);}`,
      });
      this.earlyScriptId = result?.identifier ?? null;
    } catch (err) {
      this.cb.log('warn', `早注入注册失败（不影响轮询式注入）：${String(err)}`);
    }
  }

  /**
   * 执行 Guest 请求的手势（真实 CDP 输入）。
   * Guest 的调度器已经算好坐标和时机，这里只负责"真的把鼠标动起来"。
   */
  async executeInputs(
    ops: Array<{
      kind: 'click' | 'drag';
      point?: { x: number; y: number };
      from?: { x: number; y: number };
      to?: { x: number; y: number };
      delayMs?: number;
    }>,
  ): Promise<void> {
    // 严格串行 + 手势之间留间隔：一次 preheat 可能连发 5~7 个拖拽，
    // 真机在上一手势还没回位时收到下一个 pointerdown 会直接丢弃。
    this.inputChain = this.inputChain.then(async () => {
      if (!this.client) return;
      for (const op of ops) {
        if (op.delayMs && op.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, op.delayMs));
        }
        if (op.kind === 'click' && op.point) {
          await this.click(op.point.x, op.point.y);
        } else if (op.kind === 'drag' && op.from && op.to) {
          await this.drag(op.from, op.to, 5);
        }
        await new Promise((resolve) => setTimeout(resolve, 12));
      }
    });
    return this.inputChain;
  }

  /** 重载页面（页面被脚本卡死 / 需要从头开始时的逃生通道） */
  async reload(): Promise<{ ok: boolean; error?: string }> {
    const client = this.client;
    if (!client) return { ok: false, error: 'CDP 未连接' };
    try {
      await Promise.race([
        client.Page.reload({ ignoreCache: false }),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      this.injectedHash = null;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /** 真实鼠标点击（合成 DOM 事件对某些框架无效时用这个） */
  async click(x: number, y: number): Promise<{ ok: boolean; error?: string }> {
    return this.mouse([
      { type: 'mouseMoved', x, y },
      { type: 'mousePressed', x, y },
      { type: 'mouseReleased', x, y },
    ]);
  }

  /** 真实鼠标拖拽（从音色图标拖到小人身上） */
  async drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    steps = 12,
    holdMs = 0,
  ): Promise<{ ok: boolean; error?: string }> {
    // holdMs > 0：按住不动一小会儿再移动，兼容游戏的「长按进入拖拽」判定
    const pressed = await this.mouse([
      { type: 'mouseMoved', x: from.x, y: from.y },
      { type: 'mousePressed', x: from.x, y: from.y },
    ]);
    if (!pressed.ok) return pressed;
    if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
    const moves: Array<{ type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'; x: number; y: number }> = [];
    for (let i = 1; i <= steps; i += 1) {
      moves.push({
        type: 'mouseMoved',
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      });
    }
    moves.push({ type: 'mouseReleased', x: to.x, y: to.y });
    return this.mouse(moves);
  }

  /** 真实触摸拖拽（部分 HTML5 音乐游戏只绑 touch 事件） */
  async touchDrag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    steps = 14,
    holdMs = 0,
  ): Promise<{ ok: boolean; error?: string }> {
    const client = this.client;
    if (!client) return { ok: false, error: 'CDP 未连接' };
    const points = (x: number, y: number) => [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }];
    try {
      await client.Input.dispatchTouchEvent({ type: 'touchStart', touchPoints: points(from.x, from.y) });
      if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
      for (let i = 1; i <= steps; i += 1) {
        await client.Input.dispatchTouchEvent({
          type: 'touchMove',
          touchPoints: points(
            from.x + ((to.x - from.x) * i) / steps,
            from.y + ((to.y - from.y) * i) / steps,
          ),
        });
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      await client.Input.dispatchTouchEvent({ type: 'touchEnd', touchPoints: [] });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  private async mouse(
    events: Array<{ type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'; x: number; y: number }>,
  ): Promise<{ ok: boolean; error?: string }> {
    const client = this.client;
    if (!client) return { ok: false, error: 'CDP 未连接' };
    try {
      for (const event of events) {
        await client.Input.dispatchMouseEvent({
          type: event.type,
          x: event.x,
          y: event.y,
          button: event.type === 'mouseMoved' ? 'none' : 'left',
          buttons: event.type === 'mouseReleased' ? 0 : event.type === 'mouseMoved' ? 1 : 1,
          clickCount: event.type === 'mouseMoved' ? 0 : 1,
          pointerType: 'mouse',
        });
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /**
   * 让游戏切换版本（多步 UI 流程，全部用真实鼠标事件）：
   *   点版本图标 → 等封面页 "INCREDIBOX Vx" → 点绿色 ▶ → 等 mix 界面（20 个音色图标）
   * 每一步都轮询确认，不盲点。
   */
  async selectVersion(
    versionIndex: number,
    versionId: string,
    onState: (state: { phase: 'selecting' | 'opening' | 'loading'; detected?: string }) => void,
  ): Promise<{ ok: boolean; detected?: string; error?: string }> {
    const client = this.client;
    if (!client) return { ok: false, error: 'CDP 未连接' };
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const pageText = async (): Promise<string> => {
      const res = await this.evaluate('document.body.innerText || ""');
      return typeof res.value === 'string' ? res.value : '';
    };
    const clickExpr = async (expr: string): Promise<boolean> => {
      const geo = await this.evaluate(`JSON.stringify(${expr})`);
      if (!geo.ok || !geo.value) return false;
      let point: { x?: number; y?: number } | null = null;
      try {
        point = JSON.parse(String(geo.value)) as { x?: number; y?: number };
      } catch {
        return false;
      }
      if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') return false;
      const clicked = await this.click(point.x, point.y);
      return clicked.ok;
    };

    const count = async (selector: string): Promise<number> => {
      const res = await this.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
      return Number(res.value) || 0;
    };
    const want = versionIndex + 1;
    onState({ phase: 'selecting' });

    // 首页 / 版本封面 / mix 三个界面的 DOM 极其相似，不去猜"当前在哪个界面"，
    // 而是直接「点版本图标 → 读标题校验」，不对就换一个导航入口重试。
    const readVersion = async (): Promise<number | null> => {
      const match = (await pageText()).match(/INCREDIBOX\s*V(\d+)/i);
      return match ? Number(match[1]) : null;
    };
    const viconExpr = `(()=>{const e=[...document.querySelectorAll('.vicon')][${versionIndex}];if(!e)return null;const r=e.getBoundingClientRect();if(r.width<4||r.height<4)return null;return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`;
    const navExprs = [
      `(()=>{const e=document.getElementById('bt-home');if(!e)return null;const r=e.getBoundingClientRect();if(r.width<4||r.height<4)return null;return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,
      `(()=>{const b=[...document.querySelectorAll('.bt-round')].filter((e)=>{const r=e.getBoundingClientRect();return r.width>20&&r.width<120&&r.x<innerWidth*0.35&&(r.y+r.height/2)>innerHeight*0.7;});const e=b[0];if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,
      `(()=>{const e=document.getElementById('bt-tool');if(!e)return null;const r=e.getBoundingClientRect();if(r.width<4||r.height<4)return null;return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,
    ];

    let current = await readVersion();
    for (let attempt = 0; attempt < 4 && current !== want; attempt += 1) {
      if (attempt > 0) {
        await clickExpr(navExprs[(attempt - 1) % navExprs.length]!);
        await wait(1200);
      }
      if (!(await clickExpr(viconExpr))) {
        this.cb.log('warn', `切换尝试 ${attempt + 1}：页面上找不到版本图标`);
        continue;
      }
      for (let i = 0; i < 10; i += 1) {
        await wait(400);
        current = await readVersion();
        if (current === want) break;
      }
      if (current !== want) {
        this.cb.log('info', `切换尝试 ${attempt + 1}：页面显示 V${current ?? '?'}，换入口重试`);
      }
    }
    if (current !== want) {
      return {
        ok: false,
        error: `没能自动切到 V${want}（页面显示 V${current ?? '?'}）—— 请在游戏里手动切版本，再点「◎ 探测游戏」`,
      };
    }
    const detected = `INCREDIBOX V${want}`;
    onState({ phase: 'opening', detected });

    // 封面页底部中间的圆形 ▶
    await wait(700);
    onState({ phase: 'loading', detected });
    const entered = await clickExpr(
      `(()=>{const b=[...document.querySelectorAll('.bt-round')].filter((e)=>{const r=e.getBoundingClientRect();return r.width>20&&r.width<120&&!e.classList.contains('bt-80')&&(r.y+r.height/2)>innerHeight*0.7;});const e=b[0];if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,
    );
    if (!entered) return { ok: false, error: '找不到封面页的播放按钮', detected };

    // mix 界面就绪标志：20 个音色图标
    for (let i = 0; i < 30; i += 1) {
      await wait(700);
      const count = await this.evaluate(`document.querySelectorAll('[data-picto-num]').length`);
      if (Number(count.value) === 20) {
        this.cb.log('success', `已切换到 ${detected}（${versionId}）`);
        return { ok: true, detected };
      }
    }
    return { ok: false, error: '等待 mix 界面加载超时', detected };
  }

  /** 把 Host 指令转发给 Guest */
  async send(command: GuestCommand): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    const payload = JSON.stringify(JSON.stringify(command));
    const expression =
      `window.${AGENT_GLOBAL} && window.${AGENT_GLOBAL}.receive(${payload});`;
    try {
      await client.Runtime.evaluate({ expression, returnByValue: false });
      return true;
    } catch (err) {
      this.cb.log('warn', `指令下发失败：${String(err)}`);
      return false;
    }
  }
}

/** chrome-remote-interface 的最小结构（避免在 Node 侧引入完整类型依赖） */
interface CdpSession {
  Runtime: {
    enable(): Promise<unknown>;
    addBinding(params: { name: string }): Promise<unknown>;
    evaluate(params: {
      expression: string;
      returnByValue?: boolean;
      awaitPromise?: boolean;
      userGesture?: boolean;
      includeCommandLineAPI?: boolean;
    }): Promise<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string };
    }>;
  };
  Page: {
    enable(): Promise<unknown>;
    bringToFront(): Promise<unknown>;
    reload(params?: { ignoreCache?: boolean }): Promise<unknown>;
    addScriptToEvaluateOnNewDocument(params: { source: string }): Promise<{ identifier?: string }>;
    removeScriptToEvaluateOnNewDocument(params: { identifier: string }): Promise<unknown>;
    captureScreenshot(params?: { format?: string; fromSurface?: boolean }): Promise<{ data?: string }>;
  };
  Input: {
    dispatchTouchEvent(params: {
      type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel';
      touchPoints: Array<{ x: number; y: number; id?: number; radiusX?: number; radiusY?: number; force?: number }>;
    }): Promise<unknown>;
    dispatchMouseEvent(params: {
      type: 'mouseMoved' | 'mousePressed' | 'mouseReleased';
      x: number;
      y: number;
      button?: 'none' | 'left' | 'right';
      buttons?: number;
      clickCount?: number;
      pointerType?: string;
    }): Promise<unknown>;
  };
  on(event: string, handler: (...args: never[]) => void): void;
  close(): Promise<void>;
}
