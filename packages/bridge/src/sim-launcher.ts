import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

export function findChrome(explicit: string | null): string | null {
  if (explicit && existsSync(explicit)) return explicit;
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 拉起一个带远程调试端口的 Chromium 打开模拟器。
 * 这样没有装 Steam 版 Incredibox 也能验证整条链路（Bridge → CDP → Guest → 调度器）。
 */
export function launchSimulator(opts: {
  chromePath: string | null;
  cdpPort: number;
  url: string;
  headless?: boolean;
}): ChildProcess | null {
  const chrome = findChrome(opts.chromePath);
  if (!chrome) return null;
  const profile = mkdtempSync(join(tmpdir(), 'ib-composer-'));
  const args = [
    `--remote-debugging-port=${opts.cdpPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1360,900',
    opts.url,
  ];
  if (opts.headless) args.unshift('--headless=new');
  const child = spawn(chrome, args, { stdio: 'ignore', detached: false });
  child.on('error', () => undefined);
  return child;
}
