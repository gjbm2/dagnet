import { formatDateUK, parseUKDate } from '../lib/dateFormat';

export type UKReferenceDayProvider = () => string;

let provider: UKReferenceDayProvider = () => formatDateUK(new Date());

/**
 * Canonical "UK reference day" for dynamic DSL invalidation.
 *
 * Decision (dynamic-update.md): use `formatDateUK(new Date())` (UTC-normalised day string),
 * but route via a provider for test determinism.
 */
export const ukReferenceDayService = {
  getReferenceDayUK(): string {
    return provider();
  },

  /**
   * UTC-ms of the next day boundary for the current provider output.
   * This treats the reference day as a UTC-midnight day string.
   */
  getNextDayBoundaryMs(nowMs: number = Date.now()): number {
    const now = new Date(nowMs);
    const todayUK = provider();
    const today = parseUKDate(todayUK); // UTC midnight
    const next = new Date(today.getTime());
    next.setUTCDate(today.getUTCDate() + 1);
    // If the clock is already beyond next (shouldn't happen), still return next.
    const nextMs = next.getTime();
    return nextMs > now.getTime() ? nextMs : now.getTime() + 60_000;
  },

  /** Tests only. */
  __setProviderForTests(p: UKReferenceDayProvider): void {
    provider = p;
  },
};






