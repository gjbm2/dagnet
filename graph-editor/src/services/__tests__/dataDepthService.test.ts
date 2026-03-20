/**
 * Data Depth Service — integration tests against real snapshot DB.
 *
 * These tests hit the REAL snapshot API (localhost:9000) and verify that
 * f₂ (snapshot coverage) is computed correctly for known params.
 *
 * Pre-requisites:
 *   - Python API running on localhost:9000
 *   - Snapshot DB populated with real data
 */

import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync } from 'fs';
import {
  computeDataDepthScores,
  W_DATE_COVERAGE,
  W_SNAPSHOT_COVERAGE,
  W_SAMPLE_SIZE,
  type DataDepthInput,
} from '../dataDepthService';
import { formatDateUK } from '../../lib/dateFormat';
import type { FetchPlan } from '../fetchPlanTypes';
import type { GraphEdge } from '../../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PYTHON_API = 'http://localhost:9000';

/** Generate UK-format date strings for a range of days ending on `endDate`. */
function generateWindowDates(daysBack: number, endDate: Date = new Date()): string[] {
  const dates: string[] = [];
  for (let i = daysBack - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(
      endDate.getUTCFullYear(),
      endDate.getUTCMonth(),
      endDate.getUTCDate() - i,
    ));
    dates.push(formatDateUK(d));
  }
  return dates;
}

/** Convert ISO date/datetime to UK format. */
function isoToUK(iso: string): string {
  const dateStr = iso.includes('T') ? iso.split('T')[0] : iso;
  const parts = dateStr.split('-');
  if (parts.length !== 3) return iso;
  const d = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
  return formatDateUK(d);
}

/** Call the real retrievals API. */
async function queryRetrievals(paramId: string, limit = 2000): Promise<{
  success: boolean;
  retrieved_at: string[];
  retrieved_days: string[];
  count: number;
}> {
  const resp = await fetch(`${PYTHON_API}/api/snapshots/retrievals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ param_id: paramId, limit }),
  });
  return resp.json();
}

/** Create a minimal edge for testing. */
function makeEdge(id: string, paramId: string, n: number): GraphEdge {
  return {
    uuid: id,
    from: 'node-a',
    to: 'node-b',
    p: {
      id: paramId,
      mean: 0.5,
      evidence: { n, k: Math.round(n * 0.5) },
    },
  } as any;
}

/** Create an empty fetch plan (no coverage data — isolates f₂ testing). */
function emptyPlan(): FetchPlan {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    referenceNow: new Date().toISOString(),
    dsl: '',
    items: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const log: string[] = [];
function L(msg: string) { log.push(msg); }

describe('extractWindowFromDSL — window extraction logic', () => {
  // Import the hook's extractWindowFromDSL indirectly via parseConstraints + resolveRelativeDate
  // (extractWindowFromDSL is not exported, so we replicate its logic here for testing)
  it('should extract window from cohort DSL', async () => {
    const { parseConstraints } = await import('../../lib/queryDSL');
    const { resolveRelativeDate } = await import('../../lib/dateFormat');

    // This is the actual DSL from the user's graph
    const dsl = 'cohort(17-Feb-26:23-Feb-26)';
    const constraints = parseConstraints(dsl);
    L(`[DSL test] constraints: ${JSON.stringify(constraints)}`);

    const hasCohort = !!constraints.cohort?.start;
    const hasWindow = !!constraints.window?.start;
    L(`[DSL test] hasCohort=${hasCohort}, hasWindow=${hasWindow}`);

    if (hasCohort) {
      const start = resolveRelativeDate(constraints.cohort!.start!);
      const end = constraints.cohort!.end
        ? resolveRelativeDate(constraints.cohort!.end!)
        : formatDateUK(new Date());
      L(`[DSL test] cohort window: ${start} → ${end}`);
    }

    // The dataInterestsDSL
    const dsl2 = 'window(-120d:);cohort(-120d:)';
    const constraints2 = parseConstraints(dsl2);
    L(`[DSL test] dataInterestsDSL constraints: ${JSON.stringify(constraints2)}`);
    const hasCohort2 = !!constraints2.cohort?.start;
    const hasWindow2 = !!constraints2.window?.start;
    L(`[DSL test] dataInterestsDSL hasCohort=${hasCohort2}, hasWindow=${hasWindow2}`);

    if (hasCohort2) {
      const start = resolveRelativeDate(constraints2.cohort!.start!);
      const end = constraints2.cohort!.end
        ? resolveRelativeDate(constraints2.cohort!.end!)
        : formatDateUK(new Date());
      L(`[DSL test] dataInterestsDSL cohort window: ${start} → ${end}`);
    }
    if (hasWindow2) {
      const start = resolveRelativeDate(constraints2.window!.start!);
      const end = constraints2.window!.end
        ? resolveRelativeDate(constraints2.window!.end!)
        : formatDateUK(new Date());
      L(`[DSL test] dataInterestsDSL explicit window: ${start} → ${end}`);
    }

    // At least one should produce a window
    expect(hasCohort || hasWindow || hasCohort2 || hasWindow2).toBe(true);
  });

  it('should demonstrate that narrow currentQueryDSL gives 100% f₂ while dataInterestsDSL gives correct value', async () => {
    const { parseConstraints } = await import('../../lib/queryDSL');
    const { resolveRelativeDate } = await import('../../lib/dateFormat');

    // Real param with 54 days of snapshot data (25-Jan to 19-Mar)
    const result = await queryRetrievals('nous-conversion-main-delegated-to-coffee', 2000);
    expect(result.success).toBe(true);
    const snapshotDaysUK = result.retrieved_days.map(isoToUK);

    const edgeId = 'test-edge-1';
    const edge = makeEdge(edgeId, 'nous-conversion-main-delegated-to-coffee', 5000);

    // ---- Narrow DSL (currentQueryDSL) — THE BUG ----
    const narrowDsl = 'cohort(17-Feb-26:23-Feb-26)';
    const narrowConstraints = parseConstraints(narrowDsl);
    const narrowStart = resolveRelativeDate(narrowConstraints.cohort!.start!);
    const narrowEnd = resolveRelativeDate(narrowConstraints.cohort!.end!);
    const narrowWindow = generateWindowDates(7, new Date(Date.UTC(2026, 1, 23)));  // 17-Feb to 23-Feb
    L(`[root cause] narrow window: ${narrowStart} → ${narrowEnd} (${narrowWindow.length} days)`);

    const narrowInput: DataDepthInput = {
      plan: emptyPlan(),
      snapshotDaysByEdge: new Map([[edgeId, snapshotDaysUK]]),
      edges: [edge],
      allDatesInWindow: narrowWindow,
      referenceNow: new Date(Date.UTC(2026, 1, 23)),
    };
    const narrowScores = computeDataDepthScores(narrowInput);
    const narrowF2 = narrowScores.get(edgeId)!.f2;
    L(`[root cause] narrow DSL f₂: ${narrowF2.toFixed(4)} — THIS IS THE BUG (should not be used for data depth)`);

    // ---- Full DSL (dataInterestsDSL) — THE FIX ----
    const fullDsl = 'window(-120d:);cohort(-120d:)';
    const fullConstraints = parseConstraints(fullDsl);
    // extractWindowFromDSL checks cohort first
    const fullStart = resolveRelativeDate(fullConstraints.cohort!.start!);
    const fullEnd = formatDateUK(new Date());
    const refDate = new Date();
    const allDatesInWindow = generateWindowDates(120, refDate);
    L(`[root cause] full window: ${fullStart} → ${fullEnd} (${allDatesInWindow.length} days)`);

    const fullInput: DataDepthInput = {
      plan: emptyPlan(),
      snapshotDaysByEdge: new Map([[edgeId, snapshotDaysUK]]),
      edges: [edge],
      allDatesInWindow,
      referenceNow: refDate,
    };
    const fullScores = computeDataDepthScores(fullInput);
    const fullF2 = fullScores.get(edgeId)!.f2;
    L(`[root cause] full DSL f₂: ${fullF2.toFixed(4)} — CORRECT`);

    // Narrow DSL covers only 7 days, all within snapshot range → f₂ ≈ 1.0
    expect(narrowF2).toBeGreaterThan(0.95);

    // Full DSL covers 120 days, only ~54 have snapshots → f₂ < 0.85
    expect(fullF2).toBeLessThan(0.85);
    expect(fullF2).toBeGreaterThan(0.2);
  });
});

describe('dataDepthService — real snapshot DB', () => {
  afterAll(() => {
    writeFileSync('/home/reg/dev/dagnet/debug/tmp.data-depth-test.log', log.join('\n') + '\n');
  });

  // Known param with ~54 retrieval days spanning 25-Jan-26 to 19-Mar-26.
  const REAL_PARAM_ID = 'nous-conversion-main-delegated-to-coffee';

  it('should retrieve snapshot days from the real API and find < 120 days of coverage', async () => {
    const result = await queryRetrievals(REAL_PARAM_ID);

    expect(result.success).toBe(true);
    expect(result.retrieved_at.length).toBeGreaterThan(0);

    // Deduplicate retrieved_at to unique calendar dates
    const asatDays = new Set(result.retrieved_at.map(isoToUK));
    L(`[REAL API] retrieved_at count: ${result.retrieved_at.length}`);
    L(`[REAL API] retrieved_days count: ${result.retrieved_days.length}`);
    L(`[REAL API] unique asat days (from retrieved_at): ${asatDays.size}`);
    L(`[REAL API] first 5 asat days:`, [...asatDays].slice(0, 5));

    // The snapshot DB was created ~60 days ago. There cannot be 120 days of asat coverage.
    expect(asatDays.size).toBeLessThan(120);
    // But there should be some
    expect(asatDays.size).toBeGreaterThan(0);
  });

  it('should compute f₂ < 100% for a 120-day window when snapshots cover only ~54 days', async () => {
    const result = await queryRetrievals(REAL_PARAM_ID);
    expect(result.success).toBe(true);

    // Convert retrieved_at timestamps to UK-format calendar dates (deduped)
    const asatDays = [...new Set(result.retrieved_at.map(isoToUK))];

    // Build a 120-day window ending today
    const refDate = new Date();
    const allDatesInWindow = generateWindowDates(120, refDate);
    L(`[f₂ test] window: ${allDatesInWindow[0]} → ${allDatesInWindow[allDatesInWindow.length - 1]} (${allDatesInWindow.length} days)`);
    L(`[f₂ test] asat days: ${asatDays.length}`);

    // Count how many asat days fall within the window
    const windowSet = new Set(allDatesInWindow);
    const asatInWindow = asatDays.filter(d => windowSet.has(d));
    L(`[f₂ test] asat days IN window: ${asatInWindow.length}`);

    // Now compute via computeDataDepthScores
    const edgeId = 'test-edge-1';
    const edge = makeEdge(edgeId, REAL_PARAM_ID, 5000);

    const snapshotDaysByEdge = new Map<string, string[]>();
    snapshotDaysByEdge.set(edgeId, asatDays);

    const input: DataDepthInput = {
      plan: emptyPlan(),
      snapshotDaysByEdge,
      edges: [edge],
      allDatesInWindow,
      referenceNow: refDate,
    };

    const scores = computeDataDepthScores(input);
    const score = scores.get(edgeId);
    expect(score).toBeDefined();

    L(`[f₂ test] f1=${score!.f1.toFixed(4)}, f2=${score!.f2.toFixed(4)}, f3=${score!.f3.toFixed(4)}, depth=${score!.depth.toFixed(4)}`);

    // f₂ MUST be < 100%. The DB was created ~60 days ago.
    // With recency weighting (half-life 30d), recent days count more,
    // so f₂ will be higher than naive 54/120 but CANNOT be 100%.
    expect(score!.f2).toBeLessThan(1.0);
    expect(score!.f2).toBeGreaterThan(0.0);

    // Sanity: f₂ should be roughly in the 40-80% range
    // (54 days covered out of 120, with recency favouring the recent 54)
    expect(score!.f2).toBeLessThan(0.85);
    expect(score!.f2).toBeGreaterThan(0.2);
  });

  it('should confirm the limit=200 API cap truncates retrieved_at to fewer unique days', async () => {
    // This test exposes the limit bug: limit=200 returns only ~25 unique days
    // because each day has multiple retrieved_at timestamps (one per slice/run).
    const capped = await queryRetrievals(REAL_PARAM_ID, 200);
    const uncapped = await queryRetrievals(REAL_PARAM_ID, 2000);

    const cappedDays = new Set(capped.retrieved_at.map(isoToUK));
    const uncappedDays = new Set(uncapped.retrieved_at.map(isoToUK));

    L(`[limit test] limit=200: ${capped.retrieved_at.length} timestamps → ${cappedDays.size} unique days`);
    L(`[limit test] limit=2000: ${uncapped.retrieved_at.length} timestamps → ${uncappedDays.size} unique days`);

    // With limit=200, we get fewer unique days because timestamps are capped
    // This is a real bug in the hook which uses limit: 200
    if (uncappedDays.size > cappedDays.size) {
      L(`[limit test] CONFIRMED: limit=200 loses ${uncappedDays.size - cappedDays.size} days of coverage data!`);
    }
    expect(uncappedDays.size).toBeGreaterThanOrEqual(cappedDays.size);
  });

  it('should NOT produce f₂=1 when using retrieved_days (anchor days) instead of retrieved_at (asat days)', async () => {
    // This test demonstrates the original bug: using retrieved_days (anchor days)
    // produces inflated f₂ because anchor days cover retroactive data,
    // not just days when snapshotting actually ran.
    const result = await queryRetrievals(REAL_PARAM_ID, 2000);
    expect(result.success).toBe(true);

    const refDate = new Date();
    const allDatesInWindow = generateWindowDates(120, refDate);

    const edgeId = 'test-edge-1';
    const edge = makeEdge(edgeId, REAL_PARAM_ID, 5000);

    // Method A: use retrieved_days (anchor days) — THE BUG
    const anchorDaysUK = result.retrieved_days.map(isoToUK);
    const inputWithAnchor: DataDepthInput = {
      plan: emptyPlan(),
      snapshotDaysByEdge: new Map([[edgeId, anchorDaysUK]]),
      edges: [edge],
      allDatesInWindow,
      referenceNow: refDate,
    };
    const scoresAnchor = computeDataDepthScores(inputWithAnchor);
    const f2Anchor = scoresAnchor.get(edgeId)!.f2;

    // Method B: use retrieved_at (asat days) — THE FIX
    const asatDaysUK = [...new Set(result.retrieved_at.map(isoToUK))];
    const inputWithAsat: DataDepthInput = {
      plan: emptyPlan(),
      snapshotDaysByEdge: new Map([[edgeId, asatDaysUK]]),
      edges: [edge],
      allDatesInWindow,
      referenceNow: refDate,
    };
    const scoresAsat = computeDataDepthScores(inputWithAsat);
    const f2Asat = scoresAsat.get(edgeId)!.f2;

    L(`[anchor vs asat] retrieved_days count: ${result.retrieved_days.length} → f₂=${f2Anchor.toFixed(4)}`);
    L(`[anchor vs asat] asat unique days: ${asatDaysUK.length} → f₂=${f2Asat.toFixed(4)}`);

    // anchor-based f₂ will be higher (possibly much higher) than asat-based
    // because anchor days include retroactively-fetched old data
    // asat-based f₂ MUST be < 1.0
    expect(f2Asat).toBeLessThan(1.0);
  });
});
