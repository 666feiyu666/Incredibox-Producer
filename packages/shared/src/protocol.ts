import type {
  ActionType,
  CompositionProject,
  DomProfile,
  FiredCue,
  GuestInfo,
  LogEntry,
  PlaybackState,
  ProbeReport,
  RuntimeOptions,
} from './types.ts';

/** Host 浏览器 → Bridge（WebSocket 文本帧） */
export type HostCommand =
  | { type: 'hello'; client: 'host' }
  | { type: 'project:sync'; project: CompositionProject }
  | {
      type: 'transport:play';
      project: CompositionProject;
      startBar: number;
      options?: Partial<RuntimeOptions>;
    }
  | { type: 'transport:stop' }
  | { type: 'stage:sync'; project: CompositionProject; bar: number }
  | { type: 'stage:clear' }
  | { type: 'options:set'; options: Partial<RuntimeOptions> }
  | { type: 'adapter:command'; command: AdapterCommand }
  | { type: 'record:start' }
  | { type: 'record:stop' }
  | { type: 'mix:start'; project: CompositionProject; startBar?: number }
  | { type: 'mix:abort' }
  | { type: 'probe' }
  /** 让游戏切换到指定版本（Bridge 会点游戏里的版本图标并进入 mix 界面） */
  | { type: 'version:select'; versionId: string; versionIndex: number }
  | { type: 'ping' };

export interface AdapterCommand {
  kind: 'equip' | 'mute' | 'solo' | 'clear' | 'record';
  slotIndex?: number;
  iconId?: number;
  on?: boolean;
}

/** Bridge → Host */
export type BridgeEvent =
  | {
      type: 'welcome';
      serverVersion: string;
      cdpConnected: boolean;
      guest: GuestInfo | null;
      options: RuntimeOptions;
      logs: LogEntry[];
    }
  | { type: 'status'; cdpConnected: boolean; guest: GuestInfo | null }
  | { type: 'log'; entry: LogEntry }
  | { type: 'tick'; state: PlaybackState; options: RuntimeOptions }
  | { type: 'cue'; cue: FiredCue }
  | { type: 'mix'; phase: MixPhase; message?: string }
  | { type: 'probe'; report: ProbeReport }
  | { type: 'version'; state: VersionSwitchState }
  | { type: 'error'; message: string };

/** 切版本的多步流程状态（点图标 → 封面 → 点播放 → mix 加载完成） */
export interface VersionSwitchState {
  phase: 'selecting' | 'opening' | 'loading' | 'ready' | 'error';
  versionId: string;
  versionIndex: number;
  /** 从游戏页面标题读到的实际版本（如 "INCREDIBOX V5 | Brazil"） */
  detected?: string;
  message?: string;
}

export type MixPhase = 'start' | 'armed' | 'recording' | 'done' | 'error';

/**
 * 输入执行请求。
 *
 * 真机实证：Incredibox 不响应 JS 合成事件（`dispatchEvent` 会到达监听器，但游戏内部不认），
 * 只有 CDP 注入的真实鼠标事件有效。所以 Guest 只负责「算坐标 + 决定时机」，
 * 真正的手势交给 Bridge 用 `Input.dispatchMouseEvent` 执行。
 */
export interface InputOp {
  kind: 'click' | 'drag';
  /** click 用 */
  point?: { x: number; y: number };
  /** drag 用 */
  from?: { x: number; y: number };
  to?: { x: number; y: number };
  /** 执行这个手势前额外等待（毫秒），用于等上一个动作的界面动画结束 */
  delayMs?: number;
}

/** Guest → Bridge（经 CDP binding 回传） */
export type GuestMessage =
  | { type: 'hello'; info: GuestInfo }
  | { type: 'status'; info: GuestInfo }
  | { type: 'tick'; state: PlaybackState }
  | { type: 'cue'; cue: FiredCue }
  | { type: 'mix'; phase: MixPhase; message?: string }
  | { type: 'probe'; report: ProbeReport }
  | { type: 'log'; level: LogEntry['level']; message: string }
  /** 请求 Bridge 用真实 CDP 输入执行手势 */
  | { type: 'input:exec'; ops: InputOp[] };

/** Bridge → Guest：HostCommand 去掉仅 Bridge 关心的 hello / ping */
export type GuestCommand = Exclude<HostCommand, { type: 'hello' } | { type: 'ping' }>;

/** 兼容类型：真实游戏适配时自定义 DOM 选择器画像 */
export type { DomProfile };

export type TimingAction = Extract<ActionType, 'EQUIP' | 'MUTE' | 'UNMUTE' | 'SOLO' | 'CLEAR'>;
