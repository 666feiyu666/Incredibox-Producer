import {
  DEFAULT_RUNTIME_OPTIONS,
  SLOT_COUNT,
  type CompositionProject,
  type GuestCommand,
  type GuestInfo,
  type GuestMessage,
  type MixPhase,
  type RuntimeOptions,
} from '@ic/shared';
import { createAdapter, type Adapter } from './adapter/index.ts';
import { Link } from './link.ts';
import { Mixer } from './mixer.ts';
import { Transport, type TransportCallbacks } from './transport.ts';
import { logToConsole } from './util.ts';

export interface AgentConfig {
  bundleHash: string;
  agentVersion: string;
  wsUrl: string;
  options?: Partial<RuntimeOptions>;
}

/**
 * 运行时总控：把 Bridge 发来的指令翻译成 adapter / transport / mixer 的动作，
 * 并把播放状态、指令执行回执、日志推回 Bridge。
 */
export class Agent {
  adapter: Adapter;
  transport: Transport;
  private mixer: Mixer;
  private link: Link;
  private options: RuntimeOptions;
  private project: CompositionProject | null = null;
  private injectedAt = Date.now();
  private disposed = false;
  private statusTimer: number | null = null;
  private readonly bundleHash: string;
  private readonly agentVersion: string;

  constructor(config: AgentConfig) {
    this.bundleHash = config.bundleHash;
    this.agentVersion = config.agentVersion;
    this.options = { ...DEFAULT_RUNTIME_OPTIONS, ...(config.options ?? {}) };
    this.adapter = createAdapter(this.options.adapterMode, {
      loopOverrideSec: this.options.loopOverrideSec,
      domProfile: this.options.domProfile,
      autoBonus: this.options.autoBonus,
    });
    this.adapter.setLogSink((level, message) => this.log(level, message));
    this.link = new Link((msg) => this.handle(msg), config.wsUrl);
    // 手势执行下沉到 Bridge：真机只认真实 CDP 输入，Guest 只负责算坐标和时机
    this.adapter.setInputSink((ops) => this.send({ type: 'input:exec', ops }));
    this.transport = new Transport(this.adapter, () => this.options, this.buildCallbacks());
    this.mixer = this.buildMixer();

    this.send({ type: 'hello', info: this.getInfo() });
    this.log('info', `Agent 已注入（adapter=${this.adapter.kind}, bundle=${this.bundleHash}）`);
    this.statusTimer = window.setInterval(() => {
      if (!this.disposed) this.send({ type: 'status', info: this.getInfo() });
    }, 700);
  }

  private buildCallbacks(): TransportCallbacks {
    return {
      onCue: (cue, firedAt, lateMs) => {
        this.send({
          type: 'cue',
          cue: {
            id: cue.id,
            slotIndex: cue.slotIndex,
            action: cue.action,
            ...(cue.iconId === undefined ? {} : { iconId: cue.iconId }),
            bar: cue.bar,
            beat: cue.beat,
            firedAt,
            lateMs,
          },
        });
      },
      onBarStart: (bar, mode) => {
        this.mixer.onBarStart(bar, mode);
        this.send({ type: 'tick', state: this.transport.getState() });
      },
      onState: (state) => this.send({ type: 'tick', state }),
      onFinish: (reason) => {
        this.mixer.onFinish(reason);
        this.send({ type: 'tick', state: this.transport.getState() });
      },
      log: (level, message) => this.log(level, message),
    };
  }

  private buildMixer(): Mixer {
    return new Mixer({
      adapter: this.adapter,
      transport: this.transport,
      emit: (phase: MixPhase, message?: string) =>
        this.send({ type: 'mix', phase, ...(message ? { message } : {}) }),
      log: (level, message) => this.log(level, message),
      getOptions: () => this.options,
    });
  }

  getInfo(): GuestInfo {
    return {
      online: true,
      adapterKind: this.adapter.kind,
      clockSource: this.adapter.clockSource,
      hasLoopClock: this.adapter.hasLoopClock,
      playing: this.adapter.playing,
      loopDuration: Number(this.adapter.getLoopDuration().toFixed(4)),
      progress: Number(this.adapter.getLoopProgress().toFixed(4)),
      audioTime: Number(this.adapter.getAudioTime().toFixed(3)),
      injectedAt: this.injectedAt,
      bundleHash: this.bundleHash,
      agentVersion: this.agentVersion,
      lastError: null,
    };
  }

  getOptions(): RuntimeOptions {
    return { ...this.options };
  }

  probe(): void {
    const report = this.adapter.probe();
    this.send({ type: 'probe', report });
    this.log('info', `探测完成：槽位 ${report.slots.length}/7，图标 ${report.icons.length}/20，循环 ${report.loopDuration}s`);
  }

  /** Bridge 的 Runtime.evaluate 入口：接受 JSON 字符串或对象 */
  handleRaw(raw: string | GuestCommand): void {
    try {
      const msg = typeof raw === 'string' ? (JSON.parse(raw) as GuestCommand) : raw;
      this.handle(msg);
    } catch (err) {
      this.log('error', `指令解析失败：${String(err)}`);
    }
  }

  /** 注入时机可能早于游戏挂载全局对象，第一次收到指令时再尝试升级适配层 */
  private ensureBestAdapter(): void {
    if (this.options.adapterMode !== 'auto') return;
    const w = window as unknown as Record<string, unknown>;
    const better =
      typeof w.__INCREDIBOX_SIM__ === 'object' || typeof w.__INCREDIBOX_GAME_API__ === 'object';
    if (!better || this.adapter.kind !== 'dom') return;
    const resolved = createAdapter('auto', {
      loopOverrideSec: this.options.loopOverrideSec,
      domProfile: this.options.domProfile,
      autoBonus: this.options.autoBonus,
    });
    if (resolved.kind === this.adapter.kind) return;
    this.log('info', `检测到游戏高层 API，适配层从 dom 升级为 ${resolved.kind}`);
    this.rebuildAdapter();
  }

  handle(cmd: GuestCommand): void {
    if (this.disposed) return;
    if (!cmd || typeof cmd !== 'object' || typeof (cmd as { type?: unknown }).type !== 'string') return;
    this.ensureBestAdapter();
    switch (cmd.type) {
      case 'project:sync':
        this.project = cmd.project;
        this.log('info', `乐谱已同步：${cmd.project.title}（${cmd.project.totalBars} 小节）`);
        break;
      case 'transport:play':
        if (cmd.options) this.applyOptions(cmd.options);
        this.project = cmd.project;
        this.mixer.abort();
        this.transport.start(cmd.project, cmd.startBar, 'play');
        break;
      case 'transport:stop':
        this.mixer.abort();
        this.transport.stop();
        this.log('info', '播放已停止');
        break;
      case 'stage:sync':
        this.project = cmd.project;
        this.transport.syncStage(cmd.project, cmd.bar);
        break;
      case 'stage:clear':
        for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
          this.adapter.setMute(slot, true);
          this.adapter.clearSlot(slot);
        }
        this.transport.stop();
        this.log('info', '舞台已清空');
        this.send({ type: 'tick', state: this.transport.getState() });
        break;
      case 'options:set':
        this.applyOptions(cmd.options);
        break;
      case 'adapter:command':
        this.runAdapterCommand(cmd.command);
        break;
      case 'record:start':
        this.adapter.toggleRecord(true);
        this.log('info', '已触发游戏 REC');
        break;
      case 'record:stop':
        this.adapter.toggleRecord(false);
        this.log('info', '已停止游戏 REC');
        break;
      case 'mix:start':
        this.project = cmd.project;
        this.mixer.start(cmd.project, cmd.startBar ?? 1);
        break;
      case 'mix:abort':
        this.mixer.abort();
        break;
      case 'probe':
        this.probe();
        break;
      default:
        break;
    }
  }

  private runAdapterCommand(command: { kind: string; slotIndex?: number; iconId?: number; on?: boolean }): void {
    const slot = command.slotIndex ?? 0;
    switch (command.kind) {
      case 'equip':
        if (command.iconId === undefined) {
          this.log('warn', 'equip 指令缺少 iconId');
          return;
        }
        this.adapter.equipIcon(slot, command.iconId);
        break;
      case 'mute':
        this.adapter.setMute(slot, command.on ?? true);
        break;
      case 'solo':
        this.adapter.setSolo(slot, command.on ?? true);
        break;
      case 'clear':
        this.adapter.clearSlot(slot);
        break;
      case 'record':
        this.adapter.toggleRecord(command.on ?? true);
        break;
      default:
        this.log('warn', `未知的 adapter 指令：${String(command.kind)}`);
        return;
    }
    this.send({ type: 'tick', state: this.transport.getState() });
  }

  private applyOptions(patch: Partial<RuntimeOptions>): void {
    const previousMode = this.options.adapterMode;
    this.options = { ...this.options, ...patch };
    if (patch.loopOverrideSec !== undefined) {
      this.adapter.setLoopOverride(this.options.loopOverrideSec);
    }
    if (patch.domProfile !== undefined) {
      this.adapter.setAdapterConfig({ domProfile: this.options.domProfile });
    }
    if (patch.autoBonus !== undefined) {
      this.adapter.setAutoBonus(this.options.autoBonus);
    }
    if (patch.adapterMode !== undefined && patch.adapterMode !== previousMode) {
      this.log('info', `适配层切换：${previousMode} → ${this.options.adapterMode}`);
      this.rebuildAdapter();
      return;
    }
    this.log(
      'info',
      `运行时参数已更新（offset=${this.options.offsetMs}ms, lead=${this.options.equipLeadBeats}拍, tick=${this.options.tickMs}ms, autoBonus=${this.options.autoBonus ? 'on' : 'off'}）`,
    );
    this.send({ type: 'tick', state: this.transport.getState() });
  }

  /** 切换适配层：重建 adapter / transport / mixer，必要时续播 */
  private rebuildAdapter(): void {
    const wasPlaying = this.transport.isRunning;
    const bar = this.transport.currentBar;
    this.transport.dispose();
    this.adapter.dispose();
    this.adapter = createAdapter(this.options.adapterMode, {
      loopOverrideSec: this.options.loopOverrideSec,
      domProfile: this.options.domProfile,
      autoBonus: this.options.autoBonus,
    });
    this.adapter.setInputSink((ops) => this.send({ type: 'input:exec', ops }));
    this.adapter.setLogSink((level, message) => this.log(level, message));
    this.transport = new Transport(this.adapter, () => this.options, this.buildCallbacks());
    this.mixer = this.buildMixer();
    if (wasPlaying && this.project) this.transport.start(this.project, bar, 'play');
    this.send({ type: 'hello', info: this.getInfo() });
  }

  private send(msg: GuestMessage): void {
    this.link.send(msg);
  }

  private log(level: 'info' | 'warn' | 'error' | 'success', message: string): void {
    logToConsole(level, message);
    this.send({ type: 'log', level, message });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.statusTimer !== null) window.clearInterval(this.statusTimer);
    this.statusTimer = null;
    try {
      this.transport.dispose();
      this.adapter.dispose();
    } catch {
      /* ignore */
    }
    this.link.dispose();
  }
}
