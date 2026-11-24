import { SIM_GLOBAL, type AdapterKind, type ClockSource, type ProbeReport } from '@ic/shared';
import { BaseAdapter, type AdapterConfig } from './base.ts';

/** 游戏侧可选的「高层 API」：模拟器与自定义注入脚本都可以实现它 */
export interface ExternalGameApi {
  version?: string;
  getSnapshot?(): Array<{ iconId: number | null; muted: boolean; solo: boolean }>;
  equip(slotIndex: number, iconId: number): void;
  clear(slotIndex: number): void;
  setMute(slotIndex: number, muted: boolean): void;
  setSolo(slotIndex: number, solo: boolean): void;
  setRecord(on: boolean): void;
  getClock?(): {
    audioTime: number;
    loopDuration: number;
    loopStart: number;
    progress: number;
    playing: boolean;
  } | null;
  log?(message: string): void;
}

export const GAME_API_GLOBAL = '__INCREDIBOX_GAME_API__';

/**
 * 通过游戏自己暴露的对象控制角色。
 * 模拟器（__INCREDIBOX_SIM__）与用户自己写的注入脚本（__INCREDIBOX_GAME_API__）共用这套实现。
 *
 * 时钟优先用 AudioContext hook（这样连 hook 一起验证）；hook 抓不到时退回 getClock()。
 */
export class ExternalApiAdapter extends BaseAdapter {
  readonly kind: AdapterKind;
  private apiName: string;

  constructor(config: AdapterConfig, globalName?: string) {
    super(config);
    this.apiName = globalName ?? SIM_GLOBAL;
    this.kind = this.apiName === SIM_GLOBAL ? 'sim' : 'api';
    const api = this.api();
    if (api?.version) this.notes.push(`游戏 API 版本：${api.version}`);
    if (!api) this.notes.push(`未找到全局对象 window.${this.apiName}`);
  }

  private api(): ExternalGameApi | null {
    const w = window as unknown as Record<string, unknown>;
    const api = w[this.apiName];
    return api && typeof api === 'object' ? (api as ExternalGameApi) : null;
  }

  private gameClock() {
    try {
      return this.api()?.getClock?.() ?? null;
    } catch {
      return null;
    }
  }

  override getLoopDuration(): number {
    const hook = super.getLoopDuration();
    if (hook > 0) return hook;
    return this.gameClock()?.loopDuration ?? 0;
  }

  override getLoopProgress(): number {
    if (super.getLoopDuration() > 0) return super.getLoopProgress();
    return this.gameClock()?.progress ?? 0;
  }

  override get hasLoopClock(): boolean {
    return this.getLoopDuration() > 0;
  }

  override get clockSource(): ClockSource {
    const hookSource = super.clockSource;
    if (hookSource === 'hook' || hookSource === 'override') return hookSource;
    return this.gameClock() ? 'game' : hookSource;
  }

  override get playing(): boolean {
    if (super.playing) return true;
    return this.gameClock()?.playing ?? false;
  }

  override getLoopStartTime(): number | null {
    const exact = super.getLoopStartTime();
    if (exact !== null) return exact;
    const clock = this.gameClock();
    return clock ? clock.loopStart : null;
  }

  equipIcon(slotIndex: number, iconId: number): void {
    try {
      this.api()?.equip(slotIndex, iconId);
      const stage = this.stageOf(slotIndex);
      if (stage) stage.iconId = iconId;
    } catch (err) {
      this.markError(err, 'equipIcon');
    }
  }

  clearSlot(slotIndex: number): void {
    try {
      this.api()?.clear(slotIndex);
      const stage = this.stageOf(slotIndex);
      if (stage) {
        stage.iconId = null;
        stage.muted = false;
      }
    } catch (err) {
      this.markError(err, 'clearSlot');
    }
  }

  setMute(slotIndex: number, muted: boolean): void {
    try {
      this.api()?.setMute(slotIndex, muted);
      const stage = this.stageOf(slotIndex);
      if (stage) stage.muted = muted;
    } catch (err) {
      this.markError(err, 'setMute');
    }
  }

  setSolo(slotIndex: number, solo: boolean): void {
    try {
      this.api()?.setSolo(slotIndex, solo);
      const stage = this.stageOf(slotIndex);
      if (stage) stage.solo = solo;
    } catch (err) {
      this.markError(err, 'setSolo');
    }
  }

  toggleRecord(recording: boolean): void {
    try {
      this.api()?.setRecord(recording);
    } catch (err) {
      this.markError(err, 'toggleRecord');
    }
  }

  /** 每帧回读游戏真实状态，纠正我们对舞台的影子状态 */
  resyncFromApi(): boolean {
    try {
      const snap = this.api()?.getSnapshot?.();
      if (!snap) return false;
      snap.forEach((s, i) => {
        const stage = this.stageOf(i);
        if (!stage) return;
        stage.iconId = s.iconId;
        stage.muted = s.muted;
        stage.solo = s.solo;
      });
      return true;
    } catch {
      return false;
    }
  }

  protected override probeDetails(): {
    slots: ProbeReport['slots'];
    icons: ProbeReport['icons'];
    recordButton: string | null;
  } {
    return {
      slots: Array.from({ length: 7 }, (_, i) => ({
        index: i,
        selector: `${this.apiName}.equip(${i}, iconId)`,
        label: `API 槽位 ${i}`,
      })),
      icons: Array.from({ length: 20 }, (_, i) => ({
        index: i,
        selector: `${this.apiName}.equip(slot, ${i})`,
        label: `API 图标 ${i}`,
      })),
      recordButton: `${this.apiName}.setRecord(true|false)`,
    };
  }
}
