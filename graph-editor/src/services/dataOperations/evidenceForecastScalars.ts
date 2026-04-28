/**
 * Evidence and forecast scalar computation.
 *
 * Computes evidence scalars (n, k, mean, stdev) and forecast scalars
 * (recency-weighted mature-day forecast) for probability parameters.
 * Handles exact-match, cohort, window, and MECE aggregation scenarios.
 *
 * Extracted from dataOperationsService.ts (Cluster J) during slimdown.
 */

import type { ParameterValue } from '../../types/parameterData';
import {
  aggregateCohortData,
  normalizeDate,
  parseDate,
  isDateInRange,
  isCohortModeValue,
} from '../windowAggregationService';
import { parseConstraints } from '../../lib/queryDSL';
import { extractSliceDimensions } from '../sliceIsolation';
import { normalizeToUK, formatDateUK, resolveRelativeDate } from '../../lib/dateFormat';
import { sessionLogService } from '../sessionLogService';
import { findBestMECEPartitionCandidateSync, parameterValueRecencyMs } from '../meceSliceService';
import { RECENCY_HALF_LIFE_DAYS, DEFAULT_T95_DAYS } from '../../constants/latency';
import type { ForecastingModelSettings } from '../forecastingSettingsService';

export function addEvidenceAndForecastScalars(
  aggregatedData: any,
  originalParamData: any,
  targetSlice: string | undefined,
  options?: {
    logOpId?: string;
    t95Days?: number;
    t95Source?: 'edge' | 'file_latency' | 'none' | 'unknown';
    forecasting?: ForecastingModelSettings;
  }
): any {
  if (!aggregatedData || !Array.isArray(aggregatedData.values)) {
    return aggregatedData;
  }

  const isProbabilityParam =
    aggregatedData.type === 'probability' ||
    aggregatedData.parameter_type === 'probability';

  if (!isProbabilityParam) {
    return aggregatedData;
  }

  const values = aggregatedData.values as ParameterValue[];

  // Parse target constraints once for both cohort and forecast logic
  const parsedTarget = targetSlice ? parseConstraints(targetSlice) : null;
  const isCohortQuery = !!parsedTarget?.cohort;

  // Check if this is an EXACT slice match (targetSlice == value.sliceDSL)
  // For exact matches with a single value, use the header n/k directly rather
  // than re-aggregating from daily arrays (which may be incomplete samples).
  const isExactMatch = values.length === 1 && values[0].sliceDSL === targetSlice;

  // === 1) Evidence scalars ===
  //
  // Exact slice match:
  //   - Use header n/k directly (authoritative totals for that slice).
  // Window() queries (non-exact):
  //   - evidence is derived from n/k of the aggregated window (handled upstream in aggregation).
  // Cohort() queries (non-exact):
  //   - evidence MUST be sliced to the cohort() window in the DSL (design.md §4.8, §5.3).
  //
  let valuesWithEvidence = values;

  // EXACT MATCH PATH: Use header n/k for evidence (most authoritative source)
  if (isExactMatch && values[0].n !== undefined && values[0].k !== undefined && values[0].n > 0) {
    const exactN = values[0].n;
    const exactK = values[0].k;
    const evidenceMean = exactK / exactN;
    const evidenceStdev = Math.sqrt((evidenceMean * (1 - evidenceMean)) / exactN);

    valuesWithEvidence = values.map((v) => {
      const existingEvidence: any = (v as any).evidence || {};
      return {
        ...v,
        evidence: {
          ...existingEvidence,
          n: exactN,
          k: exactK,
          mean: evidenceMean,
          stdev: evidenceStdev,
        },
      } as ParameterValue;
    });
  } else if (isCohortQuery && parsedTarget?.cohort?.start && parsedTarget.cohort.end) {
    // Cohort-based evidence: restrict to cohorts within the requested cohort() window.
    const queryDate = new Date();
    const allCohorts = aggregateCohortData(values, queryDate);

    // Resolve cohort window bounds to UK dates and normalise
    const startResolved = resolveRelativeDate(parsedTarget.cohort.start);
    const endResolved = resolveRelativeDate(parsedTarget.cohort.end);
    const startUK = normalizeToUK(startResolved);
    const endUK = normalizeToUK(endResolved);

    const filteredCohorts = allCohorts.filter(c =>
      isDateInRange(
        normalizeDate(c.date),
        { start: startUK, end: endUK }
      )
    );

    const totalN = filteredCohorts.reduce((sum, c) => sum + c.n, 0);
    const totalK = filteredCohorts.reduce((sum, c) => sum + c.k, 0);

    if (totalN > 0) {
      const evidenceMean = totalK / totalN;
      const evidenceStdev = Math.sqrt((evidenceMean * (1 - evidenceMean)) / totalN);

      valuesWithEvidence = values.map((v) => {
        const existingEvidence: any = (v as any).evidence || {};
        return {
          ...v,
          evidence: {
            ...existingEvidence,
            n: totalN,
            k: totalK,
            mean: evidenceMean,
            stdev: evidenceStdev,
          },
        } as ParameterValue;
      });
    } else {
      // totalN === 0 can mean:
      // 1. No daily arrays present (should fall back to header n/k)
      // 2. Daily arrays exist but query window doesn't match (should leave evidence unchanged)
      const hasDailyArrays = values.some(v => v.dates && v.n_daily && v.k_daily && v.dates.length > 0);

      if (!hasDailyArrays) {
        // No daily cohort arrays found - fall back to header-level n/k if present
        // This handles param files that have flat n/k totals without dates/n_daily/k_daily arrays
        // (design.md §4.8: evidence.mean = Σk/Σn should always be computable from stored data)
        const headerN = values.reduce((sum, v) => sum + (v.n || 0), 0);
        const headerK = values.reduce((sum, v) => sum + (v.k || 0), 0);

        if (headerN > 0) {
          const evidenceMean = headerK / headerN;
          const evidenceStdev = Math.sqrt((evidenceMean * (1 - evidenceMean)) / headerN);

          valuesWithEvidence = values.map((v) => {
            const existingEvidence: any = (v as any).evidence || {};
            return {
              ...v,
              evidence: {
                ...existingEvidence,
                n: headerN,
                k: headerK,
                mean: evidenceMean,
                stdev: evidenceStdev,
              },
            } as ParameterValue;
          });
        } else {
          // Truly no usable data – leave evidence unchanged
          valuesWithEvidence = values;
        }
      } else {
        // Daily arrays exist but query window doesn't match stored data
        // Leave evidence unchanged (no valid data for requested window)
        valuesWithEvidence = values;
      }
    }
  } else {
    // Default path: evidence from each value's own n/k
    valuesWithEvidence = values.map((v) => {
      if (v.n !== undefined && v.k !== undefined && v.n > 0) {
        const evidenceMean = v.k / v.n;
        const evidenceStdev = Math.sqrt((evidenceMean * (1 - evidenceMean)) / v.n);
        const existingEvidence: any = (v as any).evidence || {};

        return {
          ...v,
          evidence: {
            ...existingEvidence,
            // Do not clobber existing values if already present
            n: existingEvidence.n !== undefined ? existingEvidence.n : v.n,
            k: existingEvidence.k !== undefined ? existingEvidence.k : v.k,
            mean: existingEvidence.mean !== undefined ? existingEvidence.mean : evidenceMean,
            stdev: existingEvidence.stdev !== undefined ? existingEvidence.stdev : evidenceStdev,
          },
        } as ParameterValue;
      }
      return v;
    });
  }

  // === 1b) Window() super-range correction for from-file fixtures ===
  //
  // For window() queries where the requested window FULLY CONTAINS the stored
  // base window slice (e.g. query=window(24-Nov-25:2-Dec-25) vs stored
  // window(25-Nov-25:1-Dec-25)), evidence should reflect the FULL stored
  // slice totals, not a partial subset of daily arrays.
  //
  // This aligns with design.md and cohort-window-fixes.md §2.1:
  // - Missing days outside the stored window are treated as gaps, not zeros.
  // - Evidence totals for super-range queries should equal the base window totals.
  const hasWindowConstraint = !!parsedTarget?.window?.start && !!parsedTarget.window?.end;
  if (!isCohortQuery && hasWindowConstraint && originalParamData?.values && Array.isArray(originalParamData.values)) {
    try {
      const targetDims = extractSliceDimensions(targetSlice || '');
      const originalValues = originalParamData.values as ParameterValue[];

      // Find base window slices matching the same context/case dimensions
      const baseWindowCandidates = originalValues.filter((v) => {
        if (!v.sliceDSL || !v.sliceDSL.includes('window(')) return false;
        const dims = extractSliceDimensions(v.sliceDSL);
        return dims === targetDims && v.n !== undefined && v.k !== undefined && v.window_from && v.window_to;
      });

      if (baseWindowCandidates.length > 0) {
        // Use the most recent base window slice (by retrieved_at / window_to)
        const baseWindow = [...baseWindowCandidates].sort((a, b) => {
          const aDate = a.data_source?.retrieved_at || a.window_to || '';
          const bDate = b.data_source?.retrieved_at || b.window_to || '';
          return bDate.localeCompare(aDate);
        })[0];

        const qStart = parseDate(resolveRelativeDate(parsedTarget.window!.start!));
        const qEnd = parseDate(resolveRelativeDate(parsedTarget.window!.end!));
        const baseStart = parseDate(baseWindow.window_from!);
        const baseEnd = parseDate(baseWindow.window_to!);

        const isSuperWindow =
          qStart.getTime() <= baseStart.getTime() &&
          qEnd.getTime() >= baseEnd.getTime();

        if (isSuperWindow && baseWindow.n && baseWindow.k && baseWindow.n > 0) {
          const evidenceMean = baseWindow.k / baseWindow.n;
          const evidenceStdev = Math.sqrt((evidenceMean * (1 - evidenceMean)) / baseWindow.n);

          valuesWithEvidence = (valuesWithEvidence as ParameterValue[]).map((v) => {
            const existingEvidence: any = (v as any).evidence || {};
            return {
              ...v,
              evidence: {
                ...existingEvidence,
                // Super-window should use FULL base window totals
                mean: evidenceMean,
                stdev: evidenceStdev,
              },
            } as ParameterValue;
          });
        }
      }
    } catch (e) {
      console.warn('[DataOperationsService] Window super-range evidence adjustment failed:', e);
    }
  }

  let nextAggregated: any = {
    ...aggregatedData,
    values: valuesWithEvidence,
  };

  const computeRecencyWeightedMatureForecast = (args: {
    bestWindow: any;
    // Use a conservative maturity threshold (days) when we can infer it; otherwise fall back
    t95Days?: number;
    /** As-of date for maturity + recency weighting. Must be max(window date) when available. */
    asOfDate: Date;
  }): { mean?: number; weightedN: number; weightedK: number; maturityDays: number; usedAllDaysFallback: boolean } => {
    const { bestWindow, t95Days: innerT95Days, asOfDate } = args;
    const dates: string[] | undefined = bestWindow?.dates;
    const nDaily: number[] | undefined = bestWindow?.n_daily;
    const kDaily: number[] | undefined = bestWindow?.k_daily;
    if (!Array.isArray(dates) || !Array.isArray(nDaily) || !Array.isArray(kDaily)) {
      return { mean: undefined, weightedN: 0, weightedK: 0, maturityDays: 0, usedAllDaysFallback: false };
    }
    if (dates.length === 0 || nDaily.length !== dates.length || kDaily.length !== dates.length) {
      return { mean: undefined, weightedN: 0, weightedK: 0, maturityDays: 0, usedAllDaysFallback: false };
    }

    // Mature cutoff: exclude the most recent (ceil(t95)+1) days, which are systematically under-counted for lagged conversions.
    // If we don't have t95, fall back to DEFAULT_T95_DAYS for safety.
    // Special case: non-latency edges should NOT apply any maturity censoring.
    // We represent that by passing t95Days=0.
    const hasExplicitNoCensor = innerT95Days === 0;
    const defaultT95 =
      typeof options?.forecasting?.DEFAULT_T95_DAYS === 'number' && Number.isFinite(options.forecasting.DEFAULT_T95_DAYS)
        ? options.forecasting.DEFAULT_T95_DAYS
        : DEFAULT_T95_DAYS;
    const halfLife =
      typeof options?.forecasting?.RECENCY_HALF_LIFE_DAYS === 'number' &&
      Number.isFinite(options.forecasting.RECENCY_HALF_LIFE_DAYS) &&
      options.forecasting.RECENCY_HALF_LIFE_DAYS > 0
        ? options.forecasting.RECENCY_HALF_LIFE_DAYS
        : RECENCY_HALF_LIFE_DAYS;

    const effectiveT95 =
      hasExplicitNoCensor
        ? 0
        : ((innerT95Days !== undefined && Number.isFinite(innerT95Days) && innerT95Days > 0) ? innerT95Days : defaultT95);
    const maturityDays = hasExplicitNoCensor ? 0 : (Math.ceil(effectiveT95) + 1);
    const cutoffMs = hasExplicitNoCensor
      ? Number.POSITIVE_INFINITY
      : (asOfDate.getTime() - maturityDays * 24 * 60 * 60 * 1000);

    let weightedN = 0;
    let weightedK = 0;
    let totalNAll = 0;
    let totalKAll = 0;

    for (let i = 0; i < dates.length; i++) {
      const d = parseDate(dates[i]);
      if (Number.isNaN(d.getTime())) continue;
      const n = typeof nDaily[i] === 'number' ? nDaily[i] : 0;
      const k = typeof kDaily[i] === 'number' ? kDaily[i] : 0;
      if (n <= 0) continue;

      totalNAll += n;
      totalKAll += k;

      if (d.getTime() > cutoffMs) {
        // Immature day → exclude from baseline forecast
        continue;
      }

      const ageDays = Math.max(0, (asOfDate.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
      // Mirror statisticalEnhancementService: true half-life semantics.
      const w = Math.exp(-Math.LN2 * ageDays / halfLife);

      weightedN += w * n;
      weightedK += w * k;
    }

    if (weightedN > 0) {
      return { mean: weightedK / weightedN, weightedN, weightedK, maturityDays, usedAllDaysFallback: false };
    }

    // Fallback: censoring left no mature days; use full-window mean if available.
    if (totalNAll > 0) {
      return { mean: totalKAll / totalNAll, weightedN: totalNAll, weightedK: totalKAll, maturityDays, usedAllDaysFallback: true };
    }

    return { mean: undefined, weightedN: 0, weightedK: 0, maturityDays, usedAllDaysFallback: false };
  };

  // === 2) Forecast scalars (query-time recompute from matching window() slice daily arrays) ===
  // This applies to BOTH cohort() and window() queries:
  // - For cohort() queries: find the window baseline slice (dual-slice retrieval, design.md §4.6)
  // - For window() queries: the aggregated slice itself may have forecast, or find a matching window slice
  //
  // The presence of p.forecast.mean should NOT depend on whether the edge is "latency" or not;
  // it should depend only on whether a window baseline with forecast exists.
  if (targetSlice && originalParamData?.values && Array.isArray(originalParamData.values)) {
    const targetDims = extractSliceDimensions(targetSlice);
    const originalValues = originalParamData.values as ParameterValue[];

    const allWindowValues = originalValues.filter((v) => {
      if (!v.sliceDSL) return false;
      const parsed = parseConstraints(v.sliceDSL);
      return !!parsed.window && !parsed.cohort;
    });

    const isDailyCapable = (v: ParameterValue): boolean => {
      const dates: unknown = (v as any).dates;
      const nDaily: unknown = (v as any).n_daily;
      const kDaily: unknown = (v as any).k_daily;
      return (
        Array.isArray(dates) &&
        Array.isArray(nDaily) &&
        Array.isArray(kDaily) &&
        dates.length > 0 &&
        nDaily.length === dates.length &&
        kDaily.length === dates.length
      );
    };

    type DailyAccessor = {
      sliceDSL: string;
      recencyMs: number;
      startMs: number;
      endMs: number;
      coverageDays: number;
      hasDaily: boolean;
      getNKForDay: (dayUK: string) => { covered: boolean; n: number; k: number };
    };

    const buildDailyAccessor = (v: ParameterValue): DailyAccessor | null => {
      const sliceDSL = v.sliceDSL ?? '';
      if (!sliceDSL.trim()) return null;
      const recencyMs = parameterValueRecencyMs(v);

      const hasDaily = isDailyCapable(v);
      const dates: string[] = hasDaily ? ((v as any).dates as string[]) : [];
      const nDaily: number[] = hasDaily ? ((v as any).n_daily as number[]) : [];
      const kDaily: number[] = hasDaily ? ((v as any).k_daily as number[]) : [];

      // Coverage bounds: prefer explicit window_from/window_to; fall back to min/max of dates.
      let startMs = Number.POSITIVE_INFINITY;
      let endMs = Number.NEGATIVE_INFINITY;
      try {
        if (typeof (v as any).window_from === 'string' && String((v as any).window_from).trim()) {
          startMs = parseDate(String((v as any).window_from)).getTime();
        }
      } catch {
        // ignore
      }
      try {
        if (typeof (v as any).window_to === 'string' && String((v as any).window_to).trim()) {
          endMs = parseDate(String((v as any).window_to)).getTime();
        }
      } catch {
        // ignore
      }

      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
        if (hasDaily) {
          for (const ds of dates) {
            try {
              const t = parseDate(ds).getTime();
              if (!Number.isNaN(t)) {
                if (t < startMs) startMs = t;
                if (t > endMs) endMs = t;
              }
            } catch {
              // ignore
            }
          }
        }
      }

      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
        // No usable bounds; treat as non-covering.
        return {
          sliceDSL,
          recencyMs,
          startMs: Number.POSITIVE_INFINITY,
          endMs: Number.NEGATIVE_INFINITY,
          coverageDays: 0,
          hasDaily,
          getNKForDay: () => ({ covered: false, n: 0, k: 0 }),
        };
      }

      const coverageDays = Math.max(1, Math.floor((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1);

      // Index for sparse arrays; missing day within coverage counts as 0 (thin day), not "invalid".
      const index = new Map<string, number>();
      if (hasDaily) {
        for (let i = 0; i < dates.length; i++) index.set(dates[i], i);
      }

      const getNKForDay = (dayUK: string): { covered: boolean; n: number; k: number } => {
        let t = Number.NaN;
        try {
          t = parseDate(dayUK).getTime();
        } catch {
          return { covered: false, n: 0, k: 0 };
        }
        if (Number.isNaN(t)) return { covered: false, n: 0, k: 0 };
        if (t < startMs || t > endMs) return { covered: false, n: 0, k: 0 };
        if (!hasDaily) return { covered: true, n: 0, k: 0 };
        const i = index.get(dayUK);
        if (i === undefined) {
          // Missing day within declared coverage → treat as 0 contribution.
          return { covered: true, n: 0, k: 0 };
        }
        const n = typeof nDaily[i] === 'number' && Number.isFinite(nDaily[i]) ? nDaily[i] : 0;
        const k = typeof kDaily[i] === 'number' && Number.isFinite(kDaily[i]) ? kDaily[i] : 0;
        return { covered: true, n, k };
      };

      return { sliceDSL, recencyMs, startMs, endMs, coverageDays, hasDaily, getNKForDay };
    };

    // Find window() slices in the same param file with matching context/case dimensions (for contexted queries).
    const contextMatchedWindowCandidates = allWindowValues.filter((v) => extractSliceDimensions(v.sliceDSL ?? '') === targetDims);

    // For uncontexted queries, we may also synthesise an implicit-uncontexted MECE baseline on a per-day basis.
    const isUncontextedTarget = targetDims === '';
    const bestMECE = isUncontextedTarget ? findBestMECEPartitionCandidateSync(allWindowValues, { requireComplete: true }) : null;
    const meceKey = bestMECE?.key;
    const meceWarnings = bestMECE?.warnings;

    // Build accessors for:
    // - context-matching (always) OR explicit uncontexted (when targetDims === '')
    // - MECE member slices (uncontexted only)
    const explicitAccessorsRaw =
      isUncontextedTarget
        ? allWindowValues.filter((v) => extractSliceDimensions(v.sliceDSL ?? '') === '')
        : contextMatchedWindowCandidates;
    const explicitAccessors = explicitAccessorsRaw.map(buildDailyAccessor).filter((a): a is DailyAccessor => !!a);

    // Group MECE accessors by the MECE key's value (e.g. channel=paid-search).
    const meceByValue = new Map<string, DailyAccessor[]>();
    if (bestMECE && meceKey) {
      for (const pv of bestMECE.values) {
        const dims = extractSliceDimensions(pv.sliceDSL ?? '');
        const parsed = parseConstraints(dims);
        const ctx = parsed.context?.[0];
        if (!ctx || ctx.key !== meceKey) continue;
        const acc = buildDailyAccessor(pv);
        if (!acc) continue;
        const ctxVal = ctx.value ?? '';
        const arr = meceByValue.get(ctxVal) ?? [];
        arr.push(acc);
        meceByValue.set(ctxVal, arr);
      }
    }

    const anyDailyInputs =
      explicitAccessors.some((a) => a.hasDaily) ||
      Array.from(meceByValue.values()).some((arr) => arr.some((a) => a.hasDaily));

    if (anyDailyInputs) {
      // Meta-slice day range: union of all candidate coverage intervals (greedy temporally-wide).
      const allBounds: Array<{ startMs: number; endMs: number }> = [];
      for (const a of explicitAccessors) {
        if (Number.isFinite(a.startMs) && Number.isFinite(a.endMs) && a.startMs <= a.endMs) {
          allBounds.push({ startMs: a.startMs, endMs: a.endMs });
        }
      }
      for (const arr of meceByValue.values()) {
        for (const a of arr) {
          if (Number.isFinite(a.startMs) && Number.isFinite(a.endMs) && a.startMs <= a.endMs) {
            allBounds.push({ startMs: a.startMs, endMs: a.endMs });
          }
        }
      }
      const minStart = allBounds.reduce((m, b) => Math.min(m, b.startMs), Number.POSITIVE_INFINITY);
      const maxEnd = allBounds.reduce((m, b) => Math.max(m, b.endMs), Number.NEGATIVE_INFINITY);

      // If we still don't have bounds, fall back to "now" and skip.
      const startDate = Number.isFinite(minStart) ? new Date(minStart) : new Date();
      const endDate = Number.isFinite(maxEnd) ? new Date(maxEnd) : new Date();

      const pickBestAccessorForDay = (arr: DailyAccessor[], dayUK: string): DailyAccessor | null => {
        let best: DailyAccessor | null = null;
        for (const a of arr) {
          // Only consider slices that can cover this day (coverage window), regardless of whether the day is present in dates[].
          const nk = a.getNKForDay(dayUK);
          if (!nk.covered) continue;
          if (!best) {
            best = a;
            continue;
          }
          if (a.recencyMs > best.recencyMs) {
            best = a;
            continue;
          }
          if (a.recencyMs < best.recencyMs) continue;
          if (a.coverageDays > best.coverageDays) {
            best = a;
            continue;
          }
        }
        return best;
      };

      const datesMeta: string[] = [];
      const nMeta: number[] = [];
      const kMeta: number[] = [];

      // For diagnostics: record winner switchpoints (not per-day spam).
      type WinnerKind = 'explicit' | 'mece';
      const winnerRuns: Array<{ kind: WinnerKind; from: string; to: string; detail: string }> = [];
      const pushRun = (kind: WinnerKind, dayUK: string, detail: string): void => {
        const last = winnerRuns[winnerRuns.length - 1];
        if (last && last.kind === kind && last.detail === detail) {
          last.to = dayUK;
          return;
        }
        winnerRuns.push({ kind, from: dayUK, to: dayUK, detail });
      };

      // Iterate day-by-day over the wide horizon.
      const dayMs = 24 * 60 * 60 * 1000;
      for (let t = startDate.getTime(); t <= endDate.getTime(); t += dayMs) {
        const dayUK = formatDateUK(new Date(t));

        // Contexted queries: only use context-matching explicit series (never uncontexted).
        if (!isUncontextedTarget) {
          const best = pickBestAccessorForDay(explicitAccessors.filter((a) => a.hasDaily), dayUK);
          if (!best) continue;
          const nk = best.getNKForDay(dayUK);
          datesMeta.push(dayUK);
          nMeta.push(nk.n);
          kMeta.push(nk.k);
          pushRun('explicit', dayUK, best.sliceDSL);
          continue;
        }

        // Uncontexted: consider explicit-uncontexted and MECE aggregate (if available).
        const bestExplicit = pickBestAccessorForDay(explicitAccessors.filter((a) => a.hasDaily), dayUK);

        // Build MECE aggregate for this day: require every context value to cover the day.
        let meceCovered = meceByValue.size > 0;
        let meceN = 0;
        let meceK = 0;
        let meceRecencyMs = Number.POSITIVE_INFINITY;
        let meceCoverageDays = Number.POSITIVE_INFINITY;
        const meceDetails: string[] = [];

        if (meceCovered) {
          for (const [ctxVal, arr] of meceByValue.entries()) {
            const best = pickBestAccessorForDay(arr.filter((a) => a.hasDaily), dayUK);
            if (!best) {
              meceCovered = false;
              break;
            }
            const nk = best.getNKForDay(dayUK);
            meceN += nk.n;
            meceK += nk.k;
            meceRecencyMs = Math.min(meceRecencyMs, best.recencyMs);
            meceCoverageDays = Math.min(meceCoverageDays, best.coverageDays);
            meceDetails.push(`${ctxVal}:${best.sliceDSL}`);
          }
        }

        const explicitCovered = !!bestExplicit;

        // Pick per-day winner: freshest dataset wins; tie-break by wider coverage; final tie-break prefers explicit.
        let winner: { kind: WinnerKind; n: number; k: number; detail: string } | null = null;
        if (explicitCovered && meceCovered) {
          const explicitRecencyMs = bestExplicit!.recencyMs;
          if (explicitRecencyMs > meceRecencyMs) {
            const nk = bestExplicit!.getNKForDay(dayUK);
            winner = { kind: 'explicit', n: nk.n, k: nk.k, detail: bestExplicit!.sliceDSL };
          } else if (explicitRecencyMs < meceRecencyMs) {
            winner = { kind: 'mece', n: meceN, k: meceK, detail: `MECE(${meceKey ?? 'unknown'})` };
          } else {
            // Tie on recency: prefer wider coverage; if still tied, prefer explicit deterministically.
            const explicitCoverageDays = bestExplicit!.coverageDays;
            if (explicitCoverageDays > meceCoverageDays) {
              const nk = bestExplicit!.getNKForDay(dayUK);
              winner = { kind: 'explicit', n: nk.n, k: nk.k, detail: bestExplicit!.sliceDSL };
            } else if (explicitCoverageDays < meceCoverageDays) {
              winner = { kind: 'mece', n: meceN, k: meceK, detail: `MECE(${meceKey ?? 'unknown'})` };
            } else {
              const nk = bestExplicit!.getNKForDay(dayUK);
              winner = { kind: 'explicit', n: nk.n, k: nk.k, detail: bestExplicit!.sliceDSL };
            }
          }
        } else if (explicitCovered) {
          const nk = bestExplicit!.getNKForDay(dayUK);
          winner = { kind: 'explicit', n: nk.n, k: nk.k, detail: bestExplicit!.sliceDSL };
        } else if (meceCovered) {
          winner = { kind: 'mece', n: meceN, k: meceK, detail: `MECE(${meceKey ?? 'unknown'})` };
        } else {
          continue;
        }

        datesMeta.push(dayUK);
        nMeta.push(winner.n);
        kMeta.push(winner.k);
        pushRun(winner.kind, dayUK, winner.detail);
      }

      // As-of date for maturity + recency weighting: max meta date.
      const asOfDate =
        datesMeta.length > 0
          ? (() => {
              let best = new Date(0);
              for (const ds of datesMeta) {
                try {
                  const d = parseDate(ds);
                  if (!Number.isNaN(d.getTime()) && d.getTime() > best.getTime()) best = d;
                } catch {
                  // ignore
                }
              }
              return best.getTime() > 0 ? best : new Date();
            })()
          : new Date();

      // Prefer t95 from the caller (edge-authoritative); then the aggregated latency; then window slice latency.
      const latestAggregatedValue: any = (nextAggregated.values as any[])?.[(nextAggregated.values as any[]).length - 1];
      const inferredT95Days =
        // Explicit "no censor" sentinel: non-latency edges should pass t95Days=0.
        (options?.t95Days === 0)
          ? 0
          : ((typeof options?.t95Days === 'number' && Number.isFinite(options.t95Days) && options.t95Days > 0)
              ? options.t95Days
              : (typeof latestAggregatedValue?.latency?.t95 === 'number'
                  ? latestAggregatedValue.latency.t95
                  : undefined));

      const dailyResult = computeRecencyWeightedMatureForecast({
        bestWindow: { dates: datesMeta, n_daily: nMeta, k_daily: kMeta },
        t95Days: inferredT95Days,
        asOfDate,
      });
      const weightedNTotal = dailyResult.weightedN;
      const weightedKTotal = dailyResult.weightedK;
      const maturityDaysUsed = dailyResult.maturityDays;
      const usedAllDaysFallback = dailyResult.usedAllDaysFallback;

      // If we have a proper weighted population, compute the weighted mean.
      // Otherwise, if there is exactly one chosen slice with a scalar forecast, use it directly
      // (we still want F-mode to work even if header n is missing in some legacy fixtures).
      let forecastMeanComputed: number | undefined =
        weightedNTotal > 0 ? (weightedKTotal / weightedNTotal) : undefined;
      // Doc 73f F15 fix: pair the forecast mean with the matching window-aggregate stdev.
      // sqrt(p(1-p)/N) is the Beta-binomial sample SD from the same weighted population
      // that produced the forecast mean, so the (mean, stdev) pair feeding
      // buildAnalyticProbabilityBlock describes the same evidence set. Boundary means
      // (0 or 1) yield zero stdev → moment-match infeasible → no aggregate Beta emitted,
      // which is the correct degenerate behaviour.
      const forecastStdevComputed: number | undefined =
        forecastMeanComputed !== undefined && weightedNTotal > 0
          ? Math.sqrt(Math.max(0, forecastMeanComputed * (1 - forecastMeanComputed)) / weightedNTotal)
          : undefined;
      if (forecastMeanComputed !== undefined) {
        // Attach forecast scalar (query-time) – always overwrite so F-mode is explainable and consistent.
        nextAggregated = {
          ...nextAggregated,
          values: (nextAggregated.values as ParameterValue[]).map((v: any) => ({
            ...v,
            forecast: forecastMeanComputed,
            forecast_stdev: forecastStdevComputed,
          })),
        };

        if (options?.logOpId) {
          const diagnosticsOn = sessionLogService.isLevelEnabled('debug');
          const basisLabel =
            (!isUncontextedTarget)
              ? 'context-matching'
              : (meceKey ? `meta-slice (explicit vs MECE(${meceKey}))` : 'meta-slice (explicit)');

          const effectiveT95ForLog =
            (typeof inferredT95Days === 'number' && Number.isFinite(inferredT95Days) && inferredT95Days > 0)
              ? inferredT95Days
              : (inferredT95Days === 0 ? 0 : DEFAULT_T95_DAYS);

          const effectiveHalfLifeForLog =
            typeof options?.forecasting?.RECENCY_HALF_LIFE_DAYS === 'number' &&
            Number.isFinite(options.forecasting.RECENCY_HALF_LIFE_DAYS) &&
            options.forecasting.RECENCY_HALF_LIFE_DAYS > 0
              ? options.forecasting.RECENCY_HALF_LIFE_DAYS
              : RECENCY_HALF_LIFE_DAYS;

          const summaryLines: string[] = [];
          summaryLines.push(`basis: ${basisLabel}`);
          summaryLines.push(`as_of: ${normalizeDate(asOfDate.toISOString())} (max window date)`);
          summaryLines.push(
            inferredT95Days === 0
              ? `maturity_exclusion: none (non-latency)`
              : `maturity_exclusion: last ${maturityDaysUsed} days (t95≈${effectiveT95ForLog})`
          );
          if (options.t95Source) summaryLines.push(`t95_source: ${options.t95Source}`);
          summaryLines.push(`recency_weight: w=exp(-ln2*age/${effectiveHalfLifeForLog}d)`);
          summaryLines.push(`weighted: N=${Math.round(weightedNTotal)}, K=${Math.round(weightedKTotal)} → forecast=${(forecastMeanComputed * 100).toFixed(2)}%`);
          if (usedAllDaysFallback) summaryLines.push(`fallback: censoring left no mature days; used full-window mean`);
          if (Array.isArray(meceWarnings) && meceWarnings.length > 0) summaryLines.push(`mece_warnings: ${meceWarnings.join(' | ')}`);

          const verboseDetails =
            diagnosticsOn
              ? (() => {
                  const runs = winnerRuns
                    .slice(0, 250) // hard cap for safety; switchpoints should be small in practice
                    .map((r) => `${r.kind}: ${r.from} → ${r.to} :: ${r.detail}`)
                    .join('\n');
                  return `${summaryLines.join('\n')}\n\nmeta-slice switchpoints:\n${runs}`;
                })()
              : summaryLines.join('\n');

          sessionLogService.addChild(
            options.logOpId,
            'info',
            'FORECAST_BASIS',
            `Forecast recomputed at query time (${basisLabel})`,
            verboseDetails,
            {
              requestedSlice: targetSlice,
              targetDims,
              meceKey,
              asOf: asOfDate.toISOString(),
              maturityDays: maturityDaysUsed,
              halfLifeDays: effectiveHalfLifeForLog,
              weightedN: weightedNTotal,
              weightedK: weightedKTotal,
              forecastMean: forecastMeanComputed,
              t95Days: effectiveT95ForLog,
              t95Source: options.t95Source,
              metaDays: datesMeta.length,
              switchpoints: winnerRuns.length,
              diagnosticsOn,
            }
          );
        }
      }
    } else {
      // Scalar-only fallback: no usable daily arrays anywhere. Preserve legacy behaviour by attaching a
      // scalar forecast when available (even if header n is missing).
      const scalarCandidates = contextMatchedWindowCandidates.filter((v) => {
        const f = (v as any).forecast;
        return typeof f === 'number' && Number.isFinite(f);
      });

      // For uncontexted, if there is no explicit uncontexted scalar, attempt an implicit-uncontexted MECE aggregate
      // (weighted by header n when present).
      let forecastMeanComputed: number | undefined;
      let basisLabel = 'scalar (context-matching)';
      let basisSlices: string[] = [];

      if (scalarCandidates.length > 0) {
        const best = scalarCandidates.reduce((b, cur) => (parameterValueRecencyMs(cur) > parameterValueRecencyMs(b) ? cur : b));
        forecastMeanComputed = (best as any).forecast;
        basisSlices = [best.sliceDSL ?? '<missing sliceDSL>'];
        basisLabel = isUncontextedTarget ? 'scalar (explicit uncontexted)' : 'scalar (context-matching)';
      } else if (isUncontextedTarget && bestMECE?.values?.length) {
        let wN = 0;
        let wK = 0;
        let lone: any | undefined;
        for (const v of bestMECE.values) {
          const f = (v as any).forecast;
          if (typeof f !== 'number' || !Number.isFinite(f)) continue;
          lone = v;
          const n = typeof (v as any).n === 'number' && Number.isFinite((v as any).n) && (v as any).n > 0 ? (v as any).n : 0;
          if (n > 0) {
            wN += n;
            wK += n * f;
          }
          basisSlices.push(v.sliceDSL ?? '<missing sliceDSL>');
        }
        if (wN > 0) {
          forecastMeanComputed = wK / wN;
          basisLabel = `scalar (MECE(${meceKey ?? 'unknown'}))`;
        } else if (lone && typeof (lone as any).forecast === 'number') {
          // Last resort: single slice forecast with no n weighting available.
          forecastMeanComputed = (lone as any).forecast;
          basisLabel = `scalar (MECE(${meceKey ?? 'unknown'}), unweighted)`;
        }
      }

      if (forecastMeanComputed !== undefined) {
        // Doc 73f F15 fix: scalar-fallback paths cannot derive a window-aggregate
        // stdev because they have no weighted-N (no daily arrays). Emit no
        // forecast_stdev so downstream moment-matching correctly infers "no
        // dispersion available" rather than fabricating one.
        nextAggregated = {
          ...nextAggregated,
          values: (nextAggregated.values as ParameterValue[]).map((v: any) => ({
            ...v,
            forecast: forecastMeanComputed,
            forecast_stdev: undefined,
          })),
        };

        if (options?.logOpId) {
          const diagnosticsOn = sessionLogService.isLevelEnabled('debug');
          const msg = `Forecast attached from stored scalar (${basisLabel})`;
          const details = diagnosticsOn ? `slices:\n${basisSlices.join('\n')}` : undefined;
          sessionLogService.addChild(
            options.logOpId,
            'info',
            'FORECAST_BASIS',
            msg,
            details,
            {
              requestedSlice: targetSlice,
              targetDims,
              meceKey,
              forecastMean: forecastMeanComputed,
              basis: basisLabel,
              diagnosticsOn,
            }
          );
        }
      }
    }
    // NOTE: LAG computation (t95, completeness, forecast blend) is handled by
    // enhanceGraphLatencies in statisticalEnhancementService, which runs after
    // batch fetches in topological order. No fallback computation here.
  }

  return nextAggregated;
}
