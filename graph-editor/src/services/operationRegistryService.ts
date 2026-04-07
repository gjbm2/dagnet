/**
 * Operation Registry Service
 *
 * Central singleton that tracks all long-running operations in the app.
 * Observable via useSyncExternalStore (same pattern as bannerManagerService).
 *
 * The registry is a pure state container — it does not own timers, transport,
 * or UI. Anything can push updates in: local for-loops, polling intervals,
 * WebSocket message handlers, etc.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OperationStatus =
  | 'pending'
  | 'countdown'
  | 'running'
  | 'complete'
  | 'warning'
  | 'error'
  | 'cancelled';

export interface OperationProgress {
  current: number;
  total: number;
  /** Short detail line, e.g. "Item 3/12: fetching 45d" */
  detail?: string;
}

export interface OperationSubStep {
  label: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  detail?: string;
}

export interface Operation {
  id: string;
  /** Categorical label for grouping, e.g. 'retrieve-all', 'batch-fetch', 'bayes-fit'. */
  kind: string;
  /** Human-readable display label (mutable). */
  label: string;
  status: OperationStatus;

  progress?: OperationProgress;
  subSteps?: OperationSubStep[];
  countdownSecondsRemaining?: number;
  /** Initial countdown duration (set once on first setCountdown call, for bar width). */
  countdownTotalSeconds?: number;
  /** True when countdown is paused. Timer is stopped; seconds are frozen. */
  countdownPaused?: boolean;
  error?: string;

  startedAtMs?: number;
  completedAtMs?: number;
  cancellable: boolean;
  /**
   * Optional action button shown on terminal operations.
   * Used when the user needs to take a next step (e.g. resolve merge conflicts).
   */
  action?: { label: string; onClick: () => void };
  /**
   * Transport-agnostic cancel callback.
   * Local ops set a boolean flag; remote ops hit an API endpoint.
   * The registry just calls it — the caller is responsible for
   * stopping work and then calling `complete(id, 'cancelled')`.
   */
  onCancel?: () => void;
}

export interface OperationSpec {
  id: string;
  kind: string;
  label: string;
  cancellable?: boolean;
  onCancel?: () => void;
  /** Initial status. Defaults to 'pending'. */
  status?: OperationStatus;
  /** If provided, sets initial progress and implies status 'running'. */
  progress?: OperationProgress;
}

export interface OperationRegistryState {
  /** Operations in pending / countdown / running status. Most-recent first. */
  active: Operation[];
  /** Terminal operations (complete / error / cancelled). Most-recent first. Ring buffer. */
  recent: Operation[];
}

/**
 * Adapter interface for external progress sources (e.g. Bayes engine).
 * Implement this to bridge a polling loop or WebSocket into the registry.
 */
export interface OperationProgressAdapter {
  /** Begin polling / subscribing for updates on this operation. */
  start(operationId: string): void;
  /** Stop polling / subscribing (called on cancel or completion). */
  stop(operationId: string): void;
}

// ---------------------------------------------------------------------------
// Session log helper (fire-and-forget, same pattern as countdownService)
// ---------------------------------------------------------------------------

function auditOperationEvent(
  code: string,
  message: string,
  metadata?: Record<string, unknown>
): void {
  void import('./sessionLogService')
    .then(({ sessionLogService }) => {
      sessionLogService.debug('session', code, message, undefined, metadata);
    })
    .catch(() => {
      // ignore — logging must never crash the app
    });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RECENT = 20;

const TERMINAL_STATUSES: ReadonlySet<OperationStatus> = new Set([
  'complete',
  'warning',
  'error',
  'cancelled',
]);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

type RegistryListener = () => void;

class OperationRegistryService {
  private static instance: OperationRegistryService;

  static getInstance(): OperationRegistryService {
    if (!OperationRegistryService.instance) {
      OperationRegistryService.instance = new OperationRegistryService();
    }
    return OperationRegistryService.instance;
  }

  private opsById = new Map<string, Operation>();
  private recentOps: Operation[] = [];
  private listeners = new Set<RegistryListener>();
  private version = 0;
  private cachedVersion = -1;
  private cachedState: OperationRegistryState = { active: [], recent: [] };

  // ---- Observable contract ------------------------------------------------

  subscribe(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): OperationRegistryState {
    if (this.cachedVersion === this.version) return this.cachedState;

    const active = Array.from(this.opsById.values()).sort(
      (a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0)
    );

    this.cachedState = { active, recent: this.recentOps };
    this.cachedVersion = this.version;
    return this.cachedState;
  }

  private emit(): void {
    this.version += 1;
    for (const l of this.listeners) l();
  }

  // ---- Mutations ----------------------------------------------------------

  register(spec: OperationSpec): void {
    const now = Date.now();
    const status = spec.status ?? (spec.progress ? 'running' : 'pending');

    const op: Operation = {
      id: spec.id,
      kind: spec.kind,
      label: spec.label,
      status,
      cancellable: spec.cancellable ?? false,
      onCancel: spec.onCancel,
      progress: spec.progress,
      startedAtMs: status === 'running' ? now : undefined,
    };

    this.opsById.set(op.id, op);
    this.emit();

    auditOperationEvent('OP_REGISTERED', `Operation registered: ${spec.label}`, {
      operationId: spec.id,
      kind: spec.kind,
      status,
    });
  }

  setStatus(id: string, status: OperationStatus): void {
    const op = this.opsById.get(id);
    if (!op) return;

    if (TERMINAL_STATUSES.has(status)) {
      this.moveToRecent(id, status);
      return;
    }

    const updated: Operation = {
      ...op,
      status,
      startedAtMs: status === 'running' && !op.startedAtMs ? Date.now() : op.startedAtMs,
      // Clear countdown when leaving countdown phase
      countdownSecondsRemaining: status === 'countdown' ? op.countdownSecondsRemaining : undefined,
    };
    this.opsById.set(id, updated);
    this.emit();

    auditOperationEvent('OP_STATUS', `Operation ${status}: ${op.label}`, {
      operationId: id,
      kind: op.kind,
      status,
    });
  }

  setProgress(id: string, progress: OperationProgress): void {
    const op = this.opsById.get(id);
    if (!op) return;

    const updated: Operation = {
      ...op,
      progress,
      status: op.status !== 'running' ? 'running' : op.status,
      startedAtMs: op.startedAtMs ?? Date.now(),
    };
    this.opsById.set(id, updated);
    this.emit();
  }

  setLabel(id: string, label: string): void {
    const op = this.opsById.get(id);
    if (!op || op.label === label) return;

    this.opsById.set(id, { ...op, label });
    this.emit();
  }

  /** Attach or update the cancel callback (and optionally toggle cancellable). */
  setCancellable(id: string, onCancel: (() => void) | undefined, cancellable = true): void {
    const op = this.opsById.get(id);
    if (!op) return;

    this.opsById.set(id, { ...op, cancellable, onCancel });
    this.emit();
  }

  setCountdown(id: string, secondsRemaining: number): void {
    const op = this.opsById.get(id);
    if (!op) return;

    const seconds = Math.max(0, Math.floor(secondsRemaining));
    const updated: Operation = {
      ...op,
      status: 'countdown',
      countdownSecondsRemaining: seconds,
      // Capture the total on first call so the UI can derive a percentage.
      countdownTotalSeconds: op.countdownTotalSeconds ?? seconds,
      // Don't overwrite paused state from ticks.
      countdownPaused: op.countdownPaused,
    };
    this.opsById.set(id, updated);
    this.emit();
  }

  /**
   * Pause the countdown. The registry sets the flag; the caller (e.g.
   * useOperationCountdown) is responsible for actually stopping the timer.
   */
  pauseCountdown(id: string): void {
    const op = this.opsById.get(id);
    if (!op || op.status !== 'countdown' || op.countdownPaused) return;

    this.opsById.set(id, { ...op, countdownPaused: true });
    this.emit();

    auditOperationEvent('OP_COUNTDOWN_PAUSE', `Countdown paused: ${op.label}`, {
      operationId: id,
      kind: op.kind,
      secondsRemaining: op.countdownSecondsRemaining,
    });
  }

  /**
   * Resume a paused countdown. The caller is responsible for restarting the timer
   * with the frozen secondsRemaining.
   */
  resumeCountdown(id: string): void {
    const op = this.opsById.get(id);
    if (!op || op.status !== 'countdown' || !op.countdownPaused) return;

    this.opsById.set(id, { ...op, countdownPaused: false });
    this.emit();

    auditOperationEvent('OP_COUNTDOWN_RESUME', `Countdown resumed: ${op.label}`, {
      operationId: id,
      kind: op.kind,
      secondsRemaining: op.countdownSecondsRemaining,
    });
  }

  setSubSteps(id: string, subSteps: OperationSubStep[]): void {
    const op = this.opsById.get(id);
    if (!op) return;

    this.opsById.set(id, { ...op, subSteps });
    this.emit();
  }

  /**
   * Transition an operation to a terminal state.
   * Convenience wrapper around setStatus that also sets the error message.
   */
  complete(
    id: string,
    outcome: 'complete' | 'warning' | 'error' | 'cancelled',
    error?: string,
    action?: { label: string; onClick: () => void },
  ): void {
    const op = this.opsById.get(id);
    if (!op) return;

    this.moveToRecent(id, outcome, error, action);
  }

  remove(id: string): void {
    const hadActive = this.opsById.delete(id);
    const recentIdx = this.recentOps.findIndex((o) => o.id === id);
    if (recentIdx >= 0) this.recentOps.splice(recentIdx, 1);

    if (hadActive || recentIdx >= 0) {
      this.emit();
    }
  }

  clearRecent(): void {
    if (this.recentOps.length === 0) return;
    this.recentOps = [];
    this.emit();
  }

  // ---- Helpers ------------------------------------------------------------

  /** Get a single operation by ID (from active or recent). */
  get(id: string): Operation | undefined {
    return this.opsById.get(id) ?? this.recentOps.find((o) => o.id === id);
  }

  private moveToRecent(
    id: string,
    status: OperationStatus,
    error?: string,
    action?: { label: string; onClick: () => void },
  ): void {
    const op = this.opsById.get(id);
    if (!op) return;

    this.opsById.delete(id);

    const terminal: Operation = {
      ...op,
      status,
      error: error ?? op.error,
      completedAtMs: Date.now(),
      action: action ?? op.action,
    };

    // Prepend (most recent first); evict oldest if over capacity.
    this.recentOps = [terminal, ...this.recentOps].slice(0, MAX_RECENT);
    this.emit();

    const code =
      status === 'complete' ? 'OP_COMPLETE'
      : status === 'warning' ? 'OP_WARNING'
      : status === 'error' ? 'OP_ERROR'
      : 'OP_CANCELLED';
    auditOperationEvent(code, `Operation ${status}: ${op.label}`, {
      operationId: id,
      kind: op.kind,
      durationMs: terminal.startedAtMs ? terminal.completedAtMs! - terminal.startedAtMs : undefined,
      error,
    });
  }
}

export const operationRegistryService = OperationRegistryService.getInstance();
