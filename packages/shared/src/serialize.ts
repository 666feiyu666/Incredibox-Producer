import type { CueEvent, CompositionProject } from './types.ts';
import { ICON_COUNT, SLOT_COUNT } from './types.ts';
import { cloneProject, emptyProject, newEventId, sortEvents } from './state.ts';

const ACTIONS = new Set(['EQUIP', 'MUTE', 'UNMUTE', 'SOLO', 'CLEAR']);

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(num(value, fallback));
  return Math.min(max, Math.max(min, n));
}

/** 严格取整范围：超出范围直接判定非法（槽位 / 图标 ID 不能靠 clamp 救回来） */
function intInRange(value: unknown, min: number, max: number): number | null {
  const n = Math.round(num(value, Number.NaN));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/**
 * 宽松解析 + 归一化：导入任意 JSON（手工编辑、旧版本、第三方工具生成）都尽量救回来。
 * 无法修复的字段回退到默认值，并在 events 里丢弃非法项。
 */
export function parseProject(raw: unknown): CompositionProject {
  const base = emptyProject();
  if (typeof raw !== 'object' || raw === null) return base;
  const obj = raw as Record<string, unknown>;
  const beatsPerBar = clampInt(obj.beatsPerBar, 1, 64, base.beatsPerBar);
  const project: CompositionProject = {
    title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : base.title,
    versionId: typeof obj.versionId === 'string' && obj.versionId ? obj.versionId : base.versionId,
    bpm: Math.min(400, Math.max(20, num(obj.bpm, base.bpm))),
    beatsPerBar,
    totalBars: clampInt(obj.totalBars, 1, 1024, base.totalBars),
    events: [],
  };

  const rawEvents = Array.isArray(obj.events) ? obj.events : [];
  const events: CueEvent[] = [];
  for (const item of rawEvents) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    const action = typeof e.action === 'string' ? e.action.toUpperCase() : '';
    if (!ACTIONS.has(action)) continue;
    const bar = clampInt(e.bar, 1, 1024, 1);
    const beat = Math.min(beatsPerBar + 1, Math.max(1, num(e.beat, 1)));
    const slotIndex = intInRange(e.slotIndex, 0, SLOT_COUNT - 1);
    if (slotIndex === null) continue;
    if (action === 'EQUIP') {
      const iconId = intInRange(e.iconId, 0, ICON_COUNT - 1);
      if (iconId === null) continue;
      events.push({ id: typeof e.id === 'string' && e.id ? e.id : newEventId(), bar, beat, slotIndex, action: 'EQUIP', iconId });
    } else {
      events.push({
        id: typeof e.id === 'string' && e.id ? e.id : newEventId(),
        bar,
        beat,
        slotIndex,
        action: action as CueEvent['action'],
      });
    }
  }

  project.events = sortEvents(events);
  const maxBar = project.events.reduce((m, e) => Math.max(m, e.bar), 0);
  project.totalBars = Math.max(project.totalBars, maxBar);
  return project;
}

export function serializeProject(project: CompositionProject): string {
  return JSON.stringify(cloneProject(project), null, 2);
}
