import type { ActionType, CompositionProject, CueEvent } from './types.ts';
import { SLOT_COUNT } from './types.ts';
import { cloneProject, newEventId, sortEvents } from './state.ts';

/** 拍内切分点 */
export interface ChopPoint {
  beat: number;
  muted: boolean;
}

export type ChopPresetId = 'none' | 'firstHalf' | 'secondHalf' | 'offbeat' | 'everyOtherBeat' | 'stutter';

export const CHOP_PRESETS: Array<{ id: ChopPresetId; label: string; hint: string }> = [
  { id: 'none', label: '整小节', hint: '不切分' },
  { id: 'firstHalf', label: '前半', hint: '前半小节响、后半静音' },
  { id: 'secondHalf', label: '后半', hint: '前半静音、后半响' },
  { id: 'offbeat', label: '反拍', hint: '每拍后半响（Off-beat）' },
  { id: 'everyOtherBeat', label: '隔拍', hint: '响一拍停一拍' },
  { id: 'stutter', label: '碎拍', hint: '半拍交替（Stutter）' },
];

export interface ChopPlan {
  /** 该小节第 1 拍的基础静音状态 */
  baseMuted: boolean;
  /** 只会返回 beat > 1 的切分点 */
  points: ChopPoint[];
}

export function chopPresetPlan(preset: ChopPresetId, beatsPerBar: number): ChopPlan {
  const beats = Math.max(1, Math.round(beatsPerBar));
  const half = beats / 2 + 1;
  const points: ChopPoint[] = [];
  switch (preset) {
    case 'none':
      return { baseMuted: false, points: [] };
    case 'firstHalf':
      if (half <= beats) points.push({ beat: half, muted: true });
      return { baseMuted: false, points };
    case 'secondHalf':
      return { baseMuted: true, points: [{ beat: half, muted: false }] };
    case 'offbeat':
      for (let b = 1; b <= beats; b += 1) {
        points.push({ beat: b + 0.5, muted: false });
        if (b + 1 <= beats) points.push({ beat: b + 1, muted: true });
      }
      return { baseMuted: true, points };
    case 'everyOtherBeat':
      for (let b = 2; b <= beats; b += 2) {
        points.push({ beat: b, muted: true });
        if (b + 1 <= beats) points.push({ beat: b + 1, muted: false });
      }
      return { baseMuted: false, points };
    case 'stutter':
      for (let b = 1; b <= beats; b += 1) {
        points.push({ beat: b + 0.5, muted: true });
        if (b + 1 <= beats) points.push({ beat: b + 1, muted: false });
      }
      return { baseMuted: false, points };
    default:
      return { baseMuted: false, points: [] };
  }
}

/** 网格单元派生视图 */
export interface GridCell {
  slotIndex: number;
  bar: number;
  iconId: number | null;
  muted: boolean;
  solo: boolean;
  /** 该小节内 beat > 1 的切分点 */
  chops: ChopPoint[];
  /** 该单元是否在本小节起始就发生了换装 */
  equippedHere: boolean;
}

export type GridRow = GridCell[];

export interface GridView {
  bars: number;
  rows: GridRow[];
}

/**
 * 把事件流投影成 7 × N 网格视图。
 * 语义：某槽位在某个小节显示的音色 = 到该小节为止最后一次 EQUIP 的结果（DAW 式的「持续块」）。
 */
export function deriveGrid(project: CompositionProject): GridView {
  const bars = Math.max(1, project.totalBars);
  const slots = Array.from({ length: SLOT_COUNT }, (_, slotIndex) =>
    Array.from({ length: bars }, (_, i): GridCell => ({
      slotIndex,
      bar: i + 1,
      iconId: null,
      muted: false,
      solo: false,
      chops: [],
      equippedHere: false,
    })),
  );

  const events = sortEvents(project.events);
  const state = Array.from({ length: SLOT_COUNT }, () => ({ iconId: null as number | null, muted: false, solo: false }));
  let cursor = 0;

  for (let bar = 1; bar <= bars; bar += 1) {
    const equippedThisBar = new Set<number>();
    // 先处理 beat <= 1 的事件（换装 / 静音等落在小节头）
    while (cursor < events.length) {
      const ev = events[cursor]!;
      if (ev.bar !== bar || ev.beat > 1) break;
      applyToState(state, ev);
      if (ev.action === 'EQUIP') equippedThisBar.add(ev.slotIndex);
      cursor += 1;
    }
    // 记录小节头状态
    for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
      const s = state[slot]!;
      const cell = slots[slot]![bar - 1]!;
      cell.iconId = s.iconId;
      cell.muted = s.muted;
      cell.solo = s.solo;
      cell.equippedHere = equippedThisBar.has(slot);
    }
    // 再处理小节内切分（beat > 1），并把它折叠进状态
    while (cursor < events.length) {
      const ev = events[cursor]!;
      if (ev.bar !== bar) break;
      if (ev.action === 'MUTE' || ev.action === 'UNMUTE') {
        const cell = slots[ev.slotIndex]?.[bar - 1];
        if (cell) cell.chops.push({ beat: ev.beat, muted: ev.action === 'MUTE' });
      }
      applyToState(state, ev);
      cursor += 1;
    }
  }

  return { bars, rows: slots };
}

function applyToState(
  state: Array<{ iconId: number | null; muted: boolean; solo: boolean }>,
  ev: CueEvent,
): void {
  const s = state[ev.slotIndex];
  if (!s) return;
  switch (ev.action) {
    case 'EQUIP':
      s.iconId = ev.iconId ?? s.iconId;
      break;
    case 'CLEAR':
      s.iconId = null;
      s.muted = false;
      s.solo = false;
      break;
    case 'MUTE':
      s.muted = true;
      break;
    case 'UNMUTE':
      s.muted = false;
      break;
    case 'SOLO':
      s.solo = true;
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// 编辑操作（全部返回新 project，便于 undo/redo 做快照）
// ---------------------------------------------------------------------------

const IMMUTABLE_ACTIONS: ActionType[] = ['EQUIP', 'CLEAR'];

function withEvents(project: CompositionProject, events: CueEvent[]): CompositionProject {
  return { ...cloneProject(project), events: sortEvents(events) };
}

function removeAt(events: CueEvent[], match: (e: CueEvent) => boolean): CueEvent[] {
  return events.filter((e) => !match(e));
}

/** 单元格换音色；iconId 为 null 表示清空该槽位 */
export function setCellIcon(
  project: CompositionProject,
  slotIndex: number,
  bar: number,
  iconId: number | null,
): CompositionProject {
  const events = removeAt(project.events, (e) => e.slotIndex === slotIndex && e.bar === bar && e.beat <= 1);
  if (iconId === null) {
    events.push({ id: newEventId(), bar, beat: 1, slotIndex, action: 'CLEAR' });
  } else {
    events.push({ id: newEventId(), bar, beat: 1, slotIndex, action: 'EQUIP', iconId });
  }
  return withEvents(project, events);
}

/** 单元格基础静音状态 */
export function setCellMuted(
  project: CompositionProject,
  slotIndex: number,
  bar: number,
  muted: boolean,
): CompositionProject {
  const events = removeAt(
    project.events,
    (e) => e.slotIndex === slotIndex && e.bar === bar && e.beat <= 1 && (e.action === 'MUTE' || e.action === 'UNMUTE'),
  );
  events.push({
    id: newEventId(),
    bar,
    beat: 1,
    slotIndex,
    action: muted ? 'MUTE' : 'UNMUTE',
  });
  return withEvents(project, events);
}

export function setCellSolo(
  project: CompositionProject,
  slotIndex: number,
  bar: number,
  solo: boolean,
): CompositionProject {
  const events = removeAt(
    project.events,
    (e) => e.slotIndex === slotIndex && e.bar === bar && e.action === 'SOLO',
  );
  if (!solo) return withEvents(project, events);
  events.push({ id: newEventId(), bar, beat: 1, slotIndex, action: 'SOLO' });
  return withEvents(project, events);
}

/** 应用切分预设：清掉该单元格 beat > 1 的全部 MUTE/UNMUTE，再写入预设切分点 */
export function setCellChops(
  project: CompositionProject,
  slotIndex: number,
  bar: number,
  preset: ChopPresetId,
): CompositionProject {
  const plan = chopPresetPlan(preset, project.beatsPerBar);
  let events = removeAt(
    project.events,
    (e) => e.slotIndex === slotIndex && e.bar === bar && e.beat > 1 && (e.action === 'MUTE' || e.action === 'UNMUTE'),
  );
  for (const point of plan.points) {
    events.push({
      id: newEventId(),
      bar,
      beat: point.beat,
      slotIndex,
      action: point.muted ? 'MUTE' : 'UNMUTE',
    });
  }
  const next = withEvents(project, events);
  const head = next.events.find(
    (e) => e.slotIndex === slotIndex && e.bar === bar && e.beat <= 1 && (e.action === 'MUTE' || e.action === 'UNMUTE'),
  );
  if (head && head.action === 'MUTE' && plan.baseMuted) return next;
  return setCellMuted(next, slotIndex, bar, plan.baseMuted);
}

/** 判断某单元格当前匹配哪个切分预设（用于 UI 高亮） */
export function detectChopPreset(cell: GridCell, beatsPerBar: number): ChopPresetId {
  const ids: ChopPresetId[] = ['none', 'firstHalf', 'secondHalf', 'offbeat', 'everyOtherBeat', 'stutter'];
  const normalized = [...cell.chops]
    .sort((a, b) => a.beat - b.beat)
    .map((c) => `${c.beat.toFixed(3)}:${c.muted ? 1 : 0}`)
    .join(',');
  for (const id of ids) {
    const plan = chopPresetPlan(id, beatsPerBar);
    const sig = [...plan.points]
      .sort((a, b) => a.beat - b.beat)
      .map((c) => `${c.beat.toFixed(3)}:${c.muted ? 1 : 0}`)
      .join(',');
    if (sig === normalized) return id;
  }
  return normalized === '' ? 'none' : 'stutter';
}

export function clearCell(project: CompositionProject, slotIndex: number, bar: number): CompositionProject {
  const events = removeAt(project.events, (e) => e.slotIndex === slotIndex && e.bar === bar);
  events.push({ id: newEventId(), bar, beat: 1, slotIndex, action: 'CLEAR' });
  return withEvents(project, events);
}

export function clearAll(project: CompositionProject): CompositionProject {
  const events: CueEvent[] = [];
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    events.push({ id: newEventId(), bar: 1, beat: 1, slotIndex: slot, action: 'CLEAR' });
  }
  return withEvents(project, events);
}

export interface RangeSelection {
  fromBar: number;
  toBar: number;
  /** 选中槽位，默认全部 7 个 */
  slots?: number[];
}

function rangeSlots(selection: RangeSelection): number[] {
  return selection.slots && selection.slots.length > 0
    ? selection.slots.filter((s) => s >= 0 && s < SLOT_COUNT)
    : Array.from({ length: SLOT_COUNT }, (_, i) => i);
}

export interface PatternClip {
  kind: 'incredibox-pattern';
  version: 1;
  bars: number;
  slots: number;
  /** 槽位归一到 0 起的相对坐标 */
  events: CueEvent[];
}

/** 框选复制：把 [fromBar, toBar] × slots 的事件裁剪成相对坐标片段 */
export function copyRange(project: CompositionProject, selection: RangeSelection): PatternClip {
  const from = Math.min(selection.fromBar, selection.toBar);
  const to = Math.max(selection.fromBar, selection.toBar);
  const slots = rangeSlots(selection);
  const slotBase = Math.min(...slots);
  const slotSpan = Math.max(...slots) - slotBase + 1;
  const events = project.events
    .filter((e) => e.bar >= from && e.bar <= to && slots.includes(e.slotIndex))
    .map((e) => ({
      ...e,
      id: newEventId(),
      bar: e.bar - from + 1,
      slotIndex: e.slotIndex - slotBase,
    }));
  return { kind: 'incredibox-pattern', version: 1, bars: to - from + 1, slots: slotSpan, events };
}

export interface PasteTarget {
  bar: number;
  /** 目标起始槽位（默认 0） */
  slot?: number;
}

/** 粘贴片段到指定小节 / 槽位，超出 totalBars 的部分自动扩容 */
export function pasteAt(
  project: CompositionProject,
  clip: PatternClip,
  target: PasteTarget,
): CompositionProject {
  const slotBase = target.slot ?? 0;
  const merged = cloneProject(project);
  const incoming = clip.events.map((e) => ({
    ...e,
    id: newEventId(),
    bar: e.bar + target.bar - 1,
    slotIndex: e.slotIndex + slotBase,
  })).filter((e) => e.slotIndex < SLOT_COUNT);

  // 覆盖写入：先清掉目标区域被覆盖的事件
  const coveredBars = new Set(incoming.map((e) => e.bar));
  if (coveredBars.size > 0) {
    const slots = new Set(incoming.map((e) => e.slotIndex));
    merged.events = merged.events.filter((e) => !(coveredBars.has(e.bar) && slots.has(e.slotIndex)));
  }
  merged.events.push(...incoming);
  const maxBar = merged.events.reduce((m, e) => Math.max(m, e.bar), 0);
  merged.totalBars = Math.max(merged.totalBars, maxBar);
  return withEvents(merged, merged.events);
}

/** 在小节 fromBar 之前插入 count 个小节 */
export function insertBars(project: CompositionProject, fromBar: number, count: number): CompositionProject {
  if (count <= 0) return cloneProject(project);
  const next = cloneProject(project);
  next.events = next.events.map((e) => (e.bar >= fromBar ? { ...e, bar: e.bar + count } : e));
  next.totalBars += count;
  return withEvents(next, next.events);
}

/** 删除 [fromBar, toBar] 区间的小节 */
export function deleteBars(project: CompositionProject, fromBar: number, toBar: number): CompositionProject {
  const from = Math.min(fromBar, toBar);
  const to = Math.max(fromBar, toBar);
  const span = to - from + 1;
  const next = cloneProject(project);
  next.events = next.events
    .filter((e) => !(e.bar >= from && e.bar <= to))
    .map((e) => (e.bar > to ? { ...e, bar: e.bar - span } : e));
  next.totalBars = Math.max(1, next.totalBars - span);
  return withEvents(next, next.events);
}

export function setTotalBars(project: CompositionProject, totalBars: number): CompositionProject {
  const bars = Math.max(1, Math.round(totalBars));
  const next = cloneProject(project);
  next.totalBars = bars;
  next.events = next.events.filter((e) => e.bar <= bars);
  return withEvents(next, next.events);
}

export function duplicatePattern(
  project: CompositionProject,
  source: RangeSelection,
  targetBar: number,
): CompositionProject {
  const clip = copyRange(project, source);
  return pasteAt(project, clip, { bar: targetBar, slot: 0 });
}

export { IMMUTABLE_ACTIONS };
