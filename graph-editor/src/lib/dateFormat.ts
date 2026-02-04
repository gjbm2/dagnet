/**
 * Date Formatting Utilities
 * 
 * All dates in context DSL MUST use d-MMM-yy format (unambiguous).
 * Examples: 1-Jan-25, 15-Mar-25, 31-Dec-25
 */

/**
 * Format date to d-MMM-yy (e.g., "1-Jan-25", "15-Mar-25")
 * 
 * @param date - Date object or ISO string (YYYY-MM-DD or ISO 8601)
 * @returns Formatted date string
 */
export function formatDateUK(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }
  
  // CRITICAL: Use UTC getters to avoid timezone issues
  // When parsing ISO date strings (e.g., "2025-10-11"), JS treats them as UTC midnight.
  // Using getDate()/getMonth() returns LOCAL time, which can shift the date!
  // Example: "2025-10-11" at UTC midnight = Oct 10 at 7pm EST → getDate() returns 10, not 11!
  const day = d.getUTCDate(); // 1-31 (no leading zero), in UTC
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getUTCMonth()]; // 0-11, in UTC
  const year = String(d.getUTCFullYear()).slice(-2); // Last 2 digits, in UTC
  
  return `${day}-${month}-${year}`;
}

/**
 * Normalise a Date (which typically represents a user's local "calendar day" selection)
 * to a Date at UTC midnight for that same local calendar day.
 *
 * Why this exists:
 * - UI date pickers commonly produce Date objects at *local* midnight.
 * - If we then format using UTC getters, timezones ahead of UTC can appear as "previous day".
 * - This helper preserves the user's intended day while keeping the rest of DagNet on UTC-midnight semantics.
 */
export function toUTCMidnightFromLocalDate(date: Date): Date {
  // Interpret the Date's *local* calendar components, then re-create at UTC midnight.
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

/**
 * Parse d-MMM-yy date to Date object (in UTC)
 * 
 * IMPORTANT: Returns a UTC date to avoid timezone issues when converting to ISO string.
 * For "1-Oct-25", this returns 2025-10-01T00:00:00.000Z regardless of local timezone.
 * 
 * @param dateStr - Date in d-MMM-yy format (e.g., "1-Jan-25")
 * @returns Date object (UTC midnight)
 */
export function parseUKDate(dateStr: string): Date {
  // Format: d-MMM-yy (e.g., "1-Jan-25", "15-Mar-25")
  const parts = dateStr.split('-');
  if (parts.length !== 3) {
    throw new Error(`Invalid d-MMM-yy format: ${dateStr}`);
  }
  
  const day = parseInt(parts[0], 10);
  const monthStr = parts[1];
  const yearShort = parseInt(parts[2], 10);
  
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months.indexOf(monthStr);
  
  if (month === -1) {
    throw new Error(`Invalid month: ${monthStr}`);
  }
  
  // Assume 2000s for years 00-50, 1900s for 51-99
  const year = yearShort < 50 ? 2000 + yearShort : 1900 + yearShort;
  
  // CRITICAL: Use Date.UTC to create UTC midnight, not local midnight
  // This ensures "1-Oct-25" → "2025-10-01T00:00:00.000Z" regardless of user's timezone
  return new Date(Date.UTC(year, month, day));
}

/**
 * Check if a string is in ISO date format (YYYY-MM-DD)
 */
export function isISODate(dateStr: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(dateStr);
}

/**
 * Check if a string is in UK date format (d-MMM-yy)
 */
export function isUKDate(dateStr: string): boolean {
  return /^\d{1,2}-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2}$/.test(dateStr);
}

/**
 * Convert UK date (d-MMM-yy) to ISO date (YYYY-MM-DD) for API calls
 * 
 * @param ukDate - Date in d-MMM-yy format (e.g., "1-Dec-25")
 * @returns ISO date string (e.g., "2025-12-01")
 */
export function toISO(ukDate: string): string {
  if (isISODate(ukDate)) {
    return ukDate.split('T')[0]; // Already ISO, just strip time if present
  }
  const d = parseUKDate(ukDate);
  return d.toISOString().split('T')[0];
}

/**
 * Convert ISO date (YYYY-MM-DD) to UK date (d-MMM-yy) from API responses
 * 
 * @param isoDate - ISO date string (e.g., "2025-12-01")
 * @returns UK date string (e.g., "1-Dec-25")
 */
export function fromISO(isoDate: string): string {
  if (isUKDate(isoDate)) {
    return isoDate; // Already UK format
  }
  return formatDateUK(isoDate);
}

/**
 * Normalize any date format to UK format (d-MMM-yy)
 * Accepts either ISO (YYYY-MM-DD) or UK (d-MMM-yy) and returns UK format.
 * Also handles hybrid formats like "1-Dec-25T00:00:00Z".
 * 
 * @param date - Date in either ISO or UK format
 * @returns UK date string (e.g., "1-Dec-25")
 */
export function normalizeToUK(date: string): string {
  if (!date) return date;
  
  // Strip time portion for UK format detection (handles hybrid like "1-Dec-25T00:00:00Z")
  const datePart = date.split('T')[0];
  
  if (isUKDate(datePart)) {
    return datePart; // Return just the UK date part
  }
  if (isISODate(datePart)) {
    return fromISO(datePart);
  }
  // Try to parse as date and convert
  try {
    return formatDateUK(date);
  } catch {
    // Return as-is if can't parse
    return date;
  }
}

/**
 * Normalize a date to ISO format for internal comparisons
 * Accepts either ISO (YYYY-MM-DD) or UK (d-MMM-yy) and returns ISO format.
 * Also handles hybrid formats like "1-Dec-25T00:00:00Z".
 * 
 * @param date - Date in either ISO or UK format
 * @returns ISO date string (e.g., "2025-12-01")
 */
export function normalizeToISO(date: string): string {
  if (!date) return date;
  
  // Strip time portion first
  const datePart = date.split('T')[0];
  
  if (isISODate(datePart)) {
    return datePart; // Already ISO date format
  }
  if (isUKDate(datePart)) {
    return toISO(datePart);
  }
  // Try to parse as date and convert
  try {
    const d = new Date(date);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0];
    }
  } catch {
    // Fall through
  }
  // Return as-is if can't parse
  return date;
}

/**
 * Check if a string is a relative date expression (e.g., "-14d", "-2m", "+7w")
 */
export function isRelativeDate(dateStr: string): boolean {
  return /^-?\d+[dwmy]$/.test(dateStr);
}

/**
 * Resolve a relative date expression (e.g., "-14d", "-2m") to an actual UK date string.
 * Returns the input unchanged if it's not a relative date.
 * 
 * @param dateStr - Date string, possibly relative like "-14d" or "-2m"
 * @returns Resolved date in UK format (d-MMM-yy) or original if not relative
 */
export function resolveRelativeDate(dateStr: string): string {
  if (!dateStr) return dateStr;
  
  // Normalize common typos: double-dash to single-dash (e.g., "--1d" → "-1d")
  let normalized = dateStr.replace(/^--+/, '-');
  
  // Match relative date patterns: -14d, -2m, -1y, etc.
  const relativeMatch = normalized.match(/^(-?\d+)([dwmy])$/);
  if (!relativeMatch) return dateStr;
  
  const offset = parseInt(relativeMatch[1], 10);
  const unit = relativeMatch[2];
  
  // CRITICAL: Use UTC throughout to match formatDateUK which uses UTC getters
  // This avoids timezone mismatches where local midnight != UTC midnight
  const now = new Date();
  // Set to UTC midnight
  now.setUTCHours(0, 0, 0, 0);
  
  switch (unit) {
    case 'd':
      now.setUTCDate(now.getUTCDate() + offset);
      break;
    case 'w':
      now.setUTCDate(now.getUTCDate() + (offset * 7));
      break;
    case 'm':
      now.setUTCMonth(now.getUTCMonth() + offset);
      break;
    case 'y':
      now.setUTCFullYear(now.getUTCFullYear() + offset);
      break;
  }
  
  return formatDateUK(now);
}

