import { SIM_GLOBAL, type AdapterKind } from '@ic/shared';
import type { GameAdapter, GameAdapterExtras } from '@ic/shared';
import type { AdapterConfig } from './base.ts';
import { BaseAdapter } from './base.ts';
import { DomAdapter } from './dom.ts';
import { ExternalApiAdapter, GAME_API_GLOBAL } from './external-api.ts';

export type Adapter = GameAdapter & GameAdapterExtras & BaseAdapter;

export function createAdapter(
  mode: 'auto' | 'sim' | 'dom' | 'api',
  config: AdapterConfig,
): BaseAdapter {
  const w = window as unknown as Record<string, unknown>;
  const hasSim = typeof w[SIM_GLOBAL] === 'object' && w[SIM_GLOBAL] !== null;
  const hasGameApi = typeof w[GAME_API_GLOBAL] === 'object' && w[GAME_API_GLOBAL] !== null;

  const resolved: AdapterKind =
    mode === 'auto' ? (hasSim ? 'sim' : hasGameApi ? 'api' : 'dom') : mode;

  switch (resolved) {
    case 'sim':
      return new ExternalApiAdapter(config, SIM_GLOBAL);
    case 'api':
      return new ExternalApiAdapter(config, hasGameApi ? GAME_API_GLOBAL : SIM_GLOBAL);
    case 'dom':
    default:
      return new DomAdapter(config);
  }
}

export { BaseAdapter, DomAdapter, ExternalApiAdapter, GAME_API_GLOBAL };
