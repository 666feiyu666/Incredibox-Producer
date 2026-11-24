import { describe, expect, it } from 'vitest';
import {
  computeStageStateAtBar,
  computeStageStateAfterBar,
  emptyProject,
  type CompositionProject,
  type CueEvent,
} from '../src/index.ts';

function ev(partial: Partial<CueEvent> & Pick<CueEvent, 'bar' | 'slotIndex' | 'action'>): CueEvent {
  return { id: `e${Math.random().toString(36).slice(2)}`, beat: 1, ...partial };
}

function project(events: CueEvent[]): CompositionProject {
  return { ...emptyProject({ totalBars: 16 }), events };
}

describe('computeStageStateAtBar', () => {
  it('第 1 小节前是空舞台', () => {
    const p = project([ev({ bar: 2, slotIndex: 0, action: 'EQUIP', iconId: 3 })]);
    expect(computeStageStateAtBar(p, 1).every((s) => s.iconId === null)).toBe(true);
  });

  it('EQUIP 是队列机制：目标小节的换装在进入该小节时已生效', () => {
    const p = project([ev({ bar: 3, slotIndex: 1, action: 'EQUIP', iconId: 7 })]);
    const at3 = computeStageStateAtBar(p, 3);
    expect(at3[1]!.iconId).toBe(7);
    const at2 = computeStageStateAtBar(p, 2);
    expect(at2[1]!.iconId).toBeNull();
  });

  it('小节内（beat > 1）的换装不计入快照', () => {
    const p = project([ev({ bar: 3, beat: 4.5, slotIndex: 2, action: 'EQUIP', iconId: 11 })]);
    expect(computeStageStateAtBar(p, 3)[2]!.iconId).toBeNull();
    expect(computeStageStateAtBar(p, 4)[2]!.iconId).toBe(11);
  });

  it('折叠 MUTE / UNMUTE / CLEAR 与 SOLO', () => {
    const p = project([
      ev({ bar: 2, slotIndex: 0, action: 'EQUIP', iconId: 1 }),
      ev({ bar: 4, slotIndex: 0, action: 'MUTE' }),
      ev({ bar: 5, slotIndex: 0, action: 'UNMUTE' }),
      ev({ bar: 3, slotIndex: 4, action: 'EQUIP', iconId: 9 }),
      ev({ bar: 6, slotIndex: 4, action: 'SOLO' }),
      ev({ bar: 8, slotIndex: 4, action: 'CLEAR' }),
    ]);
    // 「到达 targetBar 前一瞬」：targetBar 第 1 拍上的 MUTE 尚未执行
    expect(computeStageStateAtBar(p, 4)[0]).toMatchObject({ iconId: 1, muted: false });
    expect(computeStageStateAfterBar(p, 4)[0]).toMatchObject({ iconId: 1, muted: true });
    expect(computeStageStateAtBar(p, 5)[0]).toMatchObject({ iconId: 1, muted: true });
    expect(computeStageStateAtBar(p, 6)[0]).toMatchObject({ iconId: 1, muted: false });
    expect(computeStageStateAtBar(p, 7)[4]).toMatchObject({ iconId: 9, solo: true });
    expect(computeStageStateAtBar(p, 9)[4]).toMatchObject({ iconId: null, solo: false });
  });

  it('目标小节里混有非 EQUIP 事件时，不会漏掉同小节的换装', () => {
    const p = project([
      ev({ bar: 1, beat: 1, slotIndex: 6, action: 'UNMUTE' }),
      ev({ bar: 1, beat: 1, slotIndex: 0, action: 'EQUIP', iconId: 4 }),
      ev({ bar: 1, beat: 5, slotIndex: 6, action: 'UNMUTE' }),
    ]);
    const at1 = computeStageStateAtBar(p, 1);
    expect(at1[0]!.iconId).toBe(4);
    expect(at1[6]!.muted).toBe(false);
  });

  it('computeStageStateAfterBar 包含小节内事件', () => {
    const p = project([
      ev({ bar: 2, beat: 1, slotIndex: 0, action: 'EQUIP', iconId: 1 }),
      ev({ bar: 2, beat: 5, slotIndex: 0, action: 'MUTE' }),
    ]);
    expect(computeStageStateAtBar(p, 3)[0]!.muted).toBe(true);
    expect(computeStageStateAfterBar(p, 1)[0]!.muted).toBe(false);
    expect(computeStageStateAfterBar(p, 2)[0]!.muted).toBe(true);
  });
});
