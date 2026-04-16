/**
 * analysisECharts/snapshotBuilders.ts
 *
 * Snapshot chart builders: buildHistogramEChartsOption, buildDailyConversionsEChartsOption.
 *
 * Extracted from analysisEChartsService.ts — AEC-PR4.
 */

import {
  echartsThemeColours,
  echartsTooltipStyle,
  buildScenarioLegend,
  smoothRates,
  type RateSmoothingMethod,
} from './echartsCommon';

// ─── Builders ───────────────────────────────────────────────────────────────

/**
 * Build ECharts option for lag histogram (snapshot-based).
 * Input: LagHistogramResult { data: [{lag_days, conversions, pct}], total_conversions, cohorts_analysed }
 */
export function buildHistogramEChartsOption(data: any, settings: Record<string, any> = {}): any | null {
  if (!data?.data || data.data.length === 0) return null;

  const c = echartsThemeColours();
  const lagDays = data.data.map((d: any) => d.lag_days);
  const conversions = data.data.map((d: any) => d.conversions);
  const percentages = data.data.map((d: any) => d.pct * 100);

  const showLabels = settings.show_labels ?? (data.data.length <= 20);
  const yScale = settings.y_axis_scale ?? 'linear';

  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...echartsTooltipStyle(),
      formatter: (params: any) => {
        const item = params[0];
        const dataItem = data.data[item.dataIndex];
        return `<strong>Lag: ${dataItem.lag_days} day${dataItem.lag_days !== 1 ? 's' : ''}</strong><br/>Conversions: ${dataItem.conversions.toLocaleString()}<br/>Percentage: ${(dataItem.pct * 100).toFixed(1)}%`;
      },
    },
    grid: { left: 52, right: 16, bottom: '3%', top: 40, containLabel: false },
    xAxis: {
      type: 'category',
      data: lagDays,
      name: 'Lag (days)',
      nameLocation: 'middle',
      nameGap: 30,
      nameTextStyle: { fontSize: 8, color: c.text },
      axisLabel: { fontSize: 9, color: c.text },
    },
    yAxis: [{
      type: yScale === 'log' ? 'log' : 'value',
      name: settings.y_axis_title ?? 'Conversions',
      nameLocation: 'middle',
      nameGap: 45,
      nameTextStyle: { fontSize: 8, color: c.text },
      min: settings.y_axis_min ?? undefined,
      max: settings.y_axis_max ?? undefined,
      axisLabel: {
        fontSize: 9,
        color: c.text,
        formatter: (value: number) => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toString(),
      },
    }],
    series: [{
      name: 'Conversions',
      type: 'bar',
      data: conversions,
      itemStyle: { color: '#3b82f6', borderRadius: [2, 2, 0, 0] },
      label: {
        show: showLabels,
        position: 'top',
        fontSize: settings.label_font_size ?? 7,
        formatter: (params: any) => {
          const pct = percentages[params.dataIndex];
          return pct >= 1 ? `${pct.toFixed(0)}%` : '';
        },
      },
    }],
  };
}

/**
 * Build ECharts option for daily conversions (snapshot-based dual-axis time-series).
 *
 * Left Y-axis: 3-layer stacked bar per scenario per cohort date:
 *   1. E (evidence_y) — solid scenario colour
 *   2. F (projected_y − evidence_y) — striated (forecast residual)
 *   3. N remainder (x − projected_y) — very light fill (unconverted)
 *   Total height = N (cohort size x).
 *
 * Right Y-axis: two rate lines per scenario:
 *   - Evidence rate (evidence_y / x) — solid, circle markers
 *   - Forecast rate (projected_y / x) — dashed, no markers
 *   For immature cohorts these diverge; for mature cohorts they converge.
 *
 * Scenario colouring: single visible scenario → #808080 (grey, matching
 * getEffectiveScenarioColour convention). Multi-scenario → scenario metadata colour.
 */
export function buildDailyConversionsEChartsOption(
  result: any,
  settings: Record<string, any> = {},
  extra?: { visibleScenarioIds?: string[]; scenarioVisibilityModes?: Record<string, string>; subjectId?: string },
): any | null {
  const rows: any[] = Array.isArray(result?.data) ? result.data : [];
  if (rows.length === 0) return null;

  const c = echartsThemeColours();
  const visibleScenarioIds = extra?.visibleScenarioIds || ['current'];
  const scenarioMeta: any = result?.dimension_values?.scenario_id || {};
  const subjectMeta: any = result?.dimension_values?.subject_id || {};

  const scenarioIds = [...new Set(rows.map((r: any) => String(r?.scenario_id)).filter(Boolean))];
  const subjectIds = [...new Set(rows.map((r: any) => String(r?.subject_id)).filter(Boolean))];
  const multiScenario = scenarioIds.length > 1;
  const effectiveSubjectId = extra?.subjectId || subjectIds[0] || 'subject';

  let filteredRows = rows.filter((r: any) => visibleScenarioIds.includes(String(r?.scenario_id)));
  if (multiScenario) {
    filteredRows = filteredRows.filter((r: any) => String(r?.subject_id) === effectiveSubjectId);
  }

  const seriesKey = multiScenario ? 'scenario_id' : 'subject_id';
  const meta = multiScenario ? scenarioMeta : subjectMeta;

  // Standard forecast striation pattern (matches cohort maturity)
  const forecastDecal = { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [3, 3], rotation: -Math.PI / 4 } as any;

  // Hex colour → rgba string
  const hexToRgba = (hex: string, alpha: number): string => {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = (num >> 16) & 0xff;
    const g = (num >> 8) & 0xff;
    const b = num & 0xff;
    return `rgba(${r},${g},${b},${alpha})`;
  };

  type Point = {
    date: string;
    x: number;
    evidenceY: number;
    forecastResidual: number;
    projectedY: number;
    evidenceRate: number | null;
    forecastRate: number | null;
    forecastBands: Record<string, [number, number]> | null;
    latencyBands: Record<string, { rate: number; source: string; bands?: Record<string, [number, number]> }> | null;
  };
  const byKey = new Map<string, Point[]>();
  for (const r of filteredRows) {
    const key = String(r?.[seriesKey]);
    const date = String(r?.date);
    if (!key || !date) continue;

    const scenarioId = String(r?.scenario_id ?? '');
    const mode = scenarioMeta?.[scenarioId]?.visibility_mode
      ?? extra?.scenarioVisibilityModes?.[scenarioId]
      ?? 'f+e';
    const rawX = Number(r?.x ?? 0);
    const rawY = Number(r?.y ?? 0);
    const evidenceY = r?.evidence_y != null ? Number(r.evidence_y) : null;
    const projectedY = r?.projected_y != null ? Number(r.projected_y) : null;

    // Skip rows with zero cohort size
    if (rawX === 0 && rawY === 0) continue;

    // Determine E and F components based on visibility mode
    let eVal: number;
    let pVal: number; // projected total (e + f)
    if (mode === 'e') {
      eVal = evidenceY != null ? evidenceY : rawY;
      pVal = eVal; // no forecast component in E-only mode
    } else if (mode === 'f') {
      eVal = 0; // no evidence component in F-only mode
      pVal = projectedY != null ? projectedY : rawY;
    } else {
      // f+e: show both
      eVal = evidenceY != null ? evidenceY : rawY;
      pVal = projectedY != null ? projectedY : rawY;
    }

    const forecastResidual = Math.max(0, pVal - eVal);

    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push({
      date,
      x: Number.isFinite(rawX) ? rawX : 0,
      evidenceY: Number.isFinite(eVal) ? eVal : 0,
      forecastResidual: Number.isFinite(forecastResidual) ? forecastResidual : 0,
      projectedY: Number.isFinite(pVal) ? pVal : 0,
      evidenceRate: rawX > 0 && eVal > 0 ? eVal / rawX : (mode === 'f' ? null : 0),
      forecastRate: rawX > 0 ? pVal / rawX : null,
      forecastBands: r?.forecast_bands ?? null,
      latencyBands: r?.latency_bands ?? null,
    });
  }

  const allSeries: any[] = [];
  const keys = Array.from(byKey.keys()).sort();
  const lineSmooth = (settings.smooth_lines !== false) ? 0.25 : false;
  const showBarsRaw = settings.show_bars !== false;
  const showRatesRaw = settings.show_rates !== false;
  // At least one must be on — if both off, force bars on
  const showBars = showBarsRaw || !showRatesRaw;
  const showRates = showRatesRaw;
  const movingAvgMethod = (settings.moving_avg ?? 'off') as RateSmoothingMethod;
  const aggregateMode = String(settings.aggregate ?? 'daily');

  // Re-bin data for weekly/monthly aggregation.
  // Replaces per-day points with per-period points (Σx, Σy, aggregate rate).
  const isRebinning = aggregateMode === 'weekly' || aggregateMode === 'monthly';
  if (isRebinning) {
    const periodDays = aggregateMode === 'weekly' ? 7 : 30;
    for (const [key, points] of byKey.entries()) {
      if (points.length === 0) continue;
      // Sort and bucket by period
      const sorted = points.slice().sort((a, b) => a.date.localeCompare(b.date));
      const buckets = new Map<string, typeof points>();
      for (const p of sorted) {
        // Bucket key: start of period containing this date.
        // Weekly: ISO week start (Monday). Monthly: first of month.
        const d = new Date(p.date + 'T00:00:00Z');
        let bucketDate: string;
        if (aggregateMode === 'weekly') {
          const day = d.getUTCDay();
          const monday = new Date(d);
          monday.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
          bucketDate = monday.toISOString().slice(0, 10);
        } else {
          bucketDate = `${p.date.slice(0, 7)}-01`;
        }
        if (!buckets.has(bucketDate)) buckets.set(bucketDate, []);
        buckets.get(bucketDate)!.push(p);
      }
      // Aggregate each bucket into a single point
      const rebinned: typeof points = [];
      for (const [bucketDate, bPoints] of buckets.entries()) {
        const sumX = bPoints.reduce((s, p) => s + p.x, 0);
        const sumEY = bPoints.reduce((s, p) => s + p.evidenceY, 0);
        const sumFR = bPoints.reduce((s, p) => s + p.forecastResidual, 0);
        const sumPY = bPoints.reduce((s, p) => s + p.projectedY, 0);
        rebinned.push({
          date: bucketDate,
          x: sumX,
          evidenceY: sumEY,
          forecastResidual: sumFR,
          projectedY: sumPY,
          evidenceRate: sumX > 0 ? sumEY / sumX : null,
          forecastRate: sumX > 0 ? sumPY / sumX : null,
          // Merge forecast bands: weighted average by x
          forecastBands: (() => {
            const levels = ['80', '90', '95', '99'];
            const merged: Record<string, [number, number]> = {};
            for (const lv of levels) {
              let wLo = 0, wHi = 0, wTotal = 0;
              for (const p of bPoints) {
                const b = p.forecastBands?.[lv];
                if (b && p.x > 0) {
                  wLo += b[0] * p.x;
                  wHi += b[1] * p.x;
                  wTotal += p.x;
                }
              }
              if (wTotal > 0) merged[lv] = [wLo / wTotal, wHi / wTotal];
            }
            return Object.keys(merged).length > 0 ? merged : null;
          })(),
          // Merge latency bands: weighted average by x
          latencyBands: (() => {
            const allBandKeys = new Set<string>();
            for (const p of bPoints) {
              if (p.latencyBands) for (const k of Object.keys(p.latencyBands)) allBandKeys.add(k);
            }
            if (allBandKeys.size === 0) return null;
            const merged: Record<string, any> = {};
            for (const bk of allBandKeys) {
              let wRate = 0, wTotal = 0;
              let source = 'evidence';
              for (const p of bPoints) {
                const lb = p.latencyBands?.[bk];
                if (lb && p.x > 0) {
                  wRate += lb.rate * p.x;
                  wTotal += p.x;
                  if (lb.source === 'forecast') source = 'forecast';
                }
              }
              if (wTotal > 0) merged[bk] = { rate: wRate / wTotal, source };
            }
            return Object.keys(merged).length > 0 ? merged : null;
          })(),
        });
      }
      byKey.set(key, rebinned);
    }
  }

  // Collect all dates across all scenarios so stacking aligns correctly
  const allDates = new Set<string>();
  for (const points of byKey.values()) {
    for (const p of points) allDates.add(p.date);
  }
  const sortedDates = Array.from(allDates).sort();

  // Single visible scenario → grey; multi → scenario colour
  const isSingleScenario = keys.length <= 1;
  // Store smoothed forecast rates per key for band polygon alignment
  const smoothedFRateByKey = new Map<string, Array<[string, number | null]>>();
  const NEUTRAL = '#808080';

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const points = (byKey.get(key) || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const pointsByDate = new Map(points.map(p => [p.date, p]));
    const name = meta?.[key]?.name || key;
    const scenarioColour = isSingleScenario
      ? NEUTRAL
      : (meta?.[key]?.colour || NEUTRAL);

    // Resolve visibility mode from scenario_id, not seriesKey.
    // For single-scenario, key is subject_id — look up the first visible scenario instead.
    const _scId = multiScenario ? key : (visibleScenarioIds[0] || 'current');
    const mode = scenarioMeta?.[_scId]?.visibility_mode
      ?? extra?.scenarioVisibilityModes?.[_scId]
      ?? 'f+e';
    const showE = mode !== 'f';
    const showF = mode !== 'e';

    // Align to common date set — fill missing dates with 0 for correct stacking
    const alignedE = sortedDates.map(d => [d, pointsByDate.get(d)?.evidenceY ?? 0]);
    const alignedF = sortedDates.map(d => [d, pointsByDate.get(d)?.forecastResidual ?? 0]);
    const alignedNRemainder = sortedDates.map(d => {
      const p = pointsByDate.get(d);
      if (!p) return [d, 0];
      return [d, Math.max(0, p.x - p.projectedY)];
    });
    const alignedERate = smoothRates(
      sortedDates.map(d => [d, pointsByDate.get(d)?.evidenceRate ?? null] as [string, number | null]),
      movingAvgMethod,
    );
    const alignedFRate = smoothRates(
      sortedDates.map(d => [d, pointsByDate.get(d)?.forecastRate ?? null] as [string, number | null]),
      movingAvgMethod,
    );
    smoothedFRateByKey.set(key, alignedFRate);

    const stackId = isSingleScenario ? 'stack' : key;
    // When bars are hidden, rate lines go on yAxisIndex 0 (left axis)
    const rateAxisIndex = showBars ? 1 : 0;

    // --- Stacked bars (left axis) ---
    if (showBars) {
      if (showE) {
        allSeries.push({
          name: isSingleScenario ? 'Evidence' : `${name} · Evidence`,
          type: 'bar',
          stack: stackId,
          yAxisIndex: 0,
          barMaxWidth: 24,
          itemStyle: { color: scenarioColour },
          emphasis: { focus: 'series' },
          data: alignedE,
        });
      }

      if (showF) {
        allSeries.push({
          name: isSingleScenario ? 'Forecast' : `${name} · Forecast`,
          type: 'bar',
          stack: stackId,
          yAxisIndex: 0,
          barMaxWidth: 24,
          itemStyle: { color: scenarioColour, opacity: 0.4, decal: forecastDecal },
          emphasis: { focus: 'series' },
          data: alignedF,
        });
      }

      // N remainder — no name, hidden from legend
      allSeries.push({
        type: 'bar',
        stack: stackId,
        yAxisIndex: 0,
        barMaxWidth: 24,
        itemStyle: {
          color: hexToRgba(scenarioColour, 0.12),
          borderRadius: [2, 2, 0, 0],
        },
        emphasis: { focus: 'series' },
        legendHoverLink: false,
        data: alignedNRemainder,
      });
    }

    // --- Rate lines ---
    if (showRates) {
      if (showE) {
        allSeries.push({
          name: isSingleScenario ? 'Evidence %' : `${name} · Evidence %`,
          type: 'line',
          yAxisIndex: rateAxisIndex,
          showSymbol: sortedDates.length <= 30,
          symbolSize: 6,
          smooth: lineSmooth,
          connectNulls: false,
          lineStyle: { width: 2, color: scenarioColour, type: 'solid' },
          itemStyle: { color: scenarioColour },
          emphasis: { focus: 'series' },
          data: alignedERate,
        });
      }

      if (showF) {
        allSeries.push({
          name: isSingleScenario ? 'Forecast %' : `${name} · Forecast %`,
          type: 'line',
          yAxisIndex: rateAxisIndex,
          showSymbol: false,
          smooth: lineSmooth,
          connectNulls: false,
          lineStyle: { width: 2, color: scenarioColour, type: 'dashed', opacity: 0.75 },
          itemStyle: { color: scenarioColour, opacity: 0.75 },
          emphasis: { focus: 'series' },
          data: alignedFRate,
        });
      }
    }
  }

  // --- Forecast dispersion bands (fan polygons on rate axis) ---
  // Same rendering pattern as cohort maturity fan bands.
  const rateAxisIndex = showBars ? 1 : 0;
  const bandSetting = String(settings.bayes_band_level ?? 'blend');
  const bandIsOff = bandSetting === 'off' || bandSetting === 'Off';
  const bandIsBlend = !bandIsOff && (bandSetting === 'blend' || bandSetting === 'Blend');
  const bandLevels = bandIsOff
    ? []
    : bandIsBlend
      ? ['99', '95', '90', '80']
      : [bandSetting];

  if (bandLevels.length > 0 && showRates) {
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const _bandScId = multiScenario ? key : (visibleScenarioIds[0] || 'current');
      const scMode = scenarioMeta?.[_bandScId]?.visibility_mode
        ?? extra?.scenarioVisibilityModes?.[_bandScId]
        ?? 'f+e';
      if (scMode === 'e') continue; // no forecast bands in evidence-only mode
      const points = (byKey.get(key) || []).slice().sort((a, b) => a.date.localeCompare(b.date));
      const scenarioColour = isSingleScenario
        ? NEUTRAL
        : (meta?.[key]?.colour || NEUTRAL);

      for (const level of bandLevels) {
        const rawPoly: Array<{ date: string; upper: number; lower: number }> = [];
        for (const p of points) {
          const band = p.forecastBands?.[level];
          if (band && Number.isFinite(band[0]) && Number.isFinite(band[1]) && band[1] > band[0] + 0.001) {
            rawPoly.push({ date: p.date, upper: band[1], lower: band[0] });
          }
        }
        if (rawPoly.length < 2) continue;
        // Band = smoothed forecast rate ± smoothed half-width.
        // The forecast rate line (alignedFRate) is already smoothed.
        // Read the smoothed rate at each band date and add the
        // smoothed half-width. This guarantees the band is centred
        // exactly on the rendered forecast line.
        const halfWidths = rawPoly.map(p => [p.date, (p.upper - p.lower) / 2] as [string, number | null]);
        const smoothedHalf = smoothRates(halfWidths, movingAvgMethod);
        const _storedFRate = smoothedFRateByKey.get(key) || [];
        const fRateByDate = new Map(_storedFRate.map(d => [d[0], d[1]]));
        const poly = rawPoly
          .map((p, j) => {
            const rate = fRateByDate.get(p.date);
            const hw = smoothedHalf[j]?.[1];
            if (rate == null || hw == null) return null;
            return { date: p.date, upper: rate + hw, lower: Math.max(0, rate - hw) };
          })
          .filter((p): p is { date: string; upper: number; lower: number } => p !== null);

        const alphaHex = bandIsBlend ? '03' : '08'; // ~1% per layer in blend, ~3% single (hatch carries the visual)
        const fillColour = `${scenarioColour}${alphaHex}`;

        allSeries.push({
          type: 'custom' as any,
          coordinateSystem: 'cartesian2d',
          yAxisIndex: rateAxisIndex,
          encode: { x: 0, y: 1 },
          silent: true,
          renderItem: (params: any, api: any) => {
            if (params.dataIndex !== 0) return;
            const pts: number[][] = [];
            for (let j = 0; j < poly.length; j++) {
              pts.push(api.coord([poly[j].date, poly[j].upper]));
            }
            for (let j = poly.length - 1; j >= 0; j--) {
              pts.push(api.coord([poly[j].date, poly[j].lower]));
            }
            const gr = params.coordSys;
            const lastPt = api.coord([poly[poly.length - 1].date, 0]);
            const clipWidth = lastPt[0] - gr.x;
            const clipRect = { x: gr.x, y: gr.y, width: clipWidth, height: gr.height };
            // Forecast striation: diagonal hatch lines clipped to the band
            // polygon. Same pattern as cohort maturity forecast region
            // (hatchGap=8, lineWidth=1, 20% opacity).
            const hatchGap = 8;
            const hatchStroke = hexToRgba(scenarioColour, 0.20);
            const hatchLines: any[] = [];
            const diag = clipWidth + gr.height;
            for (let d = 0; d < diag; d += hatchGap) {
              hatchLines.push({
                type: 'line',
                shape: { x1: gr.x + d, y1: gr.y, x2: gr.x + d - gr.height, y2: gr.y + gr.height },
                style: { stroke: hatchStroke, lineWidth: 1 },
                silent: true,
              });
            }
            return {
              type: 'group',
              children: [
                {
                  type: 'polygon',
                  shape: { points: pts, smooth: lineSmooth || 0 },
                  style: { fill: fillColour, stroke: 'none' },
                },
                {
                  type: 'group',
                  children: hatchLines,
                  clipPath: { type: 'polygon', shape: { points: pts, smooth: lineSmooth || 0 } },
                },
              ],
              clipPath: { type: 'rect', shape: clipRect },
              silent: true,
            };
          },
          data: poly.map(p => [p.date, p.upper]),
        });
      }
    }
  }

  // --- Latency band lines (optional) ---
  // Per-τ rate lines showing how conversion rate varies by cohort date
  // at fixed maturity ages (25th/50th/75th percentile of latency CDF).
  // Solid where evidence exists (age ≥ τ), dashed+fan where forecast (age < τ).
  // Dash sparsity reflects maturity: sparser = more immature slice.
  const LATENCY_DASH_PATTERNS: Record<number, number[]> = {
    0: [8, 6],       // sparsest — youngest maturity slice
    1: [6, 4],       // medium
    2: [3, 2],       // densest — most mature slice
  };
  const LATENCY_BAND_OPACITY = 0.55;

  for (let ki = 0; ki < keys.length && showRates; ki++) {
    const key = keys[ki];
    const _lbScId = multiScenario ? key : (visibleScenarioIds[0] || 'current');
    const lbMode = scenarioMeta?.[_lbScId]?.visibility_mode
      ?? extra?.scenarioVisibilityModes?.[_lbScId]
      ?? 'f+e';
    const lbShowE = lbMode !== 'f';
    const lbShowF = lbMode !== 'e';
    const points = (byKey.get(key) || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const scenarioColour = isSingleScenario
      ? NEUTRAL
      : (meta?.[key]?.colour || NEUTRAL);

    // Collect all latency band keys across points
    const bandKeys = new Set<string>();
    for (const p of points) {
      if (p.latencyBands) {
        for (const k of Object.keys(p.latencyBands)) bandKeys.add(k);
      }
    }
    const sortedBandKeys = Array.from(bandKeys).sort((a, b) => {
      const na = parseInt(a); const nb = parseInt(b);
      return (Number.isFinite(na) ? na : 0) - (Number.isFinite(nb) ? nb : 0);
    });

    for (let bi = 0; bi < sortedBandKeys.length; bi++) {
      const bk = sortedBandKeys[bi];
      const dashPattern = LATENCY_DASH_PATTERNS[Math.min(bi, 2)] || [6, 4];
      const bandName = isSingleScenario ? bk : `${meta?.[key]?.name || key} · ${bk}`;

      // Build evidence (solid) and forecast (dashed) segments
      const evidenceData: Array<[string, number | null]> = [];
      const forecastData: Array<[string, number | null]> = [];

      for (const p of points) {
        const lb = p.latencyBands?.[bk];
        if (!lb) {
          evidenceData.push([p.date, null]);
          forecastData.push([p.date, null]);
          continue;
        }
        if (lb.source === 'evidence') {
          evidenceData.push([p.date, lbShowE ? lb.rate : null]);
          forecastData.push([p.date, null]);
        } else {
          evidenceData.push([p.date, null]);
          forecastData.push([p.date, lbShowF ? lb.rate : null]);
          // Fan band data collected per level below
        }
      }

      // Apply smoothing to latency band rate data
      const smoothedEvidence = smoothRates(evidenceData, movingAvgMethod);
      const smoothedForecast = smoothRates(forecastData, movingAvgMethod);

      // Evidence portion — solid thin line with markers
      if (smoothedEvidence.some(d => d[1] !== null)) {
        allSeries.push({
          name: bandName,
          type: 'line',
          yAxisIndex: rateAxisIndex,
          showSymbol: true,
          symbolSize: 4,
          smooth: lineSmooth,
          connectNulls: false,
          lineStyle: { width: 1.5, color: scenarioColour, type: 'solid', opacity: LATENCY_BAND_OPACITY },
          itemStyle: { color: scenarioColour, opacity: LATENCY_BAND_OPACITY },
          emphasis: { focus: 'series' },
          data: smoothedEvidence,
        });
      }

      // Forecast portion — dashed thin line, no markers
      const forecastName = `${bandName} (f)`;
      if (smoothedForecast.some(d => d[1] !== null)) {
        allSeries.push({
          name: forecastName,
          type: 'line',
          yAxisIndex: rateAxisIndex,
          showSymbol: false,
          smooth: lineSmooth,
          connectNulls: false,
          lineStyle: { width: 1.5, color: scenarioColour, type: dashPattern, opacity: LATENCY_BAND_OPACITY },
          itemStyle: { color: scenarioColour, opacity: LATENCY_BAND_OPACITY },
          emphasis: { focus: 'series' },
          data: smoothedForecast,
        });
      }

      // Fan polygons for forecast region — per band level, striated
      const latBandSetting = String(settings.latency_band_level ?? 'off');
      const latBandOff = latBandSetting === 'off' || latBandSetting === 'Off';
      const latBandBlend = !latBandOff && (latBandSetting === 'blend' || latBandSetting === 'Blend');
      const latBandLevels = latBandOff
        ? []
        : latBandBlend
          ? ['99', '95', '90', '80']
          : [latBandSetting];

      for (const latLvl of latBandLevels) {
        const fanPoly: Array<{ date: string; upper: number; lower: number }> = [];
        for (const p of points) {
          const lb = p.latencyBands?.[bk];
          if (lb && lb.source === 'forecast' && lbShowF && lb.bands) {
            const b = lb.bands[latLvl];
            if (b && Number.isFinite(b[0]) && Number.isFinite(b[1]) && b[1] > b[0] + 0.001) {
              fanPoly.push({ date: p.date, upper: b[1], lower: b[0] });
            }
          }
        }
        if (fanPoly.length < 4) continue;

        const fanAlphaHex = latBandBlend ? '03' : '08';
        allSeries.push({
          type: 'custom' as any,
          coordinateSystem: 'cartesian2d',
          yAxisIndex: rateAxisIndex,
          encode: { x: 0, y: 1 },
          silent: true,
          renderItem: (params: any, api: any) => {
            if (params.dataIndex !== 0) return;
            const pts: number[][] = [];
            for (let j = 0; j < fanPoly.length; j++) {
              pts.push(api.coord([fanPoly[j].date, fanPoly[j].upper]));
            }
            for (let j = fanPoly.length - 1; j >= 0; j--) {
              pts.push(api.coord([fanPoly[j].date, fanPoly[j].lower]));
            }
            const gr = params.coordSys;
            const lastPt = api.coord([fanPoly[fanPoly.length - 1].date, 0]);
            const clipWidth = lastPt[0] - gr.x;
            const clipRect = { x: gr.x, y: gr.y, width: clipWidth, height: gr.height };
            const hLines: any[] = [];
            const diag = clipWidth + gr.height;
            for (let dd = 0; dd < diag; dd += 8) {
              hLines.push({
                type: 'line',
                shape: { x1: gr.x + dd, y1: gr.y, x2: gr.x + dd - gr.height, y2: gr.y + gr.height },
                style: { stroke: hexToRgba(scenarioColour, 0.20), lineWidth: 1 },
                silent: true,
              });
            }
            return {
              type: 'group',
              children: [
                {
                  type: 'polygon',
                  shape: { points: pts, smooth: lineSmooth || 0 },
                  style: { fill: `${scenarioColour}${fanAlphaHex}`, stroke: 'none' },
                },
                {
                  type: 'group',
                  children: hLines,
                  clipPath: { type: 'polygon', shape: { points: pts, smooth: lineSmooth || 0 } },
                },
              ],
              clipPath: { type: 'rect', shape: clipRect },
              silent: true,
            };
          },
          data: fanPoly.map(p => [p.date, p.upper]),
        });
      }
    }
  }

  // --- Legend ---
  // Multi-scenario: concepts once in neutral + one colour swatch per scenario.
  // Single scenario: auto-discover from series names (concepts ARE the names).
  const scenarioLegend = buildScenarioLegend({
    concepts: [
      { label: 'Evidence', seriesType: 'bar', icon: 'roundRect', itemStyle: { color: NEUTRAL } },
      { label: 'Forecast', seriesType: 'bar', icon: 'roundRect', itemStyle: { color: NEUTRAL, opacity: 0.4, decal: forecastDecal } },
      { label: 'Evidence %', seriesType: 'line', icon: 'line', lineStyle: { color: NEUTRAL, type: 'solid' } },
      { label: 'Forecast %', seriesType: 'line', icon: 'path://M0,5L4,5M6,5L10,5M12,5L16,5M18,5L22,5', lineStyle: { color: NEUTRAL, type: 'dashed' } },
    ],
    scenarios: keys.map(key => ({
      name: meta?.[key]?.name || key,
      colour: meta?.[key]?.colour || NEUTRAL,
    })),
    seriesArray: allSeries,
  });

  if (allSeries.length === 0) return null;

  let maxRate = 0;
  for (const s of allSeries) {
    if (s.type !== 'line') continue;
    for (const d of s.data) {
      const v = d?.[1];
      if (typeof v === 'number' && Number.isFinite(v) && v > maxRate) maxRate = v;
    }
  }
  const rateMax = Math.min(1.0, Math.max(0.05, Math.ceil((maxRate * 1.2) * 20) / 20));

  const yScale = settings.y_axis_scale ?? 'linear';
  const showLegend = settings.show_legend ?? true;

  // Count bar+line series for legend height estimate
  const legendItemCount = allSeries.filter(s => s.name).length;

  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...echartsTooltipStyle(),
      formatter: (params: any) => {
        const items = Array.isArray(params) ? params : [params];
        const first = items[0];
        const dateRaw = first?.value?.[0];
        const dateStr = typeof dateRaw === 'number'
          ? new Date(dateRaw).toISOString().slice(0, 10)
          : String(dateRaw || '');
        const d = new Date(dateStr);
        const title = Number.isNaN(d.getTime()) ? dateStr : `${d.getDate()}-${d.toLocaleDateString('en-GB', { month: 'short' })}-${d.toLocaleDateString('en-GB', { year: '2-digit' })}`;
        const lines = items.map((it: any) => {
          const val = it?.value?.[1];
          const isRate = it?.seriesIndex !== undefined && allSeries[it.seriesIndex]?.type === 'line';
          const formatted = isRate
            ? (val === null || val === undefined || !Number.isFinite(val) ? '—' : `${(val * 100).toFixed(1)}%`)
            : (val === null || val === undefined || !Number.isFinite(val) ? '—' : val.toLocaleString());
          return `${it?.marker || ''} ${it?.seriesName || ''}: <strong>${formatted}</strong>`;
        });
        return `<strong>${title}</strong><br/>${lines.join('<br/>')}`;
      },
    },
    grid: { left: 52, right: 52, bottom: 60, top: 40, containLabel: false },
    xAxis: {
      type: 'time',
      name: 'Cohort date',
      nameLocation: 'middle',
      nameGap: 30,
      nameTextStyle: { fontSize: 8, color: c.text },
      axisLabel: {
        fontSize: 9,
        rotate: 30,
        color: c.text,
        formatter: (value: number) => {
          const d = new Date(value);
          if (Number.isNaN(d.getTime())) return '';
          return `${d.getUTCDate()}-${d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
        },
      },
    },
    yAxis: showBars && showRates
      ? [
          {
            type: yScale === 'log' ? 'log' : 'value',
            name: 'N',
            nameLocation: 'middle',
            nameGap: 45,
            nameTextStyle: { fontSize: 8, color: c.text },
            min: settings.y_axis_min ?? 0,
            axisLabel: {
              fontSize: 9,
              color: c.text,
              formatter: (value: number) => {
                if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
                if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
                return value.toString();
              },
            },
            splitLine: { lineStyle: { color: c.gridLine } },
          },
          {
            type: 'value',
            name: 'Conversion %',
            nameLocation: 'middle',
            nameGap: 50,
            nameTextStyle: { fontSize: 8, color: c.text },
            min: 0,
            max: settings.y_axis_max ?? rateMax,
            axisLabel: {
              fontSize: 9,
              color: c.text,
              formatter: (v: number) => `${(v * 100).toFixed(0)}%`,
            },
            splitLine: { show: false },
          },
        ]
      : showBars
        ? [{
            type: yScale === 'log' ? 'log' : 'value',
            name: 'N',
            nameLocation: 'middle',
            nameGap: 45,
            nameTextStyle: { fontSize: 8, color: c.text },
            min: settings.y_axis_min ?? 0,
            axisLabel: {
              fontSize: 9,
              color: c.text,
              formatter: (value: number) => {
                if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
                if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
                return value.toString();
              },
            },
            splitLine: { lineStyle: { color: c.gridLine } },
          }]
        : [{
            type: 'value',
            name: 'Conversion %',
            nameLocation: 'middle',
            nameGap: 45,
            nameTextStyle: { fontSize: 8, color: c.text },
            min: 0,
            max: settings.y_axis_max ?? rateMax,
            axisLabel: {
              fontSize: 9,
              color: c.text,
              formatter: (v: number) => `${(v * 100).toFixed(0)}%`,
            },
            splitLine: { lineStyle: { color: c.gridLine } },
          }],
    legend: showLegend ? {
      top: 14, left: 12,
      textStyle: { fontSize: 8, color: c.text },
      itemGap: 6, itemWidth: 36, itemHeight: 8,
      data: allSeries
        .filter(s => {
          if (!s.name) return false;
          if (isSingleScenario) return true;
          // Multi-scenario: show all 4 concepts for FIRST scenario,
          // then only the Evidence bar for subsequent scenarios (colour swatch).
          const firstScenarioName = meta?.[keys[0]]?.name || keys[0];
          if (s.name.startsWith(`${firstScenarioName} · `)) return true;
          if (s.name.endsWith(' · Evidence') && s.type === 'bar') return true;
          return false;
        })
        .map(s => ({ name: s.name, icon: s.type === 'line' ? undefined : 'roundRect' })),
      formatter: isSingleScenario ? undefined : (name: string) => {
        const dot = name.indexOf(' · ');
        if (dot < 0) return name;
        const prefix = name.slice(0, dot);
        const suffix = name.slice(dot + 3);
        const firstScenarioName = meta?.[keys[0]]?.name || keys[0];
        // First scenario's series → show concept label only
        if (prefix === firstScenarioName) return suffix;
        // Other scenarios' Evidence bar → show scenario name only
        return prefix;
      },
    } : { show: false },
    series: allSeries,
    ...(settings.animate === false ? { animation: false } : {}),
  };
}

