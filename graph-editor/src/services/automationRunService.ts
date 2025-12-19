export type AutomationPhase = 'idle' | 'waiting' | 'countdown' | 'running' | 'stopping';

export interface AutomationRunState {
  phase: AutomationPhase;
  runId?: string;
  graphFileId?: string;
  graphName?: string;
  startedAtMs?: number;
  stopRequested?: boolean;
  countdownSecondsRemaining?: number;
}

class AutomationRunService {
  private state: AutomationRunState = { phase: 'idle' };
  private listeners: Set<(s: AutomationRunState) => void> = new Set();

  getState(): AutomationRunState {
    return this.state;
  }

  subscribe(listener: (s: AutomationRunState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.state;
    for (const l of this.listeners) l(snapshot);
  }

  start(run: { runId: string; graphFileId: string; graphName: string }): void {
    this.state = {
      phase: 'waiting',
      runId: run.runId,
      graphFileId: run.graphFileId,
      graphName: run.graphName,
      startedAtMs: Date.now(),
      stopRequested: false,
      countdownSecondsRemaining: undefined,
    };
    this.emit();
  }

  setPhase(runId: string, phase: Exclude<AutomationPhase, 'idle'>): void {
    if (this.state.runId !== runId) return;
    this.state = { ...this.state, phase, countdownSecondsRemaining: undefined };
    this.emit();
  }

  setCountdown(runId: string, secondsRemaining: number): void {
    if (this.state.runId !== runId) return;
    const next = Math.max(0, Math.floor(secondsRemaining));
    this.state = { ...this.state, phase: 'countdown', countdownSecondsRemaining: next };
    this.emit();
  }

  requestStop(): void {
    if (!this.state.runId || this.state.phase === 'idle') return;
    this.state = { ...this.state, stopRequested: true, phase: 'stopping' };
    this.emit();
  }

  shouldStop(runId: string): boolean {
    return this.state.runId === runId && this.state.stopRequested === true;
  }

  finish(runId: string): void {
    if (this.state.runId !== runId) return;
    this.state = { phase: 'idle' };
    this.emit();
  }
}

export const automationRunService = new AutomationRunService();


