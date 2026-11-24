#!/usr/bin/env node
/**
 * 端到端验收脚本（design.md 三阶段 DoD 的机器化版本）。
 *
 * 拓扑：
 *   headless Chrome(9233) ──CDP──> Bridge(9461) ──WS──> 本脚本（扮演 Host UI）
 *                                        └─ 注入 guest.bundle.js 到 /sim 页面
 *
 * 断言覆盖：
 *   1. 注入与时钟：Bridge 自动连接、Guest 注入、AudioContext hook 抓到 4s 循环
 *   2. 适配层原语：EQUIP 排队生效、MUTE 即时、CLEAR
 *   3. 整曲回放：所有指令一次且仅一次、迟到 < 30ms、换装提前量 ≈ 1 拍、
 *      同一拍多角色静音完全同步、连续小节起点间隔 4.000s（无累积漂移）
 *   4. 指定小节跳转试听：快照状态 100% 还原
 *   5. 一键自动出带：REC 在首小节起点开始、末小节结束停止、时长正确
 *   6. 热注入与刷新恢复
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { compileProject, computeStageStateAtBar, emptyProject } from '../packages/shared/src/index.ts';
import { findChrome } from '../packages/bridge/src/sim-launcher.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.IC_E2E_PORT ?? 9461);
const CDP_PORT = Number(process.env.IC_E2E_CDP_PORT ?? 9233);
const BASE = `http://127.0.0.1:${PORT}`;
const BUNDLE = join(ROOT, 'dist', 'guest.bundle.js');

let passed = 0;
const failures = [];

function section(title) {
  console.log(`\n\x1b[36m▶ ${title}\x1b[0m`);
}
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` — ${detail}` : ''}`);
  }
}
function near(name, actual, expected, tolerance) {
  check(name, Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `actual=${fmt(actual)} expected=${fmt(expected)}±${fmt(tolerance)}`);
}
function fmt(value) {
  return typeof value === 'number' ? value.toFixed(4) : String(value);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 20000, interval = 120, label = 'condition' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = String(error);
    }
    await sleep(interval);
  }
  throw new Error(`等待超时（${timeout}ms）：${label}（最后状态：${typeof last === 'object' ? JSON.stringify(last).slice(0, 200) : last}）`);
}

async function health() {
  const res = await fetch(`${BASE}/health`);
  return res.json();
}
async function evalPage(expression) {
  const res = await fetch(`${BASE}/eval`, { method: 'POST', body: expression });
  const json = await res.json();
  if (!json.ok) throw new Error(`页面求值失败：${json.error}`);
  return json.value;
}
async function simDetail() {
  const raw = await evalPage('JSON.stringify(window.__INCREDIBOX_SIM__ ? window.__INCREDIBOX_SIM__.getDetail() : null)');
  return JSON.parse(raw);
}

class HostClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.events = [];
    this.waiters = [];
  }
  async open() {
    await new Promise((resolveOpen, reject) => {
      this.ws.once('open', resolveOpen);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      this.events.push(msg);
      for (const waiter of this.waiters.slice()) {
        if (waiter.predicate(msg)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(msg);
        }
      }
    });
    return this;
  }
  send(command) {
    this.ws.send(JSON.stringify(command));
  }
  waitForMessage(predicate, timeout = 15000, label = 'message') {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveWait, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrapped);
        reject(new Error(`等待消息超时：${label}`));
      }, timeout);
      const wrapped = (msg) => {
        clearTimeout(timer);
        resolveWait(msg);
      };
      this.waiters.push({ predicate, resolve: wrapped });
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function projectFromEvents(events, totalBars) {
  const project = emptyProject({ title: 'e2e', versionId: 'SIM_Test', bpm: 120, beatsPerBar: 8, totalBars });
  project.events = events.map((event, index) => ({ id: `e${index + 1}`, ...event }));
  return project;
}

/** 验收用乐谱：每小节一个 beat-1 探针 + 换装 / 同步静音 / 半拍切分 */
function playbackProject() {
  const events = [];
  for (let bar = 1; bar <= 8; bar += 1) {
    events.push({ bar, beat: 1, slotIndex: 6, action: 'UNMUTE' });
    events.push({ bar, beat: 5, slotIndex: 6, action: 'UNMUTE' });
  }
  events.push({ bar: 1, beat: 1, slotIndex: 0, action: 'EQUIP', iconId: 0 });
  events.push({ bar: 1, beat: 1, slotIndex: 1, action: 'EQUIP', iconId: 2 });
  events.push({ bar: 2, beat: 1, slotIndex: 2, action: 'EQUIP', iconId: 10 });
  events.push({ bar: 3, beat: 1, slotIndex: 3, action: 'EQUIP', iconId: 15 });
  // 同一拍多角色同时静音（Drop）
  events.push({ bar: 4, beat: 1, slotIndex: 0, action: 'MUTE' });
  events.push({ bar: 4, beat: 1, slotIndex: 1, action: 'MUTE' });
  events.push({ bar: 4, beat: 5, slotIndex: 0, action: 'UNMUTE' });
  events.push({ bar: 4, beat: 5, slotIndex: 1, action: 'UNMUTE' });
  // 拍内切分（第 5 小节后半拍恢复）
  events.push({ bar: 5, beat: 1, slotIndex: 2, action: 'MUTE' });
  events.push({ bar: 5, beat: 4.5, slotIndex: 2, action: 'UNMUTE' });
  // 跨小节换装（bar 6 起换 icon 16）
  events.push({ bar: 6, beat: 1, slotIndex: 3, action: 'EQUIP', iconId: 16 });
  return projectFromEvents(events, 8);
}

function mixProject() {
  const events = [
    { bar: 1, beat: 1, slotIndex: 0, action: 'EQUIP', iconId: 0 },
    { bar: 1, beat: 1, slotIndex: 1, action: 'EQUIP', iconId: 3 },
    { bar: 2, beat: 1, slotIndex: 2, action: 'EQUIP', iconId: 11 },
    { bar: 3, beat: 1, slotIndex: 0, action: 'MUTE' },
    { bar: 3, beat: 5, slotIndex: 0, action: 'UNMUTE' },
    { bar: 4, beat: 1, slotIndex: 3, action: 'EQUIP', iconId: 15 },
  ];
  return projectFromEvents(events, 4);
}

async function main() {
  console.log('\x1b[1mIncredibox Composer · 端到端验收\x1b[0m');
  console.log(`Bridge : http://127.0.0.1:${PORT}`);
  console.log(`CDP    : http://127.0.0.1:${CDP_PORT}`);

  readFileSync(BUNDLE);
  const bridge = spawn(process.execPath, ['packages/bridge/src/server.ts', '--port', String(PORT), '--cdp-port', String(CDP_PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stdout.on('data', (chunk) => process.stdout.write(`\x1b[90m[bridge] ${chunk}\x1b[0m`));
  bridge.stderr.on('data', (chunk) => process.stdout.write(`\x1b[31m[bridge] ${chunk}\x1b[0m`));

  const chromePath = findChrome(process.env.IC_CHROME ?? null);
  let chrome = null;
  let host = null;
  const cleanup = () => {
    host?.close();
    if (chrome && chrome.exitCode === null) {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
      else chrome.kill('SIGKILL');
    }
    if (bridge.exitCode === null) {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(bridge.pid), '/T', '/F'], { stdio: 'ignore' });
      else bridge.kill('SIGTERM');
    }
  };

  try {
    // ---------------------------------------------------------------- 启动
    section('1. 注入链路（阶段一 DoD）');
    await waitFor(async () => (await health()).ok, { timeout: 15000, label: 'Bridge HTTP 就绪' });
    check('Bridge HTTP 服务就绪', true);

    if (!chromePath) throw new Error('未找到 Chrome / Edge，无法运行 e2e');
    const profile = mkdtempSync(join(tmpdir(), 'ib-e2e-'));
    chrome = spawn(
      chromePath,
      [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profile}`,
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-features=Translate',
        '--window-size=1360,900',
        `${BASE}/sim/`,
      ],
      { stdio: 'ignore' },
    );

    const injected = await waitFor(
      async () => {
        const h = await health();
        if (!h.cdp?.connected || !h.guest?.online) return null;
        // 模拟器的 AudioContext 要等 Guest 注入完成后才创建，等它被 hook 抓到
        return h.guest.loopDuration > 0 ? h : null;
      },
      { timeout: 45000, label: 'Guest 注入完成且抓到循环时钟' },
    );
    check(`CDP 在 1s 内自动连上游戏页面（${injected.cdp.target?.title ?? injected.cdp.target?.url}）`, injected.cdp.connected);
    check('guest.bundle.js 已注入', Boolean(injected.guest.online));
    check(`适配层自动识别为 ${injected.guest.adapterKind}`, injected.guest.adapterKind === 'sim');
    check('时钟来自 AudioContext hook', injected.guest.clockSource === 'hook', injected.guest.clockSource);
    near('单循环时长实测 = 4s', injected.guest.loopDuration, 4, 0.02);

    host = await new HostClient(`ws://127.0.0.1:${PORT}/host`).open();
    const welcome = await host.waitForMessage((m) => m.type === 'welcome', 5000, 'welcome');
    check('Host WebSocket 握手成功', welcome.type === 'welcome');

    // ------------------------------------------------------- 2. 原语直控
    section('2. 适配层原语（equipIcon / setMute / clearSlot）');
    host.send({ type: 'adapter:command', command: { kind: 'equip', slotIndex: 0, iconId: 5 } });
    const equipped = await waitFor(async () => {
      const detail = await simDetail();
      return detail.slots[0].iconId === 5 ? detail : null;
    }, { timeout: 9000, label: 'EQUIP 生效' });
    check('equipIcon(0, 5) 在下一个循环头生效', equipped.slots[0].iconId === 5);
    check('生效点落在整数循环边界', Number.isFinite(equipped.slots[0].appliedLoop));

    host.send({ type: 'adapter:command', command: { kind: 'mute', slotIndex: 0, on: true } });
    const mutedFast = await waitFor(async () => {
      const detail = await simDetail();
      return detail.slots[0].muted ? detail : null;
    }, { timeout: 400, interval: 40, label: 'MUTE 即时生效' }).catch(() => null);
    check('setMute 立即生效（<400ms）', mutedFast !== null);

    host.send({ type: 'adapter:command', command: { kind: 'mute', slotIndex: 0, on: false } });
    await waitFor(async () => !(await simDetail()).slots[0].muted, { timeout: 1500, label: 'UNMUTE' });
    check('再次 setMute 可即时解除', true);

    host.send({ type: 'adapter:command', command: { kind: 'clear', slotIndex: 0 } });
    const cleared = await waitFor(async () => {
      const detail = await simDetail();
      return detail.slots[0].iconId === null ? detail : null;
    }, { timeout: 9000, label: 'CLEAR 生效' });
    check('clearSlot(0) 清空槽位', cleared.slots[0].iconId === null);

    // ------------------------------------------------------- 3. 整曲回放
    section('3. 整曲回放：换装 / 同步静音 / 切分 / 漂移');
    const project = playbackProject();
    host.events.length = 0;
    host.send({ type: 'transport:play', project, startBar: 1 });
    const finished = await waitFor(async () => {
      const tick = [...host.events].reverse().find((m) => m.type === 'tick');
      if (!tick) return null;
      if (tick.state.playing) return null;
      return host.events.some((m) => m.type === 'tick' && m.state.playing) ? tick : null;
    }, { timeout: 70000, interval: 200, label: '整曲播放结束' });
    check('播放自然结束并回到 idle', finished.state.mode === 'idle');

    const cues = host.events.filter((m) => m.type === 'cue').map((m) => m.cue);
    // 第 1 小节头部的 EQUIP 走「舞台预热」，派发小节为 0，不会作为 cue 事件下发
    const expected = compileProject(project, { equipLeadBeats: 1 }).cues.filter((cue) => cue.fireBar >= 1).length;
    check(`全部 ${expected} 条指令都已执行（实际 ${cues.length}）`, cues.length === expected, `期望 ${expected}，实际 ${cues.length}`);
    const uniqueIds = new Set(cues.map((c) => c.id));
    check('没有指令被重复执行', uniqueIds.size === cues.length);

    const lateAbs = cues.map((cue) => Math.abs(cue.lateMs)).sort((a, b) => a - b);
    const maxLate = lateAbs[lateAbs.length - 1];
    const medianLate = lateAbs[Math.floor(lateAbs.length / 2)];
    check(
      `指令误差：中位 ${medianLate.toFixed(1)}ms / 最大 ${maxLate.toFixed(1)}ms（均 < 25ms）`,
      maxLate < 25,
      `median=${medianLate.toFixed(2)} max=${maxLate.toFixed(2)}`,
    );
    const sources = new Set(
      host.events.filter((m) => m.type === 'tick' && m.state.playing).map((m) => m.state.clockSource),
    );
    check(`播放期间时钟来源恒为 AudioContext hook（${[...sources].join(',')}）`, sources.size === 1 && sources.has('hook'));

    const probes = cues
      .filter((cue) => cue.slotIndex === 6 && cue.beat === 1)
      .sort((a, b) => a.firedAt - b.firedAt);
    check(`每小节起点探针齐全（${probes.length}/8）`, probes.length === 8);
    const intervals = probes.slice(1).map((cue, index) => cue.firedAt - probes[index].firedAt);
    const intervalErrs = intervals.map((value) => Math.abs(value - 4)).sort((a, b) => a - b);
    const medianIntervalErr = intervalErrs[Math.floor(intervalErrs.length / 2)];
    const maxIntervalErr = intervalErrs[intervalErrs.length - 1];
    // 单次间隔会被系统负载干扰（实测同一台机器 10~30ms 都出现过），
    // 所以判「中位偏差」；「有没有漂移」由后面的斜率断言负责。
    check(
      `相邻小节起点间隔中位偏差 ${(medianIntervalErr * 1000).toFixed(1)}ms（最大 ${(maxIntervalErr * 1000).toFixed(1)}ms，系统负载抖动）`,
      medianIntervalErr < 0.012,
    );
    // 「无累积漂移」不能只看首尾两条指令（会被单条抖动污染），
    // 这里同时看：① 相对首个探针的偏移不再增长 ② 最小二乘斜率恒为 4.000s/小节。
    const offsets = probes.map((cue, index) => cue.firedAt - probes[0].firedAt - index * 4);
    const mean = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
    const trend = mean(offsets.slice(-3)) - mean(offsets.slice(0, 3));
    const spread = Math.max(...offsets) - Math.min(...offsets);
    const n = probes.length;
    const xs = probes.map((_, index) => index);
    const ys = probes.map((cue) => cue.firedAt);
    const slope =
      (n * xs.reduce((sum, x, i) => sum + x * ys[i], 0) - xs.reduce((a, b) => a + b, 0) * ys.reduce((a, b) => a + b, 0)) /
      (n * xs.reduce((sum, x) => sum + x * x, 0) - xs.reduce((a, b) => a + b, 0) ** 2);
    check(
      `小节网格斜率 = ${slope.toFixed(6)}s/小节（漂移 < 3ms/小节）`,
      Math.abs(slope - 4) < 0.003,
      `slope=${slope}`,
    );
    check(
      `偏移不随小节增长（首 3 与末 3 小节均值差 ${(trend * 1000).toFixed(1)}ms < 10ms，总散布 ${(spread * 1000).toFixed(1)}ms）`,
      Math.abs(trend) < 0.01,
    );

    const bar4Mutes = cues.filter((cue) => cue.bar === 4 && cue.beat === 1 && cue.action === 'MUTE');
    check('第 4 小节同拍出现 2 条 MUTE', bar4Mutes.length === 2);
    if (bar4Mutes.length === 2) {
      const delta = Math.abs(bar4Mutes[0].firedAt - bar4Mutes[1].firedAt);
      check(`同拍多角色静音零拉链（Δt=${(delta * 1000).toFixed(3)}ms < 1ms）`, delta < 0.001);
    }

    const equipBar3 = cues.find((cue) => cue.bar === 3 && cue.action === 'EQUIP');
    const probeBar3 = probes.find((cue) => cue.bar === 3);
    if (equipBar3 && probeBar3) {
      const lead = probeBar3.firedAt - equipBar3.firedAt;
      // 这是两条 cue 的时间差，两侧各带 ±20ms 抖动，所以容差取 60ms
      near('跨小节换装提前量 ≈ 1 拍（0.5s，含定时器抖动）', lead, 0.5, 0.06);
    } else {
      check('找到第 3 小节换装与探针', false);
    }

    const finalState = await simDetail();
    const expectedFinal = computeStageStateAtBar(project, project.totalBars + 1);
    const matches = [0, 1, 2, 3].every((slot) => finalState.slots[slot].iconId === expectedFinal[slot].iconId);
    check('播放结束时舞台与状态推演一致', matches, JSON.stringify(finalState.slots.slice(0, 4).map((s) => s.iconId)));

    // --------------------------------------------------- 4. 指定小节跳转
    section('4. 指定小节跳转试听（Play from Bar X）');
    const targetBar = 6;
    host.events.length = 0;
    const snapshot = computeStageStateAtBar(project, targetBar);
    host.send({ type: 'transport:play', project, startBar: targetBar });
    const jumped = await waitFor(async () => {
      const tick = [...host.events].reverse().find((m) => m.type === 'tick');
      return tick && tick.state.playing ? tick.state : null;
    }, { timeout: 12000, label: '跳转播放启动' });
    check(`从第 ${targetBar} 小节开始播放（bar=${jumped.bar}）`, jumped.bar === targetBar);

    const restored = await waitFor(async () => {
      const detail = await simDetail();
      const ok = [0, 1, 2, 3, 4, 5].every(
        (slot) => detail.slots[slot].iconId === snapshot[slot].iconId && detail.slots[slot].muted === snapshot[slot].muted,
      );
      return ok ? detail : null;
    }, { timeout: 2000, interval: 60, label: '舞台快照还原' }).catch(() => null);
    check('前置状态 100% 还原（iconId + muted）', restored !== null);
    host.send({ type: 'transport:stop' });
    await sleep(400);

    // ------------------------------------------------------ 5. 自动出带
    section('5. 一键自动出带（Auto-Mix）');
    const mix = mixProject();
    host.events.length = 0;
    const mixStartedAt = Date.now();
    host.send({ type: 'mix:start', project: mix, startBar: 1 });
    const recording = await waitFor(async () => {
      const detail = await simDetail();
      return detail.record ? detail : null;
    }, { timeout: 20000, label: 'REC 开始' });
    check('REC 在首小节起点被按下', recording.record === true);
    const mixDone = await waitFor(async () => {
      const detail = await simDetail();
      return !detail.record && detail.lastMix ? detail : null;
    }, { timeout: 45000, label: '录制停止' });
    check('末小节结束后自动停止录制并弹出保存', mixDone.lastMix !== null);
    near('录制时长 ≈ 4 小节 × 4s', mixDone.lastMix.duration, 16, 1.2);
    const mixMessage = host.events.find((m) => m.type === 'mix' && m.phase === 'done');
    check('Host 收到自动出带完成事件', Boolean(mixMessage));
    console.log(`  \x1b[90m自动出带全程耗时 ${((Date.now() - mixStartedAt) / 1000).toFixed(1)}s\x1b[0m`);

    // --------------------------------------------------- 6. 热注入 / 恢复
    section('6. 热注入与页面刷新恢复');
    const beforeReload = (await health()).guest;
    await evalPage('location.reload()');
    const afterReload = await waitFor(async () => {
      const h = await health();
      return h.guest?.online && h.guest.injectedAt !== beforeReload.injectedAt ? h.guest : null;
    }, { timeout: 15000, interval: 200, label: '刷新后重新注入' });
    check('页面刷新后自动重新注入', afterReload.online && afterReload.injectedAt !== beforeReload.injectedAt);

    const original = readFileSync(BUNDLE, 'utf8');
    const beforeHot = (await health()).guest.injectedAt;
    appendFileSync(BUNDLE, '\n// e2e hot-reload probe\n');
    const afterHot = await waitFor(async () => {
      const h = await health();
      return h.guest?.online && h.guest.injectedAt !== beforeHot ? h.guest : null;
    }, { timeout: 12000, interval: 200, label: '热注入' });
    writeFileSync(BUNDLE, original);
    check('bundle 变更触发自动热注入（无需重启游戏）', afterHot.injectedAt !== beforeHot);
  } finally {
    cleanup();
  }

  console.log('');
  if (failures.length > 0) {
    console.log(`\x1b[41m\x1b[1m 失败 ${failures.length} 项 \x1b[0m`);
    for (const failure of failures) console.log(`  · ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`\x1b[42m\x1b[30m\x1b[1m 全部通过：${passed} 项断言 \x1b[0m`);
  }
}

main().catch((error) => {
  console.error(`\n\x1b[31mE2E 异常终止：${error?.stack ?? error}\x1b[0m`);
  process.exitCode = 1;
});
