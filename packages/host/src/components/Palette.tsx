import { ICONS, type GridView, iconMeta, iconName, SLOT_COUNT } from '@ic/shared';
import { Badge, Button, Panel } from './ui.tsx';

export function Palette({
  selectedIcon,
  onPick,
}: {
  selectedIcon: number;
  onPick: (iconId: number) => void;
}) {
  const groups = ['beats', 'effects', 'melodies', 'voices'] as const;
  const labels: Record<(typeof groups)[number], string> = {
    beats: 'Beats',
    effects: 'Effects',
    melodies: 'Melodies',
    voices: 'Voices',
  };
  return (
    <Panel title="音色调色板" bodyClassName="p-2.5">
      <div className="space-y-2">
        {groups.map((group) => (
          <div key={group}>
            <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-slate-600">{labels[group]}</div>
            <div className="grid grid-cols-5 gap-1.5">
              {ICONS.filter((icon) => icon.group === group).map((icon) => {
                const active = selectedIcon === icon.id;
                return (
                  <button
                    key={icon.id}
                    type="button"
                    title={`${icon.name} · #${icon.id}`}
                    onClick={() => onPick(icon.id)}
                    className={[
                      'flex flex-col items-center gap-1 rounded-lg border px-1 py-1.5 transition-all',
                      active
                        ? 'border-cyan-400 bg-cyan-500/15 shadow-[0_0_0_1px_rgba(34,211,238,0.35)]'
                        : 'border-slate-800 bg-slate-950/60 hover:border-slate-600',
                    ].join(' ')}
                  >
                    <span className="h-3 w-full rounded-sm" style={{ background: icon.color }} />
                    <span className="w-full truncate text-[9.5px] leading-tight text-slate-400">{icon.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/50 px-2 py-1.5">
        <span className="text-[10px] text-slate-500">当前画笔</span>
        <span className="flex items-center gap-1.5 text-[11px] text-slate-200">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: iconMeta(selectedIcon)?.color }} />
          {iconName(selectedIcon)}
        </span>
      </div>
    </Panel>
  );
}

export function SlotLegend({ grid }: { grid: GridView }) {
  return (
    <Panel title="槽位 / 当前状态" bodyClassName="p-2.5">
      <div className="space-y-1">
        {Array.from({ length: SLOT_COUNT }, (_, slot) => {
          const row = grid.rows[slot] ?? [];
          const filled = row.filter((cell) => cell.iconId !== null).length;
          const last = row[row.length - 1];
          return (
            <div key={slot} className="flex items-center gap-2 rounded-md bg-slate-950/40 px-2 py-1">
              <span className="w-4 text-[10px] text-slate-500">S{slot}</span>
              <span className="flex-1 truncate text-[11px] text-slate-300">{iconName(last?.iconId ?? null)}</span>
              <Badge tone={filled > 0 ? 'cyan' : 'slate'}>{filled} 小节</Badge>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export function LegendHint({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2 text-[11px] text-slate-500">
      <span>
        单击 / 拖拽涂色 · <kbd className="rounded bg-slate-800 px-1">Alt+单击</kbd> 静音 ·{' '}
        <kbd className="rounded bg-slate-800 px-1">Shift+单击</kbd> 框选 · 双击清空该格
      </span>
      <Button variant="ghost" onClick={onClear}>
        清空整谱
      </Button>
    </div>
  );
}
