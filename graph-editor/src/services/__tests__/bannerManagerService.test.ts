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
});

