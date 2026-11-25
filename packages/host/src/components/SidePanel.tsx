import { useMemo } from 'react';
import {
  CHOP_PRESETS,
  iconName,
  type ChopPresetId,
  type CompositionProject,
  type GridView,
  type LogEntry,
  type ProbeReport,
  type RuntimeOptions,
  type GuestInfo,
} from '@ic/shared';
import type { Selection } from './Grid.tsx';
import { Badge, Button, Field, NumberInput, Panel, Select, TextInput, cx } from './ui.tsx';

export type SideTab = 'inspect' | 'settings' | 'log' | 'probe';

const TABS: Array<{ id: SideTab; label: string }> = [
  { id: 'inspect', label: '检视' },
  { id: 'settings', label: '校准' },
  { id: 'log', label: '日志' },
  { id: 'probe', label: '探测' },
];

export function SidePanel({
  tab,
  onTab,
  children,
}: {
  tab: SideTab;
  onTab: (tab: SideTab) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 w-[340px] shrink-0 flex-col gap-2">
      <div className="flex gap-1 rounded-xl border border-slate-800 bg-slate-900/60 p-1">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onTab(item.id)}
            className={cx(
              'flex-1 rounded-lg px-2 py-1.5 text-[11px] transition-colors',
              tab === item.id ? 'bg-cyan-500/15 text-cyan-200' : 'text-slate-500 hover:text-slate-300',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

export function Inspector({
  grid,
  selection,
  project,
  clipBars,
  onChop,
  onMuteSelection,
  onClearSelection,
  onCopy,
  onPaste,
  onClearCells,
}: {
  grid: GridView;
  selection: Selection | null;
  project: CompositionProject;
  clipBars: number | null;
  onChop: (preset: ChopPresetId) => void;
  onMuteSelection: (muted: boolean) => void;
  onClearSelection: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onClearCells: () => void;
}) {
  const cells = useMemo(() => {
    if (!selection) return [];
    const out: GridView['rows'][number] = [];
    for (const slot of selection.slots) {
      const row = grid.rows[slot];
      if (!row) continue;
      for (let bar = selection.fromBar; bar <= selection.toBar; bar += 1) {
        const cell = row[bar - 1];
        if (cell) out.push(cell);
      }
    }
    return out;
  }, [grid, selection]);

  const events = useMemo(() => {
    if (!selection) return [];
    return project.events
      .filter(
        (e) =>
          e.bar >= selection.fromBar &&
          e.bar <= selection.toBar &&
          selection.slots.includes(e.slotIndex),
      )
      .slice(0, 40);
  }, [project.events, selection]);

  return (
    <Panel
      title="选区检视"
      bodyClassName="overflow-auto p-3"
      actions={
        <span className="text-[10px] text-slate-500">
          {selection ? `第 ${selection.fromBar}–${selection.toBar} 小节 · ${selection.slots.length} 槽` : '未选中'}
        </span>
      }
    >
      <div className="space-y-3">
        <div>
          <div className="mb-1.5 text-[10px] uppercase tracking-[0.16em] text-slate-600">拍内切分</div>
          <div className="grid grid-cols-3 gap-1.5">
            {CHOP_PRESETS.map((preset) => (
              <Button key={preset.id} onClick={() => onChop(preset.id)} disabled={!selection} title={preset.hint}>
                {preset.label}
              </Button>
            ))}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
            切分写入 beat &gt; 1 的 MUTE/UNMUTE 事件，用于拍内切分与骤停；对选区内所有格子生效。
          </p>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <Button onClick={() => onMuteSelection(true)} disabled={!selection}>静音选区</Button>
          <Button onClick={() => onMuteSelection(false)} disabled={!selection}>解除静音</Button>
          <Button onClick={onCopy} disabled={!selection}>复制片段</Button>
          <Button onClick={onPaste} disabled={clipBars === null}>粘贴片段{clipBars ? `（${clipBars}）` : ''}</Button>
          <Button onClick={onClearCells} disabled={!selection}>清空选中格</Button>
          <Button onClick={onClearSelection} disabled={!selection}>取消选择</Button>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-slate-600">
            <span>选区格子</span>
            <span>{cells.length} 格</span>
          </div>
          <div className="max-h-40 space-y-1 overflow-auto">
            {cells.slice(0, 60).map((cell) => (
              <div
                key={`${cell.slotIndex}-${cell.bar}`}
                className="flex items-center justify-between rounded border border-slate-800 bg-slate-950/50 px-2 py-1 text-[10.5px]"
              >
                <span className="text-slate-500">S{cell.slotIndex} · Bar {cell.bar}</span>
                <span className="flex items-center gap-1">
                  <span className="text-slate-300">{iconName(cell.iconId)}</span>
                  {cell.muted && <Badge tone="rose">muted</Badge>}
                  {cell.chops.length > 0 && <Badge tone="amber">{cell.chops.length} 切分</Badge>}
                </span>
              </div>
            ))}
            {cells.length === 0 && <div className="text-[10.5px] text-slate-600">在网格上点选格子</div>}
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-[10px] uppercase tracking-[0.16em] text-slate-600">选区事件</div>
          <div className="max-h-44 space-y-0.5 overflow-auto font-mono text-[10px] text-slate-500">
            {events.map((event) => (
              <div key={event.id} className="flex justify-between">
                <span>
                  Bar {event.bar} · Beat {event.beat} · S{event.slotIndex}
                </span>
                <span className={event.action === 'EQUIP' ? 'text-cyan-400' : event.action === 'MUTE' ? 'text-rose-400' : 'text-slate-400'}>
                  {event.action}
                  {event.iconId !== undefined ? ` #${event.iconId}` : ''}
                </span>
              </div>
            ))}
            {events.length === 0 && <div className="text-slate-600">无事件</div>}
          </div>
        </div>
      </div>
    </Panel>
  );
}

export function Settings({
  options,
  onOptions,
  guest,
  onProbe,
}: {
  options: RuntimeOptions;
  onOptions: (patch: Partial<RuntimeOptions>) => void;
  guest: GuestInfo | null;
  onProbe: () => void;
}) {
  return (
    <Panel title="校准与运行时" bodyClassName="overflow-auto p-3">
      <div className="space-y-1">
        <Field label="全局偏移" hint="−50 ~ +50ms">
          <span className="flex items-center gap-2">
            <input
              type="range"
              min={-50}
              max={50}
              value={options.offsetMs}
              onChange={(e) => onOptions({ offsetMs: Number(e.target.value) })}
              className="w-28 accent-cyan-400"
            />
            <span className="w-12 text-right text-[11px] text-slate-300">{options.offsetMs}ms</span>
          </span>
        </Field>
        <Field label="换装提前量" hint="拍">
          <NumberInput
            value={options.equipLeadBeats}
            min={0}
            max={4}
            step={0.25}
            onChange={(e) => onOptions({ equipLeadBeats: Number(e.target.value) })}
          />
        </Field>
        <Field label="前瞻窗口" hint="ms">
          <NumberInput
            value={options.lookaheadMs}
            min={10}
            max={300}
            step={5}
            onChange={(e) => onOptions({ lookaheadMs: Number(e.target.value) })}
          />
        </Field>
        <Field label="调度轮询" hint="ms">
          <NumberInput
            value={options.tickMs}
            min={4}
            max={100}
            step={1}
            onChange={(e) => onOptions({ tickMs: Number(e.target.value) })}
          />
        </Field>
        <Field label="适配层">
          <Select
            value={options.adapterMode}
            onChange={(e) => onOptions({ adapterMode: e.target.value as RuntimeOptions['adapterMode'] })}
          >
            <option value="auto">auto（自动）</option>
            <option value="sim">sim（模拟器）</option>
            <option value="api">api（游戏高层 API）</option>
            <option value="dom">dom（纯 DOM 拖拽）</option>
          </Select>
        </Field>
        <Field label="自动接 bonus" hint="按钮跳起时自动点">
          <label className="flex items-center gap-1.5 text-[11px] text-slate-300">
            <input
              type="checkbox"
              checked={options.autoBonus}
              onChange={(e) => onOptions({ autoBonus: e.target.checked })}
              className="accent-cyan-400"
            />
            {options.autoBonus ? '开（动画期间会吞输入）' : '关'}
          </label>
        </Field>
        <Field label="循环时长覆盖" hint="秒，0=自动">
          <NumberInput
            value={options.loopOverrideSec ?? 0}
            min={0}
            max={60}
            step={0.05}
            onChange={(e) => {
              const value = Number(e.target.value);
              onOptions({ loopOverrideSec: value > 0 ? value : null });
            }}
          />
        </Field>
      </div>

      <div className="mt-3 border-t border-slate-800 pt-2">
        <div className="mb-1.5 text-[10px] uppercase tracking-[0.16em] text-slate-600">DOM 选择器画像</div>
        <div className="space-y-1">
          <Field label="槽位">
            <TextInput
              value={options.domProfile?.slotSelector ?? ''}
              placeholder="[data-slot]"
              onChange={(e) =>
                onOptions({ domProfile: { ...(options.domProfile ?? {}), slotSelector: e.target.value || undefined } })
              }
              className="w-40"
            />
          </Field>
          <Field label="音色">
            <TextInput
              value={options.domProfile?.iconSelector ?? ''}
              placeholder="[data-icon]"
              onChange={(e) =>
                onOptions({ domProfile: { ...(options.domProfile ?? {}), iconSelector: e.target.value || undefined } })
              }
              className="w-40"
            />
          </Field>
          <Field label="REC">
            <TextInput
              value={options.domProfile?.recordSelector ?? ''}
              placeholder=".rec"
              onChange={(e) =>
                onOptions({ domProfile: { ...(options.domProfile ?? {}), recordSelector: e.target.value || undefined } })
              }
              className="w-40"
            />
          </Field>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-slate-800 pt-2 text-[10.5px] text-slate-500">
        <span>
          {guest
            ? `${guest.adapterKind} · ${guest.clockSource} · ${guest.loopDuration.toFixed(2)}s`
            : 'Guest 离线'}
        </span>
        <Button onClick={onProbe}>重新探测</Button>
      </div>
    </Panel>
  );
}

export function LogPanel({ logs }: { logs: LogEntry[] }) {
  return (
    <Panel title="运行日志" bodyClassName="overflow-auto p-2 font-mono text-[10px]" actions={<span className="text-[10px] text-slate-600">{logs.length}</span>}>
      <div className="space-y-0.5">
        {logs.map((entry) => (
          <div key={entry.id} className="flex gap-1.5">
            <span className="shrink-0 text-slate-700">{new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span>
            <span
              className={cx(
                'shrink-0',
                entry.source === 'guest' ? 'text-fuchsia-400/80' : 'text-slate-600',
              )}
            >
              {entry.source}
            </span>
            <span
              className={cx(
                'break-all',
                entry.level === 'error'
                  ? 'text-rose-400'
                  : entry.level === 'warn'
                    ? 'text-amber-400'
                    : entry.level === 'success'
                      ? 'text-emerald-400'
                      : 'text-slate-400',
              )}
            >
              {entry.message}
            </span>
          </div>
        ))}
        {logs.length === 0 && <div className="text-slate-600">暂无日志</div>}
      </div>
    </Panel>
  );
}

export function ProbePanel({ report, onRefresh }: { report: ProbeReport | null; onRefresh: () => void }) {
  return (
    <Panel
      title="游戏内探测"
      bodyClassName="overflow-auto p-2 text-[10.5px]"
      actions={<Button onClick={onRefresh}>探测</Button>}
    >
      {!report ? (
        <div className="text-slate-600">点「探测」读取游戏结构（槽位 / 图标 / 循环候选 / 全局对象），用于真实游戏适配时定位选择器。</div>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-1">
            <Badge tone="cyan">{report.adapterKind}</Badge>
            <Badge tone="slate">{report.clockSource}</Badge>
            <Badge tone="slate">ctx × {report.audioContexts}</Badge>
            <Badge tone={report.loopDuration > 0 ? 'cyan' : 'rose'}>loop {report.loopDuration}s</Badge>
          </div>
          <div>
            <div className="mb-1 text-slate-600">槽位 {report.slots.length}/7 · 图标 {report.icons.length}/20</div>
            <div className="max-h-28 space-y-0.5 overflow-auto font-mono text-[9.5px] text-slate-500">
              {report.slots.map((slot) => (
                <div key={`s${slot.index}`} className="truncate">S{slot.index}: {slot.selector}</div>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-slate-600">循环候选</div>
            <div className="space-y-0.5 font-mono text-[9.5px] text-slate-500">
              {report.loopCandidates.map((candidate, index) => (
                <div key={index}>
                  {candidate.duration}s · {candidate.playing ? 'playing' : 'idle'} · age {candidate.ageSec}s
                </div>
              ))}
              {report.loopCandidates.length === 0 && <div className="text-rose-400/80">未捕获 loop source</div>}
            </div>
          </div>
          <div>
            <div className="mb-1 text-slate-600">全局对象</div>
            <div className="max-h-24 overflow-auto font-mono text-[9.5px] text-slate-500">
              {report.globals.map((global) => (
                <div key={global.name}>
                  {global.name}: {global.type}
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-slate-600">备注</div>
            <ul className="list-disc pl-4 text-[10px] leading-relaxed text-slate-500">
              {report.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          </div>
          {report.recordButton && <div className="text-slate-500">REC: {report.recordButton}</div>}
        </div>
      )}
    </Panel>
  );
}
