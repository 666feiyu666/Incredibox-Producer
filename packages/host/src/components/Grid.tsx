import { useCallback, useEffect, useRef } from 'react';
import { iconMeta, iconName, SLOT_COUNT, type GridCell, type GridView, type PlaybackState } from '@ic/shared';
import { cx } from './ui.tsx';

export interface Selection {
  fromBar: number;
  toBar: number;
  slots: number[];
}

const ROW_HEADER = 136;
const COL_W = 46;
const ROW_H = 42;

export interface GridProps {
  grid: GridView;
  selection: Selection | null;
  tick: PlaybackState | null;
  beatsPerBar: number;
  totalBars: number;
  redLineBar: number | null;
  playFrom: number;
  onPaint: (slot: number, bar: number) => void;
  onMute: (slot: number, bar: number) => void;
  onClearCell: (slot: number, bar: number) => void;
  onSelect: (selection: Selection | null) => void;
  onPlayFrom: (bar: number) => void;
  onChopEdit: (slot: number, bar: number) => void;
}

export function Grid(props: GridProps) {
  const { grid, selection, tick, beatsPerBar, totalBars, redLineBar, playFrom } = props;
  const painting = useRef(false);
  const anchor = useRef<{ bar: number; slot: number } | null>(null);

  useEffect(() => {
    const stop = () => {
      painting.current = false;
    };
    window.addEventListener('mouseup', stop);
    return () => window.removeEventListener('mouseup', stop);
  }, []);

  const inSelection = useCallback(
    (slot: number, bar: number) => {
      if (!selection) return false;
      return bar >= selection.fromBar && bar <= selection.toBar && selection.slots.includes(slot);
    },
    [selection],
  );

  const handleCellDown = (slot: number, bar: number, event: React.MouseEvent) => {
    if (event.button !== 0) return;
    if (event.altKey) {
      props.onMute(slot, bar);
      return;
    }
    if (event.shiftKey) {
      anchor.current = anchor.current ?? { bar, slot };
      const from = Math.min(anchor.current.bar, bar);
      const to = Math.max(anchor.current.bar, bar);
      props.onSelect({ fromBar: from, toBar: to, slots: grid.rows.map((_, i) => i) });
      return;
    }
    anchor.current = { bar, slot };
    props.onSelect({ fromBar: bar, toBar: bar, slots: [slot] });
    props.onPaint(slot, bar);
    painting.current = true;
  };

  const handleCellEnter = (slot: number, bar: number, event: React.MouseEvent) => {
    if (event.buttons === 1 && event.shiftKey) {
      const from = anchor.current ? Math.min(anchor.current.bar, bar) : bar;
      const to = anchor.current ? Math.max(anchor.current.bar, bar) : bar;
      props.onSelect({ fromBar: from, toBar: to, slots: grid.rows.map((_, i) => i) });
      return;
    }
    if (!painting.current) return;
    props.onPaint(slot, bar);
  };

  const playingBar = tick && tick.playing ? tick.bar : null;
  const progress = tick && tick.playing ? tick.progress : 0;
  const playheadLeft = ROW_HEADER + (((playingBar ?? 0) - 1 + progress) * COL_W);

  return (
    <div className="relative h-full overflow-auto grid-scroll">
      <div className="relative" style={{ width: ROW_HEADER + totalBars * COL_W }}>
        {/* 标尺 */}
        <div className="sticky top-0 z-20 flex" style={{ height: 34 }}>
          <div
            className="sticky left-0 z-30 flex items-center gap-1 border-b border-r border-slate-800 bg-slate-950/95 px-2 backdrop-blur"
            style={{ width: ROW_HEADER }}
          >
            <span className="text-[10px] uppercase tracking-[0.16em] text-slate-500">bar</span>
            <span className="text-[10px] text-slate-600">/ 拍</span>
          </div>
          {Array.from({ length: totalBars }, (_, i) => {
            const bar = i + 1;
            const isBeat = bar % 4 === 1;
            const isPlayFrom = bar === playFrom;
            const isPlaying = playingBar === bar;
            return (
              <button
                key={bar}
                type="button"
                onClick={() => props.onPlayFrom(bar)}
                title={`从第 ${bar} 小节开始`}
                style={{ width: COL_W }}
                className={cx(
                  'relative flex shrink-0 items-center justify-center border-b border-slate-800 text-[10px] transition-colors',
                  isBeat ? 'border-l border-l-slate-700 text-slate-400' : 'text-slate-600',
                  isPlayFrom && 'bg-cyan-500/15 text-cyan-300',
                  isPlaying && 'bg-cyan-500/25 text-cyan-100',
                )}
              >
                {bar}
                {redLineBar === bar && (
                  <span className="absolute inset-y-0 right-0 w-px bg-rose-500" title="3 分钟录制上限" />
                )}
              </button>
            );
          })}
        </div>

        {/* 7 行槽位 */}
        {grid.rows.map((row, slot) => {
          const activeBar = playFrom;
          const state = row[Math.min(row.length - 1, Math.max(0, activeBar - 1))];
          return (
            <div key={slot} className="flex" style={{ height: ROW_H }}>
              <div
                className="sticky left-0 z-10 flex items-center gap-2 border-b border-r border-slate-800 bg-slate-950/95 px-2 backdrop-blur"
                style={{ width: ROW_HEADER }}
              >
                <span className="grid h-5 w-5 place-items-center rounded bg-slate-800 text-[10px] text-slate-400">
                  {slot}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[11px] text-slate-300">{iconName(state?.iconId ?? null)}</span>
                  <span className="text-[9px] text-slate-600">
                    {state?.muted ? 'muted' : state?.solo ? 'solo' : '—'}
                  </span>
                </span>
                <button
                  type="button"
                  title="切换该小节静音"
                  onClick={() => props.onMute(slot, activeBar)}
                  className={cx(
                    'rounded border px-1 text-[9px]',
                    state?.muted
                      ? 'border-rose-600/70 bg-rose-500/15 text-rose-300'
                      : 'border-slate-700 text-slate-500 hover:text-slate-300',
                  )}
                >
                  M
                </button>
              </div>
              {row.map((cell, i) => {
                const bar = i + 1;
                return (
                  <Cell
                    key={bar}
                    cell={cell}
                    beatsPerBar={beatsPerBar}
                    selected={inSelection(slot, bar)}
                    isPlayFrom={bar === playFrom}
                    isPlaying={playingBar === bar}
                    beatGroupStart={bar % 4 === 1}
                    onMouseDown={(e) => handleCellDown(slot, bar, e)}
                    onMouseEnter={(e) => handleCellEnter(slot, bar, e)}
                    onDoubleClick={() => props.onClearCell(slot, bar)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      props.onChopEdit(slot, bar);
                    }}
                    onAltClick={() => props.onMute(slot, bar)}
                  />
                );
              })}
            </div>
          );
        })}

        {/* 播放头 */}
        {playingBar !== null && (
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-cyan-300/80 shadow-[0_0_12px_rgba(34,211,238,0.7)]"
            style={{ left: playheadLeft }}
          >
            <span className="absolute -top-0.5 -left-1 h-2 w-2 rounded-full bg-cyan-300" />
          </div>
        )}
      </div>
      <div className="pointer-events-none sticky bottom-0 left-0 flex h-0 items-end justify-start">
        <span className="ml-1 text-[9px] text-slate-700">共 {SLOT_COUNT} 个槽位 × {totalBars} 小节</span>
      </div>
    </div>
  );
}

function Cell({
  cell,
  beatsPerBar,
  selected,
  isPlayFrom,
  isPlaying,
  beatGroupStart,
  onMouseDown,
  onMouseEnter,
  onDoubleClick,
  onContextMenu,
}: {
  cell: GridCell;
  beatsPerBar: number;
  selected: boolean;
  isPlayFrom: boolean;
  isPlaying: boolean;
  beatGroupStart: boolean;
  onMouseDown: (event: React.MouseEvent) => void;
  onMouseEnter: (event: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onAltClick: () => void;
}) {
  const meta = iconMeta(cell.iconId);
  const hasChops = cell.chops.length > 0;
  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={
        meta
          ? `S${cell.slotIndex} · 第 ${cell.bar} 小节 · ${meta.name}${cell.muted ? '（静音）' : ''}`
          : `S${cell.slotIndex} · 第 ${cell.bar} 小节 · 空`
      }
      style={{ width: COL_W, height: ROW_H }}
      className={cx(
        'relative shrink-0 cursor-pointer border-b border-slate-800/80 p-0.5 transition-colors',
        beatGroupStart && 'border-l border-l-slate-700',
        selected && 'bg-cyan-500/10',
        isPlaying && 'bg-cyan-400/[0.07]',
        isPlayFrom && !selected && 'bg-cyan-500/[0.05]',
      )}
    >
      <div
        className={cx(
          'relative flex h-full w-full flex-col justify-between overflow-hidden rounded-[5px] border px-1 py-0.5',
          meta ? 'border-slate-700/80' : 'border-slate-800/60',
          cell.muted && meta && 'cell-muted-stripes',
        )}
        style={
          meta
            ? {
                background: `linear-gradient(180deg, ${meta.color}22, ${meta.color}10)`,
                borderColor: `${meta.color}66`,
              }
            : undefined
        }
      >
        {meta ? (
          <span className="truncate text-[9.5px] font-medium leading-tight" style={{ color: meta.color }}>
            {iconName(cell.iconId)}
          </span>
        ) : (
          <span />
        )}
        <div className="flex items-end justify-between">
          {meta ? (
            <span className="text-[8px] leading-none text-slate-500">#{cell.iconId}</span>
          ) : (
            <span className="text-[8px] leading-none text-slate-800">·</span>
          )}
          <span className="flex items-center gap-0.5">
            {cell.equippedHere && <span className="h-1 w-1 rounded-full bg-cyan-300/90" title="本小节起点换装" />}
            {hasChops && <span className="text-[8px] leading-none text-amber-400" title="拍内切分">≈</span>}
            {cell.solo && <span className="text-[8px] leading-none text-emerald-400" title="独奏">S</span>}
          </span>
        </div>
        {hasChops && (
          <span className="absolute inset-x-0 bottom-0 h-1.5">
            {cell.chops.map((chop, index) => (
              <span
                key={`${chop.beat}-${index}`}
                className={cx('absolute top-0 h-full w-px', chop.muted ? 'bg-rose-400/90' : 'bg-emerald-400/90')}
                style={{ left: `${((chop.beat - 1) / beatsPerBar) * 100}%` }}
              />
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
