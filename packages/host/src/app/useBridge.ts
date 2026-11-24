import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_RUNTIME_OPTIONS,
  type BridgeEvent,
  type FiredCue,
  type GuestInfo,
  type HostCommand,
  type LogEntry,
  type MixPhase,
  type PlaybackState,
  type ProbeReport,
  type RuntimeOptions,
  type VersionSwitchState,
} from '@ic/shared';

export interface BridgeState {
  connected: boolean;
  cdpConnected: boolean;
  guest: GuestInfo | null;
  tick: PlaybackState | null;
  options: RuntimeOptions;
  logs: LogEntry[];
  probe: ProbeReport | null;
  mix: { phase: MixPhase; message?: string } | null;
  lastCue: FiredCue | null;
  serverVersion: string | null;
  /** 切版本流程状态 */
  version: VersionSwitchState | null;
}

const EMPTY: BridgeState = {
  connected: false,
  cdpConnected: false,
  guest: null,
  tick: null,
  options: { ...DEFAULT_RUNTIME_OPTIONS },
  logs: [],
  probe: null,
  mix: null,
  lastCue: null,
  serverVersion: null,
  version: null,
};

function bridgeUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/host`;
}

/**
 * 与 Bridge 的 WebSocket 长连接。
 * 断线自动重连；重连成功后 Bridge 会重发 welcome + 当前 tick，UI 不需要自己补偿。
 */
export function useBridge() {
  const [state, setState] = useState<BridgeState>(EMPTY);
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number | null>(null);

  const applyEvent = useCallback((event: BridgeEvent) => {
    setState((prev) => {
      switch (event.type) {
        case 'welcome':
          return {
            ...prev,
            connected: true,
            serverVersion: event.serverVersion,
            cdpConnected: event.cdpConnected,
            guest: event.guest,
            options: event.options,
            logs: event.logs.slice(-200),
          };
        case 'status':
          return { ...prev, cdpConnected: event.cdpConnected, guest: event.guest };
        case 'tick':
          return { ...prev, tick: event.state, options: event.options };
        case 'log':
          return { ...prev, logs: [...prev.logs, event.entry].slice(-240) };
        case 'cue':
          return { ...prev, lastCue: event.cue };
        case 'mix':
          return { ...prev, mix: { phase: event.phase, ...(event.message ? { message: event.message } : {}) } };
        case 'probe':
          return { ...prev, probe: event.report };
        case 'version':
          return { ...prev, version: event.state };
        case 'error':
          return {
            ...prev,
            logs: [
              ...prev.logs,
              {
                id: Date.now(),
                ts: Date.now(),
                level: 'error' as const,
                source: 'bridge' as const,
                message: event.message,
              },
            ].slice(-240),
          };
        default:
          return prev;
      }
    });
  }, []);

  const connect = useCallback(() => {
    if (socketRef.current && socketRef.current.readyState <= WebSocket.OPEN) return;
    const socket = new WebSocket(bridgeUrl());
    socketRef.current = socket;
    socket.addEventListener('open', () => {
      setState((prev) => ({ ...prev, connected: true }));
    });
    socket.addEventListener('message', (event) => {
      try {
        applyEvent(JSON.parse(String(event.data)) as BridgeEvent);
      } catch {
        /* ignore */
      }
    });
    socket.addEventListener('close', () => {
      socketRef.current = null;
      setState((prev) => ({ ...prev, connected: false }));
      if (retryRef.current === null) {
        retryRef.current = window.setTimeout(() => {
          retryRef.current = null;
          connect();
        }, 1200);
      }
    });
    socket.addEventListener('error', () => {
      socket.close();
    });
  }, [applyEvent]);

  useEffect(() => {
    connect();
    return () => {
      if (retryRef.current !== null) window.clearTimeout(retryRef.current);
      retryRef.current = null;
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [connect]);

  const send = useCallback((command: HostCommand): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(command));
    return true;
  }, []);

  const clearProbe = useCallback(() => setState((prev) => ({ ...prev, probe: null })), []);

  return useMemo(() => ({ ...state, send, clearProbe }), [state, send, clearProbe]);
}

export type BridgeApi = ReturnType<typeof useBridge>;
