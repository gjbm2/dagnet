import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mocks must be declared before importing the module under test.
const parseQueryMock = vi.fn();
vi.mock('../../lib/graphComputeClient', () => ({
  graphComputeClient: {
    parseQuery: (...args: any[]) => parseQueryMock(...args),
  },
}));

const checkSnapshotHealthMock = vi.fn();
vi.mock('../snapshotWriteService', () => ({
  checkSnapshotHealth: (...args: any[]) => checkSnapshotHealthMock(...args),
}));

const getRepoInfoMock = vi.fn();
vi.mock('../gitService', () => ({
  gitService: {
    getRepoInfo: (...args: any[]) => getRepoInfoMock(...args),
  },
}));

import { runHealthCheck } from '../healthCheckService';

function setNavigatorOnline(value: boolean) {
  // happy-dom allows redefining navigator.onLine
  const nav: any = globalThis.navigator || {};
  Object.defineProperty(nav, 'onLine', { value, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
}

describe('healthCheckService.runHealthCheck', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    setNavigatorOnline(true);
    globalThis.fetch = vi.fn(async () => new Response('ok', { status: 200 })) as any;

    parseQueryMock.mockResolvedValue({
      from_node: 'a',
      to_node: 'b',
      exclude: [],
      visited: [],
      context: [],
      cases: [],
    });
    checkSnapshotHealthMock.mockResolvedValue({ status: 'ok', db: 'connected' });
    getRepoInfoMock.mockResolvedValue({ success: true, data: {}, message: 'ok' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns offline when navigator.onLine is false', async () => {
    setNavigatorOnline(false);

    const r = await runHealthCheck();
    expect(r.mode).toBe('offline');
    expect(r.isOnline).toBe(false);
    expect(r.checks.vercel.ok).toBe(false);
    expect(parseQueryMock).not.toHaveBeenCalled();
  });

  it('returns ok when all checks succeed', async () => {
    const r = await runHealthCheck();
    expect(r.mode).toBe('ok');
    expect(r.checks.vercel.ok).toBe(true);
    expect(r.checks.python.ok).toBe(true);
    expect(r.checks.db.ok).toBe(true);
    expect(r.checks.git.ok).toBe(true);
  });

  it('returns error when python check fails in online mode', async () => {
    parseQueryMock.mockRejectedValueOnce(new Error('boom'));
    const r = await runHealthCheck();
    expect(r.isOnline).toBe(true);
    expect(r.mode).toBe('error');
    expect(r.checks.python.ok).toBe(false);
  });

  it('returns error when db check fails in online mode', async () => {
    checkSnapshotHealthMock.mockResolvedValueOnce({ status: 'error', db: 'unavailable', error: 'bad' });
    const r = await runHealthCheck();
    expect(r.isOnline).toBe(true);
    expect(r.mode).toBe('error');
    expect(r.checks.db.ok).toBe(false);
  });

  it('returns error when git check fails in online mode', async () => {
    getRepoInfoMock.mockResolvedValueOnce({ success: false, error: 'nope' });
    const r = await runHealthCheck();
    expect(r.isOnline).toBe(true);
    expect(r.mode).toBe('error');
    expect(r.checks.git.ok).toBe(false);
  });
});

