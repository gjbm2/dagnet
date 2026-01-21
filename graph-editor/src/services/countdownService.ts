export interface CountdownState {
  key: string;
  /** Seconds remaining (integer, >= 0). */
  secondsRemaining: number;
  /** True while the countdown is actively ticking. */
  isActive: boolean;
}

type CountdownListener = () => void;

export interface CountdownAuditConfig {
  /** Session log channel/type (e.g. 'session', 'git', 'file'). */
  operationType: Parameters<typeof import('./sessionLogService').sessionLogService.info>[0];
  /** Emitted when a countdown starts. */
  startCode: string;
  /** Emitted when a countdown is cancelled by a caller. */
  cancelCode: string;
  /** Emitted when a countdown expires naturally. */
  expireCode: string;
  /** Human-readable base message (we add key + seconds). */
  message: string;
  /** Extra metadata to attach. */
  metadata?: Record<string, unknown>;
}

function auditCountdownEvent(
  audit: CountdownAuditConfig,
  code: string,
  payload: Record<string, unknown>
): void {
  // IMPORTANT: This is fire-and-forget and must never crash the app if logging is unavailable.
  // Use dynamic import so this module does not rely on `require()` in the browser.
  void import('./sessionLogService')
    .then(({ sessionLogService }) => {
      sessionLogService.info(audit.operationType, code, audit.message, undefined, payload);
    })
    .catch(() => {
      // ignore
    });
}

interface StartCountdownOptions {
  key: string;
  durationSeconds: number;
  /**
   * Called exactly once when the countdown reaches 0.
   * The countdown is automatically cleared before invoking this callback.
   */
  onExpire?: () => void | Promise<void>;
  /** Optional structured audit events into Session Log. */
  audit?: CountdownAuditConfig;
}

class CountdownService {
  private static instance: CountdownService;

  static getInstance(): CountdownService {
    if (!CountdownService.instance) {
      CountdownService.instance = new CountdownService();
    }
    return CountdownService.instance;
  }

  private stateByKey = new Map<string, CountdownState>();
  private listeners = new Set<CountdownListener>();
  private timeoutByKey = new Map<string, number>();
  private onExpireByKey = new Map<string, () => void | Promise<void>>();
  private runIdByKey = new Map<string, number>();
  private auditByKey = new Map<string, CountdownAuditConfig>();

  subscribe(listener: CountdownListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  getState(key: string): CountdownState | undefined {
    return this.stateByKey.get(key);
  }

  startCountdown(options: StartCountdownOptions): void {
    const { key, durationSeconds } = options;
    const seconds = Math.max(0, Math.floor(durationSeconds));

    // Restart semantics: clear any existing timer for the same key (do not log as "cancel").
    this.clearCountdown(key, 'restart');

    const runId = (this.runIdByKey.get(key) ?? 0) + 1;
    this.runIdByKey.set(key, runId);

    this.stateByKey.set(key, { key, secondsRemaining: seconds, isActive: seconds > 0 });
    if (options.onExpire) this.onExpireByKey.set(key, options.onExpire);
    if (options.audit) this.auditByKey.set(key, options.audit);
    this.emit();

    if (options.audit) {
      auditCountdownEvent(options.audit, options.audit.startCode, {
        key,
        seconds,
        ...options.audit.metadata,
      });
    }

    if (seconds <= 0) {
      // Expire immediately, but async to avoid surprising re-entrancy.
      queueMicrotask(() => void this.expireNow(key, runId));
      return;
    }

    this.scheduleTick(key, runId);
  }

  cancelCountdown(key: string): void {
    this.clearCountdown(key, 'cancel');
  }

  cancelCountdownsByPrefix(prefix: string): void {
    const keys = Array.from(this.stateByKey.keys()).filter((k) => k.startsWith(prefix));
    for (const k of keys) this.cancelCountdown(k);
  }

  private scheduleTick(key: string, runId: number): void {
    // Replace any existing scheduled tick for this key.
    const existing = this.timeoutByKey.get(key);
    if (existing !== undefined) {
      window.clearTimeout(existing);
      this.timeoutByKey.delete(key);
    }

    const timeoutId = window.setTimeout(() => {
      if (this.runIdByKey.get(key) !== runId) return;
      const current = this.stateByKey.get(key);
      if (!current || !current.isActive) return;

      const next = Math.max(0, current.secondsRemaining - 1);
      if (next <= 0) {
        void this.expireNow(key, runId);
        return;
      }

      this.stateByKey.set(key, { key, secondsRemaining: next, isActive: true });
      this.emit();
      this.scheduleTick(key, runId);
    }, 1000);

    this.timeoutByKey.set(key, timeoutId);
  }

  private async expireNow(key: string, runId: number): Promise<void> {
    // If the countdown was cancelled/restarted, ignore this expiry attempt.
    if (this.runIdByKey.get(key) !== runId) return;

    // Capture callback before clearing so we can still run it.
    const fn = this.onExpireByKey.get(key);
    // Clear first so consumers don't accidentally re-trigger.
    this.clearCountdown(key, 'expire');
    if (fn) {
      try {
        await fn();
      } catch {
        // Best-effort only; the caller should handle errors via their own logging.
      }
    }
  }

  private clearCountdown(key: string, reason: 'cancel' | 'expire' | 'restart'): void {
    // Bump runId so any in-flight expiry callbacks from a prior run are ignored.
    this.runIdByKey.set(key, (this.runIdByKey.get(key) ?? 0) + 1);

    const timeoutId = this.timeoutByKey.get(key);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      this.timeoutByKey.delete(key);
    }
    this.onExpireByKey.delete(key);

    const hadState = this.stateByKey.has(key);
    const audit = this.auditByKey.get(key);
    this.auditByKey.delete(key);

    if (hadState) {
      this.stateByKey.delete(key);
      this.emit();
    }

    if (audit && reason !== 'restart') {
      const code = reason === 'cancel' ? audit.cancelCode : audit.expireCode;
      auditCountdownEvent(audit, code, { key, reason, ...audit.metadata });
    }
  }
}

export const countdownService = CountdownService.getInstance();

