/**
 * 核心领域模型（Shared Types）
 *
 * 严格对齐 design.md 第 2 节的游戏原生机制约束：
 *  1. EQUIP（穿戴/替换）是队列机制 —— 调用后角色在「下一个循环小节第 1 拍」才发声，
 *     所以 `CueEvent.bar` 对 EQUIP 而言表示「期望发声的小节」，调度器负责提前派发。
 *  2. MUTE / UNMUTE 是即时机制 —— 调用后立刻生效，可用于拍内切分与骤停。
 */

/** 7 个小人槽位 (0 - 6) */
export const SLOT_COUNT = 7;
/** 20 个音色图标 (0 - 19) */
export const ICON_COUNT = 20;

export type ActionType = 'EQUIP' | 'MUTE' | 'UNMUTE' | 'SOLO' | 'CLEAR';

export interface CueEvent {
  id: string;
  /** 目标小节（从 1 开始计数）。对 EQUIP 来说是「希望开始发声的小节」。 */
  bar: number;
  /** 小节内拍数（从 1.0 开始，支持小数如 4.5 实现半拍切分） */
  beat: number;
  /** 7 个小人槽位 (0 - 6) */
  slotIndex: number;
  action: ActionType;
  /** 20 个音色图标 ID (0 - 19)，仅 EQUIP 时必填 */
  iconId?: number;
}

export interface CompositionProject {
  title: string;
  /** 对应游戏版本（如 V1_Alpha, V2_LittleMiss 等） */
  versionId: string;
  bpm: number;
  /** 单循环拍数（通常为 8 或 16） */
  beatsPerBar: number;
  totalBars: number;
  events: CueEvent[];
}

/** 单个槽位在「某一瞬间」的舞台状态 */
export interface SlotStage {
  slotIndex: number;
  iconId: number | null;
  muted: boolean;
  solo: boolean;
}

export type StageSnapshot = SlotStage[];

/**
 * 注入式运行时对游戏内部的控制接口。
 * 真实游戏内由 adapter/* 的实现者提供（DOM 兜底 / 全局 API / 模拟器）。
 */
export interface GameAdapter {
  /** 获取硬件级 AudioContext.currentTime */
  getAudioTime(): number;
  /** 获取当前小节进度 [0.0, 1.0) */
  getLoopProgress(): number;
  /** 获取当前版本单小节精确时长（秒） */
  getLoopDuration(): number;
  equipIcon(slotIndex: number, iconId: number): void;
  clearSlot(slotIndex: number): void;
  setMute(slotIndex: number, muted: boolean): void;
  setSolo(slotIndex: number, solo: boolean): void;
  /** 控制游戏原生 REC 按钮 */
  toggleRecord(recording: boolean): void;
}

/** GameAdapter 的可选扩展（不强制，供调度器/UI 增强） */
export interface GameAdapterExtras {
  /** 适配层类型，用于 Host 端展示与降级提示 */
  readonly kind: AdapterKind;
  /** 循环时钟来源，'hook' / 'game' / 'override' / 'none' */
  readonly clockSource: ClockSource;
  /** 是否有可用的循环边界（否则退化为自由运行时钟） */
  readonly hasLoopClock: boolean;
  /** 游戏内是否真的有声音在循环（无人登台时 Incredibox 是静默的） */
  readonly playing: boolean;
  /** 获取当前循环边界（最近一次小节起点）的 AudioContext 时间；取不到返回 null */
  getLoopStartTime(): number | null;
  /** 调度器/UI 认为的 7 个槽位当前状态 */
  getTrackedStage(): StageSnapshot;
  /** 覆盖自动探测到的循环时长（校准用），传 null 恢复自动 */
  setLoopOverride(durationSec: number | null): void;
  /** 探测游戏内结构，返回可读报告 */
  probe(): ProbeReport;
  /** 卸载所有 hook */
  dispose(): void;
}

export type AdapterKind = 'sim' | 'dom' | 'api' | 'noop';
export type ClockSource = 'hook' | 'game' | 'override' | 'manual' | 'none';

export interface LoopCandidate {
  duration: number;
  playing: boolean;
  /** 距离现在多久之前 start() 被调用 */
  ageSec: number;
  kind: 'buffer' | 'oscillator' | 'element';
}

export interface ProbeReport {
  url: string;
  userAgent: string;
  adapterKind: AdapterKind;
  clockSource: ClockSource;
  audioContexts: number;
  audioState: string;
  loopDuration: number;
  progress: number;
  loopCandidates: LoopCandidate[];
  slots: Array<{ index: number; selector: string; label: string }>;
  icons: Array<{ index: number; selector: string; label: string }>;
  recordButton: string | null;
  /** 扫描到的高层全局对象（可能藏着游戏状态机） */
  globals: Array<{ name: string; type: string }>;
  notes: string[];
}

/** 运行时可调参数（Host 侧校准面板 → Bridge → Guest） */
export interface RuntimeOptions {
  /** 全局偏移微调（-50ms ~ +50ms），补偿音频输出设备缓冲延迟 */
  offsetMs: number;
  /** 换装提前量（拍），在目标小节前这么多拍派发 EQUIP */
  equipLeadBeats: number;
  /** 前瞻窗口（毫秒） */
  lookaheadMs: number;
  /** 调度轮询间隔（毫秒） */
  tickMs: number;
  /** 适配层选择 */
  adapterMode: 'auto' | 'sim' | 'dom' | 'api';
  /** 手动指定循环时长（秒），null = 自动探测 */
  loopOverrideSec: number | null;
  /** 自定义 DOM 选择器画像（真实游戏适配时用） */
  domProfile: DomProfile | null;
}

export interface DomProfile {
  slotSelector?: string;
  iconSelector?: string;
  recordSelector?: string;
}

export const DEFAULT_RUNTIME_OPTIONS: RuntimeOptions = {
  offsetMs: 0,
  equipLeadBeats: 1,
  lookaheadMs: 50,
  tickMs: 15,
  adapterMode: 'auto',
  loopOverrideSec: null,
  domProfile: null,
};

/** 播放状态快照（Guest → Bridge → Host，约 10Hz） */
export interface PlaybackState {
  /** 'idle' | 'arming'（等待循环边界对齐） | 'playing' | 'recording' | 'mix' */
  mode: 'idle' | 'arming' | 'playing' | 'recording' | 'mix';
  playing: boolean;
  bar: number;
  totalBars: number;
  /** 当前小节进度 [0,1) */
  progress: number;
  /** 当前拍（1 起，浮点） */
  beat: number;
  firedCues: number;
  lateCues: number;
  recording: boolean;
  slots: StageSnapshot;
  /** 游戏内是否真的有循环在跑 */
  gamePlaying: boolean;
  clockSource: ClockSource;
  adapterKind: AdapterKind;
}

export interface FiredCue {
  id: string;
  slotIndex: number;
  action: ActionType;
  iconId?: number;
  bar: number;
  beat: number;
  /** guest 侧音频时钟时间戳 */
  firedAt: number;
  /** 相对计划时间的迟到量（毫秒，正数为晚） */
  lateMs: number;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  source: 'bridge' | 'guest' | 'host';
  message: string;
}

export interface GuestInfo {
  online: boolean;
  adapterKind: AdapterKind;
  clockSource: ClockSource;
  hasLoopClock: boolean;
  playing: boolean;
  loopDuration: number;
  progress: number;
  audioTime: number;
  injectedAt: number;
  bundleHash: string;
  agentVersion: string;
  lastError: string | null;
}
