import { useSyncExternalStore } from 'react';
import { bannerManagerService, type BannerManagerState } from '../services/bannerManagerService';

export function useBanners(): BannerManagerState {
  return useSyncExternalStore(
    (cb) => bannerManagerService.subscribe(cb),
    () => bannerManagerService.getState(),
    () => ({ banners: [] })
  );
}

