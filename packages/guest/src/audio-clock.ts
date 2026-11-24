import type { ClockSource, LoopCandidate } from '@ic/shared';
import { nowSec } from './util.ts';

/**
 * AudioContext 时钟 Hook。
 *
 * 逆向思路（design.md 第一阶段核心任务 3）：Incredibox 的音乐循环一定是
 * `AudioBufferSourceNode` + `loop = true` 在跑。因此只要给
 * `AudioBufferSourceNode.prototype.start` 打桩，记录：
 *   - 该 source 的 AudioContext（拿到硬件级 currentTime）
 *   - start(when) 的调度时刻（循环相位原点）
 *   - buffer.duration / loopStart / loopEnd（单循环精确时长）
 * 就能在不认识游戏任何内部对象的前提下，重建「小节进度」与「小节边界」。
 *
 * 多次热注入必须复用同一份注册表，否则会重复打桩、丢历史 source，
 * 所以注册表挂在 window 上。
 */

const CLOCK_KEY = '__INCREDIBOX_AUDIO_CLOCK__';

interface TrackedSource {
  id: number;
  ctx: AudioContext;
  /** ctx 时间轴上的起播时刻 */
  startTime: number;
  /** start() 传入的 buffer 偏移 */
  offset: number;
  /** 音乐长度（秒）：loop=true 时是循环段长度，否则是 buffer 长度 */
  duration: number;
  /** 是否设置过 loop = true（真机 Incredibox 用的是「每循环重新 start」的非循环 source） */
  loop: boolean;
  createdAt: number;
}

interface ClockRegistry {
  patched: boolean;
  contexts: AudioContext[];
  sources: TrackedSource[];
  seq: number;
}

function registryOf(): ClockRegistry {
  const w = window as unknown as Record<string, unknown>;
  let reg = w[CLOCK_KEY] as ClockRegistry | undefined;
  if (!reg) {
    reg = { patched: false, contexts: [], sources: [], seq: 0 };
    w[CLOCK_KEY] = reg;
  }
  return reg;
}

/**
 * 取这个 source 的「音乐长度」。
 *
 * 真机实测（Incredibox Steam 1.2.9 / Electron 24）：音色 source 是**非循环**的 ——
 * 每个循环重新 start 一次（实测 start 间隔 5.06s），`buffer.duration` 就是循环长度。
 * 所以非 loop 的 source 也必须记录长度，否则会误判成「抓不到循环」。
 */
function loopDurationOf(node: AudioBufferSourceNode): number {
  const buffer = node.buffer;
  let duration = buffer ? buffer.duration : 0;
  if (!node.loop) return duration;
  const loopStart = Math.max(0, node.loopStart || 0);
  const loopEnd = node.loopEnd || 0;
  if (loopEnd > loopStart) duration = loopEnd - loopStart;
  else if (loopStart > 0) duration = Math.max(0, duration - loopStart);
  return duration;
}

function track(node: AudioBufferSourceNode, when?: number, offset?: number): void {
  const reg = registryOf();
  const ctx = node.context as AudioContext;
  const startTime = when && when > 0 ? when : ctx.currentTime;
  const duration = loopDurationOf(node);
  reg.seq += 1;
  reg.sources.push({
    id: reg.seq,
    ctx,
    startTime,
    offset: offset ?? 0,
    duration,
    loop: Boolean(node.loop),
    createdAt: nowSec(),
  });
  if (reg.sources.length > 400) reg.sources.splice(0, reg.sources.length - 400);
}

export function installAudioHook(): void {
  const reg = registryOf();
  if (reg.patched) return;
  reg.patched = true;

  const w = window as unknown as Record<string, unknown>;
  const NativeAC = (w.AudioContext ?? w.webkitAudioContext) as typeof AudioContext | undefined;
  if (NativeAC) {
    class PatchedAudioContext extends NativeAC {
      constructor(options?: AudioContextOptions) {
        super(options);
        reg.contexts.push(this);
      }
    }
    Object.defineProperty(PatchedAudioContext, 'name', { value: 'AudioContext' });
    w.AudioContext = PatchedAudioContext;
    w.webkitAudioContext = PatchedAudioContext;
  }

  const proto = typeof AudioBufferSourceNode !== 'undefined' ? AudioBufferSourceNode.prototype : null;
  if (proto) {
    const originalStart = proto.start;
    proto.start = function patchedStart(
      this: AudioBufferSourceNode,
      when?: number,
      offset?: number,
      duration?: number,
    ): void {
      try {
        track(this, when, offset);
      } catch {
        /* 打桩失败不能影响游戏本身 */
      }
      if (duration === undefined) originalStart.call(this, when, offset);
      else originalStart.call(this, when, offset, duration);
    } as typeof proto.start;
  }
}

export interface PrimaryLoop {
  duration: number;
  /** 最近一次循环边界的 ctx 时间 */
  anchor: number;
  progress: number;
  source: TrackedSource;
}

export class AudioClock {
  private overrideDuration: number | null = null;
  private manualAnchor: number | null = null;

  constructor() {
    installAudioHook();
  }

  setOverride(durationSec: number | null): void {
    this.overrideDuration = durationSec && durationSec > 0 ? durationSec : null;
    this.manualAnchor = this.overrideDuration ? this.rawAudioTime() : null;
  }

  get override(): number | null {
    return this.overrideDuration;
  }

  get contextCount(): number {
    return registryOf().contexts.length;
  }

  get audioState(): string {
    const loop = this.primaryLoop();
    if (loop && loop.source.ctx && typeof loop.source.ctx.state === 'string') return loop.source.ctx.state;
    const ctx = this.primaryContext();
    return ctx ? ctx.state : 'none';
  }

  private primaryContext(): AudioContext | null {
    const reg = registryOf();
    const running = reg.contexts.filter((c) => c.state === 'running');
    const pool = running.length > 0 ? running : reg.contexts;
    return pool[0] ?? null;
  }

  /**
   * 兜底时钟：来自 hook 到的 AudioContext，没有就退回 performance.now()。
   * 注意：游戏可能在注入**之前**就创建了 AudioContext，此时 reg.contexts 是空的，
   * 所以这里不能作为主时钟（见下面的 audioTime）。
   */
  rawAudioTime(): number {
    const ctx = this.primaryContext();
    if (ctx) return ctx.currentTime;
    return nowSec();
  }

  /**
   * 调度统一时间轴。
   * 优先级：主循环 source 所属的 AudioContext.currentTime
   *        （即使该 ctx 早于注入创建，只要 source 是在注入后 start 的，prototype 打桩仍能抓到它）
   *      → hook 到的 ctx → performance.now()。
   * 这样「调度时刻」与「循环相位」永远在同一个时钟上，不会出现基准错位的假漂移。
   */
  get audioTime(): number {
    const loop = this.primaryLoop();
    if (loop && loop.source.ctx && typeof loop.source.ctx.currentTime === 'number') {
      return loop.source.ctx.currentTime;
    }
    return this.rawAudioTime();
  }

  /** 所有仍在「活跃期」的循环 source */
  private activeSources(): TrackedSource[] {
    const reg = registryOf();
    return reg.sources.filter((s) => {
      if (s.duration <= 0.05 || s.duration > 120) return false;
      if (s.ctx.state === 'closed') return false;
      if (s.ctx.currentTime - s.startTime < -0.5) return false;
      // 刻意不做过期淘汰：真机实测有两种播放方式 ——
      //   V9：每个循环重新 start 一批 source（间隔 == duration）
      //   V5 Brazil：整个会话只 start 一个长 buffer，之后再没有新 source
      // 一旦按 age 淘汰，第二种情况会直接丢掉整个时钟（loopDuration 变 0、退化成 BPM 推算）。
      // 旧 source 由上面的 400 条上限控制，相位锚点永远取最新的那一条，所以保留是安全的。
      return true;
    });
  }

  candidates(): LoopCandidate[] {
    return this.activeSources().map((s) => ({
      duration: Number(s.duration.toFixed(4)),
      playing: s.ctx.state === 'running' && s.ctx.currentTime >= s.startTime,
      ageSec: Number((s.ctx.currentTime - s.startTime).toFixed(3)),
      kind: 'buffer',
    }));
  }

  /**
   * 相位原点 = startTime - offset。
   * start(when, offset) 的语义是「when 时刻播放到 buffer 的 offset 位置」，
   * 所以把 (when - offset) 当作循环网格原点，才能和游戏自己的节拍网格对齐。
   */
  private originOf(s: TrackedSource): number {
    return s.startTime - s.offset;
  }

  private sourceProgress(s: TrackedSource): number {
    const duration = s.duration;
    if (duration <= 0) return 0;
    const elapsed = s.ctx.currentTime - this.originOf(s);
    if (elapsed < 0) return 0;
    const loc = ((elapsed % duration) + duration) % duration;
    return loc / duration;
  }

  private sourceAnchor(s: TrackedSource): number {
    const duration = s.duration;
    const origin = this.originOf(s);
    const elapsed = s.ctx.currentTime - origin;
    if (elapsed < 0) return origin;
    return origin + Math.floor(elapsed / duration) * duration;
  }

  /**
   * 主循环选择：先按时长聚类（2% 容差），取活跃 source 最多的簇，
   * 簇内取最早开始（最稳定、相位最可信）的那一路。
   */
  primaryLoop(): PrimaryLoop | null {
    if (this.overrideDuration) {
      const duration = this.overrideDuration;
      const anchor = this.manualAnchor ?? this.rawAudioTime();
      const elapsed = Math.max(0, this.rawAudioTime() - anchor);
      return {
        duration,
        anchor,
        progress: ((elapsed % duration) + duration) % duration / duration,
        source: { id: -1, ctx: this.primaryContext() ?? ({} as AudioContext), startTime: anchor, offset: 0, duration, loop: true, createdAt: 0 },
      };
    }

    const sources = this.activeSources();
    if (sources.length === 0) return null;

    const clusters: Array<{ duration: number; items: TrackedSource[] }> = [];
    for (const s of sources) {
      const hit = clusters.find((c) => Math.abs(c.duration - s.duration) / c.duration < 0.02);
      if (hit) hit.items.push(s);
      else clusters.push({ duration: s.duration, items: [s] });
    }
    clusters.sort((a, b) => {
      // 最短的是基准 loop（Incredibox 里部分音色的 buffer 会横跨 2 个 loop）
      if (Math.abs(a.duration - b.duration) > 0.02) return a.duration - b.duration;
      return b.items.length - a.items.length;
    });
    const best = clusters[0];
    if (!best) return null;
    // 非循环 source 每循环重新 start：最新的 startTime 才是当前循环的真实起点
    const master = best.items.reduce((newest, s) => (s.startTime > newest.startTime ? s : newest), best.items[0]!);
    return {
      duration: best.duration,
      anchor: this.sourceAnchor(master),
      progress: this.sourceProgress(master),
      source: master,
    };
  }

  get loopDuration(): number {
    return this.primaryLoop()?.duration ?? 0;
  }

  get progress(): number {
    return this.primaryLoop()?.progress ?? 0;
  }

  /** 是否真的有音乐在循环（无人登台时 Incredibox 是静默的） */
  get playing(): boolean {
    const p = this.primaryLoop();
    if (!p) return false;
    return p.source.ctx.state === 'running' && p.source.ctx.currentTime >= p.source.startTime;
  }

  get clockSource(): ClockSource {
    if (this.overrideDuration) return 'override';
    const p = this.primaryLoop();
    if (!p) return this.primaryContext() ? 'none' : 'none';
    return 'hook';
  }

  /** 当前时刻所在循环的起点（ctx 时间） */
  loopStartTime(): number | null {
    const p = this.primaryLoop();
    if (!p) return null;
    return p.anchor;
  }
}
