import { EMIT_BINDING, type GuestCommand, type GuestMessage } from '@ic/shared';
import { logToConsole } from './util.ts';

/**
 * 与 Bridge 的双向通道。
 *
 * 首选通道：CDP `Runtime.addBinding(EMIT_BINDING)` —— Bridge 注入前安装，
 * Guest 直接调用这个函数就能把消息推回 Node 进程，零额外依赖、零宿主页面改动。
 *
 * 兜底通道：Guest 自己连 `ws://127.0.0.1:<port>/guest`，用于用户手动把
 * bundle 粘进 DevTools 控制台、没有 Bridge 注入 binding 的场景。
 */
export class Link {
  private socket: WebSocket | null = null;
  private binding: ((payload: string) => void) | null = null;
  private queue: GuestMessage[] = [];
  private socketReady = false;
  private reconnectTimer: number | null = null;
  private disposed = false;

  constructor(
    private readonly onMessage: (msg: GuestCommand) => void,
    private readonly wsUrl: string,
  ) {
    const w = window as unknown as Record<string, unknown>;
    const candidate = w[EMIT_BINDING];
    if (typeof candidate === 'function') {
      this.binding = candidate as (payload: string) => void;
    }
  }

  get usingBinding(): boolean {
    return this.binding !== null;
  }

  send(msg: GuestMessage): void {
    if (this.binding) {
      try {
        this.binding(JSON.stringify(msg));
        return;
      } catch (err) {
        logToConsole('warn', `binding 发送失败，改用 WebSocket：${String(err)}`);
        this.binding = null;
      }
    }
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
      return;
    }
    this.queue.push(msg);
    if (this.queue.length > 64) this.queue.splice(0, this.queue.length - 64);
    this.ensureSocket();
  }

  private ensureSocket(): void {
    if (this.disposed || this.binding || this.socket) return;
    try {
      this.socket = new WebSocket(this.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket.addEventListener('open', () => {
      this.socketReady = true;
      const pending = this.queue.splice(0, this.queue.length);
      for (const msg of pending) this.socket?.send(JSON.stringify(msg));
    });
    this.socket.addEventListener('message', (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as GuestCommand;
        this.onMessage(parsed);
      } catch (err) {
        logToConsole('warn', `命令解析失败：${String(err)}`);
      }
    });
    this.socket.addEventListener('close', () => {
      this.socketReady = false;
      this.socket = null;
      this.scheduleReconnect();
    });
    this.socket.addEventListener('error', () => {
      this.socketReady = false;
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.binding || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSocket();
    }, 1500);
  }

  /** Bridge 通过 Runtime.evaluate 调用入口 */
  receive(raw: string | GuestCommand): void {
    const msg = typeof raw === 'string' ? (JSON.parse(raw) as GuestCommand) : raw;
    this.onMessage(msg);
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.socketReady = false;
  }

  get connected(): boolean {
    return this.binding !== null || this.socketReady;
  }
}
