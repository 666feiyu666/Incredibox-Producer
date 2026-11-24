import { ICON_COUNT } from './types.ts';

export interface IconMeta {
  id: number;
  /** 分组 */
  group: IconGroup;
  /** 展示名（音色名，非游戏原始素材名） */
  name: string;
  /** 调色板色值（Tailwind 无法覆盖全部场景，直接给 hex） */
  color: string;
}

export type IconGroup = 'beats' | 'effects' | 'melodies' | 'voices';

export const ICON_GROUPS: Array<{ id: IconGroup; label: string; hint: string }> = [
  { id: 'beats', label: 'Beats', hint: '节奏骨架' },
  { id: 'effects', label: 'Effects', hint: '音效点缀' },
  { id: 'melodies', label: 'Melodies', hint: '旋律 / 和声' },
  { id: 'voices', label: 'Voices', hint: '人声切片' },
];

const BEATS = ['Kick', 'Snare', 'Hat', 'Perc', 'Tom'];
const EFFECTS = ['Scratch', 'Horn', 'Riser', 'Sweep', 'Zap'];
const MELODIES = ['Bass', 'Pluck', 'Bell', 'Synth', 'Organ'];
const VOICES = ['Vox Ah', 'Vox Eh', 'Vox Oh', 'Chant', 'Shout'];

const BEAT_COLORS = ['#f97316', '#fb7185', '#f59e0b', '#ea580c', '#fbbf24'];
const EFFECT_COLORS = ['#a855f7', '#8b5cf6', '#c084fc', '#7c3aed', '#d8b4fe'];
const MELODY_COLORS = ['#22d3ee', '#06b6d4', '#38bdf8', '#0ea5e9', '#67e8f9'];
const VOICE_COLORS = ['#34d399', '#10b981', '#4ade80', '#059669', '#86efac'];

function build(): IconMeta[] {
  const out: IconMeta[] = [];
  const push = (group: IconGroup, names: string[], colors: string[], base: number) => {
    names.forEach((name, i) => {
      out.push({ id: base + i, group, name, color: colors[i % colors.length] ?? '#94a3b8' });
    });
  };
  push('beats', BEATS, BEAT_COLORS, 0);
  push('effects', EFFECTS, EFFECT_COLORS, 5);
  push('melodies', MELODIES, MELODY_COLORS, 10);
  push('voices', VOICES, VOICE_COLORS, 15);
  return out;
}

export const ICONS: IconMeta[] = build();

if (ICONS.length !== ICON_COUNT) {
  throw new Error(`图标目录数量必须是 ${ICON_COUNT}，当前 ${ICONS.length}`);
}

const ICON_INDEX = new Map<number, IconMeta>(ICONS.map((i) => [i.id, i]));

export function iconMeta(id: number | null | undefined): IconMeta | null {
  if (id === null || id === undefined) return null;
  return ICON_INDEX.get(id) ?? null;
}

export function iconName(id: number | null | undefined): string {
  const meta = iconMeta(id);
  return meta ? meta.name : id === null || id === undefined ? '空' : `#${id}`;
}

export interface VersionPreset {
  id: string;
  label: string;
  bpm: number;
  beatsPerBar: number;
}

/**
 * 曲目版本预设。Steam 版 Incredibox 各曲目的 BPM / 单循环拍数不同，
 * 这里给出可直接使用的默认值；真实循环时长仍由 Guest 的 AudioContext hook 实测，
 * 若实测与预设不一致以实测为准（可在校准面板手动覆盖）。
 */
export const VERSION_PRESETS: VersionPreset[] = [
  { id: 'V1_Alpha', label: 'V1 Alpha', bpm: 120, beatsPerBar: 8 },
  { id: 'V2_LittleMiss', label: 'V2 Little Miss', bpm: 110, beatsPerBar: 8 },
  { id: 'V3_Sunrise', label: 'V3 Sunrise', bpm: 125, beatsPerBar: 8 },
  { id: 'V4_TheLove', label: 'V4 The Love', bpm: 116, beatsPerBar: 8 },
  { id: 'V5_Brazil', label: 'V5 Brazil', bpm: 128, beatsPerBar: 8 },
  { id: 'V6_Dystopia', label: 'V6 Dystopia', bpm: 122, beatsPerBar: 8 },
  { id: 'V7_Colors', label: 'V7 Colors', bpm: 118, beatsPerBar: 8 },
  { id: 'V8_Barbados', label: 'V8 Barbados', bpm: 124, beatsPerBar: 8 },
  { id: 'V9_WeLikeToParty', label: 'V9 We Like to Party', bpm: 126, beatsPerBar: 16 },
  { id: 'SIM_Test', label: '模拟器测试曲目', bpm: 120, beatsPerBar: 8 },
];

export function versionPreset(id: string): VersionPreset {
  return VERSION_PRESETS.find((v) => v.id === id) ?? VERSION_PRESETS[0]!;
}
