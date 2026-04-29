import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerCanvasAnalysisRefresh,
  unregisterCanvasAnalysisRefresh,
  refreshCanvasAnalysis,
} from '../canvasAnalysisRefreshRegistry';
import { graphComputeClient } from '../../lib/graphComputeClient';

describe('canvasAnalysisRefreshRegistry', () => {
  let clearCacheSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearCacheSpy = vi.spyOn(graphComputeClient, 'clearCache').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete (window as any).__dagnetComputeNoCacheOnce;
  });

  afterEach(() => {
    clearCacheSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('calls the registered refresh fn for the matching analysis id', () => {
    const fn = vi.fn();
    registerCanvasAnalysisRefresh('A', fn);
    refreshCanvasAnalysis('A');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('purges graphComputeClient cache and sets the one-shot bypass flag', () => {
    registerCanvasAnalysisRefresh('A', () => {});
    refreshCanvasAnalysis('A');
    expect(clearCacheSpy).toHaveBeenCalledTimes(1);
    expect((window as any).__dagnetComputeNoCacheOnce).toBe(true);
  });

  it('warns and still purges caches when no hook is registered', () => {
    refreshCanvasAnalysis('UNREGISTERED');
    expect(clearCacheSpy).toHaveBeenCalledTimes(1);
    expect((window as any).__dagnetComputeNoCacheOnce).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('isolates refresh fns per analysis id', () => {
    const fnA = vi.fn();
    const fnB = vi.fn();
    registerCanvasAnalysisRefresh('A', fnA);
    registerCanvasAnalysisRefresh('B', fnB);
    refreshCanvasAnalysis('A');
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).not.toHaveBeenCalled();
  });

  it('only unregisters the matching fn (guards against unmount-after-remount races)', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    registerCanvasAnalysisRefresh('A', fn1);
    registerCanvasAnalysisRefresh('A', fn2);
    unregisterCanvasAnalysisRefresh('A', fn1);
    refreshCanvasAnalysis('A');
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('removes the fn cleanly when unregistered', () => {
    const fn = vi.fn();
    registerCanvasAnalysisRefresh('A', fn);
    unregisterCanvasAnalysisRefresh('A', fn);
    refreshCanvasAnalysis('A');
    expect(fn).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });
});
