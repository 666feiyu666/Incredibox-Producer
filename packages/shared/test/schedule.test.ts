import { describe, expect, it } from 'vitest';
import {
  compileProject,
  emptyProject,
  type CompositionProject,
  type CueEvent,
} from '../src/index.ts';

function ev(partial: Partial<CueEvent> & Pick<CueEvent, 'bar' | 'slotIndex' | 'action'>): CueEvent {
  return { id: `${partial.bar}-${partial.slotIndex}-${partial.action}-${partial.beat ?? 1}`, beat: 1, ...partial };
}

const base: CompositionProject = emptyProject({ bpm: 120, beatsPerBar: 8, totalBars: 16 });

describe('compileProject', () => {
  it('EQUIP 提前 1 拍派发到上一小节', () => {
    const compiled = compileProject({ ...base, events: [ev({ bar: 5, slotIndex: 0, action: 'EQUIP', iconId: 2 })] });
    const cue = compiled.cues[0]!;
    expect(cue.fireBar).toBe(4);
    expect(cue.fireFraction).toBeCloseTo(1 - 1 / 8, 6);
    expect(cue.preEquip).toBe(true);
  });

  it('EQUIP 提前量可配置', () => {
    const compiled = compileProject(
      { ...base, events: [ev({ bar: 5, slotIndex: 0, action: 'EQUIP', iconId: 2 })] },
      { equipLeadBeats: 2 },
    );
    expect(compiled.cues[0]!.fireFraction).toBeCloseTo(1 - 2 / 8, 6);
  });

  it('第 1 小节的 EQUIP 派发小节为 0（交给舞台预热）', () => {
    const compiled = compileProject({ ...base, events: [ev({ bar: 1, slotIndex: 0, action: 'EQUIP', iconId: 2 })] });
    expect(compiled.cues[0]!.fireBar).toBe(0);
  });

  it('MUTE / UNMUTE 即时，按拍内比例定位', () => {
    const compiled = compileProject({
      ...base,
      events: [
        ev({ bar: 3, beat: 4.5, slotIndex: 1, action: 'MUTE' }),
        ev({ bar: 3, beat: 1, slotIndex: 1, action: 'UNMUTE' }),
      ],
    });
    const mute = compiled.cues.find((c) => c.action === 'MUTE')!;
    expect(mute.fireBar).toBe(3);
    expect(mute.fireFraction).toBeCloseTo(3.5 / 8, 6);
    const unmute = compiled.cues.find((c) => c.action === 'UNMUTE')!;
    expect(unmute.fireBar).toBe(3);
    expect(unmute.fireFraction).toBe(0);
  });

  it('同一拍多角色动作被聚合到同一派发小节，且解除静音先于静音', () => {
    const compiled = compileProject({
      ...base,
      events: [
        ev({ bar: 2, beat: 1, slotIndex: 0, action: 'MUTE' }),
        ev({ bar: 2, beat: 1, slotIndex: 1, action: 'MUTE' }),
        ev({ bar: 2, beat: 1, slotIndex: 2, action: 'UNMUTE' }),
      ],
    });
    const bar2 = compiled.byFireBar.get(2)!;
    expect(bar2).toHaveLength(3);
    expect(bar2[0]!.action).toBe('UNMUTE');
    expect(bar2.filter((c) => c.action === 'MUTE')).toHaveLength(2);
  });

  it('小节内换装标记为近似', () => {
    const compiled = compileProject({
      ...base,
      events: [ev({ bar: 7, beat: 4.5, slotIndex: 3, action: 'EQUIP', iconId: 5 })],
    });
    const cue = compiled.cues[0]!;
    expect(cue.fireBar).toBe(7);
    expect(cue.approximate).toBe(true);
    expect(cue.fireFraction).toBeCloseTo(3.5 / 8 + 1 / 8, 6);
  });
});
