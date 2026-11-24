import type { ActionType, CompositionProject, CueEvent } from './types.ts';
import { beatsToFraction, sortEvents } from './state.ts';

/**
 * 编译后的调度指令。
 *
 * 关键推导（design.md §2 第 1 条）：EQUIP 是队列机制，游戏会在「下一个循环小节第 1 拍」
 * 才让它发声。因此 `CueEvent.bar = N` 的 EQUIP 必须在 `fireBar = N - 1` 就派发，
 * 派发位置取该小节的 `fireFraction = 1 - equipLeadBeats / beatsPerBar`（默认提前 1 拍）。
 */
export interface CompiledCue {
  id: string;
  slotIndex: number;
  action: ActionType;
  iconId?: number;
  /** 期望发声 / 生效的小节 */
  bar: number;
  /** 期望发声 / 生效的拍（1 起，支持小数） */
  beat: number;
  /** 真正需要调用游戏接口的小节序号；<= 0 表示需要由「舞台预热」完成 */
  fireBar: number;
  /** 真正需要调用游戏接口的小节内进度 [0, 1) */
  fireFraction: number;
  /** 是否为「提前拍换装」派发 */
  preEquip: boolean;
  /** 近似标记：小节内换装（bar 的 beat > 1）无法精确落位，实际会在下个循环头生效 */
  approximate: boolean;
}

export interface CompiledProject {
  totalBars: number;
  beatsPerBar: number;
  equipLeadBeats: number;
  cues: CompiledCue[];
  /** 按派发小节聚合，key 为 fireBar */
  byFireBar: Map<number, CompiledCue[]>;
}

export interface CompileOptions {
  equipLeadBeats?: number;
}

function isImmediate(action: ActionType): boolean {
  return action !== 'EQUIP';
}

export function compileProject(
  project: CompositionProject,
  options: CompileOptions = {},
): CompiledProject {
  const beatsPerBar = Math.max(1, project.beatsPerBar);
  const equipLeadBeats = clamp(options.equipLeadBeats ?? 1, 0, beatsPerBar);
  const cues: CompiledCue[] = [];

  for (const event of sortEvents(project.events)) {
    cues.push(compileCue(event, beatsPerBar, equipLeadBeats));
  }

  cues.sort((a, b) => {
    if (a.fireBar !== b.fireBar) return a.fireBar - b.fireBar;
    if (a.fireFraction !== b.fireFraction) return a.fireFraction - b.fireFraction;
    // 同一时刻：先解除静音 / 先穿戴，再静音，保证「同一拍多角色同时动作」
    return actionOrder(a.action) - actionOrder(b.action);
  });

  const byFireBar = new Map<number, CompiledCue[]>();
  for (const cue of cues) {
    const list = byFireBar.get(cue.fireBar);
    if (list) list.push(cue);
    else byFireBar.set(cue.fireBar, [cue]);
  }

  return {
    totalBars: Math.max(1, project.totalBars),
    beatsPerBar,
    equipLeadBeats,
    cues,
    byFireBar,
  };
}

function actionOrder(action: ActionType): number {
  switch (action) {
    case 'CLEAR':
      return 0;
    case 'EQUIP':
      return 1;
    case 'UNMUTE':
      return 2;
    case 'MUTE':
      return 3;
    case 'SOLO':
      return 4;
    default:
      return 5;
  }
}

function compileCue(event: CueEvent, beatsPerBar: number, equipLeadBeats: number): CompiledCue {
  const beat = clamp(event.beat, 1, beatsPerBar + 1);
  const base = {
    id: event.id,
    slotIndex: event.slotIndex,
    action: event.action,
    ...(event.iconId === undefined ? {} : { iconId: event.iconId }),
    bar: event.bar,
    beat,
  };

  if (isImmediate(event.action)) {
    return {
      ...base,
      fireBar: event.bar,
      fireFraction: beatsToFraction(beat, beatsPerBar),
      preEquip: false,
      approximate: false,
    };
  }

  const leadFraction = equipLeadBeats / beatsPerBar;
  const approximate = beat > 1;
  if (beat > 1) {
    // 小节内换装：游戏只在循环边界重启音色，实际生效在下一个小节头
    return {
      ...base,
      fireBar: event.bar,
      fireFraction: clamp(beatsToFraction(beat, beatsPerBar) + leadFraction, 0, 0.999999),
      preEquip: true,
      approximate,
    };
  }

  return {
    ...base,
    fireBar: event.bar - 1,
    fireFraction: clamp(1 - leadFraction, 0, 0.999999),
    preEquip: true,
    approximate,
  };
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 派发某小节时应当跳过的小节号：起点之前的一律交给舞台预热 */
export function cuesForBar(
  compiled: CompiledProject,
  fireBar: number,
): CompiledCue[] {
  return compiled.byFireBar.get(fireBar) ?? [];
}

/** 该小节是否包含需要提前派发的换装指令 */
export function barHasPreEquip(compiled: CompiledProject, bar: number): boolean {
  const cues = compiled.byFireBar.get(bar);
  if (!cues) return false;
  return cues.some((c) => c.preEquip);
}
