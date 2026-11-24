import type {
  ActionType,
  CompositionProject,
  CueEvent,
  SlotStage,
  StageSnapshot,
} from './types.ts';
import { SLOT_COUNT } from './types.ts';

let idSeq = 0;
/** 生成稳定可读的 event id（guest/host 都可用） */
export function newEventId(): string {
  idSeq += 1;
  return `ev${Date.now().toString(36)}${idSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function emptySlotStage(slotIndex: number): SlotStage {
  return { slotIndex, iconId: null, muted: false, solo: false };
}

export function emptySnapshot(): StageSnapshot {
  return Array.from({ length: SLOT_COUNT }, (_, i) => emptySlotStage(i));
}

export function emptyProject(overrides: Partial<CompositionProject> = {}): CompositionProject {
  return {
    title: '未命名乐谱',
    versionId: 'V1_Alpha',
    bpm: 120,
    beatsPerBar: 8,
    totalBars: 32,
    events: [],
    ...overrides,
  };
}

/** 事件排序：先小节，再拍，再原始顺序（稳定） */
export function sortEvents(events: CueEvent[]): CueEvent[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (a.e.bar !== b.e.bar) return a.e.bar - b.e.bar;
      if (a.e.beat !== b.e.beat) return a.e.beat - b.e.beat;
      return a.i - b.i;
    })
    .map((x) => x.e);
}

/** 把一个事件折叠进舞台状态 */
export function applyEvent(snapshot: StageSnapshot, event: CueEvent): void {
  const stage = snapshot[event.slotIndex];
  if (!stage) return;
  switch (event.action) {
    case 'EQUIP':
      stage.iconId = event.iconId ?? stage.iconId;
      break;
    case 'CLEAR':
      stage.iconId = null;
      stage.muted = false;
      stage.solo = false;
      break;
    case 'MUTE':
      stage.muted = true;
      break;
    case 'UNMUTE':
      stage.muted = false;
      break;
    case 'SOLO':
      stage.solo = true;
      break;
    default:
      break;
  }
  if (event.action !== 'SOLO' && stage.solo) {
    // 独奏是全局模式：任何其它槽位的动作不改变 solo 标志本身，
    // 这里保留，避免一处 solo 被无关事件意外清掉。
  }
}

/**
 * 状态推演纯函数（design.md §2.3）：
 * 遍历 Bar 1 至 targetBar 之前的所有历史事件，计算到达 targetBar 前一瞬，
 * 7 个槽位各自应该穿戴的 iconId 以及 muted / solo 状态。
 *
 * EQUIP 是队列机制：目标小节 bar N 的换装是在 bar N-1 就派发的，
 * 因此这里把「bar === targetBar 且 beat <= 1 的 EQUIP」也计入快照 ——
 * 这正是「到达 targetBar 前一瞬」已经排队生效的穿戴指令。
 */
export function computeStageStateAtBar(
  project: CompositionProject,
  targetBar: number,
): StageSnapshot {
  const snapshot = emptySnapshot();
  const events = sortEvents(project.events);
  for (const event of events) {
    if (event.bar > targetBar) break;
    const reachable =
      event.bar < targetBar || (event.action === 'EQUIP' && event.beat <= 1);
    // 同一小节里，只有「目标小节头部的 EQUIP」算已排队生效，其它事件（如 beat 1 上的 MUTE）
    // 都要等调度器在边界处派发，因此这里是 continue 而不是 break —— 否则会漏掉排在其后的换装。
    if (!reachable) continue;
    applyEvent(snapshot, event);
  }
  return snapshot;
}

/** 计算执行完 bar（含该小节内全部事件）之后的状态 */
export function computeStageStateAfterBar(
  project: CompositionProject,
  bar: number,
): StageSnapshot {
  const snapshot = emptySnapshot();
  for (const event of sortEvents(project.events)) {
    if (event.bar > bar) break;
    applyEvent(snapshot, event);
  }
  return snapshot;
}

/** 单小节时长（秒），按 BPM 与拍数推算 */
export function barDurationSec(project: Pick<CompositionProject, 'bpm' | 'beatsPerBar'>): number {
  if (project.bpm <= 0 || project.beatsPerBar <= 0) return 0;
  return (60 / project.bpm) * project.beatsPerBar;
}

/** 整曲时长（秒） */
export function projectDurationSec(project: CompositionProject): number {
  return barDurationSec(project) * project.totalBars;
}

/** 总时长超过该值即触发「录制上限预警」（design 阶段三：3 分钟红线） */
export const REC_RED_LINE_SEC = 180;

export function beatsToFraction(beat: number, beatsPerBar: number): number {
  const f = (beat - 1) / beatsPerBar;
  return Math.min(0.999999, Math.max(0, f));
}

export function fractionToBeat(fraction: number, beatsPerBar: number): number {
  return fraction * beatsPerBar + 1;
}

export function actionLabel(action: ActionType): string {
  switch (action) {
    case 'EQUIP':
      return '穿戴';
    case 'MUTE':
      return '静音';
    case 'UNMUTE':
      return '解除静音';
    case 'SOLO':
      return '独奏';
    case 'CLEAR':
      return '清空';
    default:
      return action;
  }
}

/** 深拷贝（乐谱都是纯 JSON 数据） */
export function cloneProject(project: CompositionProject): CompositionProject {
  return {
    title: project.title,
    versionId: project.versionId,
    bpm: project.bpm,
    beatsPerBar: project.beatsPerBar,
    totalBars: project.totalBars,
    events: project.events.map((e) => ({ ...e })),
  };
}
