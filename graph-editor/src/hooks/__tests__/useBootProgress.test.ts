import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mock decisions
// ---------------------------------------------------------------------------

// sessionLogService: fire-and-forget audit. Mock assumes no state impact.
vi.mock('../../services/sessionLogService', () => ({
  sessionLogService: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    isLevelEnabled: vi.fn(() => false),
  },
}));

// operationRegistryService: REAL. The hook's entire purpose is to drive the registry.
// Window events: dispatched manually — no mock needed.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// We need fresh singleton + module state per test.
async function freshModules() {
  const { operationRegistryService } = await import('../../services/operationRegistryService');
  const { useBootProgress } = await import('../useBootProgress');
  return { registry: operationRegistryService, useBootProgress };
}

const BOOT_OP_ID = 'app:boot';

describe('useBootProgress', () => {
  beforeEach(() => {
    vi.resetModules();
    // Ensure the hot-reload guard is clear.
    delete (window as any).__dagnetTabContextInitDone;
  });

  afterEach(() => {
    delete (window as any).__dagnetTabContextInitDone;
  });

  it('should register a boot operation with label "Loading workspace…" and status running on mount', async () => {
    const { registry, useBootProgress } = await freshModules();

    renderHook(() => useBootProgress());

    const op = registry.get(BOOT_OP_ID);
    expect(op).toBeDefined();
    expect(op!.label).toBe('Loading workspace…');
    expect(op!.status).toBe('running');
    expect(op!.kind).toBe('boot');
  });

  it('should change label to "Loading files…" on tabContextInitDone but NOT complete', async () => {
    const { registry, useBootProgress } = await freshModules();

    renderHook(() => useBootProgress());

    window.dispatchEvent(new Event('dagnet:tabContextInitDone'));

    const op = registry.get(BOOT_OP_ID);
    expect(op!.label).toBe('Loading files…');
    // Still active — not complete yet.
    expect(op!.status).toBe('running');
  });

  it('should NOT complete when only navigatorLoadComplete fires (without tabContextInitDone)', async () => {
    const { registry, useBootProgress } = await freshModules();

    renderHook(() => useBootProgress());

    window.dispatchEvent(new CustomEvent('dagnet:navigatorLoadComplete'));

    const op = registry.get(BOOT_OP_ID);
    expect(op).toBeDefined();
    expect(op!.status).toBe('running');
  });

  it('should set label to "Workspace ready" and complete when BOTH events fire (tab first)', async () => {
    const { registry, useBootProgress } = await freshModules();

    renderHook(() => useBootProgress());

    window.dispatchEvent(new Event('dagnet:tabContextInitDone'));
    window.dispatchEvent(new CustomEvent('dagnet:navigatorLoadComplete'));

    const op = registry.get(BOOT_OP_ID);
    expect(op!.label).toBe('Workspace ready');
    expect(op!.status).toBe('complete');
  });

  it('should complete when BOTH events fire (navigator first, then tab)', async () => {
    const { registry, useBootProgress } = await freshModules();

    renderHook(() => useBootProgress());

    window.dispatchEvent(new CustomEvent('dagnet:navigatorLoadComplete'));
    window.dispatchEvent(new Event('dagnet:tabContextInitDone'));

    const op = registry.get(BOOT_OP_ID);
    expect(op!.label).toBe('Workspace ready');
    expect(op!.status).toBe('complete');
  });

  it('should not register a boot operation when __dagnetTabContextInitDone is already set (hot reload)', async () => {
    (window as any).__dagnetTabContextInitDone = true;

    const { registry, useBootProgress } = await freshModules();

    renderHook(() => useBootProgress());

    const op = registry.get(BOOT_OP_ID);
    expect(op).toBeUndefined();
  });

  it('should remove the operation from the registry on unmount if boot is still in progress', async () => {
    const { registry, useBootProgress } = await freshModules();

    const { unmount } = renderHook(() => useBootProgress());

    expect(registry.get(BOOT_OP_ID)).toBeDefined();

    unmount();

    expect(registry.get(BOOT_OP_ID)).toBeUndefined();
  });

  it('should NOT remove a completed boot operation on unmount', async () => {
    const { registry, useBootProgress } = await freshModules();

    const { unmount } = renderHook(() => useBootProgress());

    // Complete the boot.
    window.dispatchEvent(new Event('dagnet:tabContextInitDone'));
    window.dispatchEvent(new CustomEvent('dagnet:navigatorLoadComplete'));

    const op = registry.get(BOOT_OP_ID);
    expect(op!.status).toBe('complete');

    unmount();

    // Should still be in recent (complete), not removed.
    const afterUnmount = registry.get(BOOT_OP_ID);
    expect(afterUnmount).toBeDefined();
    expect(afterUnmount!.status).toBe('complete');
  });
});
