import React from 'react';

/**
 * AutomationBanner is now a no-op stub.
 *
 * The daily-automation job (dailyAutomationJob.ts) manages its own banner
 * via the scheduler's banner:automation presentation. The scheduler writes
 * to bannerManagerService directly; BannerHost renders it.
 *
 * This component is kept as an empty stub to avoid breaking imports.
 * It will be removed in Phase 6 cleanup.
 */
export function AutomationBanner(): React.ReactElement | null {
  return null;
}
