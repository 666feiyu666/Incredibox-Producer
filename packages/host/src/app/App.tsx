import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  barDurationSec,
  clearCell,
  copyRange,
  DEFAULT_RUNTIME_OPTIONS,
  deleteBars,
  deriveGrid,
  insertBars,
  pasteAt,
  projectDurationSec,
  REC_RED_LINE_SEC,
  setCellChops,
  setCellIcon,
  setCellMuted,
  setTotalBars,
  versionPreset,
  type ChopPresetId,
  type CompositionProject,
  type PatternClip,
  type RuntimeOptions,
} from '@ic/shared';
import { SidePanel, Inspector, LogPanel, ProbePanel, Settings, type SideTab } from '../components/SidePanel.tsx';
import { Grid, type Selection } from '../components/Grid.tsx';
import { Palette, SlotLegend } from '../components/Palette.tsx';
import { StatusBar, TopBar, TransportBar, formatDuration } from '../components/Bar.tsx';
import { Badge, Button } from '../components/ui.tsx';
import { useBridge } from './useBridge.ts';
import { downloadProject, pickProjectFile, useProject } from './useProject.ts';

const OPTIONS_KEY = 'ib-composer:options:v2';
const LEGACY_OPTIONS_KEY = 'ib-composer:options:v1';

function loadOptions(): RuntimeOptions {
  try {
    const current = localStorage.getItem(OPTIONS_KEY);
    if (current) {
      return { ...DEFAULT_RUNTIME_OPTIONS, ...(JSON.parse(current) as Partial<RuntimeOptions>) };
    }
    // 从 v1 迁移：v1 时代 autoBonus 的默认值是「关」，落盘的 false 并不代表用户的选择，
    // 沿用下来会让「自动接 bonus」看起来永远不生效，因此丢掉该字段、改用新默认。
    const legacy = localStorage.getItem(LEGACY_OPTIONS_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as Partial<RuntimeOptions>;
      delete parsed.autoBonus;
      return { ...DEFAULT_RUNTIME_OPTIONS, ...parsed };
    }
    return { ...DEFAULT_RUNTIME_OPTIONS };
  } catch {
    return { ...DEFAULT_RUNTIME_OPTIONS };
  }
}

export default function App() {
  const bridge = useBridge();
  const store = useProject();
  const [iconId, setIconId] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [clip, setClip] = useState<PatternClip | null>(null);
  const [playFrom, setPlayFrom] = useState(1);
  const [tab, setTab] = useState<SideTab>('inspect');
  const [options, setOptions] = useState<RuntimeOptions>(loadOptions);
  const [banner, setBanner] = useState<{ tone: 'cyan' | 'rose' | 'amber'; text: string } | null>(null);

  const { project } = store;
  const grid = useMemo(() => deriveGrid(project), [project]);
  const barDur = barDurationSec(project);
  const redLineBar = barDur > 0 ? Math.ceil(REC_RED_LINE_SEC / barDur) : null;
  const totalDuration = projectDurationSec(project);

  // ---- 校准参数：本地持久化，并在连上 Bridge 后回推给服务端 ----
  useEffect(() => {
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
    } catch {
      /* ignore */
    }
  }, [options]);

  const syncedRef = useRef(false);
  useEffect(() => {
    if (!bridge.connected) {
      syncedRef.current = false;
      return;
    }
    if (syncedRef.current) return;
    syncedRef.current = true;
    bridge.send({ type: 'options:set', options });
  }, [bridge, options]);

  const patchOptions = useCallback(
    (patch: Partial<RuntimeOptions>) => {
      setOptions((prev) => ({ ...prev, ...patch }));
      bridge.send({ type: 'options:set', options: patch });
    },
    [bridge],
  );

  // ---- 乐谱同步给 Bridge（Guest 重连后能自动补全）----
  useEffect(() => {
    const timer = window.setTimeout(() => {
      bridge.send({ type: 'project:sync', project });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [bridge, project]);

  // ---- 提示条 ----
  useEffect(() => {
    if (!bridge.mix) return;
    const tone = bridge.mix.phase === 'error' ? 'rose' : bridge.mix.phase === 'done' ? 'cyan' : 'amber';
    setBanner({ tone, text: `自动出带 · ${bridge.mix.phase}${bridge.mix.message ? ` — ${bridge.mix.message}` : ''}` });
    const timer = window.setTimeout(() => setBanner(null), 5200);
    return () => window.clearTimeout(timer);
  }, [bridge.mix]);

  // ---- 网格操作 ----
  const paint = useCallback(
    (slot: number, bar: number) => {
      store.update((p) => setCellIcon(p, slot, bar, iconId), `涂色 S${slot}·Bar${bar}`);
    },
    [iconId, store],
  );

  const toggleMute = useCallback(
    (slot: number, bar: number) => {
      const cell = grid.rows[slot]?.[bar - 1];
      if (!cell) return;
      const muted = !cell.muted;
      store.update((p) => setCellMuted(p, slot, bar, muted), `${muted ? '静音' : '解除静音'} S${slot}·Bar${bar}`);
    },
    [grid, store],
  );

  const clearOne = useCallback(
    (slot: number, bar: number) => {
      store.update((p) => clearCell(p, slot, bar), `清空 S${slot}·Bar${bar}`);
    },
    [store],
  );

  const focusCell = useCallback((slot: number, bar: number) => {
    setSelection({ fromBar: bar, toBar: bar, slots: [slot] });
    setTab('inspect');
  }, []);

  const selectionCells = useCallback((): Array<{ slot: number; bar: number }> => {
    if (!selection) return [];
    const out: Array<{ slot: number; bar: number }> = [];
    for (const slot of selection.slots) {
      for (let bar = selection.fromBar; bar <= selection.toBar; bar += 1) out.push({ slot, bar });
    }
    return out;
  }, [selection]);

  const applyChop = useCallback(
    (preset: ChopPresetId) => {
      const cells = selectionCells();
      if (cells.length === 0) return;
      store.update((p) => cells.reduce((acc, cell) => setCellChops(acc, cell.slot, cell.bar, preset), p), `切分 ${preset}`);
    },
    [selectionCells, store],
  );

  const muteSelection = useCallback(
    (muted: boolean) => {
      const cells = selectionCells();
      if (cells.length === 0) return;
      store.update((p) => cells.reduce((acc, cell) => setCellMuted(acc, cell.slot, cell.bar, muted), p), muted ? '静音选区' : '解除静音选区');
    },
    [selectionCells, store],
  );

  const clearCells = useCallback(() => {
    const cells = selectionCells();
    if (cells.length === 0) return;
    store.update((p) => cells.reduce((acc, cell) => clearCell(acc, cell.slot, cell.bar), p), '清空选区');
  }, [selectionCells, store]);

  const doCopy = useCallback(() => {
    if (!selection) return;
    const pattern = copyRange(project, selection);
    setClip(pattern);
    setBanner({ tone: 'cyan', text: `已复制 ${pattern.bars} 小节 × ${pattern.slots} 槽位` });
  }, [project, selection]);

  const doPaste = useCallback(() => {
    if (!clip) return;
    const target = { bar: selection?.fromBar ?? playFrom, slot: selection?.slots[0] ?? 0 };
    store.update((p) => pasteAt(p, clip, target), `粘贴到 Bar ${target.bar}`);
  }, [clip, playFrom, selection, store]);

  // ---- 传输控制 ----
  const transport = useMemo(
    () => ({
      play: (startBar: number) => {
        bridge.send({ type: 'transport:play', project, startBar, options });
        setPlayFrom(startBar);
      },
      stop: () => bridge.send({ type: 'transport:stop' }),
      syncStage: (bar: number) => bridge.send({ type: 'stage:sync', project, bar }),
    }),
    [bridge, options, project],
  );

  const actions = useMemo(
    () => ({
      play: () => transport.play(playFrom),
      playFrom: () => transport.play(selection?.fromBar ?? playFrom),
      stop: () => transport.stop(),
      syncStage: () => transport.syncStage(selection?.fromBar ?? playFrom),
      clearStage: () => bridge.send({ type: 'stage:clear' }),
      mix: () => bridge.send({ type: 'mix:start', project, startBar: 1 }),
      abortMix: () => bridge.send({ type: 'mix:abort' }),
      record: (on: boolean) => bridge.send({ type: on ? 'record:start' : 'record:stop' }),
      copy: doCopy,
      paste: doPaste,
      undo: store.undo,
      redo: store.redo,
      importJson: async () => {
        const loaded = await pickProjectFile();
        if (!loaded) {
          setBanner({ tone: 'rose', text: '导入失败：不是合法的乐谱 JSON' });
          return;
        }
        store.replace(loaded);
        setBanner({ tone: 'cyan', text: `已导入「${loaded.title}」` });
      },
      exportJson: () => downloadProject(project),
      probe: () => bridge.send({ type: 'probe' }),
      insertBars: () => store.update((p) => insertBars(p, selection?.fromBar ?? playFrom, 1), '插入小节'),
      deleteBars: () => {
        if (!selection) return;
        store.update((p) => deleteBars(p, selection.fromBar, selection.toBar), '删除小节');
      },
    }),
    [bridge, doCopy, doPaste, playFrom, project, selection, store, transport],
  );

  // ---- 键盘快捷键 ----
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (meta && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        doCopy();
        return;
      }
      if (meta && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        doPaste();
        return;
      }
      if (event.code === 'Space') {
        event.preventDefault();
        if (bridge.tick?.playing) transport.stop();
        else transport.play(playFrom);
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!selection) return;
        event.preventDefault();
        clearCells();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bridge.tick?.playing, clearCells, doCopy, doPaste, playFrom, selection, store, transport]);

  const changeMeta = useCallback(
    (patch: { title?: string; versionId?: string; bpm?: number; beatsPerBar?: number; totalBars?: number }) => {
      store.update((p) => {
        const next: CompositionProject = { ...p };
        if (patch.title !== undefined) next.title = patch.title;
        if (patch.versionId !== undefined) {
          next.versionId = patch.versionId;
          const preset = versionPreset(patch.versionId);
          if (patch.bpm === undefined) next.bpm = preset.bpm;
          if (patch.beatsPerBar === undefined) next.beatsPerBar = preset.beatsPerBar;
        }
        if (patch.bpm !== undefined) next.bpm = Math.min(400, Math.max(20, Math.round(patch.bpm)));
        if (patch.beatsPerBar !== undefined) next.beatsPerBar = Math.min(32, Math.max(1, Math.round(patch.beatsPerBar)));
        if (patch.totalBars !== undefined) {
          next.totalBars = Math.max(1, Math.round(patch.totalBars));
          next.events = p.events.filter((e) => e.bar <= next.totalBars);
        }
        return next;
      }, '修改乐谱属性');
    },
    [store],
  );

  // ---- 一键切版本：把乐谱选定的版本同步到游戏里 ----
  const switchVersion = useCallback(() => {
    const match = /^V(\d+)/.exec(project.versionId);
    if (!match) {
      setBanner({ tone: 'amber', text: '当前选的是「模拟器测试曲目」，游戏里没有对应版本' });
      return;
    }
    bridge.send({ type: 'version:select', versionId: project.versionId, versionIndex: Number(match[1]) - 1 });
  }, [bridge, project.versionId]);

  // 切版本成功后自动重新探测，回填真实的循环长度（用 ref 去重，避免 probe→state→probe 循环）
  const lastVersionPhase = useRef<string | null>(null);
  useEffect(() => {
    const phase = bridge.version?.phase ?? null;
    if (phase === lastVersionPhase.current) return;
    lastVersionPhase.current = phase;
    if (phase === 'ready') bridge.send({ type: 'probe' });
    if (phase === 'error') {
      setBanner({ tone: 'rose', text: `切换版本失败：${bridge.version?.message ?? '未知原因'}` });
    }
  }, [bridge.version, bridge.send]);

  const clearAllProject = useCallback(() => {
    store.replace(setTotalBars({ ...project, events: [] }, project.totalBars));
    setBanner({ tone: 'amber', text: '已清空整谱（可用撤销恢复）' });
  }, [project, store]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar bridge={bridge} store={store} onChangeMeta={changeMeta} onSwitchVersion={switchVersion} />
      <TransportBar
        store={store}
        bridge={bridge}
        selection={selection}
        clip={clip ? { bars: clip.bars } : null}
        playFrom={playFrom}
        options={options}
        onOptions={patchOptions}
        actions={actions}
      />

      {banner && (
        <div className="flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/70 px-3 py-1.5 text-[11px]">
          <span className="flex items-center gap-2">
            <Badge tone={banner.tone}>{banner.tone === 'rose' ? '错误' : banner.tone === 'amber' ? '进行中' : '提示'}</Badge>
            <span className="text-slate-300">{banner.text}</span>
          </span>
          <Button variant="ghost" onClick={() => setBanner(null)}>
            关闭
          </Button>
        </div>
      )}

      {!bridge.connected && (
        <div className="border-b border-amber-900/60 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300">
          Bridge 未连接：请先运行 <code className="rounded bg-slate-900 px-1">npm run dev</code> 或{' '}
          <code className="rounded bg-slate-900 px-1">npm run sim</code>。当前编辑的乐谱会保存在本地，不会丢失。
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-2.5 p-2.5">
        <div className="flex w-[236px] shrink-0 flex-col gap-2.5 overflow-y-auto pr-0.5">
          <Palette selectedIcon={iconId} onPick={setIconId} />
          <SlotLegend grid={grid} />
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-2.5 py-2 text-[10px] leading-relaxed text-slate-500">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-slate-400">整曲时长</span>
              <span className={totalDuration > REC_RED_LINE_SEC ? 'text-rose-400' : 'text-slate-300'}>
                {formatDuration(totalDuration)}
              </span>
            </div>
            <div>
              录制红线 {formatDuration(REC_RED_LINE_SEC)}
              {redLineBar !== null && redLineBar <= project.totalBars
                ? `（第 ${redLineBar} 小节，网格已标注）`
                : '（本曲未触及）'}
            </div>
          </div>
        </div>

        <section className="flex min-w-0 flex-1 flex-col gap-2.5">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40">
            <Grid
              grid={grid}
              selection={selection}
              tick={bridge.tick}
              beatsPerBar={project.beatsPerBar}
              totalBars={project.totalBars}
              redLineBar={redLineBar}
              playFrom={playFrom}
              onPaint={paint}
              onMute={toggleMute}
              onClearCell={clearOne}
              onSelect={setSelection}
              onPlayFrom={setPlayFrom}
              onChopEdit={focusCell}
            />
          </div>
          <StatusBar bridge={bridge} store={store} />
        </section>

        <SidePanel tab={tab} onTab={setTab}>
          {tab === 'inspect' && (
            <Inspector
              grid={grid}
              selection={selection}
              project={project}
              clipBars={clip?.bars ?? null}
              onChop={applyChop}
              onMuteSelection={muteSelection}
              onClearSelection={() => setSelection(null)}
              onCopy={doCopy}
              onPaste={doPaste}
              onClearCells={clearCells}
            />
          )}
          {tab === 'settings' && (
            <Settings
              options={options}
              onOptions={patchOptions}
              guest={bridge.guest}
              onProbe={() => bridge.send({ type: 'probe' })}
            />
          )}
          {tab === 'log' && <LogPanel logs={bridge.logs} />}
          {tab === 'probe' && <ProbePanel report={bridge.probe} onRefresh={() => bridge.send({ type: 'probe' })} />}
        </SidePanel>
      </div>

      <div className="flex items-center justify-between border-t border-slate-800 px-3 py-1 text-[10px] text-slate-600">
        <span>
          空格播放/停止 · Ctrl+Z 撤销 · Ctrl+C/V 复制粘贴 · Del 清空选区 · 双击格子清空 · 右键格子聚焦切分
        </span>
        <span className="flex items-center gap-2">
          <button type="button" className="hover:text-slate-400" onClick={clearAllProject}>
            清空整谱
          </button>
          <span>·</span>
          <a className="hover:text-slate-400" href="/sim/" target="_blank" rel="noreferrer">
            打开模拟器
          </a>
        </span>
      </div>
    </div>
  );
}
