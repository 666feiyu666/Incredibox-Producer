import type { WebSocket } from 'ws';
import {
  DEFAULT_RUNTIME_OPTIONS,
  SERVER_VERSION,
  type BridgeEvent,
  type CompositionProject,
  type GuestInfo,
  type GuestMessage,
  type LogEntry,
  type LogLevel,
  type PlaybackState,
  type RuntimeOptions,
} from '@ic/shared';

export interface HubState {
  cdpConnected: boolean;
  guest: GuestInfo | null;
  lastTick: PlaybackState | null;
}

/**
 * 连接汇聚点：维护 Host 客户端集合、日志环形缓冲、当前播放状态与运行时参数。
 * Bridge 是唯一知道「CDP 是否连通 / Guest 是否在线」的角色，Host 只是订阅者。
 */
export class Hub {
  private hosts = new Set<WebSocket>();
  private logs: LogEntry[] = [];
  private logSeq = 0;
  private state: HubState = { cdpConnected: false, guest: null, lastTick: null };
  private options: RuntimeOptions = { ...DEFAULT_RUNTIME_OPTIONS };
  private project: CompositionProject | null = null;

  get projectRef(): CompositionProject | null {
    return this.project;
  }

  get runtimeOptions(): RuntimeOptions {
    return { ...this.options };
  }

  get snapshot(): HubState {
    return this.state;
  }

  addHost(socket: WebSocket): void {
    this.hosts.add(socket);
    this.sendTo(socket, {
      type: 'welcome',
      serverVersion: SERVER_VERSION,
      cdpConnected: this.state.cdpConnected,
      guest: this.state.guest,
      options: this.options,
      logs: this.logs.slice(-120),
    });
    if (this.state.lastTick) this.sendTo(socket, { type: 'tick', state: this.state.lastTick, options: this.options });
  }

  removeHost(socket: WebSocket): void {
    this.hosts.delete(socket);
  }

  get hostCount(): number {
    return this.hosts.size;
  }

  broadcast(event: BridgeEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.hosts) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  private sendTo(socket: WebSocket, event: BridgeEvent): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  }

  log(level: LogLevel, source: LogEntry['source'], message: string): void {
    this.logSeq += 1;
    const entry: LogEntry = { id: this.logSeq, ts: Date.now(), level, source, message };
    this.logs.push(entry);
    if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400);
    // 同时打到 stdout：Bridge 是命令行工具，排障时必须能在终端直接看到日志
    const color = level === 'error' ? '[31m' : level === 'warn' ? '[33m' : level === 'success' ? '[32m' : '[90m';
    console.log(`${color}[${source}/${level}][0m ${message}`);
    this.broadcast({ type: 'log', entry });
  }

  setCdpConnected(connected: boolean): void {
    const changed = this.state.cdpConnected !== connected;
    this.state.cdpConnected = connected;
    if (!connected) this.state.guest = null;
    if (changed) this.broadcastStatus();
  }

  setGuest(info: GuestInfo | null): void {
    this.state.guest = info ? { ...info, online: true } : null;
    if (!info) this.state.lastTick = null;
    this.broadcastStatus();
  }

  setTick(state: PlaybackState): void {
    this.state.lastTick = state;
    this.broadcast({ type: 'tick', state, options: this.options });
  }

  setOptions(patch: Partial<RuntimeOptions>): RuntimeOptions {
    this.options = { ...this.options, ...patch };
    return this.options;
  }

  setProject(project: CompositionProject): void {
    this.project = project;
  }

  broadcastStatus(): void {
    this.broadcast({
      type: 'status',
      cdpConnected: this.state.cdpConnected,
      guest: this.state.guest,
    });
  }

  /** Guest 消息 → Host 事件（附带 Hub 侧状态更新） */
  handleGuestMessage(msg: GuestMessage): void {
    switch (msg.type) {
      case 'hello':
      case 'status':
        this.setGuest(msg.info);
        break;
      case 'tick':
        this.setTick(msg.state);
        break;
      case 'cue':
        this.broadcast({ type: 'cue', cue: msg.cue });
        break;
      case 'mix':
        this.broadcast({ type: 'mix', phase: msg.phase, ...(msg.message ? { message: msg.message } : {}) });
        this.log(msg.phase === 'error' ? 'error' : 'info', 'guest', `自动出带：${msg.phase}${msg.message ? ` — ${msg.message}` : ''}`);
        break;
      case 'probe':
        this.broadcast({ type: 'probe', report: msg.report });
        break;
      case 'log':
        this.log(msg.level, 'guest', msg.message);
        break;
      default:
        break;
    }
  }
}
