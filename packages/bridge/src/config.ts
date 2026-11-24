import { DEFAULT_CDP_PORT, DEFAULT_WS_PORT } from '@ic/shared';

export interface BridgeConfig {
  /** Bridge 自己的 HTTP + WebSocket 端口 */
  port: number;
  cdpHost: string;
  cdpPort: number;
  /** guest.bundle.js 绝对路径 */
  bundlePath: string;
  /** host 构建产物目录（生产模式下由 Bridge 直接托管） */
  hostDist: string;
  /** 模拟器页面目录 */
  simDir: string;
  /** 启动时自动拉起一个带调试端口的 Chrome 打开模拟器 */
  launchSim: boolean;
  /** 是否监听 bundle 变化做热注入 */
  watch: boolean;
  chromePath: string | null;
  /** 自动拉起的浏览器是否 headless（e2e 用） */
  headless: boolean;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 解析 CLI 参数与环境变量：
 *   --port / IC_WS_PORT            Bridge 端口（默认 9451）
 *   --cdp-port / IC_CDP_PORT       Electron 远程调试端口（默认 9222）
 *   --cdp-host / IC_CDP_HOST       （默认 127.0.0.1）
 *   --bundle                       guest bundle 路径（默认 dist/guest.bundle.js）
 *   --launch-sim                   自动拉起 Chrome 打开内置模拟器
 *   --no-watch                     关闭热注入监听
 *   --chrome                       Chrome/Edge 可执行文件路径
 */
export function parseConfig(argv: string[], rootDir: string): BridgeConfig {
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, true);
    }
  }
  const str = (key: string): string | undefined => {
    const v = args.get(key);
    return typeof v === 'string' ? v : undefined;
  };
  const port = num(str('port') ?? process.env.IC_WS_PORT, DEFAULT_WS_PORT);
  return {
    port,
    cdpHost: str('cdp-host') ?? process.env.IC_CDP_HOST ?? '127.0.0.1',
    cdpPort: num(str('cdp-port') ?? process.env.IC_CDP_PORT, DEFAULT_CDP_PORT),
    bundlePath: str('bundle') ?? `${rootDir}/dist/guest.bundle.js`,
    hostDist: str('host-dist') ?? `${rootDir}/packages/host/dist`,
    simDir: `${rootDir}/sim`,
    launchSim: args.has('launch-sim'),
    watch: !args.has('no-watch'),
    chromePath: str('chrome') ?? process.env.IC_CHROME ?? null,
    headless: args.has('headless'),
  };
}
