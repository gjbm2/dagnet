/**
 * Fetch Plan Types
 * 
 * Canonical types for the FetchPlan data structure used by:
 * - Planner analysis (WindowSelector)
 * - Dry-run reporting
 * - Live execution
 * 
 * Design doc: docs/current/fetch-planning-first-principles.md
 * 
 * Key invariant: The same FetchPlan must be used by analysis, dry-run, and execution.
 * There is no separate "planner plan" vs "execution plan".
 */

import { formatDateUK, parseUKDate } from '../lib/dateFormat';

// =============================================================================
// Core Types
// =============================================================================

/**
 * Reason a window is included in the fetch plan.
 */
export type FetchWindowReason = 'missing' | 'stale' | 'db_missing';

/**
 * A contiguous date window to fetch.
 */
export interface FetchWindow {
  /** Start date (UK format, e.g. '1-Nov-25') */
  start: string;
  /** End date (UK format, e.g. '30-Nov-25') */
  end: string;
  /** Why this window is in the plan */
  reason: FetchWindowReason;
  /** Number of days in the window (convenience) */
  dayCount: number;
}

/**
 * Classification of a plan item.
 */
export type FetchPlanItemClassification = 'fetch' | 'covered' | 'unfetchable';

/**
 * A single item in the fetch plan.
 */
export interface FetchPlanItem {
  /** Canonical key: `${type}:${objectId}:${targetId}:${slot ?? ''}:${conditionalIndex ?? ''}` */
  itemKey: string;
  
  /** Item type */
  type: 'parameter' | 'case';
  
  /** Parameter or case file object ID (without 'parameter-' or 'case-' prefix) */
  objectId: string;
  
  /** Edge UUID or node UUID */
  targetId: string;
  
  /** Parameter slot (for multi-slot edges) */
  slot?: 'p' | 'cost_gbp' | 'labour_cost';
  
  /** Conditional index (for conditional edges) */
  conditionalIndex?: number;
  
  /** Query mode */
  mode: 'window' | 'cohort';
  
  /** Slice family identity (e.g. 'context(channel:paid-search)' or '' for uncontexted) */
  sliceFamily: string;
  
  /** Query signature used for cache matching */
  querySignature: string;
  
  /** Item classification */
  classification: FetchPlanItemClassification;
  
  /** If unfetchable, the reason */
  unfetchableReason?: string;
  
  /** Windows to fetch (sorted by start date ascending; empty if covered/unfetchable) */
  windows: FetchWindow[];
}

/**
 * The complete fetch plan.
 */
export interface FetchPlan {
  /** Schema version */
  version: 1;
  
  /** When the plan was created (ISO timestamp) */
  createdAt: string;
  
  /** Reference "now" used for staleness calculations (ISO timestamp) */
  referenceNow: string;
  
  /** The authoritative DSL this plan was built for */
  dsl: string;
  
  /** Items in the plan (sorted by itemKey) */
  items: FetchPlanItem[];
}

// =============================================================================
// Canonicalisation Helpers
// =============================================================================

/**
 * Build the canonical item key for sorting and equality.
 */
export function buildItemKey(item: {
  type: 'parameter' | 'case';
  objectId: string;
  targetId: string;
  slot?: 'p' | 'cost_gbp' | 'labour_cost';
  conditionalIndex?: number;
}): string {
  return `${item.type}:${item.objectId}:${item.targetId}:${item.slot ?? ''}:${item.conditionalIndex ?? ''}`;
}

/**
 * Parse a UK date string to a Date object for comparison.
 */
function parseDateForSort(ukDate: string): Date {
  try {
    return parseUKDate(ukDate);
  } catch {
    // Fallback: attempt ISO parse
    return new Date(ukDate);
  }
}

/**
 * Compare two UK date strings for sorting.
 */
function compareDates(a: string, b: string): number {
  const dateA = parseDateForSort(a);
  const dateB = parseDateForSort(b);
  return dateA.getTime() - dateB.getTime();
}

/**
 * Sort windows by start date ascending.
 */
export function sortWindows(windows: FetchWindow[]): FetchWindow[] {
  return [...windows].sort((a, b) => compareDates(a.start, b.start));
}

/**
 * Sort items by itemKey.
 */
export function sortItems(items: FetchPlanItem[]): FetchPlanItem[] {
  return [...items].sort((a, b) => a.itemKey.localeCompare(b.itemKey));
}

/**
 * Canonicalise a FetchPlan for deterministic serialisation.
 * 
 * - Items sorted by itemKey
 * - Windows within each item sorted by start date
 */
export function canonicalisePlan(plan: FetchPlan): FetchPlan {
  const canonicalItems = sortItems(plan.items).map(item => ({
    ...item,
    windows: sortWindows(item.windows),
  }));
  
  return {
    ...plan,
    items: canonicalItems,
  };
}

/**
 * Serialise a FetchPlan to canonical JSON.
 * 
 * Uses sorted keys and deterministic ordering for equality testing.
 */
export function serialisePlanCanonical(plan: FetchPlan): string {
  const canonical = canonicalisePlan(plan);
  return stableStringify(canonical);
}

/**
 * Check if two FetchPlans are equal (by canonical serialisation).
 */
export function plansEqual(a: FetchPlan, b: FetchPlan): boolean {
  return serialisePlanCanonical(a) === serialisePlanCanonical(b);
}

/**
 * Stable JSON stringification:
 * - Recursively sorts keys for plain objects
 * - Preserves array order (callers must sort arrays beforehand as part of canonicalisation)
 *
 * This is required so plan equality cannot "lie" by omitting nested fields.
 */
function stableStringify(value: unknown): string {
  const normalised = normaliseForStableJson(value);
  return JSON.stringify(normalised, null, 2);
}

function normaliseForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normaliseForStableJson);
  }
  if (value && typeof value === 'object') {
    // Only sort keys for plain objects; leave Dates, Maps, etc. untouched.
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) {
        out[key] = normaliseForStableJson(obj[key]);
      }
      return out;
    }
  }
  return value;
}

// =============================================================================
// Window Construction Helpers
// =============================================================================

/**
 * Count the number of days in a date range (inclusive).
 */
export function countDays(start: string, end: string): number {
  const startDate = parseDateForSort(start);
  const endDate = parseDateForSort(end);
  const diffMs = endDate.getTime() - startDate.getTime();
  return Math.floor(diffMs / (24 * 60 * 60 * 1000)) + 1;
}

/**
 * Create a FetchWindow.
 */
export function createFetchWindow(
  start: string,
  end: string,
  reason: FetchWindowReason
): FetchWindow {
  return {
    start,
    end,
    reason,
    dayCount: countDays(start, end),
  };
}

/**
 * Merge a set of dates into minimal contiguous windows.
 * 
 * @param dates - Array of UK date strings
 * @param reason - Reason to assign to all windows
 * @returns Minimal set of contiguous windows covering all dates
 */
export function mergeDatesToWindows(
  dates: string[],
  reason: FetchWindowReason
): FetchWindow[] {
  if (dates.length === 0) return [];
  
  // Sort dates
  const sorted = [...dates].sort(compareDates);
  
  const windows: FetchWindow[] = [];
  let windowStart = sorted[0];
  let windowEnd = sorted[0];
  
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const prevDate = parseDateForSort(windowEnd);
    const currDate = parseDateForSort(current);
    
    // Check if current date is consecutive (within 1 day of previous end)
    const diffDays = (currDate.getTime() - prevDate.getTime()) / (24 * 60 * 60 * 1000);
    
    if (diffDays <= 1) {
      // Extend current window
      windowEnd = current;
    } else {
      // Close current window and start new one
      windows.push(createFetchWindow(windowStart, windowEnd, reason));
      windowStart = current;
      windowEnd = current;
    }
  }
  
  // Close final window
  windows.push(createFetchWindow(windowStart, windowEnd, reason));
  
  return windows;
}

/**
 * Merge two sets of windows (missing + stale) into a single minimal set.
 * 
 * The result preserves reason metadata: if a date appears in both missing and stale,
 * it is tagged as 'missing' (missing takes precedence).
 */
export function mergeWindowSets(
  missingWindows: FetchWindow[],
  staleWindows: FetchWindow[]
): FetchWindow[] {
  // Expand windows to date sets
  const missingDates = new Set<string>();
  const staleDates = new Set<string>();
  
  for (const w of missingWindows) {
    for (const d of expandWindowToDates(w)) {
      missingDates.add(d);
    }
  }
  
  for (const w of staleWindows) {
    for (const d of expandWindowToDates(w)) {
      // Only add to stale if not already in missing
      if (!missingDates.has(d)) {
        staleDates.add(d);
      }
    }
  }
  
  // Rebuild windows from date sets
  const missingWindowsResult = mergeDatesToWindows(Array.from(missingDates), 'missing');
  const staleWindowsResult = mergeDatesToWindows(Array.from(staleDates), 'stale');
  
  // Merge and sort all windows
  const allWindows = [...missingWindowsResult, ...staleWindowsResult];
  return sortWindows(allWindows);
}

/**
 * Expand a window to individual date strings.
 */
export function expandWindowToDates(window: FetchWindow): string[] {
  const dates: string[] = [];
  const startDate = parseDateForSort(window.start);
  const endDate = parseDateForSort(window.end);
  
  const current = new Date(startDate);
  while (current <= endDate) {
    dates.push(formatDateUK(current));
    // Use UTC day increments to avoid DST/local-time artefacts.
    current.setUTCDate(current.getUTCDate() + 1);
  }
  
  return dates;
}

// =============================================================================
// Plan Summary Helpers
// =============================================================================

/**
 * Summarise a FetchPlan for logging/display.
 */
export interface FetchPlanSummary {
  totalItems: number;
  coveredItems: number;
  fetchItems: number;
  unfetchableItems: number;
  totalWindows: number;
  totalDaysToFetch: number;
  missingDays: number;
  staleDays: number;
  dbMissingDays: number;
}

export function summarisePlan(plan: FetchPlan): FetchPlanSummary {
  let coveredItems = 0;
  let fetchItems = 0;
  let unfetchableItems = 0;
  let totalWindows = 0;
  let totalDaysToFetch = 0;
  let missingDays = 0;
  let staleDays = 0;
  let dbMissingDays = 0;
  
  for (const item of plan.items) {
    switch (item.classification) {
      case 'covered':
        coveredItems++;
        break;
      case 'fetch':
        fetchItems++;
        break;
      case 'unfetchable':
        unfetchableItems++;
        break;
    }
    
    for (const w of item.windows) {
      totalWindows++;
      totalDaysToFetch += w.dayCount;
      if (w.reason === 'missing') {
        missingDays += w.dayCount;
      } else if (w.reason === 'db_missing') {
        dbMissingDays += w.dayCount;
      } else {
        staleDays += w.dayCount;
      }
    }
  }
  
  return {
    totalItems: plan.items.length,
    coveredItems,
    fetchItems,
    unfetchableItems,
    totalWindows,
    totalDaysToFetch,
    missingDays,
    staleDays,
    dbMissingDays,
  };
}





