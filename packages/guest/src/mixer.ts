import {
  projectDurationSec,
  REC_RED_LINE_SEC,
  SLOT_COUNT,
  type CompositionProject,
  type MixPhase,
  type RuntimeOptions,
} from '@ic/shared';
import type { Adapter } from './adapter/index.ts';
import type { Transport, TransportMode } from './transport.ts';

export interface MixerDeps {
  adapter: Adapter;
  transport: Transport;
  emit: (phase: MixPhase, message?: string) => void;
  log: (level: 'info' | 'warn' | 'error' | 'success', message: string) => void;
  getOptions: () => RuntimeOptions;
}

/**
 * 一键自动出带（Auto-Mix Export，design.md 第三阶段核心任务 2）。
 *
 * 时序：
 *   1. 全员静音 + 清空舞台（避免上一首的残响被录进去）
 *   2. 立刻派发第 1 小节需要的换装（EQUIP 队列会在下一个循环头生效）
 *   3. 循环边界到达时：先按快照解除静音 → 同一瞬间触发游戏原生 REC
 *      —— 录音起点与音乐起点落在同一个循环边界上，零误差
 *   4. 最后一个小节结束的边界处停止 REC，唤起游戏原生保存弹窗
 */
export class Mixer {
  private active = false;
  private recordingStarted = false;
  private startBar = 1;

  constructor(private deps: MixerDeps) {}

  get isActive(): boolean {
    return this.active;
  }

  start(project: CompositionProject, startBar = 1): void {
    if (this.active) {
      this.deps.log('warn', '自动出带已经在进行中');
      return;
    }
    const duration = projectDurationSec(project);
    if (duration > REC_RED_LINE_SEC) {
      this.deps.log(
        'warn',
        `整曲时长 ${duration.toFixed(1)}s 超过游戏录制上限（${REC_RED_LINE_SEC}s 红线），可能无法一次录完`,
      );
    }
    this.active = true;
    this.recordingStarted = false;
    this.startBar = Math.max(1, Math.round(startBar));
    this.deps.emit('start', '清空舞台，准备录制…');

    for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
      this.deps.adapter.setMute(slot, true);
      this.deps.adapter.clearSlot(slot);
    }

    this.deps.transport.start(project, this.startBar, 'record');
  }

  /** Transport 每进入一个小节都会回调，这里负责在第一小节起点按下 REC */
  onBarStart(bar: number, mode: TransportMode): void {
    if (!this.active || mode !== 'recording' || this.recordingStarted) return;
    if (bar !== this.startBar) return;
    this.recordingStarted = true;
    this.deps.adapter.toggleRecord(true);
    this.deps.emit('recording', `第 ${bar} 小节起点已同步按下 REC`);
    this.deps.log('success', '游戏录制已开始，正在执行整首乐谱');
  }

  onBarEnd(): void {
    /* 预留：单小节结束钩子 */
  }

  onFinish(reason: 'end' | 'synced'): void {
    if (!this.active) return;
    this.active = false;
    if (this.recordingStarted) {
      this.recordingStarted = false;
      this.deps.adapter.toggleRecord(false);
      this.deps.emit('done', '录制已停止，请在游戏内保存 Mix 作品');
      this.deps.log('success', '自动出带完成，游戏应已弹出保存对话框');
    } else if (reason === 'end') {
      this.deps.emit('error', '乐谱结束但录制并未开始（REC 未触发）');
    }
  }

  abort(): void {
    if (!this.active) return;
    this.active = false;
    if (this.recordingStarted) {
      this.recordingStarted = false;
      this.deps.adapter.toggleRecord(false);
    }
    this.deps.transport.stop();
    this.deps.emit('done', '自动出带已中止');
  }
}
