/**
 * toUTCMidnightFromLocalDate – timezone-safe "date-only" normalisation
 *
 * The invariant we need:
 * - UI date pickers often produce Date objects at *local* midnight.
 * - We must persist/query with UTC-midnight semantics without shifting the intended calendar day.
 *
 * This test is timezone-independent because we construct the input Date using
 * the local-calendar constructor (new Date(y, m, d)), then assert the resulting
 * UTC timestamp is for the same calendar day.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { formatDateUK, toUTCMidnightFromLocalDate } from '../dateFormat';

describe('toUTCMidnightFromLocalDate', () => {
  it('normalises a local-midnight Date to UTC midnight of the same local calendar day', () => {
    // Local midnight for 7-Oct-25 (month is 0-based)
    const localMidnight = new Date(2025, 9, 7, 0, 0, 0, 0);
    const utcMidnight = toUTCMidnightFromLocalDate(localMidnight);

    expect(utcMidnight.toISOString()).toBe('2025-10-07T00:00:00.000Z');
    expect(formatDateUK(utcMidnight)).toBe('7-Oct-25');
  });
});


