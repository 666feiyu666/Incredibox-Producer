import { AGENT_GLOBAL, DEFAULT_WS_PORT } from '@ic/shared';
import { Agent } from './agent.ts';

declare const __BUNDLE_HASH__: string;
declare const __AGENT_VERSION__: string;
declare const __WS_PORT__: number;

interface ExposedAgent {
  version: string;
  injectedAt: number;
  agent: Agent;
  adapter: Agent['adapter'];
  transport: Agent['transport'];
  receive: (raw: string) => void;
  probe: () => void;
  status: () => unknown;
  options: () => unknown;
  dispose: () => void;
}

function boot(): void {
  const w = window as unknown as Record<string, unknown>;
  const previous = w[AGENT_GLOBAL] as Partial<ExposedAgent> | undefined;
  if (previous && typeof previous.dispose === 'function') {
    try {
      previous.dispose();
    } catch (err) {
      console.warn('[IB·Agent] 旧实例卸载失败', err);
    }
  }

  const port = typeof __WS_PORT__ === 'number' && __WS_PORT__ > 0 ? __WS_PORT__ : DEFAULT_WS_PORT;
  const agent = new Agent({
    bundleHash: typeof __BUNDLE_HASH__ === 'string' ? __BUNDLE_HASH__ : 'dev',
    agentVersion: typeof __AGENT_VERSION__ === 'string' ? __AGENT_VERSION__ : 'dev',
    wsUrl: `ws://127.0.0.1:${port}/guest`,
  });

  const exposed: ExposedAgent = {
    version: agent.getInfo().agentVersion,
    injectedAt: Date.now(),
    agent,
    adapter: agent.adapter,
    transport: agent.transport,
    receive: (raw: string) => agent.handleRaw(raw),
    probe: () => agent.probe(),
    status: () => agent.getInfo(),
    options: () => agent.getOptions(),
    dispose: () => agent.dispose(),
  };
  w[AGENT_GLOBAL] = exposed;

  console.log(
    `%c[IB·Agent] ${agent.getInfo().agentVersion} 已就绪 · adapter=${agent.adapter.kind} ` +
      `· 控制台可用 __INCREDIBOX_AGENT__.adapter.equipIcon(0, 0) 等指令`,
    'color:#22d3ee;font-weight:bold',
  );
}

boot();
