import { describe, expect, it } from 'vitest';
import {
  chopPresetPlan,
  clearAll,
  copyRange,
  deleteBars,
  deriveGrid,
  detectChopPreset,
  emptyProject,
  insertBars,
  parseProject,
  pasteAt,
  serializeProject,
  setCellChops,
  setCellIcon,
  setCellMuted,
  setTotalBars,
  computeStageStateAtBar,
  type CompositionProject,
} from '../src/index.ts';

const base: CompositionProject = emptyProject({ bpm: 120, beatsPerBar: 8, totalBars: 8 });

describe('单元格编辑 → 网格投影', () => {
  it('换音色后网格从小节起持续显示', () => {
    let p = setCellIcon(base, 0, 2, 4);
    p = setCellIcon(p, 3, 5, 12);
    const grid = deriveGrid(p);
    expect(grid.rows[0]![0]!.iconId).toBeNull();
    expect(grid.rows[0]![1]!.iconId).toBe(4);
    expect(grid.rows[0]![3]!.iconId).toBe(4);
    expect(grid.rows[3]![4]!.iconId).toBe(12);
    expect(grid.rows[3]![4]!.equippedHere).toBe(true);
  });

  it('清空槽位后网格显示为空', () => {
    let p = setCellIcon(base, 0, 2, 4);
    p = setCellIcon(p, 0, 4, null);
    const grid = deriveGrid(p);
    expect(grid.rows[0]![2]!.iconId).toBe(4);
    expect(grid.rows[0]![3]!.iconId).toBeNull();
    expect(grid.rows[0]![4]!.iconId).toBeNull();
  });

  it('静音状态持续并可解除', () => {
    let p = setCellIcon(base, 1, 1, 6);
    p = setCellMuted(p, 1, 2, true);
    p = setCellMuted(p, 1, 4, false);
    const grid = deriveGrid(p);
    expect(grid.rows[1]![0]!.muted).toBe(false);
    expect(grid.rows[1]![2]!.muted).toBe(true);
    expect(grid.rows[1]![5]!.muted).toBe(false);
  });

  it('切分预设写入 beat > 1 的事件并折叠进网格', () => {
    let p = setCellIcon(base, 2, 3, 8);
    p = setCellChops(p, 2, 3, 'firstHalf');
    const cell = deriveGrid(p).rows[2]![2]!;
    expect(cell.chops).toEqual([{ beat: 5, muted: true }]);
    expect(detectChopPreset(cell, 8)).toBe('firstHalf');
  });

  it('后半切分设置了小节头静音', () => {
    const p = setCellChops(setCellIcon(base, 0, 1, 1), 0, 1, 'secondHalf');
    const cell = deriveGrid(p).rows[0]![0]!;
    expect(cell.muted).toBe(true);
    expect(cell.chops).toEqual([{ beat: 5, muted: false }]);
  });

  it('切分计划：beatsPerBar=16 时半小节在第 9 拍', () => {
    expect(chopPresetPlan('firstHalf', 16).points).toEqual([{ beat: 9, muted: true }]);
  });
});

describe('片段复制 / 粘贴 / 小节增删', () => {
  it('复制 2 小节并粘贴到第 6 小节', () => {
    let p = setCellIcon(base, 0, 1, 1);
    p = setCellIcon(p, 0, 2, 2);
    p = setCellMuted(p, 0, 2, true);
    const clip = copyRange(p, { fromBar: 1, toBar: 2 });
    expect(clip.bars).toBe(2);
    const pasted = pasteAt(p, clip, { bar: 6 });
    expect(pasted.events.some((e) => e.bar === 6 && e.action === 'EQUIP' && e.iconId === 1)).toBe(true);
    expect(pasted.events.some((e) => e.bar === 7 && e.action === 'MUTE')).toBe(true);
    expect(computeStageStateAtBar(pasted, 7)[0]).toMatchObject({ iconId: 2, muted: true });
  });

  it('粘贴到不同槽位时整体平移', () => {
    const p = setCellIcon(base, 0, 1, 3);
    const clip = copyRange(p, { fromBar: 1, toBar: 1 });
    const pasted = pasteAt(p, clip, { bar: 3, slot: 4 });
    expect(pasted.events.some((e) => e.bar === 3 && e.slotIndex === 4 && e.iconId === 3)).toBe(true);
  });

  it('插入小节把后续事件整体后移', () => {
    const p = insertBars(setCellIcon(base, 0, 3, 5), 2, 2);
    expect(p.totalBars).toBe(10);
    expect(p.events.find((e) => e.action === 'EQUIP')!.bar).toBe(5);
  });

  it('删除小节把后续事件整体前移', () => {
    const p = deleteBars(setCellIcon(base, 0, 5, 5), 2, 3);
    expect(p.totalBars).toBe(6);
    expect(p.events.find((e) => e.action === 'EQUIP')!.bar).toBe(3);
  });

  it('缩减总小节数会裁掉越界事件', () => {
    const p = setTotalBars(setCellIcon(base, 0, 8, 1), 4);
    expect(p.totalBars).toBe(4);
    expect(p.events).toHaveLength(0);
  });

  it('clearAll 生成 7 条 CLEAR', () => {
    const p = clearAll(setCellIcon(base, 0, 1, 1));
    expect(p.events.filter((e) => e.action === 'CLEAR')).toHaveLength(7);
  });
});

describe('导入 / 导出', () => {
  it('JSON 往返保持等价', () => {
    const p = setCellChops(setCellIcon(base, 0, 2, 9), 0, 2, 'offbeat');
    const round = parseProject(JSON.parse(serializeProject(p)));
    expect(round.events.length).toBe(p.events.length);
    expect(deriveGrid(round).rows[0]![1]).toMatchObject({ iconId: 9 });
    expect(deriveGrid(round).rows[0]![1]!.chops.length).toBe(chopPresetPlan('offbeat', 8).points.length);
  });

  it('非法输入被清洗', () => {
    const p = parseProject({
      title: '  ',
      bpm: 'abc',
      beatsPerBar: 999,
      totalBars: -5,
      events: [
        { bar: 2, beat: 1, slotIndex: 0, action: 'EQUIP', iconId: 99 },
        { bar: 2, beat: 1, slotIndex: 9, action: 'MUTE' },
        { bar: 3, beat: 1, slotIndex: 2, action: 'NOPE' },
        { bar: 3, beat: 1, slotIndex: 2, action: 'MUTE' },
      ],
    });
    expect(p.beatsPerBar).toBe(64);
    expect(p.totalBars).toBe(3);
    expect(p.events).toHaveLength(1);
    expect(p.events[0]).toMatchObject({ bar: 3, action: 'MUTE', slotIndex: 2 });
  });

  it('完全非法输入返回空乐谱', () => {
    expect(parseProject(null).events).toHaveLength(0);
    expect(parseProject('x').events).toHaveLength(0);
  });
});
