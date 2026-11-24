import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost' | 'active';

const VARIANTS: Record<ButtonVariant, string> = {
  default: 'bg-slate-800/80 hover:bg-slate-700/80 border-slate-700 text-slate-200',
  primary: 'bg-cyan-500/90 hover:bg-cyan-400 border-cyan-400 text-slate-950 font-semibold',
  danger: 'bg-rose-600/85 hover:bg-rose-500 border-rose-500 text-white',
  ghost: 'bg-transparent hover:bg-slate-800/60 border-transparent text-slate-400 hover:text-slate-200',
  active: 'bg-cyan-500/20 border-cyan-500/70 text-cyan-200',
};

export function Button({
  variant = 'default',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-40',
        VARIANTS[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cx('flex min-h-0 flex-col rounded-xl border border-slate-800 bg-slate-900/60', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-2">
          <h2 className="text-[11px] font-semibold tracking-[0.14em] text-slate-400">{title}</h2>
          {actions}
        </header>
      )}
      <div className={cx('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-3 py-1.5 text-xs text-slate-400">
      <span className="shrink-0">
        {label}
        {hint && <span className="ml-1 text-[10px] text-slate-600">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function NumberInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="number"
      {...rest}
      className={cx(
        'w-20 rounded-md border border-slate-700 bg-slate-950/70 px-2 py-1 text-right text-xs text-slate-100',
        'focus:border-cyan-500 focus:outline-none',
        className,
      )}
    />
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="text"
      {...rest}
      className={cx(
        'rounded-md border border-slate-700 bg-slate-950/70 px-2 py-1 text-xs text-slate-100',
        'focus:border-cyan-500 focus:outline-none',
        className,
      )}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={cx(
        'rounded-md border border-slate-700 bg-slate-950/70 px-2 py-1 text-xs text-slate-100',
        'focus:border-cyan-500 focus:outline-none',
        className,
      )}
    >
      {children}
    </select>
  );
}

export function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'idle' }) {
  const color =
    tone === 'ok' ? 'bg-emerald-400' : tone === 'warn' ? 'bg-amber-400' : tone === 'bad' ? 'bg-rose-500' : 'bg-slate-600';
  return <span className={cx('inline-block h-2 w-2 rounded-full', color)} />;
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'cyan' | 'amber' | 'rose' }) {
  const map = {
    slate: 'border-slate-700 bg-slate-800/70 text-slate-300',
    cyan: 'border-cyan-700/60 bg-cyan-500/10 text-cyan-300',
    amber: 'border-amber-700/60 bg-amber-500/10 text-amber-300',
    rose: 'border-rose-700/60 bg-rose-500/10 text-rose-300',
  } as const;
  return (
    <span className={cx('rounded border px-1.5 py-0.5 text-[10px] leading-none', map[tone])}>{children}</span>
  );
}
