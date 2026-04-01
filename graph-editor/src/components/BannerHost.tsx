import React, { useEffect, useMemo } from 'react';
import { useBanners } from '../hooks/useBanners';
import { CountdownBanner } from './CountdownBanner';
import type { BannerSpec } from '../services/bannerManagerService';
import { operationRegistryService } from '../services/operationRegistryService';

const testParams = new URLSearchParams(window.location.search);
const showTestBanner = testParams.has('testbanner');
const showTestCountdown = testParams.has('testcountdown');

const TEST_BANNER: BannerSpec = {
  id: 'test-banner',
  priority: 999,
  label: 'New version available — reload to update',
  detail: 'Current: 1.9.2-beta → Available: 1.9.3-beta',
  actionLabel: 'Reload now',
  onAction: () => console.log('[test] reload clicked'),
  actionTitle: 'Reload to pick up the latest version',
};

const TEST_COUNTDOWN_BANNER: BannerSpec = {
  id: 'test-countdown',
  priority: 999,
  label: 'New version available — reloading shortly',
  detail: 'Current: 1.9.2-beta → Available: 1.9.3-beta',
  actionLabel: 'Reload now',
  onAction: () => console.log('[test] reload clicked'),
  operationId: 'test-countdown-op',
};

/**
 * Single owner for top-of-app banners.
 *
 * This exists to avoid ad-hoc per-hook stacking with inconsistent z-index and layout.
 */
export function BannerHost(): React.ReactElement | null {
  const { banners: liveBanners } = useBanners();

  // ?testcountdown — register a fake countdown operation that ticks down from 30s.
  useEffect(() => {
    if (!showTestCountdown) return;
    operationRegistryService.register({
      id: 'test-countdown-op',
      kind: 'session',
      label: 'Test countdown',
      status: 'countdown',
    });
    let remaining = 30;
    operationRegistryService.setCountdown('test-countdown-op', remaining);
    const interval = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(interval);
        console.log('[test] countdown expired — would reload');
        return;
      }
      operationRegistryService.setCountdown('test-countdown-op', remaining);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const testBanner = showTestCountdown ? TEST_COUNTDOWN_BANNER : showTestBanner ? TEST_BANNER : null;
  const banners = useMemo(
    () => testBanner ? [testBanner, ...liveBanners] : liveBanners,
    [liveBanners, testBanner],
  );
  if (!banners.length) return null;

  return (
    <>
      {banners.map((b) => (
        <CountdownBanner
          key={b.id}
          label={b.label}
          detail={b.detail}
          actionLabel={b.actionLabel}
          onAction={b.onAction}
          actionDisabled={b.actionDisabled}
          actionTitle={b.actionTitle}
          operationId={b.operationId}
        />
      ))}
    </>
  );
}

