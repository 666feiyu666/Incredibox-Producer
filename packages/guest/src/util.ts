export function nowSec(): number {
  return typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000;
}

export function shortHash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0) * 4294967296 + (h1 >>> 0)).toString(16).slice(0, 12);
}

export const LOG_PREFIX = '[IB·Agent]';

export function logToConsole(level: 'info' | 'warn' | 'error' | 'success', message: string): void {
  // eslint-disable-next-line no-console
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`${LOG_PREFIX} ${message}`);
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 元素是否有可交互的面积（用于槽位/图标发现） */
export function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < 6 || rect.height < 6) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none') return false;
  if (Number(style.opacity) < 0.05) return false;
  // 刻意不检查 visibility：Incredibox 真机的 .polo 容器是 visibility:hidden，
  // 真正的角色图形画在子元素上；按 visibility 过滤会把 7 个槽位全部误杀。
  return true;
}

export function rectCenter(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function describe(el: Element | null): string {
  if (!el) return 'null';
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className.trim()
    ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
    : '';
  const attrs = ['data-slot', 'data-icon', 'data-id', 'aria-label', 'title']
    .map((a) => (el.hasAttribute(a) ? `[${a}=${el.getAttribute(a)}]` : ''))
    .join('');
  return `${tag}${id}${cls}${attrs}`;
}

export function cssPath(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && depth < 4) {
    const parent: Element | null = cur.parentElement;
    if (!parent) break;
    const index = Array.from(parent.children).indexOf(cur) + 1;
    parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${index})`);
    cur = parent;
    depth += 1;
  }
  return parts.join('>');
}
