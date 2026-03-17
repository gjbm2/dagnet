import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock decisions
// ---------------------------------------------------------------------------

// sessionLogService: fire-and-forget audit. Mock assumes no state impact.
vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

// repositoryOperationsService: network/git boundary — the ONE thing we mock.
// After the regression fix, nonBlockingPullService uses pullLatest (3-way merge)
// instead of pullLatestRemoteWins (which silently overwrote dirty files).
const mockPullLatest = vi.fn();
vi.mock('../repositoryOperationsService', () => ({
  repositoryOperationsService: {
    pullLatest: (...args: any[]) => mockPullLatest(...args),
  },
}));

// gitService: external boundary. We mock dispatchGitAuthExpired to verify it's
// called on auth errors without triggering real CustomEvents.
const mockDispatchGitAuthExpired = vi.fn();
vi.mock('../gitService', () => ({
  dispatchGitAuthExpired: (...args: any[]) => mockDispatchGitAuthExpired(...args),
}));

// operationRegistryService and countdownService: REAL.
// The integration between pull, registry, and countdown is where bugs live.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// We need fresh singletons per test to avoid cross-pollution of the module-level
// `activePullOpId` state in nonBlockingPullService.
async function freshModules() {
  const { operationRegistryService } = await import('../operationRegistryService');
  const { countdownService } = await import('../countdownService');
  const { startNonBlockingPull, cancelNonBlockingPull, isNonBlockingPullActive } = await import(
    '../nonBlockingPullService'
  );
  return {
    registry: operationRegistryService,
    countdown: countdownService,
    startNonBlockingPull,
    cancelNonBlockingPull,
    isNonBlockingPullActive,
  };
}

describe('nonBlockingPullService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    mockPullLatest.mockReset();
    mockDispatchGitAuthExpired.mockReset();
    // Default: successful pull with no conflicts.
    mockPullLatest.mockResolvedValue({ success: true, conflicts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------- Registration ----------

  it('should register a countdown operation in the registry with correct ID, kind, and status', async () => {
    const { registry, startNonBlockingPull } = await freshModules();

    const opId = startNonBlockingPull({ repository: 'my-repo', branch: 'main' });

    expect(opId).toBe('auto-pull:my-repo:main');
    const op = registry.get(opId!);
    expect(op).toBeDefined();
    expect(op!.kind).toBe('auto-pull');
    expect(op!.status).toBe('countdown');
    expect(op!.cancellable).toBe(true);
    expect(op!.countdownSecondsRemaining).toBe(15); // default
  });

  it('should use custom countdown duration when provided', async () => {
    const { registry, startNonBlockingPull } = await freshModules();

    startNonBlockingPull({ repository: 'r', branch: 'b', countdownSeconds: 30 });

    const op = registry.get('auto-pull:r:b');
    expect(op!.countdownSecondsRemaining).toBe(30);
  });

  // ---------- Duplicate prevention ----------

  it('should return undefined and not create a second operation when one is already active', async () => {
    const { registry, startNonBlockingPull } = await freshModules();

    const first = startNonBlockingPull({ repository: 'r', branch: 'b' });
    const second = startNonBlockingPull({ repository: 'r', branch: 'b' });

    expect(first).toBe('auto-pull:r:b');
    expect(second).toBeUndefined();

    // Only one operation in the registry.
    const state = registry.getState();
    expect(state.active.filter((o) => o.kind === 'auto-pull')).toHaveLength(1);
  });

  it('should allow a new pull after the previous one reached a terminal state', async () => {
    const { startNonBlockingPull, cancelNonBlockingPull } = await freshModules();

    startNonBlockingPull({ repository: 'r', branch: 'b' });
    cancelNonBlockingPull();

    const second = startNonBlockingPull({ repository: 'r', branch: 'b' });
    expect(second).toBe('auto-pull:r:b');
  });

  // ---------- Countdown expiry triggers pull ----------

  it('should call pullLatest (3-way merge) with correct repo and branch when countdown expires', async () => {
    const { startNonBlockingPull } = await freshModules();

    startNonBlockingPull({ repository: 'my-repo', branch: 'main', countdownSeconds: 5 });

    // Advance past countdown.
    vi.advanceTimersByTime(5000);
    await vi.advanceTimersByTimeAsync(0);

    expect(mockPullLatest).toHaveBeenCalledWith('my-repo', 'main');
  });

  // ---------- Successful pull ----------

  it('should transition to complete and fire onComplete callback on successful pull', async () => {
    const { registry, startNonBlockingPull } = await freshModules();
    const onComplete = vi.fn();

    const opId = startNonBlockingPull({
      repository: 'r',
      branch: 'b',
      countdownSeconds: 2,
      onComplete,
    })!;

    vi.advanceTimersByTime(2000);
    await vi.advanceTimersByTimeAsync(0);
    // Let the async executePull resolve.
    await vi.advanceTimersByTimeAsync(0);

    const op = registry.get(opId);
    expect(op!.status).toBe('complete');
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  // ---------- Pull with conflicts ----------

  it('should surface unresolved conflicts as an error status (not auto-resolve them)', async () => {
    mockPullLatest.mockResolvedValue({
      success: true,
      conflicts: [
        { fileId: 'parameter-a', fileName: 'a.yaml' },
        { fileId: 'parameter-b', fileName: 'b.yaml' },
        { fileId: 'parameter-c', fileName: 'c.yaml' },
      ],
    });
    const { registry, startNonBlockingPull } = await freshModules();

    const opId = startNonBlockingPull({ repository: 'r', branch: 'b', countdownSeconds: 1 })!;

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    const op = registry.get(opId);
    // Conflicts must be surfaced as an error so the user notices and resolves manually.
    expect(op!.status).toBe('error');
    expect(op!.error).toContain('Merge conflicts');
    expect(op!.error).toContain('a.yaml');
  });

  it('should NOT fire onComplete when there are unresolved conflicts', async () => {
    mockPullLatest.mockResolvedValue({
      success: true,
      conflicts: [{ fileId: 'parameter-x', fileName: 'x.yaml' }],
    });
    const { startNonBlockingPull } = await freshModules();
    const onComplete = vi.fn();

    startNonBlockingPull({
      repository: 'r',
      branch: 'b',
      countdownSeconds: 1,
      onComplete,
    });

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // onComplete must NOT fire — cascaded operations (retrieve-all) must not
    // run on top of unresolved conflicts.
    expect(onComplete).not.toHaveBeenCalled();
  });

  // ---------- Pull failure ----------

  it('should transition to error with message when pull fails', async () => {
    mockPullLatest.mockRejectedValue(new Error('Auth expired'));
    const { registry, startNonBlockingPull } = await freshModules();

    const opId = startNonBlockingPull({ repository: 'r', branch: 'b', countdownSeconds: 1 })!;

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    const op = registry.get(opId);
    expect(op!.status).toBe('error');
    expect(op!.error).toContain('Auth expired');
  });

  // ---------- Cancel ----------

  it('should cancel the countdown and mark operation cancelled, firing onDismiss', async () => {
    const { registry, startNonBlockingPull, cancelNonBlockingPull } = await freshModules();
    const onDismiss = vi.fn();

    const opId = startNonBlockingPull({
      repository: 'r',
      branch: 'b',
      countdownSeconds: 10,
      onDismiss,
    })!;

    // Cancel via the operation's own onCancel callback (simulates toast cancel button).
    const op = registry.get(opId)!;
    op.onCancel!();

    const cancelled = registry.get(opId);
    expect(cancelled!.status).toBe('cancelled');
    expect(onDismiss).toHaveBeenCalledTimes(1);

    // Pull should never execute.
    vi.advanceTimersByTime(15000);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockPullLatest).not.toHaveBeenCalled();
  });

  it('should safely no-op when cancelNonBlockingPull is called with nothing active', async () => {
    const { cancelNonBlockingPull } = await freshModules();

    // Should not throw.
    expect(() => cancelNonBlockingPull()).not.toThrow();
  });

  // ---------- isNonBlockingPullActive ----------

  it('should reflect current lifecycle state accurately', async () => {
    const { startNonBlockingPull, cancelNonBlockingPull, isNonBlockingPullActive } =
      await freshModules();

    expect(isNonBlockingPullActive()).toBe(false);

    startNonBlockingPull({ repository: 'r', branch: 'b', countdownSeconds: 5 });
    expect(isNonBlockingPullActive()).toBe(true);

    cancelNonBlockingPull();
    expect(isNonBlockingPullActive()).toBe(false);
  });

  it('should report inactive after pull completes', async () => {
    const { startNonBlockingPull, isNonBlockingPullActive } = await freshModules();

    startNonBlockingPull({ repository: 'r', branch: 'b', countdownSeconds: 1 });

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(isNonBlockingPullActive()).toBe(false);
  });

  // ---------- Countdown ticks sync to registry ----------

  it('should sync countdown ticks from countdownService into the operation registry', async () => {
    const { registry, startNonBlockingPull } = await freshModules();

    const opId = startNonBlockingPull({ repository: 'r', branch: 'b', countdownSeconds: 10 })!;

    vi.advanceTimersByTime(3000);

    const op = registry.get(opId);
    // Should have ticked down from 10 to ~7.
    expect(op!.countdownSecondsRemaining).toBeLessThanOrEqual(7);
    expect(op!.countdownSecondsRemaining).toBeGreaterThanOrEqual(6);
  });

  // ---------- Conflict action: onConflicts callback and toast action ----------

  it('should NOT call onConflicts immediately — background pull must not hijack the screen', async () => {
    const conflictData = [
      { fileId: 'param-a', fileName: 'a.yaml', hasConflicts: true },
      { fileId: 'param-b', fileName: 'b.yaml', hasConflicts: true },
    ];
    mockPullLatest.mockResolvedValue({ success: true, conflicts: conflictData });

    const { startNonBlockingPull } = await freshModules();
    const onConflicts = vi.fn();

    startNonBlockingPull({
      repository: 'r', branch: 'b', countdownSeconds: 1,
      onConflicts,
    });

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // Auto-pull is background — onConflicts must NOT fire automatically.
    // User opens the modal via the toast "Resolve conflicts" action instead.
    expect(onConflicts).not.toHaveBeenCalled();
  });

  it('should attach a "Resolve conflicts" action to the operation when onConflicts is provided', async () => {
    mockPullLatest.mockResolvedValue({
      success: true,
      conflicts: [{ fileId: 'param-x', fileName: 'x.yaml' }],
    });

    const { registry, startNonBlockingPull } = await freshModules();
    const onConflicts = vi.fn();

    const opId = startNonBlockingPull({
      repository: 'r', branch: 'b', countdownSeconds: 1,
      onConflicts,
    })!;

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    const op = registry.get(opId);
    expect(op!.action).toBeDefined();
    expect(op!.action!.label).toBe('Resolve conflicts');

    // Clicking the action should re-invoke onConflicts (re-opens modal after dismiss).
    onConflicts.mockClear();
    op!.action!.onClick();
    expect(onConflicts).toHaveBeenCalledTimes(1);
    expect(onConflicts).toHaveBeenCalledWith([{ fileId: 'param-x', fileName: 'x.yaml' }], opId);
  });

  it('should NOT attach an action when onConflicts is not provided (backward compat)', async () => {
    mockPullLatest.mockResolvedValue({
      success: true,
      conflicts: [{ fileId: 'param-x', fileName: 'x.yaml' }],
    });

    const { registry, startNonBlockingPull } = await freshModules();

    const opId = startNonBlockingPull({ repository: 'r', branch: 'b', countdownSeconds: 1 })!;

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    const op = registry.get(opId);
    expect(op!.status).toBe('error');
    expect(op!.action).toBeUndefined();
  });

  // ---------- GitAuthError handling ----------

  it('should dispatch auth expired and attach "Sign in" action on GitAuthError', async () => {
    const authError = new Error('Token expired');
    (authError as any).name = 'GitAuthError';
    mockPullLatest.mockRejectedValue(authError);

    const { registry, startNonBlockingPull } = await freshModules();

    const opId = startNonBlockingPull({ repository: 'r', branch: 'b', countdownSeconds: 1 })!;

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    const op = registry.get(opId);
    expect(op!.status).toBe('error');
    expect(op!.error).toBe('Authentication expired');

    // dispatchGitAuthExpired must have been called immediately.
    expect(mockDispatchGitAuthExpired).toHaveBeenCalledTimes(1);

    // Action button must allow re-triggering auth modal.
    expect(op!.action).toBeDefined();
    expect(op!.action!.label).toBe('Sign in');

    mockDispatchGitAuthExpired.mockClear();
    op!.action!.onClick();
    expect(mockDispatchGitAuthExpired).toHaveBeenCalledTimes(1);
  });

  it('should distinguish GitAuthError from generic pull errors', async () => {
    const genericError = new Error('Network timeout');
    mockPullLatest.mockRejectedValue(genericError);

    const { registry, startNonBlockingPull } = await freshModules();

    const opId = startNonBlockingPull({ repository: 'r', branch: 'b', countdownSeconds: 1 })!;

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    const op = registry.get(opId);
    expect(op!.status).toBe('error');
    expect(op!.error).toContain('Network timeout');
    // Generic errors should NOT have an action or trigger auth flow.
    expect(op!.action).toBeUndefined();
    expect(mockDispatchGitAuthExpired).not.toHaveBeenCalled();
  });

  // ---------- Conflict loop prevention (regression: infinite pull → conflicts → pull) ----------

  it('should call onDismiss after conflicts to dismiss the remote SHA and prevent re-trigger loop', async () => {
    mockPullLatest.mockResolvedValue({
      success: true,
      conflicts: [{ fileId: 'param-a', fileName: 'a.yaml' }],
    });
    const { startNonBlockingPull } = await freshModules();
    const onDismiss = vi.fn();
    const onConflicts = vi.fn();

    startNonBlockingPull({
      repository: 'r', branch: 'b', countdownSeconds: 1,
      onDismiss,
      onConflicts,
    });

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // onDismiss must fire so the remote SHA is dismissed in staleness detection.
    // Without this, maybePrompt() sees gitPullDue=true again and starts another pull.
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // onConflicts must NOT fire — background pull doesn't auto-open the modal.
    expect(onConflicts).not.toHaveBeenCalled();
  });

  it('should NOT call onDismiss on successful pull (SHA is naturally cleared by onComplete)', async () => {
    mockPullLatest.mockResolvedValue({ success: true, conflicts: [] });
    const { startNonBlockingPull } = await freshModules();
    const onDismiss = vi.fn();
    const onComplete = vi.fn();

    startNonBlockingPull({
      repository: 'r', branch: 'b', countdownSeconds: 1,
      onDismiss,
      onComplete,
    });

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(onDismiss).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('should report isNonBlockingPullActive=true during the async pull execution', async () => {
    // Make pullLatest hang until we resolve it manually.
    let resolvePull!: (v: any) => void;
    mockPullLatest.mockReturnValue(new Promise((r) => { resolvePull = r; }));

    const { startNonBlockingPull, isNonBlockingPullActive } = await freshModules();

    startNonBlockingPull({ repository: 'r', branch: 'b', countdownSeconds: 1 });

    // Expire countdown to start the pull.
    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);

    // Pull is in-flight — must block re-entry.
    expect(isNonBlockingPullActive()).toBe(true);

    // Resolve the pull.
    resolvePull({ success: true, conflicts: [] });
    await vi.advanceTimersByTimeAsync(0);

    expect(isNonBlockingPullActive()).toBe(false);
  });

  it('should allow a new pull after previous one completed with conflicts', async () => {
    mockPullLatest.mockResolvedValue({
      success: true,
      conflicts: [{ fileId: 'param-a', fileName: 'a.yaml' }],
    });

    const { startNonBlockingPull } = await freshModules();

    startNonBlockingPull({ repository: 'r', branch: 'b', countdownSeconds: 1 });

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // Now start a new pull (e.g. user resolved conflicts, new SHA detected).
    mockPullLatest.mockResolvedValue({ success: true, conflicts: [] });
    const second = startNonBlockingPull({ repository: 'r', branch: 'b', countdownSeconds: 1 });

    // Must succeed — terminal 'error' state should not permanently block.
    expect(second).toBe('auto-pull:r:b');
  });

  // ---------- Status transitions during pull ----------

  it('should transition through countdown → running → complete lifecycle', async () => {
    const { registry, startNonBlockingPull } = await freshModules();
    const statuses: string[] = [];

    const opId = startNonBlockingPull({ repository: 'r', branch: 'b', countdownSeconds: 2 })!;

    // Record status at key moments.
    statuses.push(registry.get(opId)!.status);

    vi.advanceTimersByTime(2000);
    await vi.advanceTimersByTimeAsync(0);
    // After countdown expires, should be running (before pull resolves).
    const midOp = registry.get(opId);
    if (midOp) statuses.push(midOp.status);

    // Let the pull resolve.
    await vi.advanceTimersByTimeAsync(0);
    statuses.push(registry.get(opId)!.status);

    expect(statuses[0]).toBe('countdown');
    // Last status should be complete.
    expect(statuses[statuses.length - 1]).toBe('complete');
  });
});
