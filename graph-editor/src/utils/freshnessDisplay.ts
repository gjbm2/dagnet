/**
 * Freshness display utilities — relative time formatting and age colour-coding.
 *
 * Converts timestamps to user-friendly relative strings ("3 hours ago")
 * and maps age to a colour spectrum (green → neutral → amber → red).
 */

// ── Age thresholds (ms) ─────────────────────────────────────

const HOUR = 3_600_000;
const DAY = 86_400_000;

const AGE_FRESH = DAY;          // < 24h = neutral (current)
const AGE_STALE = 3 * DAY;      // > 3d = red

// ── Relative time formatting ────────────────────────────────

/**
 * Format a timestamp as a relative time string.
 * Returns null if the timestamp can't be parsed.
 */
export function formatRelativeTime(timestamp: string | number | Date | null | undefined): string | null {
  if (timestamp == null) return null;

  let ms: number;
  if (typeof timestamp === 'number') {
    ms = timestamp;
  } else if (timestamp instanceof Date) {
    ms = timestamp.getTime();
  } else {
    // Try ISO parse first, then UK date format (d-MMM-yy)
    ms = Date.parse(timestamp);
    if (isNaN(ms)) {
      ms = parseUkDate(timestamp);
    }
  }

  if (isNaN(ms) || ms <= 0) return null;

  const age = Date.now() - ms;
  if (age < 0) return 'just now';

  if (age < 60_000) return 'just now';
  if (age < HOUR) {
    const mins = Math.floor(age / 60_000);
    return `${mins}m ago`;
  }
  if (age < DAY) {
    const hours = Math.floor(age / HOUR);
    return `${hours}h ago`;
  }
  if (age < 30 * DAY) {
    const days = Math.floor(age / DAY);
    return `${days}d ago`;
  }
  const months = Math.floor(age / (30 * DAY));
  return `${months}mo ago`;
}

/**
 * Parse UK date format "d-MMM-yy" (e.g. "18-Mar-26") to epoch ms.
 * Returns NaN on failure.
 */
function parseUkDate(s: string): number {
  const MONTHS: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const m = s.match(/^(\d{1,2})-(\w{3})-(\d{2})$/);
  if (!m) return NaN;
  const day = parseInt(m[1], 10);
  const month = MONTHS[m[2]];
  const year = 2000 + parseInt(m[3], 10);
  if (month == null || isNaN(day) || isNaN(year)) return NaN;
  return new Date(year, month, day).getTime();
}

// ── Age colour coding ───────────────────────────────────────

export type FreshnessLevel = 'current' | 'stale' | 'very-stale' | 'unknown';

/**
 * Classify a timestamp's age into a freshness level.
 * < 24h: current (neutral), 24h–3d: stale (amber), > 3d: very-stale (red)
 */
export function getFreshnessLevel(timestamp: string | number | Date | null | undefined): FreshnessLevel {
  if (timestamp == null) return 'unknown';

  let ms: number;
  if (typeof timestamp === 'number') {
    ms = timestamp;
  } else if (timestamp instanceof Date) {
    ms = timestamp.getTime();
  } else {
    ms = Date.parse(timestamp);
    if (isNaN(ms)) ms = parseUkDate(timestamp);
  }

  if (isNaN(ms) || ms <= 0) return 'unknown';

  const age = Date.now() - ms;
  if (age < AGE_FRESH) return 'current';
  if (age < AGE_STALE) return 'stale';
  return 'very-stale';
}

const FRESHNESS_COLOURS: Record<FreshnessLevel, { light: string; dark: string }> = {
  'current':    { light: '#6b7280', dark: '#9ca3af' },   // Neutral grey
  'stale':      { light: '#d97706', dark: '#f59e0b' },   // Amber
  'very-stale': { light: '#dc2626', dark: '#ef4444' },   // Red
  'unknown':    { light: '#9ca3af', dark: '#6b7280' },   // Muted grey
};

/**
 * Get the display colour for a freshness level.
 */
export function freshnessColour(level: FreshnessLevel, theme: 'light' | 'dark' = 'dark'): string {
  return FRESHNESS_COLOURS[level]?.[theme] ?? FRESHNESS_COLOURS.unknown[theme];
}
