import React from 'react';
import { useBanners } from '../hooks/useBanners';
import { CountdownBanner } from './CountdownBanner';

/**
 * Single owner for top-of-app banners.
 *
 * This exists to avoid ad-hoc per-hook stacking with inconsistent z-index and layout.
 */
export function BannerHost(): React.ReactElement | null {
  const { banners } = useBanners();
  if (!banners.length) return null;

  const rowHeight = 40; // px (matches CountdownBanner padding/line-height reasonably)

  return (
    <>
      {banners.map((b, idx) => (
        <CountdownBanner
          key={b.id}
          label={b.label}
          detail={b.detail}
          actionLabel={b.actionLabel}
          onAction={b.onAction}
          actionDisabled={b.actionDisabled}
          actionTitle={b.actionTitle}
          topPx={idx * rowHeight}
          zIndex={2000 - idx}
        />
      ))}
    </>
  );
}

