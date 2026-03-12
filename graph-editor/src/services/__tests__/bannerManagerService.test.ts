import { describe, it, expect, vi } from 'vitest';
import { bannerManagerService } from '../bannerManagerService';

describe('bannerManagerService', () => {
  it('orders banners deterministically by priority desc then id asc', () => {
    bannerManagerService.clearAll();

    bannerManagerService.setBanner({ id: 'b', priority: 10, label: 'B' });
    bannerManagerService.setBanner({ id: 'a', priority: 10, label: 'A' });
    bannerManagerService.setBanner({ id: 'c', priority: 20, label: 'C' });

    const state = bannerManagerService.getState();
    expect(state.banners.map((b) => b.id)).toEqual(['c', 'a', 'b']);
  });

  it('replaces an existing banner with the same id (single owner)', () => {
    bannerManagerService.clearAll();

    bannerManagerService.setBanner({ id: 'automation', priority: 1, label: 'First' });
    bannerManagerService.setBanner({ id: 'automation', priority: 99, label: 'Second' });

    const state = bannerManagerService.getState();
    expect(state.banners).toHaveLength(1);
    expect(state.banners[0].label).toBe('Second');
    expect(state.banners[0].priority).toBe(99);
  });

  it('notifies subscribers on set/clear', () => {
    bannerManagerService.clearAll();
    const fn = vi.fn();
    const unsub = bannerManagerService.subscribe(fn);

    bannerManagerService.setBanner({ id: 'x', priority: 1, label: 'X' });
    bannerManagerService.clearBanner('x');

    unsub();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should empty all banners on clearAll and emit', () => {
    bannerManagerService.clearAll();

    bannerManagerService.setBanner({ id: 'a', priority: 1, label: 'A' });
    bannerManagerService.setBanner({ id: 'b', priority: 2, label: 'B' });

    const fn = vi.fn();
    const unsub = bannerManagerService.subscribe(fn);

    bannerManagerService.clearAll();
    unsub();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(bannerManagerService.getState().banners).toHaveLength(0);
  });

  it('should not emit when clearAll is called on an already empty store', () => {
    bannerManagerService.clearAll();

    const fn = vi.fn();
    const unsub = bannerManagerService.subscribe(fn);

    bannerManagerService.clearAll();
    unsub();

    expect(fn).not.toHaveBeenCalled();
  });

  it('should not emit when clearBanner is called with a non-existent ID', () => {
    bannerManagerService.clearAll();

    const fn = vi.fn();
    const unsub = bannerManagerService.subscribe(fn);

    bannerManagerService.clearBanner('does-not-exist');
    unsub();

    expect(fn).not.toHaveBeenCalled();
  });

  it('should stop calling a listener after unsubscribe', () => {
    bannerManagerService.clearAll();
    const fn = vi.fn();
    const unsub = bannerManagerService.subscribe(fn);

    bannerManagerService.setBanner({ id: 'x', priority: 1, label: 'X' });
    expect(fn).toHaveBeenCalledTimes(1);

    unsub();
    bannerManagerService.setBanner({ id: 'y', priority: 2, label: 'Y' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should return the same reference from getState when no mutations have occurred', () => {
    bannerManagerService.clearAll();
    bannerManagerService.setBanner({ id: 'a', priority: 1, label: 'A' });

    const first = bannerManagerService.getState();
    const second = bannerManagerService.getState();
    expect(first).toBe(second);
  });

  it('should return a new reference from getState after a mutation', () => {
    bannerManagerService.clearAll();
    bannerManagerService.setBanner({ id: 'a', priority: 1, label: 'A' });

    const before = bannerManagerService.getState();
    bannerManagerService.setBanner({ id: 'b', priority: 2, label: 'B' });
    const after = bannerManagerService.getState();

    expect(before).not.toBe(after);
  });
});

