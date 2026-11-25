import type { AdapterKind, InputOp, ProbeReport } from '@ic/shared';
import { BaseAdapter } from './base.ts';
import { cssPath, describe, isVisible, rectCenter } from '../util.ts';

const SLOT_SELECTORS = [
  // Incredibox Steam 1.2.9 真机：7 个角色容器带 data-polo-id="0..6"
  '.polo[data-polo-id]',
  '[data-polo-id].polo',
  '[data-slot]',
  '.character',
  '.performer',
  '.bonhomme',
  '.robot',
  '[class*="character"]',
  '[class*="performer"]',
  '[class*="bonhomme"]',
];

const ICON_SELECTORS = [
  // Incredibox Steam 1.2.9 真机：20 个音色图标带 data-picto-num="0..19"（数值就是 iconId）
  '[data-picto-num]',
  '[data-icon]',
  '.icon',
  '.sound',
  '.sound-icon',
  '[class*="icon"]',
  '[draggable="true"]',
];

const REC_SELECTORS = ['[data-rec]', '#rec', '[class*="icon-game-bt-record"]', '.rec', '[class*="record"]'];

/**
 * 自动接 bonus 的观察窗口。必须盖住「最后一个音色就位 → 按钮开始弹跳」的延迟：
 * 实测（V5 Brazil）这一步可能跨一整个循环（8s），旧值 2.5s 会刚好错过。
 */
const BONUS_WATCH_MS = 15000;
/** 自动接 bonus 的轮询间隔 */
const BONUS_POLL_MS = 250;

/** 真机每个角色自带的控制按钮（mute / solo / 移除） */
const CTRL_SELECTORS = {
  mute: '.icon-game-bt-mute, [class*="bt-mute"]',
  solo: '.icon-game-bt-solo, [class*="bt-solo"]',
  delete: '.icon-game-bt-delete, [class*="bt-delete"]',
} as const;

/**
 * 真实游戏（Steam/Electron）里没有可供脚本调用的 API，只能走 DOM：
 * Incredibox 的交互是「把底部音色图标拖到小人身上」，所以：
 *   equip  = 从图标中心拖到小人中心的完整指针 / HTML5 DnD 序列
 *   mute   = 点击小人（Incredibox 点小人即静音/解除）
 *   clear  = 再点一次小人（脱离队伍）
 *
 * 选择器先按「data-* 约定」找，找不到再用「一排尺寸相近的兄弟元素」启发式推断，
 * 也可以由 Host 端下发 domProfile 手动指定。
 */
export class DomAdapter extends BaseAdapter {
  readonly kind: AdapterKind = 'dom';
  private slotCache: HTMLElement[] = [];
  private iconCache: HTMLElement[] = [];
  /** 自动接 bonus：观察窗口截止时间 + 轮询定时器 */
  private bonusWatchUntil = 0;
  private bonusTimer: number | null = null;
  private bonusClickedAt = 0;

  /** data 属性里的编号就是游戏内的槽位/图标序号，优先按它排序 */
  private orderByData(elements: HTMLElement[], attr: string): HTMLElement[] | null {
    const pairs = elements.map((el) => ({ el, n: Number(el.dataset[attr]) }));
    if (pairs.some((p) => !Number.isFinite(p.n))) return null;
    if (new Set(pairs.map((p) => p.n)).size !== pairs.length) return null;
    return pairs.sort((a, b) => a.n - b.n).map((p) => p.el);
  }

  private ensureSlots(): HTMLElement[] {
    if (this.slotCache.length === 7 && this.slotCache.every((el) => el.isConnected)) return this.slotCache;
    this.slotCache = this.discover(this.config.domProfile?.slotSelector, SLOT_SELECTORS, 7, 'poloId');
    if (this.slotCache.length < 7) {
      this.notes.push(`DOM 槽位只找到 ${this.slotCache.length}/7 个，请在校准面板指定 slotSelector`);
    }
    return this.slotCache;
  }

  private ensureIcons(): HTMLElement[] {
    if (this.iconCache.length >= 20 && this.iconCache.every((el) => el.isConnected)) return this.iconCache;
    this.iconCache = this.discover(this.config.domProfile?.iconSelector, ICON_SELECTORS, 20, 'pictoNum');
    if (this.iconCache.length < 20) {
      this.notes.push(`DOM 音色图标只找到 ${this.iconCache.length}/20 个，请在校准面板指定 iconSelector`);
    }
    return this.iconCache;
  }

  private discover(
    profileSelector: string | undefined,
    candidates: string[],
    want: number,
    dataAttr: string,
  ): HTMLElement[] {
    const pick = (selector: string): HTMLElement[] =>
      Array.from(document.querySelectorAll(selector)).filter(
        (el): el is HTMLElement => el instanceof HTMLElement && isVisible(el),
      );
    if (profileSelector) {
      const found = pick(profileSelector);
      if (found.length > 0) {
        return (this.orderByData(found, dataAttr) ?? this.orderByLayout(found)).slice(0, want);
      }
    }
    for (const selector of candidates) {
      const found = pick(selector);
      if (found.length >= want) {
        return (this.orderByData(found, dataAttr) ?? this.orderByLayout(found)).slice(0, want);
      }
    }
    return this.inferRow(want);
  }

  /** 先按「行」再按「列」排序，保证索引稳定对应游戏内的 7 / 20 序号 */
  private orderByLayout(elements: HTMLElement[]): HTMLElement[] {
    const withRect = elements.map((el) => ({ el, rect: el.getBoundingClientRect() }));
    withRect.sort((a, b) => {
      const dy = a.rect.top - b.rect.top;
      if (Math.abs(dy) > Math.min(a.rect.height, b.rect.height) * 0.6) return dy;
      return a.rect.left - b.rect.left;
    });
    return withRect.map((x) => x.el);
  }

  /** 启发式：在一排尺寸相近、等距排列的兄弟元素里找 slots / icons */
  private inferRow(want: number): HTMLElement[] {
    let best: { score: number; items: HTMLElement[] } | null = null;
    const containers = Array.from(document.querySelectorAll('div,section,ul,main,nav'));
    for (const container of containers.slice(0, 4000)) {
      const children = Array.from(container.children).filter(
        (el): el is HTMLElement => el instanceof HTMLElement && isVisible(el),
      );
      if (children.length < want || children.length > want * 3) continue;
      const rects = children.map((el) => el.getBoundingClientRect());
      const heights = rects.map((r) => r.height);
      const avgH = heights.reduce((a, b) => a + b, 0) / heights.length;
      if (avgH < 8) continue;
      const similar = heights.every((h) => Math.abs(h - avgH) / avgH < 0.4);
      if (!similar) continue;
      const rowAligned = rects.every((r) => Math.abs(r.top - rects[0]!.top) < Math.max(8, avgH * 0.5));
      const score = (rowAligned ? 2 : 0) + (children.length === want ? 1 : 0) + Math.min(1, avgH / 120);
      if (!best || score > best.score) best = { score, items: children };
    }
    if (!best) return [];
    return this.orderByLayout(best.items).slice(0, want);
  }

  /**
   * 派发指针/鼠标事件。
   * `buttons` 必须正确：真机 Incredibox 靠 `e.buttons` 判断"鼠标是否仍按住"来决定是否算拖拽，
   * 少了它（或 pointerType 缺失）事件会被当成普通点击，装备/拖动静默失效。
   */
  private dispatchPointer(el: Element, type: string, point: { x: number; y: number }, buttons = 1): void {
    const common = {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      button: 0,
      buttons,
      view: window,
    };
    if (type.startsWith('pointer')) {
      const Ctor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      el.dispatchEvent(
        new Ctor(type, { ...common, pointerId: 1, isPrimary: true, pointerType: 'mouse' } as PointerEventInit),
      );
    } else {
      el.dispatchEvent(new MouseEvent(type, common));
    }
  }

  private dispatchDrag(el: Element, type: string, point: { x: number; y: number }, dataTransfer: DataTransfer): void {
    const event = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      dataTransfer,
    });
    el.dispatchEvent(event);
  }

  /** 把 iconId 拖到 slotIndex 身上 */
  equipIcon(slotIndex: number, iconId: number): void {
    const slots = this.ensureSlots();
    const icons = this.ensureIcons();
    const slot = slots[slotIndex];
    const icon = icons[iconId];
    if (!slot || !icon) {
      this.markError(`slot=${slotIndex} icon=${iconId} 元素缺失`, 'equipIcon');
      return;
    }
    // 真机的拖拽热区是 .picto 内部的 .hitzone，从那里起手才被游戏接受
    const handle = (icon.querySelector('.hitzone') as HTMLElement | null) ?? icon;
    const from = rectCenter(handle);
    // 落点取角色上半部：角色中下部被 mute/solo/delete 那层 .ctrl 覆盖，
    // 拖到中心时 drop 会被控制层吃掉（实测换装因此失败）。
    const slotRect = slot.getBoundingClientRect();
    const to = { x: slotRect.left + slotRect.width / 2, y: slotRect.top + slotRect.height * 0.3 };
    const dataTransfer = typeof DataTransfer === 'function' ? new DataTransfer() : null;

    // 复制一份舞台影子状态用于判断是否需要先撤下
    const current = this.stageOf(slotIndex);
    const needsClear = current !== null && current.iconId !== null && current.iconId !== iconId;
    const removeBtn = slot.querySelector(CTRL_SELECTORS.delete) as HTMLElement | null;

    // 真机实证：把新音色直接拖到「已有音色」的角色上会被忽略，
    // 必须先点角色上的 × 撤下，等撤场动画结束再拖新的上来。
    const ops: InputOp[] = [];
    if (needsClear && removeBtn) {
      ops.push({ kind: 'click', point: rectCenter(removeBtn) });
      ops.push({ kind: 'drag', from, to, delayMs: 420 });
    } else {
      ops.push({ kind: 'drag', from, to });
    }

    // 优先请求 Bridge 用真实 CDP 输入执行（合成事件在真机上不被游戏接受）
    if (this.emitInput(ops)) {
      const stage = this.stageOf(slotIndex);
      if (stage) {
        stage.iconId = iconId;
        stage.muted = false;
      }
      this.armBonusWatch();
      return;
    }

    try {
      this.dispatchPointer(icon, 'pointerdown', from, 1);
      this.dispatchPointer(icon, 'mousedown', from, 1);
      if (dataTransfer) {
        this.dispatchDrag(icon, 'dragstart', from, dataTransfer);
        let hovered: Element | null = icon;
        for (let step = 1; step <= 6; step += 1) {
          const point = {
            x: from.x + ((to.x - from.x) * step) / 6,
            y: from.y + ((to.y - from.y) * step) / 6,
          };
          this.dispatchPointer(icon, 'pointermove', point, 1);
          this.dispatchPointer(document.elementFromPoint(point.x, point.y) ?? icon, 'mousemove', point, 1);
          const target = document.elementFromPoint(point.x, point.y) ?? slot;
          if (target !== hovered) {
            this.dispatchDrag(target, 'dragenter', point, dataTransfer);
            hovered = target;
          }
          this.dispatchDrag(target, 'dragover', point, dataTransfer);
        }
        this.dispatchDrag(slot, 'drop', to, dataTransfer);
        this.dispatchDrag(icon, 'dragend', to, dataTransfer);
      }
      this.dispatchPointer(slot, 'pointermove', to, 1);
      this.dispatchPointer(slot, 'pointerup', to, 0);
      this.dispatchPointer(slot, 'mouseup', to, 0);
      this.dispatchPointer(slot, 'click', to, 0);

      const stage = this.stageOf(slotIndex);
      if (stage) {
        stage.iconId = iconId;
        stage.muted = false;
      }
      this.armBonusWatch();
    } catch (err) {
      this.markError(err, 'equipIcon');
    }
  }

  /**
   * 游戏自己只负责「识别组合 + 让 bonus 按钮弹跳」，播放要玩家点一下。
   * 真机实测（V5 Brazil 1.2.9）：bonus 组合在 bar7 前后凑齐时 class 走
   * `unlock` → `inprogress` → `found bounce`（弹跳，只停留约 23s），
   * 点击后约 9s 进入 `playing`（`.video.show`），再过 ~8s 收尾。
   *
   * 这里在每次换装后开一个观察窗（多次换装共用一个窗口并不断续期），
   * 一旦发现弹跳的按钮就发一次真实点击。关掉 autoBonus 时完全不介入。
   */
  private armBonusWatch(): void {
    if (!this.config.autoBonus) return;
    // 窗口必须盖住「最后一个音色就位 → 按钮开始弹跳」的延迟：实测这一步可能跨
    // 一整个循环（8s），2.5s 的旧窗口会刚好错过，表现就是「bonus 弹了但没人点」。
    this.bonusWatchUntil = Math.max(this.bonusWatchUntil, Date.now() + BONUS_WATCH_MS);
    if (this.bonusTimer !== null) return;
    const poll = (): void => {
      this.bonusTimer = null;
      if (!this.config.autoBonus) return;
      const button = document.querySelector('.bt-bonus.bounce');
      if (button instanceof HTMLElement) {
        if (Date.now() - this.bonusClickedAt > 3000) {
          this.bonusClickedAt = Date.now();
          // 点完就收工：游戏开始播动画后按钮不再弹跳，继续轮询只会重复点击。
          this.bonusWatchUntil = 0;
          this.log('success', `游戏提示 bonus 可播，已自动点击 ${button.id || 'bonus'}`);
          this.clickElement(button);
        }
        return;
      }
      if (Date.now() < this.bonusWatchUntil) {
        this.bonusTimer = window.setTimeout(poll, BONUS_POLL_MS);
      }
    };
    this.bonusTimer = window.setTimeout(poll, BONUS_POLL_MS);
  }

  override dispose(): void {
    if (this.bonusTimer !== null) window.clearTimeout(this.bonusTimer);
    this.bonusTimer = null;
    this.bonusWatchUntil = 0;
    super.dispose();
  }

  clearSlot(slotIndex: number): void {
    const slot = this.ensureSlots()[slotIndex];
    if (!slot) return;
    try {
      // 真机：角色上的 × 按钮才是「移除音色」；没有就退回点击角色
      const button = slot.querySelector(CTRL_SELECTORS.delete) as HTMLElement | null;
      this.clickElement(button ?? slot);
      const stage = this.stageOf(slotIndex);
      if (stage) {
        stage.iconId = null;
        stage.muted = false;
      }
    } catch (err) {
      this.markError(err, 'clearSlot');
    }
  }

  setMute(slotIndex: number, muted: boolean): void {
    const slot = this.ensureSlots()[slotIndex];
    if (!slot) return;
    const stage = this.stageOf(slotIndex);
    if (stage && stage.muted === muted) return;
    // 真机：角色身上自带 mute 按钮，比「点击角色」精确
    const button = slot.querySelector(CTRL_SELECTORS.mute) as HTMLElement | null;
    try {
      if (button) {
        this.clickElement(button);
      } else {
        this.clickElement(slot);
      }
      if (stage) stage.muted = muted;
    } catch (err) {
      this.markError(err, 'setMute');
    }
  }

  private clickElement(el: Element): void {
    const point = rectCenter(el);
    if (this.emitInput([{ kind: 'click', point }])) return;
    this.dispatchPointer(el, 'pointerdown', point, 1);
    this.dispatchPointer(el, 'pointerup', point, 0);
    this.dispatchPointer(el, 'click', point, 0);
  }

  setSolo(slotIndex: number, solo: boolean): void {
    const slot = this.ensureSlots()[slotIndex];
    const stage = this.stageOf(slotIndex);
    if (stage && stage.solo === solo) return;
    const button = slot?.querySelector(CTRL_SELECTORS.solo) as HTMLElement | null;
    if (button) {
      try {
        this.clickElement(button);
        if (stage) stage.solo = solo;
      } catch (err) {
        this.markError(err, 'setSolo');
      }
      return;
    }
    // 没有原生 SOLO 控件时只能更新影子状态
    if (stage) stage.solo = solo;
  }

  toggleRecord(recording: boolean): void {
    const selector = this.config.domProfile?.recordSelector;
    let button: HTMLElement | null = null;
    if (selector) button = document.querySelector(selector);
    if (!button) {
      for (const candidate of REC_SELECTORS) {
        const el = document.querySelector(candidate);
        if (el instanceof HTMLElement && isVisible(el)) {
          button = el;
          break;
        }
      }
    }
    if (!button) {
      const byText = Array.from(document.querySelectorAll('button,div,span,a')).find(
        (el) => el instanceof HTMLElement && isVisible(el) && /^(rec|record|录制)$/i.test((el.textContent ?? '').trim()),
      );
      if (byText instanceof HTMLElement) button = byText;
    }
    if (!button) {
      this.markError('未找到 REC 按钮', 'toggleRecord');
      return;
    }
    const point = rectCenter(button);
    try {
      this.dispatchPointer(button, 'pointerdown', point);
      this.dispatchPointer(button, 'pointerup', point);
      this.dispatchPointer(button, 'click', point);
    } catch (err) {
      this.markError(err, 'toggleRecord');
    }
  }

  protected override probeDetails(): {
    slots: ProbeReport['slots'];
    icons: ProbeReport['icons'];
    recordButton: string | null;
  } {
    const slotEls = this.ensureSlots();
    const iconEls = this.ensureIcons();
    return {
      slots: slotEls.map((el, index) => ({ index, selector: cssPath(el), label: describe(el) })),
      icons: iconEls.map((el, index) => ({ index, selector: cssPath(el), label: describe(el) })),
      recordButton: (() => {
        const selector = this.config.domProfile?.recordSelector;
        if (selector) return selector;
        for (const candidate of REC_SELECTORS) {
          const el = document.querySelector(candidate);
          if (el) return candidate;
        }
        return null;
      })(),
    };
  }
}
