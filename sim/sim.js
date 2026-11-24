/*
 * 开发用「模拟游戏」——不是官方 Incredibox，而是按 design.md 记录的游戏原生机制
 * 复刻的最小可验证舞台：
 *   · 7 个小人槽位 + 20 个音色图标
 *   · EQUIP 采用「队列」机制：调用后在下一个小节第 1 拍才发声
 *   · MUTE / UNMUTE 即时生效
 *   · 全局循环节拍网格（4s / 8 拍 @120BPM），由真实 AudioContext 驱动
 *   · 原生 REC 按钮 + 录制完成保存弹窗
 *   · 暴露 window.__INCREDIBOX_SIM__ 供脚本控制（等价于「游戏高层 API」）
 *   · 同时支持真实 HTML5 拖拽 / 指针拖拽 + 点击小人静音，便于验证 DOM 适配层
 */
(function () {
  'use strict';

  const LOOP_SEC = 4;
  const BEATS = 8;
  const SLOT_COUNT = 7;
  const ICON_COUNT = 20;
  const IDLE_GAIN = 0.55;
  const REC_LIMIT_SEC = 180;

  const GROUPS = [
    { label: 'Beats', from: 0, to: 4, colors: ['#f97316', '#fb7185', '#f59e0b', '#ea580c', '#fbbf24'] },
    { label: 'Effects', from: 5, to: 9, colors: ['#a855f7', '#8b5cf6', '#c084fc', '#7c3aed', '#d8b4fe'] },
    { label: 'Melodies', from: 10, to: 14, colors: ['#22d3ee', '#06b6d4', '#38bdf8', '#0ea5e9', '#67e8f9'] },
    { label: 'Voices', from: 15, to: 19, colors: ['#34d399', '#10b981', '#4ade80', '#059669', '#86efac'] },
  ];

  const ICON_NAMES = [
    'Kick', 'Snare', 'Hat', 'Perc', 'Tom',
    'Scratch', 'Horn', 'Riser', 'Sweep', 'Zap',
    'Bass', 'Pluck', 'Bell', 'Synth', 'Organ',
    'Vox Ah', 'Vox Eh', 'Vox Oh', 'Chant', 'Shout',
  ];

  function iconColor(id) {
    for (const g of GROUPS) if (id >= g.from && id <= g.to) return g.colors[id - g.from];
    return '#94a3b8';
  }

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------
  const slots = Array.from({ length: SLOT_COUNT }, () => ({
    iconId: null,
    muted: false,
    solo: false,
    pending: undefined,
    appliedAudioTime: null,
    appliedLoop: null,
    voice: null,
  }));

  const state = {
    record: false,
    recordStart: 0,
    lastMix: null,
    mixes: [],
    logs: [],
    loops: 0,
  };

  let ctx = null;
  let master = null;
  let clockGain = null;
  let clockSource = null;
  let t0 = 0;
  let lastLoopIndex = -1;
  const buffers = new Map();
  let selectedIcon = null;

  const logEl = document.getElementById('log');
  const stageEl = document.getElementById('stage');
  const paletteEl = document.getElementById('palette');
  const progressEl = document.getElementById('progress');
  const loopInfoEl = document.getElementById('loop-info');
  const beatsEl = document.getElementById('beats');
  const recBtn = document.getElementById('rec');
  const dialogMask = document.getElementById('dialog-mask');
  const dialogText = document.getElementById('dialog-text');

  function pushLog(message, kind) {
    state.logs.push({ t: ctx ? Number(ctx.currentTime.toFixed(3)) : 0, message, kind: kind || 'info' });
    if (state.logs.length > 300) state.logs.shift();
    if (!logEl) return;
    const row = document.createElement('div');
    const time = document.createElement('span');
    time.className = 't';
    time.textContent = ctx ? ctx.currentTime.toFixed(2) : '0.00';
    const body = document.createElement('span');
    if (kind) body.className = kind;
    body.textContent = message;
    row.append(time, body);
    logEl.appendChild(row);
    while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ---------------------------------------------------------------------------
  // 音频
  // ---------------------------------------------------------------------------
  function buildClockBuffer() {
    const rate = ctx.sampleRate;
    const length = Math.round(LOOP_SEC * rate);
    const buffer = ctx.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    for (let beat = 0; beat < BEATS; beat += 1) {
      const start = Math.round((beat * LOOP_SEC) / BEATS * rate);
      const accent = beat % 4 === 0;
      const freq = accent ? 1320 : 880;
      const dur = Math.round((accent ? 0.09 : 0.05) * rate);
      for (let i = 0; i < dur && start + i < length; i += 1) {
        const env = Math.exp(-i / (dur * 0.28));
        data[start + i] += Math.sin((2 * Math.PI * freq * i) / rate) * env * (accent ? 0.5 : 0.28);
      }
    }
    return buffer;
  }

  function buildIconBuffer(iconId) {
    if (buffers.has(iconId)) return buffers.get(iconId);
    const rate = ctx.sampleRate;
    const length = Math.round(LOOP_SEC * rate);
    const buffer = ctx.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    const group = Math.floor(iconId / 5);
    const step = (iconId % 5) + 1;
    const baseFreq = [110, 196, 262, 330][group] || 220;
    const hitsPerLoop = [8, 4, 2, 3][group] || 4;
    for (let hit = 0; hit < hitsPerLoop; hit += 1) {
      const start = Math.round(((hit * LOOP_SEC) / hitsPerLoop) * rate);
      const dur = Math.round((group === 0 ? 0.16 : 0.5) * rate);
      const freq = baseFreq * (1 + ((step - 1) * (group === 3 ? 0.05 : 0.03)));
      for (let i = 0; i < dur && start + i < length; i += 1) {
        const env = Math.exp(-i / (dur * 0.35));
        const tone = group === 0 ? Math.sin((2 * Math.PI * freq * i) / rate) : Math.sin((2 * Math.PI * freq * i) / rate) + 0.3 * Math.sin((2 * Math.PI * freq * 2 * i) / rate);
        data[start + i] += tone * env * 0.32;
      }
    }
    buffers.set(iconId, buffer);
    return buffer;
  }

  function ensureAudio() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return true;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return false;
    try {
      ctx = new Ctor();
    } catch (err) {
      pushLog('AudioContext 创建失败：' + err, 'warn');
      return false;
    }
    master = ctx.createGain();
    master.gain.value = 0.85;
    master.connect(ctx.destination);
    t0 = ctx.currentTime + 0.08;
    clockGain = ctx.createGain();
    clockGain.gain.value = 0.19;
    clockGain.connect(master);
    clockSource = ctx.createBufferSource();
    clockSource.buffer = buildClockBuffer();
    clockSource.loop = true;
    clockSource.connect(clockGain);
    clockSource.start(t0);
    lastLoopIndex = -1;
    if (ctx.state === 'suspended') ctx.resume();
    pushLog('音频引擎就绪：loop=' + LOOP_SEC + 's / ' + BEATS + ' 拍', 'ok');
    return true;
  }

  function loopStartOf(t) {
    return t0 + Math.floor((t - t0) / LOOP_SEC) * LOOP_SEC;
  }

  function progressOf(t) {
    if (!ctx) return 0;
    const loc = (((t - t0) % LOOP_SEC) + LOOP_SEC) % LOOP_SEC;
    return loc / LOOP_SEC;
  }

  function stopVoice(slot, at) {
    const s = slots[slot];
    if (!s.voice) return;
    try {
      s.voice.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
      s.voice.src.stop(ctx.currentTime + 0.06);
    } catch (err) {
      /* ignore */
    }
    s.voice = null;
  }

  function startVoice(slot, iconId) {
    const s = slots[slot];
    const when = Math.max(ctx.currentTime, t0);
    const offset = ((when - t0) % LOOP_SEC + LOOP_SEC) % LOOP_SEC;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(master);
    const src = ctx.createBufferSource();
    src.buffer = buildIconBuffer(iconId);
    src.loop = true;
    src.connect(gain);
    src.start(when, offset);
    s.voice = { src, gain, base: IDLE_GAIN + (iconId % 5) * 0.04 };
    applyVoiceGain(slot);
  }

  function applyVoiceGain(slot) {
    const s = slots[slot];
    if (!s.voice) return;
    const soloActive = slots.some((other, i) => i !== slot && other.solo && other.iconId !== null);
    const audible = !!s.iconId && !s.muted && (!soloActive || s.solo);
    s.voice.gain.gain.setTargetAtTime(audible ? s.voice.base : 0, ctx.currentTime, 0.008);
  }

  function refreshGains() {
    for (let i = 0; i < SLOT_COUNT; i += 1) applyVoiceGain(i);
  }

  // ---------------------------------------------------------------------------
  // 控制原语（EQUIP 队列 / MUTE 即时）
  // ---------------------------------------------------------------------------
  function equip(slot, iconId) {
    if (slot < 0 || slot >= SLOT_COUNT || iconId < 0 || iconId >= ICON_COUNT) return false;
    ensureAudio();
    slots[slot].pending = iconId;
    pushLog('槽位 ' + slot + ' 队列换装 → 图标 ' + iconId + '（下一个循环头生效）');
    render();
    return true;
  }

  function clearSlot(slot) {
    if (slot < 0 || slot >= SLOT_COUNT) return false;
    ensureAudio();
    slots[slot].pending = null;
    pushLog('槽位 ' + slot + ' 队列清空（下一个循环头生效）');
    render();
    return true;
  }

  function setMute(slot, muted) {
    if (slot < 0 || slot >= SLOT_COUNT) return false;
    ensureAudio();
    slots[slot].muted = !!muted;
    applyVoiceGain(slot);
    render();
    return true;
  }

  function setSolo(slot, solo) {
    if (slot < 0 || slot >= SLOT_COUNT) return false;
    slots[slot].solo = !!solo;
    refreshGains();
    render();
    return true;
  }

  function setRecord(on) {
    ensureAudio();
    if (on) {
      if (state.record) return true;
      state.record = true;
      state.recordStart = ctx.currentTime;
      state.mixes.push({ startedAt: state.recordStart });
      recBtn.classList.add('on');
      recBtn.textContent = 'STOP';
      pushLog('REC 开始录制', 'ok');
      return true;
    }
    if (!state.record) return true;
    state.record = false;
    const duration = ctx.currentTime - state.recordStart;
    state.lastMix = { duration: Number(duration.toFixed(3)), slots: snapshot() };
    recBtn.classList.remove('on');
    recBtn.textContent = 'REC';
    pushLog('REC 停止录制，时长 ' + duration.toFixed(2) + 's', 'ok');
    dialogText.textContent = '已生成 Mix 作品 · 时长 ' + duration.toFixed(2) + 's';
    dialogMask.classList.add('show');
    return true;
  }

  function applyPending(t) {
    const boundary = loopStartOf(t);
    const loopIndex = Math.round((boundary - t0) / LOOP_SEC);
    for (let i = 0; i < SLOT_COUNT; i += 1) {
      const s = slots[i];
      if (s.pending === undefined) continue;
      const iconId = s.pending;
      s.pending = undefined;
      if (iconId === null) {
        stopVoice(i);
        s.iconId = null;
      } else {
        s.iconId = iconId;
        startVoice(i, iconId);
      }
      s.appliedAudioTime = Number(boundary.toFixed(4));
      s.appliedLoop = loopIndex;
      pushLog('循环 #' + loopIndex + ' 生效：槽位 ' + i + ' → ' + (iconId === null ? '空' : '图标 ' + iconId), 'ok');
    }
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------
  function buildUi() {
    for (let i = 0; i < SLOT_COUNT; i += 1) {
      const el = document.createElement('div');
      el.className = 'character';
      el.dataset.slot = String(i);
      el.draggable = false;
      el.innerHTML =
        '<span class="slot-no">' + i + '</span>' +
        '<span class="mute-mark"></span>' +
        '<div class="face">◉</div>' +
        '<div class="badge">空</div>';
      stageEl.appendChild(el);
      bindSlot(el, i);
    }
    for (const group of GROUPS) {
      for (let id = group.from; id <= group.to; id += 1) {
        const el = document.createElement('div');
        el.className = 'icon';
        el.dataset.icon = String(id);
        el.draggable = true;
        el.innerHTML = '<i style="background:' + iconColor(id) + '"></i><b>' + ICON_NAMES[id] + '</b><span>#' + id + '</span>';
        paletteEl.appendChild(el);
        bindIcon(el, id);
      }
    }
    for (let b = 0; b < BEATS; b += 1) {
      const dot = document.createElement('b');
      beatsEl.appendChild(dot);
    }
    recBtn.addEventListener('click', () => setRecord(!state.record));
    document.getElementById('clear-all').addEventListener('click', () => {
      for (let i = 0; i < SLOT_COUNT; i += 1) {
        setMute(i, true);
        clearSlot(i);
      }
    });
    document.getElementById('unmute-all').addEventListener('click', () => {
      for (let i = 0; i < SLOT_COUNT; i += 1) setMute(i, false);
    });
    document.getElementById('dialog-ok').addEventListener('click', () => dialogMask.classList.remove('show'));
  }

  function bindIcon(el, id) {
    el.addEventListener('dragstart', (e) => {
      try {
        e.dataTransfer.setData('text/plain', String(id));
        e.dataTransfer.effectAllowed = 'copy';
      } catch (err) {
        /* ignore */
      }
      window.__simDragIcon = id;
      el.style.opacity = '0.5';
    });
    el.addEventListener('dragend', () => {
      el.style.opacity = '';
      window.__simDragIcon = null;
    });
    el.addEventListener('pointerdown', () => {
      window.__simDragIcon = id;
    });
    el.addEventListener('click', () => {
      selectedIcon = selectedIcon === id ? null : id;
      render();
    });
  }

  function bindSlot(el, slot) {
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = 'copy';
      } catch (err) {
        /* ignore */
      }
    });
    el.addEventListener('dragenter', (e) => e.preventDefault());
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      let raw = null;
      try {
        raw = e.dataTransfer.getData('text/plain');
      } catch (err) {
        raw = null;
      }
      const iconId = raw !== null && raw !== '' ? Number(raw) : window.__simDragIcon;
      window.__simDragIcon = null;
      el.dataset.draggedAt = String(Date.now());
      if (Number.isFinite(iconId)) equip(slot, Number(iconId));
    });
    el.addEventListener('pointerup', () => {
      const iconId = window.__simDragIcon;
      if (iconId !== null && iconId !== undefined) {
        window.__simDragIcon = null;
        el.dataset.draggedAt = String(Date.now());
        equip(slot, Number(iconId));
      }
    });
    el.addEventListener('click', () => {
      const draggedAt = Number(el.dataset.draggedAt || 0);
      if (Date.now() - draggedAt < 250) return; // 拖拽尾部的 click 不算静音
      if (selectedIcon !== null) {
        const iconId = selectedIcon;
        selectedIcon = null;
        equip(slot, iconId);
        return;
      }
      if (slots[slot].iconId === null) return;
      setMute(slot, !slots[slot].muted);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      clearSlot(slot);
    });
  }

  function render() {
    const children = stageEl.children;
    for (let i = 0; i < children.length; i += 1) {
      const el = children[i];
      const s = slots[i];
      el.classList.toggle('has-icon', s.iconId !== null);
      el.classList.toggle('muted', s.muted);
      el.classList.toggle('pending', s.pending !== undefined);
      const badge = el.querySelector('.badge');
      const mark = el.querySelector('.mute-mark');
      if (badge) {
        if (s.pending !== undefined) badge.textContent = '→ ' + ICON_NAMES[s.pending] ;
        else badge.textContent = s.iconId === null ? '空' : ICON_NAMES[s.iconId];
        if (s.pending === null) badge.textContent = '→ 空';
      }
      if (mark) mark.textContent = s.muted ? 'MUTE' : s.solo ? 'SOLO' : '';
    }
    const icons = paletteEl.children;
    for (let i = 0; i < icons.length; i += 1) {
      icons[i].style.borderColor = selectedIcon === i ? '#22d3ee' : '';
    }
  }

  function updateClockUi(t) {
    if (!ctx) return;
    const p = progressOf(t);
    progressEl.style.width = (p * 100).toFixed(2) + '%';
    const beat = Math.floor(p * BEATS);
    for (let i = 0; i < beatsEl.children.length; i += 1) {
      beatsEl.children[i].classList.toggle('on', i === beat);
    }
    if (loopInfoEl) {
      loopInfoEl.textContent =
        'loop ' + LOOP_SEC.toFixed(2) + 's · ' + BEATS + ' 拍 · ' +
        (state.record ? 'REC ' + (t - state.recordStart).toFixed(1) + 's' : 'idle');
    }
    if (state.record && t - state.recordStart > REC_LIMIT_SEC) {
      pushLog('录制超过 ' + REC_LIMIT_SEC + 's 上限，自动停止', 'warn');
      setRecord(false);
    }
  }

  // ---------------------------------------------------------------------------
  // 主循环
  // ---------------------------------------------------------------------------
  let lastRenderAt = 0;
  setInterval(() => {
    if (!ctx) {
      if (window.__INCREDIBOX_AGENT__) ensureAudio();
      return;
    }
    const t = ctx.currentTime;
    const loopIndex = Math.floor((t - t0) / LOOP_SEC);
    if (loopIndex !== lastLoopIndex) {
      lastLoopIndex = loopIndex;
      state.loops = loopIndex;
      applyPending(t);
      refreshGains();
    }
    updateClockUi(t);
    if (Date.now() - lastRenderAt > 120) {
      lastRenderAt = Date.now();
      render();
    }
  }, 25);

  document.addEventListener('pointerdown', ensureAudio, { once: true });
  document.addEventListener('keydown', ensureAudio, { once: true });

  function snapshot() {
    return slots.map((s) => ({ iconId: s.iconId, muted: s.muted, solo: s.solo }));
  }

  function detail() {
    return {
      clock: getClock(),
      record: state.record,
      lastMix: state.lastMix,
      loops: state.loops,
      slots: slots.map((s, i) => ({
        index: i,
        iconId: s.iconId,
        muted: s.muted,
        solo: s.solo,
        pending: s.pending === undefined ? 'none' : s.pending,
        appliedLoop: s.appliedLoop,
        appliedAudioTime: s.appliedAudioTime,
      })),
      logs: state.logs.slice(-80),
    };
  }

  function getClock() {
    if (!ctx) return null;
    const t = ctx.currentTime;
    const loopStart = loopStartOf(t);
    return {
      audioTime: Number(t.toFixed(4)),
      loopDuration: LOOP_SEC,
      loopStart: Number(loopStart.toFixed(4)),
      progress: Number(progressOf(t).toFixed(4)),
      playing: slots.some((s) => s.iconId !== null && !s.muted),
    };
  }

  buildUi();
  render();

  window.__INCREDIBOX_SIM__ = {
    version: 'sim-1.1',
    loopSeconds: LOOP_SEC,
    beatsPerBar: BEATS,
    getSnapshot: snapshot,
    getDetail: detail,
    getClock,
    equip,
    clear: clearSlot,
    setMute,
    setSolo,
    setRecord,
    ensureAudio,
    log: (message) => pushLog(String(message)),
  };

  pushLog('模拟舞台已就绪，等待注入 __INCREDIBOX_AGENT__', 'ok');
})();
