import {
  emptySnapshot,
  type InputOp,
  type AdapterKind,
  type ClockSource,
  type GameAdapter,
  type GameAdapterExtras,
  type LoopCandidate,
  type ProbeReport,
  type SlotStage,
  type StageSnapshot,
} from '@ic/shared';
import { AudioClock } from '../audio-clock.ts';
import { describe } from '../util.ts';

export interface AdapterConfig {
  loopOverrideSec: number | null;
  domProfile: { slotSelector?: string; iconSelector?: string; recordSelector?: string } | null;
}

/**
 * 适配层基类：统一处理「时钟读取 + 舞台状态影子跟踪 + 探测报告」，
 * 子类只需要实现 5 个控制原语（equip / clear / mute / solo / record）。
 */
export abstract class BaseAdapter implements GameAdapter, GameAdapterExtras {
  abstract readonly kind: AdapterKind;
  protected clock: AudioClock;
  protected tracked: StageSnapshot = emptySnapshot();
  protected notes: string[] = [];
  protected lastError: string | null = null;
  protected config: AdapterConfig;
  /** 由 Agent 注入：把手势交给 Bridge 用真实 CDP 输入执行 */
  private inputSink: ((ops: InputOp[]) => void) | null = null;

  setInputSink(sink: ((ops: InputOp[]) => void) | null): void {
    this.inputSink = sink;
  }

  /** 有 Bridge 通道就走真实输入；没有（纯控制台注入）退回合成事件 */
  protected emitInput(ops: InputOp[]): boolean {
    if (!this.inputSink) return false;
    try {
      this.inputSink(ops);
      return true;
    } catch (err) {
      this.markError(err, 'emitInput');
      return false;
    }
  }

  constructor(config: AdapterConfig) {
    this.config = config;
    this.clock = new AudioClock();
    this.clock.setOverride(config.loopOverrideSec);
  }

  abstract equipIcon(slotIndex: number, iconId: number): void;
  abstract clearSlot(slotIndex: number): void;
  abstract setMute(slotIndex: number, muted: boolean): void;
  abstract setSolo(slotIndex: number, solo: boolean): void;
  abstract toggleRecord(recording: boolean): void;

  /** 子类覆盖：清理自身 hook */
  dispose(): void {
    this.notes = [];
  }

  getAudioTime(): number {
    return this.clock.audioTime;
  }

  getLoopProgress(): number {
    return this.clock.progress;
  }

  getLoopDuration(): number {
    return this.clock.loopDuration;
  }

  getLoopStartTime(): number | null {
    return this.clock.loopStartTime();
  }

  get clockSource(): ClockSource {
    return this.clock.clockSource;
  }

  get hasLoopClock(): boolean {
    return this.clock.loopDuration > 0;
  }

  get playing(): boolean {
    return this.clock.playing;
  }

  get lastErrorMessage(): string | null {
    return this.lastError;
  }

  setLoopOverride(durationSec: number | null): void {
    this.config.loopOverrideSec = durationSec;
    this.clock.setOverride(durationSec);
  }

  setAdapterConfig(config: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.loopOverrideSec !== undefined) this.clock.setOverride(config.loopOverrideSec);
  }

  getTrackedStage(): StageSnapshot {
    return this.tracked.map((s) => ({ ...s }));
  }

  protected stageOf(slotIndex: number): SlotStage | null {
    return this.tracked[slotIndex] ?? null;
  }

  protected markError(err: unknown, context: string): void {
    this.lastError = `${context}: ${String(err)}`;
  }

  /** 覆盖探针：子类补充可控元素信息 */
  protected probeDetails(): {
    slots: ProbeReport['slots'];
    icons: ProbeReport['icons'];
    recordButton: string | null;
  } {
    return { slots: [], icons: [], recordButton: null };
  }

  probe(): ProbeReport {
    const details = this.probeDetailsSafe();
    return {
      url: location.href,
      userAgent: navigator.userAgent,
      adapterKind: this.kind,
      clockSource: this.clockSource,
      audioContexts: this.clock.contextCount,
      audioState: this.clock.audioState,
      loopDuration: Number(this.getLoopDuration().toFixed(4)),
      progress: Number(this.getLoopProgress().toFixed(4)),
      loopCandidates: this.safeCandidates(),
      slots: details.slots,
      icons: details.icons,
      recordButton: details.recordButton,
      globals: scanGlobals(),
      notes: [...this.notes, ...this.clockNotes()],
    };
  }

  private probeDetailsSafe() {
    try {
      return this.probeDetails();
    } catch (err) {
      return { slots: [], icons: [], recordButton: null, note: String(err) };
    }
  }

  private safeCandidates(): LoopCandidate[] {
    try {
      return this.clock.candidates().slice(0, 12);
    } catch {
      return [];
    }
  }

  protected clockNotes(): string[] {
    const out: string[] = [];
    const ctx = this.clock.contextCount;
    out.push(`AudioContext 实例数：${ctx}`);
    const candidates = this.safeCandidates();
    if (candidates.length === 0) {
      out.push('未捕获到 loop=true 的 AudioBufferSourceNode：游戏可能使用 <audio> 元素或尚未开始播放。');
    } else {
      const top = candidates[0]!;
      out.push(`主循环候选：${top.duration}s（${candidates.length} 个活跃循环 source）`);
    }
    if (this.config.loopOverrideSec) out.push(`已启用手动循环时长覆盖：${this.config.loopOverrideSec}s`);
    return out;
  }
}

/** 扫描 window 上看起来像游戏状态机的高层对象，帮助人工定位 */
export function scanGlobals(limit = 40): Array<{ name: string; type: string }> {
  const out: Array<{ name: string; type: string }> = [];
  const suspicious = /(game|incredibox|stage|player|charact|performer|audio|music|mix|scene|loop|beat|sound|voice|icon)/i;
  try {
    for (const key of Object.keys(window)) {
      if (out.length >= limit) break;
      if (key.startsWith('__INCREDIBOX')) continue;
      let value: unknown;
      try {
        value = (window as unknown as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      if (value === null || value === undefined) continue;
      const type = typeof value;
      if (type === 'function' && suspicious.test(key)) {
        out.push({ name: key, type: 'function' });
      } else if (type === 'object') {
        let size = 0;
        try {
          size = Object.keys(value as object).length;
        } catch {
          size = 0;
        }
        if (size >= 4) out.push({ name: key, type: `object(${size})` });
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function describeElement(el: Element | null): string {
  return describe(el);
}
