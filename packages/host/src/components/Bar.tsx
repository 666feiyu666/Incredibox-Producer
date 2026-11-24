import {
  REC_RED_LINE_SEC,
  barDurationSec,
  projectDurationSec,
  VERSION_PRESETS,
  type PlaybackState,
  type RuntimeOptions,
} from '@ic/shared';
import { Badge, Button, Dot, Field, NumberInput, Select, TextInput, cx } from './ui.tsx';
import type { BridgeState } from '../app/useBridge.ts';
import type { ProjectStore } from '../app/useProject.ts';
import type { Selection } from './Grid.tsx';

export function TopBar({
  bridge,
  store,
  onChangeMeta,
  onSwitchVersion,
}: {
  bridge: BridgeState;
  store: ProjectStore;
  onChangeMeta: (patch: { title?: string; versionId?: string; bpm?: number; beatsPerBar?: number; totalBars?: number }) => void;
  onSwitchVersion: () => void;
}) {
  const { project } = store;
  const guest = bridge.guest;
  const duration = projectDurationSec(project);
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-800 bg-slate-950/80 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-cyan-400 to-fuchsia-500 text-[13px] font-black text-slate-950">
          IB
        </span>
        <div className="leading-tight">
          <div className="text-[11px] font-semibold tracking-[0.16em] text-cyan-300">INCREDIBOX COMPOSER</div>
          <div className="text-[10px] text-slate-500">CDP 自动化作曲工作台</div>
        </div>
      </div>

      <TextInput
        value={project.title}
        onChange={(e) => onChangeMeta({ title: e.target.value })}
        className="w-56"
        placeholder="乐谱名称"
      />

      <div className="flex items-center gap-2 text-[11px] text-slate-400">
        <Select value={project.versionId} onChange={(e) => onChangeMeta({ versionId: e.target.value })}>
          {VERSION_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </Select>
        <VersionSwitchButton bridge={bridge} versionId={project.versionId} onSwitch={onSwitchVersion} />
        <label className="flex items-center gap-1">
          BPM
          <NumberInput
            value={project.bpm}
            min={20}
            max={400}
            step={1}
            onChange={(e) => onChangeMeta({ bpm: Number(e.target.value) })}
          />
        </label>
        <label className="flex items-center gap-1">
          拍/小节
          <NumberInput
            value={project.beatsPerBar}
            min={1}
            max={32}
            step={1}
            onChange={(e) => onChangeMeta({ beatsPerBar: Number(e.target.value) })}
          />
        </label>
        <label className="flex items-center gap-1">
          小节数
          <NumberInput
            value={project.totalBars}
            min={1}
            max={512}
            step={1}
            onChange={(e) => onChangeMeta({ totalBars: Number(e.target.value) })}
          />
        </label>
      </div>

      <div className="ml-auto flex items-center gap-3 text-[11px]">
        <span className="flex items-center gap-1.5 text-slate-400">
          <Dot tone={bridge.connected ? 'ok' : 'bad'} />
          Bridge
        </span>
        <span className="flex items-center gap-1.5 text-slate-400">
          <Dot tone={bridge.cdpConnected ? 'ok' : 'warn'} />
          CDP
        </span>
        <span className="flex items-center gap-1.5 text-slate-400">
          <Dot tone={guest ? 'ok' : 'idle'} />
          游戏
        </span>
        {guest && (
          <span className="flex items-center gap-1">
            <Badge tone="cyan">{guest.adapterKind}</Badge>
            <Badge tone={guest.clockSource === 'hook' ? 'cyan' : guest.clockSource === 'none' ? 'rose' : 'amber'}>
              {guest.clockSource}
            </Badge>
            <Badge tone="slate">{guest.loopDuration ? `${guest.loopDuration.toFixed(2)}s` : '无循环'}</Badge>
          </span>
        )}
        <Badge tone={duration > REC_RED_LINE_SEC ? 'rose' : 'slate'}>
          时长 {formatDuration(duration)}
        </Badge>
      </div>
    </header>
  );
}

export function TransportBar({
  store,
  bridge,
  selection,
  clip,
  playFrom,
  options,
  onOptions,
  actions,
}: {
  store: ProjectStore;
  bridge: BridgeState;
  selection: Selection | null;
  clip: { bars: number } | null;
  playFrom: number;
  options: RuntimeOptions;
  onOptions: (patch: Partial<RuntimeOptions>) => void;
  actions: {
    play: () => void;
    playFrom: () => void;
    stop: () => void;
    syncStage: () => void;
    clearStage: () => void;
    mix: () => void;
    abortMix: () => void;
    record: (on: boolean) => void;
    copy: () => void;
    paste: () => void;
    undo: () => void;
    redo: () => void;
    importJson: () => void;
    exportJson: () => void;
    probe: () => void;
    insertBars: () => void;
    deleteBars: () => void;
  };
}) {
  const playing = bridge.tick?.playing ?? false;
  const recording = bridge.tick?.recording ?? false;
  const kind = bridge.tick?.mode ?? 'idle';
  const disabled = !bridge.guest;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900/50 px-3 py-2">
      <Button variant="primary" onClick={actions.play} disabled={disabled || playing}>
        ▶ 从 {playFrom} 小节播放
      </Button>
      <Button onClick={actions.playFrom} disabled={disabled || playing}>
        ⏵ 跳转试听（{Math.min(selection?.fromBar ?? playFrom, store.project.totalBars)}）
      </Button>
      <Button variant={playing ? 'danger' : 'default'} onClick={actions.stop} disabled={!playing}>
        ⏹ 停止
      </Button>
      <Button
        variant="active"
        onClick={actions.mix}
        disabled={disabled || kind === 'mix' || playing}
        title="清空舞台 → 按边界触发 REC → 零误差执行整首 → 自动停止录制"
      >
        ⏺ 一键自动出带
      </Button>
      <Button onClick={() => actions.record(true)} disabled={disabled || recording}>
        手动 REC 开
      </Button>
      <Button onClick={() => actions.record(false)} disabled={!recording}>
        手动 REC 停
      </Button>

      <Separator />

      <Button onClick={actions.syncStage} disabled={disabled} title="按当前小节推演结果强制重刷舞台">
        ⇄ 同步舞台
      </Button>
      <Button onClick={actions.clearStage} disabled={disabled}>
        ⌫ 清空舞台
      </Button>

      <Separator />

      <Button onClick={actions.undo} disabled={!store.canUndo} title={`撤销：${store.lastLabel ?? ''}`}>
        ↶ 撤销
      </Button>
      <Button onClick={actions.redo} disabled={!store.canRedo}>
        ↷ 重做
      </Button>
      <Button onClick={actions.copy} disabled={!selection}>
        ⧉ 复制{selection ? ` ${selection.toBar - selection.fromBar + 1} 小节` : ''}
      </Button>
      <Button onClick={actions.paste} disabled={!clip}>
        ⧷ 粘贴{clip ? `（${clip.bars}）` : ''}
      </Button>
      <Button onClick={actions.insertBars}>＋插入小节</Button>
      <Button onClick={actions.deleteBars} disabled={!selection}>
        －删除小节
      </Button>

      <Separator />

      <Button onClick={actions.importJson}>⇩ 导入</Button>
      <Button onClick={actions.exportJson}>⇧ 导出</Button>
      <Button onClick={actions.probe} disabled={disabled}>
        ◎ 探测游戏
      </Button>

      <div className="ml-auto flex items-center gap-2">
        <span className={cx('text-[10px]', kind === 'arming' ? 'text-amber-400' : 'text-slate-500')}>
          {kind === 'arming' ? '等待循环边界…' : `mode: ${kind}`}
        </span>
        <Field label={`校准 ${options.offsetMs > 0 ? '+' : ''}${options.offsetMs}ms`}>
          <input
            type="range"
            min={-50}
            max={50}
            step={1}
            value={options.offsetMs}
            onChange={(e) => onOptions({ offsetMs: Number(e.target.value) })}
            className="w-36 accent-cyan-400"
          />
        </Field>
      </div>
    </div>
  );
}

function Separator() {
  return <span className="mx-0.5 h-5 w-px bg-slate-800" />;
}

export function StatusBar({ bridge, store }: { bridge: BridgeState; store: ProjectStore }) {
  const tick: PlaybackState | null = bridge.tick;
  const barDur = barDurationSec(store.project);
  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-1.5 text-[10.5px] text-slate-500">
      <span>
        小节 <b className="text-slate-200">{tick?.bar ?? '-'}</b> /{' '}
        {tick && tick.playing ? tick.totalBars : store.project.totalBars}
      </span>
      <span>
        拍 <b className="text-slate-200">{tick ? tick.beat.toFixed(2) : '-'}</b>
      </span>
      <span>单小节 {barDur.toFixed(3)}s</span>
      <span>指令 {tick?.firedCues ?? 0} 条</span>
      <span className={cx((tick?.lateCues ?? 0) > 0 && 'text-amber-400')}>迟到 {tick?.lateCues ?? 0}</span>
      <span>游戏发声 {tick?.gamePlaying ? '是' : '否'}</span>
      <span className="ml-auto">
        {bridge.guest
          ? `agent ${bridge.guest.agentVersion} · hash ${bridge.guest.bundleHash}`
          : '等待 Guest 注入…'}
      </span>
      {store.lastLabel && <span className="text-slate-600">最近操作：{store.lastLabel}</span>}
    </footer>
  );
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 一键把游戏切到当前乐谱选定的版本（Bridge 会点游戏里的版本图标并进入 mix） */
function VersionSwitchButton({
  bridge,
  versionId,
  onSwitch,
}: {
  bridge: BridgeState;
  versionId: string;
  onSwitch: () => void;
}) {
  const match = /^V(\d+)/.exec(versionId);
  const supported = Boolean(match);
  const state = bridge.version;
  const busy = state?.phase === 'selecting' || state?.phase === 'opening' || state?.phase === 'loading';
  const label = (() => {
    if (!state) return '⇄ 切到游戏';
    switch (state.phase) {
      case 'selecting':
        return '点版本图标…';
      case 'opening':
        return '封面加载…';
      case 'loading':
        return '进入 mix…';
      case 'ready':
        return `✓ ${state.detected ?? '已切换'}`;
      default:
        return '✗ 切换失败';
    }
  })();
  return (
    <span className="flex items-center gap-1">
      <Button
        onClick={onSwitch}
        disabled={!bridge.guest || !supported || busy}
        title={
          supported
            ? `让游戏切换到 ${versionId}（会点版本图标 → 封面 → 播放，约 10 秒）`
            : '这个版本不在游戏可选列表里（例如模拟器测试曲目）'
        }
        variant={state?.phase === 'ready' ? 'active' : 'default'}
      >
        {label}
      </Button>
      {state?.phase === 'error' && state.message && (
        <span className="max-w-40 truncate text-[10px] text-rose-400" title={state.message}>
          {state.message}
        </span>
      )}
    </span>
  );
}
