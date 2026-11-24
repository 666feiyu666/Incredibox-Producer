import {
  barDurationSec,
  clamp,
  compileProject,
  computeStageStateAtBar,
  type CompiledCue,
  type CompiledProject,
  type CompositionProject,
  type PlaybackState,
  type RuntimeOptions,
  type StageSnapshot,
} from '@ic/shared';
import type { Adapter } from './adapter/index.ts';

export type TransportTarget = 'play' | 'record' | 'sync';
export type TransportMode = 'idle' | 'arming' | 'playing' | 'recording';

export interface TransportCallbacks {
  onCue(cue: CompiledCue, firedAt: number, lateMs: number): void;
  onBarStart(bar: number, mode: TransportMode): void;
  onState(state: PlaybackState): void;
  onFinish(reason: 'end' | 'synced'): void;
  log(level: 'info' | 'warn' | 'error' | 'success', message: string): void;
}

interface CueGroup {
  key: number;
  fraction: number;
  cues: CompiledCue[];
  scheduled: boolean;
}

/**
 * 游戏内前瞻调度器（Lookahead Scheduler）。
 *
 * 时钟模型（design.md 第二阶段核心任务 2）：
 *  - 小节进度直接来自游戏的 AudioContext 循环（hook 抓到的 loop source），
 *    因此整首歌永远钉在游戏自己的循环网格上，不会累积漂移。
 *  - 每次 tick（默认 15ms）只做两件事：把「未来 lookaheadMs 内要执行」的指令
 *    用 setTimeout 精确预约到目标时刻；以及检测循环边界推进小节。
 *  - EQUIP 的提前量在 shared/compileProject 里已经算好（fireBar = 目标小节 - 1），
 *    调度器只负责在该小节的 (1 - leadBeats/beatsPerBar) 位置派发。
 *  - 同一个小节内 fireFraction 相同的指令会被聚成一个 group，在同一个同步块里
 *    一次性下发，保证「同一拍多角色同时静音/解除」没有拉链式延迟。
 *  - 时钟短暂消失（游戏静音 / 无人登台）时用最后一次观测到的相位外推，
 *    保证小节网格不断裂；重新出现时再锚定回真实相位。
 */
export class Transport {
  private adapter: Adapter;
  private getOptions: () => RuntimeOptions;
  private cb: TransportCallbacks;

  private project: CompositionProject | null = null;
  private compiled: CompiledProject | null = null;
  private target: TransportTarget = 'play';
  private mode: TransportMode = 'idle';
  private bar = 1;
  private totalBars = 1;
  private groups: CueGroup[] = [];
  private fired = new Set<string>();
  private timers = new Set<number>();
  private ticker: number | null = null;

  private snapshot: StageSnapshot = [];
  private barStartAudioTime = 0;
  private armStartedAt = 0;
  private advancedBoundary = Number.NEGATIVE_INFINITY;
  private lastLoopStart: number | null = null;
  private freeAnchor = 0;

  /** 观测到的相位模型（时钟消失时用它外推） */
  private knownDuration = 0;
  private knownAnchor = 0;
  private hasKnownPhase = false;

  private fireCount = 0;
  private lateCount = 0;
  /** setTimeout 相对 AudioContext 时钟的系统性迟到补偿（秒，指数滑动平均） */
  private timerBias = 0;
  private lastPublishAt = 0;
  private loggedDegraded = false;

  constructor(adapter: Adapter, getOptions: () => RuntimeOptions, cb: TransportCallbacks) {
    this.adapter = adapter;
    this.getOptions = getOptions;
    this.cb = cb;
  }

  get currentBar(): number {
    return this.bar;
  }

  get currentMode(): TransportMode {
    return this.mode;
  }

  get isRunning(): boolean {
    return this.mode !== 'idle';
  }

  get compiledProject(): CompiledProject | null {
    return this.compiled;
  }

  /** 从 startBar 开始播放 / 录制 */
  start(project: CompositionProject, startBar: number, target: TransportTarget = 'play'): void {
    this.prepare(project, startBar, target);
    this.cb.log('info', `准备从第 ${this.bar} 小节开始（目标模式：${target}），等待循环边界对齐…`);
    this.publish(true);
  }

  /** 只同步舞台状态，不放音 */
  syncStage(project: CompositionProject, bar: number): void {
    this.prepare(project, bar, 'sync');
    this.cb.log('info', `强制同步舞台到第 ${this.bar} 小节的状态`);
    this.publish(true);
  }

  stop(): void {
    this.mode = 'idle';
    this.groups = [];
    this.clearTimers();
    this.stopTicker();
    this.publish(true);
  }

  dispose(): void {
    this.stop();
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  private prepare(project: CompositionProject, startBar: number, target: TransportTarget): void {
    this.stopTimers();
    this.project = project;
    this.totalBars = Math.max(1, project.totalBars);
    this.compiled = compileProject(project, { equipLeadBeats: this.getOptions().equipLeadBeats });
    this.bar = clamp(Math.round(startBar), 1, this.totalBars);
    this.target = target;
    this.mode = 'arming';
    this.groups = [];
    this.fired.clear();
    this.fireCount = 0;
    this.lateCount = 0;
    this.timerBias = 0;
    this.loggedDegraded = false;
    this.snapshot = computeStageStateAtBar(project, this.bar);
    this.preheat(this.snapshot);
    this.armStartedAt = this.adapter.getAudioTime();
    this.freeAnchor = this.armStartedAt;
    this.advancedBoundary = Number.NEGATIVE_INFINITY;
    this.lastLoopStart = null;
    // 刻意不重置 knownDuration / hasKnownPhase：清空舞台会让游戏静音、循环 source 消失，
    // 此时必须靠上一次观测到的相位继续外推小节网格，否则「自动出带」会在静音期卡住。
    this.syncPhase(this.armStartedAt);
    this.startTicker();
  }

  /**
   * 舞台预热：EQUIP 是队列机制，必须在目标小节之前派发。
   * 需要换装的槽位先静音（避免旧音色残留到边界），再排队穿戴新音色；
   * 到边界处再按快照解除静音 —— 这样换装无缝、听不到旧音色多响一下。
   */
  private preheat(snapshot: StageSnapshot): void {
    const tracked = this.adapter.getTrackedStage();
    const actions: string[] = [];
    for (const target of snapshot) {
      const current = tracked[target.slotIndex];
      if (!current) continue;
      if (target.iconId !== null && current.iconId !== target.iconId) {
        this.adapter.setMute(target.slotIndex, true);
        this.adapter.equipIcon(target.slotIndex, target.iconId);
        actions.push(`S${target.slotIndex}←#${target.iconId}`);
      } else if (target.iconId === null && current.iconId !== null) {
        this.adapter.setMute(target.slotIndex, true);
        actions.push(`S${target.slotIndex}←空`);
      }
    }
    this.cb.log(
      'info',
      actions.length > 0 ? `舞台预热（等待循环头生效）：${actions.join(' ')}` : '舞台预热：无需换装',
    );
  }

  private applySnapshot(): void {
    const summary: string[] = [];
    for (const target of this.snapshot) {
      if (target.iconId === null) {
        this.adapter.clearSlot(target.slotIndex);
        this.adapter.setMute(target.slotIndex, false);
        summary.push(`S${target.slotIndex}:空`);
      } else {
        this.adapter.setMute(target.slotIndex, target.muted);
        summary.push(`S${target.slotIndex}:#${target.iconId}${target.muted ? 'M' : ''}`);
      }
      this.adapter.setSolo(target.slotIndex, target.solo);
    }
    this.cb.log('info', `循环边界应用快照：${summary.join(' ')}`);
  }

  private startTicker(): void {
    this.stopTicker();
    const tick = Math.max(4, this.getOptions().tickMs);
    this.ticker = window.setInterval(() => this.tick(), tick);
    this.tick();
  }

  private stopTicker(): void {
    if (this.ticker !== null) window.clearInterval(this.ticker);
    this.ticker = null;
  }

  private clearTimers(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
  }

  private stopTimers(): void {
    this.clearTimers();
    this.stopTicker();
  }

  /** 记录 / 刷新相位模型 */
  private syncPhase(t: number): void {
    if (!this.adapter.hasLoopClock) return;
    const duration = this.adapter.getLoopDuration();
    if (!(duration > 0)) return;
    const exact = this.adapter.getLoopStartTime();
    this.knownDuration = duration;
    this.knownAnchor = exact ?? t - this.adapter.getLoopProgress() * duration;
    this.hasKnownPhase = true;
  }

  private loopDuration(): number {
    if (this.adapter.hasLoopClock) {
      const d = this.adapter.getLoopDuration();
      if (d > 0) return d;
    }
    if (this.knownDuration > 0) return this.knownDuration;
    const fallback = this.project ? barDurationSec(this.project) : 0;
    return fallback > 0 ? fallback : 2;
  }

  /** 当前所在循环的起点（audio 时间轴） */
  private loopStartAt(t: number, duration: number): number {
    if (this.adapter.hasLoopClock) {
      const exact = this.adapter.getLoopStartTime();
      if (exact !== null && Number.isFinite(exact)) return exact;
    }
    const anchor = this.hasKnownPhase ? this.knownAnchor : this.freeAnchor;
    const k = Math.floor((t - anchor) / duration + 1e-9);
    return anchor + k * duration;
  }

  private progressAt(t: number, duration: number): number {
    if (this.adapter.hasLoopClock) {
      const p = this.adapter.getLoopProgress();
      if (Number.isFinite(p)) return clamp(p, 0, 0.999999);
    }
    const start = this.loopStartAt(t, duration);
    return clamp((t - start) / duration, 0, 0.999999);
  }

  private armTimeout(duration: number): number {
    return Math.max(4, duration * 2.5);
  }

  private tick(): void {
    if (this.mode === 'idle') return;
    const t = this.adapter.getAudioTime();
    this.syncPhase(t);
    const duration = this.loopDuration();

    if (this.mode === 'arming') {
      this.publish();
      if (!this.boundaryReached(t, duration)) return;
      this.beginPlayback(t, duration);
      return;
    }

    const progress = this.progressAt(t, duration);
    this.schedule(t, duration);

    const loopStart = this.loopStartAt(t, duration);
    // 音乐重新起播/主循环 source 变化时锚点会跳变（实测跨了 15s 被误判成"掉帧跳过小节"）。
    // 锚点明显跳变时直接重新对齐，而不是推进小节号。
    if (this.lastLoopStart !== null && Math.abs(loopStart - this.lastLoopStart) > duration * 3) {
      this.cb.log('warn', `循环锚点跳变 ${((loopStart - this.lastLoopStart) * 1000).toFixed(0)}ms，重新对齐`);
      this.advancedBoundary = loopStart;
    }
    this.lastLoopStart = loopStart;
    const nextBoundary = loopStart + duration;
    const lookahead = this.getOptions().lookaheadMs / 1000;
    if (nextBoundary > this.advancedBoundary + 1e-6 && nextBoundary - t <= lookahead) {
      if (!this.advanceBar(nextBoundary, duration)) return;
      this.schedule(t, duration);
    } else if (progress < 0.02 && nextBoundary - duration > this.advancedBoundary + 1e-6) {
      // 兜底：相位模型与真实时钟出现跳变时，用回绕补一次推进
      if (!this.advanceBar(loopStart + duration, duration)) return;
      this.schedule(t, duration);
    }

    this.publish();
  }

  private boundaryReached(t: number, duration: number): boolean {
    const loopStart = this.loopStartAt(t, duration);
    if (loopStart > this.armStartedAt + 1e-6) return true;
    if (t - this.armStartedAt > this.armTimeout(duration)) {
      this.cb.log(
        'warn',
        `等待循环边界超时（${(t - this.armStartedAt).toFixed(2)}s），退化为自由运行时钟。请检查游戏是否在播放，或手动指定循环时长。`,
      );
      this.hasKnownPhase = false;
      this.knownDuration = 0;
      this.freeAnchor = t;
      return true;
    }
    return false;
  }

  private beginPlayback(t: number, duration: number): void {
    if (this.target === 'sync') {
      this.applySnapshot();
      this.mode = 'idle';
      this.cb.onFinish('synced');
      this.publish(true);
      return;
    }
    const start = this.adapter.hasLoopClock
      ? (this.adapter.getLoopStartTime() ?? t)
      : this.loopStartAt(t, duration);
    this.mode = this.target === 'record' ? 'recording' : 'playing';
    this.advancedBoundary = start;
    this.applySnapshot();
    this.enterBar(this.bar, start);
    this.cb.onBarStart(this.bar, this.mode);
    this.schedule(t, duration);
    this.publish(true);
    if (!this.adapter.hasLoopClock) {
      this.cb.log('warn', '当前没有可用的 AudioContext 循环时钟，节拍依赖 BPM 推算，可能有漂移。');
    }
  }

  private advanceBar(boundary: number, duration: number): boolean {
    // 游戏掉帧/主线程阻塞时，一次 tick 可能已经跨过多个循环边界。
    // 这时小节号必须按「实际跨过的循环数」推进，否则 UI 与小节对齐会永久错位。
    const previous = Number.isFinite(this.advancedBoundary) ? this.advancedBoundary : boundary - duration;
    const crossed = Math.max(1, Math.round(Math.abs(boundary - previous) / duration) || 1);
    if (crossed > 1) {
      this.cb.log(
        'warn',
        `一次跨过 ${crossed} 个循环边界（游戏掉帧 ${((boundary - previous) * 1000).toFixed(0)}ms），跳过 ${crossed - 1} 个小节`,
      );
    }
    const next = this.bar + crossed;
    if (next > this.totalBars) {
      this.finish('end');
      return false;
    }
    this.bar = next;
    this.advancedBoundary = boundary;
    this.enterBar(next, boundary);
    this.cb.onBarStart(next, this.mode);
    this.publish(true);
    return true;
  }

  private enterBar(bar: number, at: number): void {
    this.barStartAudioTime = at;
    const byKey = new Map<number, CueGroup>();
    for (const cue of this.compiled?.byFireBar.get(bar) ?? []) {
      if (this.fired.has(cue.id)) continue;
      const key = Math.round(cue.fireFraction * 100000);
      const group = byKey.get(key);
      if (group) group.cues.push(cue);
      else byKey.set(key, { key, fraction: cue.fireFraction, cues: [cue], scheduled: false });
    }
    this.groups = [...byKey.values()].sort((a, b) => a.fraction - b.fraction);
  }

  private schedule(t: number, duration: number): void {
    const opts = this.getOptions();
    const lookahead = opts.lookaheadMs / 1000;
    const offset = opts.offsetMs / 1000;
    for (const group of this.groups) {
      if (group.scheduled) continue;
      const target = this.barStartAudioTime + group.fraction * duration + offset;
      if (target - t > lookahead) break;
      group.scheduled = true;
      if (target <= t + 0.002) {
        this.fireGroup(group, target, false);
        continue;
      }
      // 浏览器的 setTimeout 相对音频硬件时钟普遍存在几毫秒的系统性迟到，
      // 用滑动平均把它补偿掉，让「平均误差」逼近 0（残余抖动由 lateMs 统计上报）。
      const delay = Math.max(0, (target - t - this.timerBias) * 1000);
      const timer = window.setTimeout(() => {
        this.timers.delete(timer);
        this.fireGroup(group, target, true);
      }, delay);
      this.timers.add(timer);
    }
  }

  private fireGroup(group: CueGroup, target: number, viaTimer: boolean): void {
    const firedAt = this.adapter.getAudioTime();
    const lateMs = (firedAt - target) * 1000;
    const lateFence = Math.max(25, this.getOptions().lookaheadMs);
    if (viaTimer && Math.abs(lateMs) < 60) {
      this.timerBias = clamp(this.timerBias * 0.8 + (lateMs / 1000) * 0.2, -0.025, 0.025);
    }
    for (const cue of group.cues) {
      if (this.fired.has(cue.id)) continue;
      this.fired.add(cue.id);
      this.dispatch(cue);
      this.fireCount += 1;
      if (lateMs > lateFence) this.lateCount += 1;
      this.cb.onCue(cue, firedAt, lateMs);
    }
    if (lateMs > lateFence) {
      this.cb.log('warn', `第 ${this.bar} 小节指令迟到 ${lateMs.toFixed(1)}ms（游戏掉帧或主线程阻塞）`);
    }
  }

  private dispatch(cue: CompiledCue): void {
    switch (cue.action) {
      case 'EQUIP':
        if (cue.iconId !== undefined) this.adapter.equipIcon(cue.slotIndex, cue.iconId);
        break;
      case 'MUTE':
        this.adapter.setMute(cue.slotIndex, true);
        break;
      case 'UNMUTE':
        this.adapter.setMute(cue.slotIndex, false);
        break;
      case 'SOLO':
        this.adapter.setSolo(cue.slotIndex, true);
        break;
      case 'CLEAR':
        this.adapter.clearSlot(cue.slotIndex);
        break;
      default:
        break;
    }
  }

  private finish(reason: 'end' | 'synced'): void {
    this.mode = 'idle';
    this.groups = [];
    this.clearTimers();
    this.stopTicker();
    this.cb.log('success', reason === 'end' ? `整首乐谱播放完毕（共 ${this.totalBars} 小节）` : '舞台状态已同步');
    this.cb.onFinish(reason);
    this.publish(true);
  }

  getState(): PlaybackState {
    const duration = this.loopDuration();
    const t = this.adapter.getAudioTime();
    const progress = this.mode === 'idle' ? 0 : this.progressAt(t, duration);
    const beatsPerBar = this.compiled?.beatsPerBar ?? this.project?.beatsPerBar ?? 8;
    return {
      mode: this.mode,
      playing: this.mode === 'playing' || this.mode === 'recording',
      bar: this.bar,
      totalBars: this.totalBars,
      progress,
      beat: 1 + progress * beatsPerBar,
      firedCues: this.fireCount,
      lateCues: this.lateCount,
      recording: this.mode === 'recording',
      slots: this.adapter.getTrackedStage(),
      gamePlaying: this.adapter.playing,
      clockSource: this.adapter.clockSource,
      adapterKind: this.adapter.kind,
    };
  }

  /** 每 tick 调用，节流到 ~10Hz 之后才上报给 Bridge */
  private publish(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastPublishAt < 90) return;
    this.lastPublishAt = now;
    this.cb.onState(this.getState());
  }
}
