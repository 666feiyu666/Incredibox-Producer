import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cloneProject,
  emptyProject,
  parseProject,
  serializeProject,
  type CompositionProject,
} from '@ic/shared';

const PROJECT_KEY = 'ib-composer:project:v1';
const HISTORY_LIMIT = 120;

function loadProject(): CompositionProject {
  try {
    const raw = localStorage.getItem(PROJECT_KEY);
    if (!raw) return demoProject();
    return parseProject(JSON.parse(raw));
  } catch {
    return demoProject();
  }
}

/** 首次打开时给一段能立刻听出效果的示例乐谱 */
function demoProject(): CompositionProject {
  const project = emptyProject({ title: '示例 · 8 小节律动', versionId: 'SIM_Test', totalBars: 8 });
  let id = 0;
  const push = (bar: number, beat: number, slotIndex: number, action: 'EQUIP' | 'MUTE' | 'UNMUTE', iconId?: number) => {
    id += 1;
    project.events.push({
      id: `demo-${id}`,
      bar,
      beat,
      slotIndex,
      action,
      ...(iconId === undefined ? {} : { iconId }),
    });
  };
  push(1, 1, 0, 'EQUIP', 0); // Kick
  push(1, 1, 1, 'EQUIP', 2); // Hat
  push(2, 1, 2, 'EQUIP', 10); // Bass
  push(3, 1, 3, 'EQUIP', 15); // Vox Ah
  push(3, 1, 4, 'EQUIP', 5); // Scratch
  push(5, 1, 3, 'MUTE');
  push(5, 5, 3, 'UNMUTE');
  push(6, 1, 4, 'MUTE');
  push(7, 1, 4, 'UNMUTE');
  push(7, 1, 5, 'EQUIP', 12); // Bell
  return project;
}

export interface ProjectStore {
  project: CompositionProject;
  /** 以「一次用户操作」为粒度记录历史 */
  update: (updater: (project: CompositionProject) => CompositionProject, label?: string) => void;
  replace: (project: CompositionProject, options?: { record?: boolean }) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  lastLabel: string | null;
}

export function useProject(): ProjectStore {
  const [stack, setStack] = useState<{ items: CompositionProject[]; index: number; labels: string[] }>(() => ({
    items: [loadProject()],
    index: 0,
    labels: ['初始'],
  }));

  const project = stack.items[stack.index] ?? emptyProject();

  const commit = useCallback((next: CompositionProject, label: string) => {
    setStack((prev) => {
      const current = prev.items[prev.index];
      if (current && JSON.stringify(current) === JSON.stringify(next)) return prev;
      const items = [...prev.items.slice(Math.max(0, prev.index + 1 - HISTORY_LIMIT)), next].slice(-HISTORY_LIMIT);
      const labels = [...prev.labels.slice(Math.max(0, prev.index + 1 - HISTORY_LIMIT)), label].slice(-HISTORY_LIMIT);
      return { items, index: items.length - 1, labels };
    });
  }, []);

  const update = useCallback(
    (updater: (project: CompositionProject) => CompositionProject, label = '编辑') => {
      setStack((prev) => {
        const current = prev.items[prev.index];
        if (!current) return prev;
        const next = updater(current);
        if (JSON.stringify(current) === JSON.stringify(next)) return prev;
        const items = [...prev.items.slice(0, prev.index + 1), next].slice(-HISTORY_LIMIT);
        const labels = [...prev.labels.slice(0, prev.index + 1), label].slice(-HISTORY_LIMIT);
        return { items, index: items.length - 1, labels };
      });
    },
    [],
  );

  const replace = useCallback(
    (next: CompositionProject, options?: { record?: boolean }) => {
      if (options?.record === false) {
        setStack((prev) => {
          const items = [...prev.items];
          items[prev.index] = next;
          return { ...prev, items };
        });
        return;
      }
      commit(cloneProject(next), '替换乐谱');
    },
    [commit],
  );

  const undo = useCallback(() => {
    setStack((prev) => (prev.index > 0 ? { ...prev, index: prev.index - 1 } : prev));
  }, []);

  const redo = useCallback(() => {
    setStack((prev) => (prev.index < prev.items.length - 1 ? { ...prev, index: prev.index + 1 } : prev));
  }, []);

  // 自动持久化到 localStorage
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      try {
        localStorage.setItem(PROJECT_KEY, serializeProject(project));
      } catch {
        /* 配额满了就放弃持久化 */
      }
    }, 400);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [project]);

  return useMemo(
    () => ({
      project,
      update,
      replace,
      undo,
      redo,
      canUndo: stack.index > 0,
      canRedo: stack.index < stack.items.length - 1,
      lastLabel: stack.labels[stack.index] ?? null,
    }),
    [project, update, replace, undo, redo, stack],
  );
}

export function downloadProject(project: CompositionProject): void {
  const blob = new Blob([serializeProject(project)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.title.replace(/[\\/:*?"<>|]/g, '_') || 'composition'}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickProjectFile(): Promise<CompositionProject | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(parseProject(JSON.parse(String(reader.result))));
        } catch {
          resolve(null);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  });
}
