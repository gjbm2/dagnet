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
  darkenHex,
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

    // --- Rate lines (epoch A/B/forecast convention) ---
    // Main lines use a darker shade for visual prominence over latency bands.
    const mainLineColour = darkenHex(scenarioColour, 0.3);
    // Epoch A: mature Cohorts (completeness ≥ 0.95) — solid + markers
    // Epoch B: immature Cohorts (completeness < 0.95) — dashed, no markers
    // Forecast: dotted, no markers
    if (showRates) {
      if (showE) {
        // Split evidence into epoch A (solid) and epoch B (dashed)
        const epochARate: Array<[string, number | null]> = [];
        const epochBRate: Array<[string, number | null]> = [];
        for (let di = 0; di < sortedDates.length; di++) {
          const d = sortedDates[di];
          const p = pointsByDate.get(d);
          const rate = alignedERate[di]?.[1] ?? null;
          // Use raw row completeness to determine epoch. If no raw row exists
          // for this date (i.e. date is outside the scenario's data range),
          // drop the point from both epochs so smoothing tails don't leak
          // past the scenario's scope as phantom Epoch A markers.
          const rawRow = filteredRows.find((r: any) =>
            String(r?.date) === d && String(r?.[seriesKey]) === key);
          if (!rawRow) {
            epochARate.push([d, null]);
            epochBRate.push([d, null]);
            continue;
          }
          const c = rawRow.completeness ?? 1;
          if (c >= 0.95) {
            epochARate.push([d, rate]);
            epochBRate.push([d, null]);
          } else {
            epochARate.push([d, null]);
            epochBRate.push([d, rate]);
          }
        }
        // Overlap point for line continuity at the epoch boundary
        for (let di = 1; di < sortedDates.length; di++) {
          if (epochARate[di][1] === null && epochARate[di - 1][1] !== null
              && epochBRate[di][1] !== null) {
            epochBRate[di - 1] = [epochBRate[di - 1][0], epochARate[di - 1][1]];
          }
        }

        // Epoch A — solid, circle markers
        if (epochARate.some(d => d[1] !== null)) {
          allSeries.push({
            name: isSingleScenario ? 'Evidence %' : `${name} · Evidence %`,
            type: 'line',
            yAxisIndex: rateAxisIndex,
            showSymbol: sortedDates.length <= 30,
            symbolSize: 6,
            smooth: lineSmooth,
            connectNulls: false,
            lineStyle: { width: 2, color: mainLineColour, type: 'solid' },
            itemStyle: { color: mainLineColour },
            emphasis: { focus: 'series' },
            data: epochARate,
          });
        }

        // Epoch B — dashed, no markers
        if (epochBRate.some(d => d[1] !== null)) {
          allSeries.push({
            type: 'line',
            yAxisIndex: rateAxisIndex,
            showSymbol: false,
            smooth: lineSmooth,
            connectNulls: false,
            lineStyle: { width: 2, color: mainLineColour, type: 'dashed', opacity: 0.75 },
            itemStyle: { color: mainLineColour, opacity: 0.75 },
            emphasis: { focus: 'series' },
            data: epochBRate,
          });
        }
      }

      if (showF) {
        allSeries.push({
          name: isSingleScenario ? 'Forecast %' : `${name} · Forecast %`,
          type: 'line',
          yAxisIndex: rateAxisIndex,
          showSymbol: false,
          smooth: lineSmooth,
          connectNulls: false,
          lineStyle: { width: 2, color: mainLineColour, type: 'dotted', opacity: 0.6 },
          itemStyle: { color: mainLineColour, opacity: 0.6 },
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
      const pointsByDate = new Map(points.map(p => [p.date, p]));
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
        // Band edges are asymmetric around the forecast rate (the
        // y_draws distribution is right-skewed for immature cohorts).
        // Decompose into separate upper/lower offsets from the raw
        // forecast rate, smooth each independently, then reconstruct
        // around the smoothed forecast rate. This preserves asymmetry
        // and guarantees the lower edge stays >= evidence rate.
        const _storedFRate = smoothedFRateByKey.get(key) || [];
        const fRateByDate = new Map(_storedFRate.map(d => [d[0], d[1]]));
        const upperOffsets = rawPoly.map(p => {
          const rawFR = pointsByDate.get(p.date)?.forecastRate;
          return [p.date, rawFR != null ? p.upper - rawFR : null] as [string, number | null];
        });
        const lowerOffsets = rawPoly.map(p => {
          const rawFR = pointsByDate.get(p.date)?.forecastRate;
          return [p.date, rawFR != null ? rawFR - p.lower : null] as [string, number | null];
        });
        const smoothedUpper = smoothRates(upperOffsets, movingAvgMethod);
        const smoothedLower = smoothRates(lowerOffsets, movingAvgMethod);
        const poly = rawPoly
          .map((p, j) => {
            const rate = fRateByDate.get(p.date);
            const uo = smoothedUpper[j]?.[1];
            const lo = smoothedLower[j]?.[1];
            if (rate == null || uo == null || lo == null) return null;
            const evRate = pointsByDate.get(p.date)?.evidenceRate ?? 0;
            return { date: p.date, upper: rate + uo, lower: Math.max(evRate, rate - lo) };
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
  // One unified line per band — dash pattern encodes the percentile:
  //   25% (sparsest): ·    ·    ·    ·
  //   50% (medium):   ·   ·   ·   ·
  //   75% (densest):  ·  ·  ·  ·
  const LATENCY_DASH_PATTERNS: number[][] = [
    [2, 8],   // 25% — dot, long gap (sparsest)
    [2, 5],   // 50% — dot, medium gap
    [2, 3],   // 75% — dot, short gap (densest)
  ];
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
      const dashPattern = LATENCY_DASH_PATTERNS[Math.min(bi, LATENCY_DASH_PATTERNS.length - 1)];
      const bandName = isSingleScenario ? bk : `${meta?.[key]?.name || key} · ${bk}`;

      // Skip bands where evidence is too sparse to be meaningful.
      // If fewer than 30% of evidence points are non-zero, the band
      // is mostly noise (e.g. too-young τ for this edge's latency).
      {
        let _evTotal = 0, _evNonZero = 0;
        for (const p of points) {
          const lb = p.latencyBands?.[bk];
          if (lb && lb.source === 'evidence') {
            _evTotal++;
            if (lb.rate > 0.001) _evNonZero++;
          }
        }
        if (_evTotal > 0 && _evNonZero / _evTotal < 0.3) continue;
      }

      // Smooth the combined data first (one EWMA pass), then split
      // into evidence/forecast for rendering with different opacities.
      // This avoids EWMA discontinuity at the evidence→forecast boundary.
      const combinedRaw: Array<[string, number | null]> = [];
      const sourceMap: Array<'evidence' | 'forecast' | null> = [];
      for (const p of points) {
        const lb = p.latencyBands?.[bk];
        if (!lb) {
          combinedRaw.push([p.date, null]);
          sourceMap.push(null);
        } else if (lb.source === 'evidence') {
          combinedRaw.push([p.date, lbShowE ? lb.rate : null]);
          sourceMap.push('evidence');
        } else {
          combinedRaw.push([p.date, lbShowF ? lb.rate : null]);
          sourceMap.push('forecast');
        }
      }
      const smoothedCombined = smoothRates(combinedRaw, movingAvgMethod);

      // Split into evidence (75% opacity) and forecast (30% opacity).
      // Duplicate the last evidence point as the first forecast point
      // so the two segments connect without a gap.
      let lastEvidenceIdx = -1;
      for (let j = smoothedCombined.length - 1; j >= 0; j--) {
        if (sourceMap[j] === 'evidence' && smoothedCombined[j][1] != null) {
          lastEvidenceIdx = j;
          break;
        }
      }

      const evidenceData = smoothedCombined.map((d, j) =>
        [d[0], sourceMap[j] === 'evidence' ? d[1] : null] as [string, number | null]);
      const forecastData = smoothedCombined.map((d, j) =>
        [d[0], sourceMap[j] === 'forecast' ? d[1] : null] as [string, number | null]);

      // Bridge: copy last evidence point into forecast array
      if (lastEvidenceIdx >= 0 && smoothedCombined[lastEvidenceIdx][1] != null) {
        forecastData[lastEvidenceIdx] = [
          smoothedCombined[lastEvidenceIdx][0],
          smoothedCombined[lastEvidenceIdx][1],
        ];
      }

      // Evidence segment — 75% opacity
      if (evidenceData.some(d => d[1] !== null)) {
        allSeries.push({
          name: bandName,
          type: 'line',
          yAxisIndex: rateAxisIndex,
          showSymbol: false,
          smooth: lineSmooth,
          connectNulls: false,
          lineStyle: { width: 1.5, color: scenarioColour, type: dashPattern, opacity: 0.75 },
          itemStyle: { color: scenarioColour, opacity: 0.75 },
          emphasis: { focus: 'series' },
          data: evidenceData,
        });
      }

      // Forecast segment — 30% opacity, same dash pattern
      if (forecastData.some(d => d[1] !== null)) {
        allSeries.push({
          type: 'line',
          yAxisIndex: rateAxisIndex,
          showSymbol: false,
          smooth: lineSmooth,
          connectNulls: false,
          lineStyle: { width: 1.5, color: scenarioColour, type: dashPattern, opacity: 0.30 },
          itemStyle: { color: scenarioColour, opacity: 0.30 },
          emphasis: { focus: 'series' },
          data: forecastData,
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
      minInterval: 86400000, // 1 day — prevent sub-day ticks
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

/**
 * Build ECharts option for conversion rate analysis (doc 49 Part B).
 *
 * Per scenario, per time bin:
 *   1. Scatter circle at observed k/n — circle area scales with n.
 *   2. Dashed line connecting epistemic posterior means (as-at fit_history).
 *   3. Non-striated filled band showing epistemic 90% HDI.
 *
 * Reverse trumpet: bands narrow as successive fit_history entries produce
 * progressively more confident posteriors. See doc 49 §B.4.
 *
 * Non-latency edges only (doc 49 §B.2) — BE handler suppresses latency
 * edges and surfaces an error message.
 */
export function buildConversionRateEChartsOption(
  result: any,
  settings: Record<string, any> = {},
  extra?: { visibleScenarioIds?: string[]; subjectId?: string },
): any | null {
  const rows: any[] = Array.isArray(result?.data) ? result.data : [];
  if (rows.length === 0) return null;

  const c = echartsThemeColours();
  const visibleScenarioIds = extra?.visibleScenarioIds || ['current'];
  const scenarioMeta: any = result?.dimension_values?.scenario_id || {};
  const subjectIds = [...new Set(rows.map((r: any) => String(r?.subject_id)).filter(Boolean))];
  const effectiveSubjectId = extra?.subjectId || subjectIds[0] || 'subject';

  // Always key series by scenario_id (matches daily_conversions pattern).
  // Subject filtering happens up front when there are multiple subjects.
  let filteredRows = rows.filter((r: any) => visibleScenarioIds.includes(String(r?.scenario_id)));
  if (subjectIds.length > 1) {
    filteredRows = filteredRows.filter((r: any) => String(r?.subject_id) === effectiveSubjectId);
  }

  const visibleScenarios = [...new Set(filteredRows.map((r: any) => String(r?.scenario_id)).filter(Boolean))];
  const isSingleScenario = visibleScenarios.length <= 1;
  const seriesKey = 'scenario_id';
  const meta = scenarioMeta;

  // Hex → rgba for band fills
  const hexToRgba = (hex: string, alpha: number): string => {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = (num >> 16) & 0xff;
    const g = (num >> 8) & 0xff;
    const b = num & 0xff;
    return `rgba(${r},${g},${b},${alpha})`;
  };

  type Point = {
    bin_start: string;
    x: number;
    y: number;
    rate: number | null;
    hdi_lower: number | null;
    hdi_upper: number | null;
    posterior_mean: number | null;
    evidence_grade: number;
    fitted_at: string | null;
  };

  const byKey = new Map<string, Point[]>();
  for (const r of filteredRows) {
    const key = String(r?.[seriesKey] ?? '');
    const bin = String(r?.bin_start ?? r?.date ?? '');
    if (!key || !bin) continue;
    const x = Number(r?.x ?? 0);
    const y = Number(r?.y ?? 0);
    const rate = r?.rate != null ? Number(r.rate) : null;
    const epist = r?.epistemic || null;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push({
      bin_start: bin,
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      rate,
      hdi_lower: epist?.hdi_lower != null ? Number(epist.hdi_lower) : null,
      hdi_upper: epist?.hdi_upper != null ? Number(epist.hdi_upper) : null,
      posterior_mean: epist?.posterior_mean != null ? Number(epist.posterior_mean) : null,
      evidence_grade: epist?.evidence_grade != null ? Number(epist.evidence_grade) : 0,
      fitted_at: epist?.fitted_at ?? null,
    });
  }

  // Compute n-scaling for scatter circle sizes (area ∝ n).
  let maxX = 0;
  for (const pts of byKey.values()) for (const p of pts) if (p.x > maxX) maxX = p.x;
  const MIN_PX = 4;
  const MAX_PX = 14;
  const sizeFor = (x: number): number => {
    if (!Number.isFinite(x) || x <= 0 || maxX <= 0) return MIN_PX;
    const frac = Math.sqrt(x / maxX);
    return MIN_PX + frac * (MAX_PX - MIN_PX);
  };

  const showBands = settings.show_epistemic_bands !== false;
  const showModelLine = settings.show_model_midpoint !== false;

  const allSeries: any[] = [];
  const keys = Array.from(byKey.keys()).sort();

  // Fill a value array by forward-then-backward propagation of non-nulls.
  const fillArray = (vals: (number | null)[]): (number | null)[] => {
    const out = vals.slice();
    let last: number | null = null;
    for (let i = 0; i < out.length; i++) {
      if (out[i] != null) last = out[i];
      else if (last != null) out[i] = last;
    }
    last = null;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i] != null) last = out[i];
      else if (last != null) out[i] = last;
    }
    return out;
  };

  // Consistent naming: series always named "{scenario} · {concept}". The legend
  // filter below strips "{firstScenario} · " for concept entries and the trailing
  // "· {concept}" for swatch entries — same pattern as daily_conversions.
  for (const key of keys) {
    const pts = byKey.get(key)!.sort((a, b) => a.bin_start.localeCompare(b.bin_start));
    const scenarioName = scenarioMeta?.[key]?.name || key;
    // Current scenario defaults to #3B82F6 (the canvas "Current" scenario blue).
    const colour = scenarioMeta?.[key]?.colour || (key === 'current' ? '#3B82F6' : '#808080');

    // HDI band: fill-forward/backward bounds so the band spans every bin once
    // any fit_history entry exists. Stacked invisible lower + height with areaStyle.
    if (showBands) {
      const filledLo = fillArray(pts.map(p => p.hdi_lower));
      const filledHi = fillArray(pts.map(p => p.hdi_upper));
      const bandLo: Array<[string, number | null]> = pts.map((p, i) => [p.bin_start, filledLo[i]]);
      const bandHi: Array<[string, number | null]> = pts.map((p, i) => [
        p.bin_start,
        (filledHi[i] != null && filledLo[i] != null) ? (filledHi[i]! - filledLo[i]!) : null,
      ]);
      if (bandLo.some(d => d[1] != null)) {
        allSeries.push({
          id: `${key}::hdi_lower`,
          name: `__${key}_hdi_lower`,
          type: 'line',
          data: bandLo,
          lineStyle: { opacity: 0 },
          symbol: 'none',
          stack: `${key}::hdi`,
          silent: true,
          color: colour,
          z: 1,
        });
        allSeries.push({
          id: `${key}::hdi_band`,
          name: `${scenarioName} · HDI 90%`,
          type: 'line',
          data: bandHi,
          lineStyle: { opacity: 0 },
          symbol: 'none',
          stack: `${key}::hdi`,
          areaStyle: { color: hexToRgba(colour, 0.18) },
          itemStyle: { color: colour },
          color: colour,
          z: 1,
        });
      }
    }

    // Model midpoint line (fill-forward/backward so one current fit renders across all bins)
    if (showModelLine) {
      const filled = fillArray(pts.map(p => p.posterior_mean));
      const midpoint = pts.map((p, i) => [p.bin_start, filled[i]]);
      if (midpoint.some(d => d[1] != null)) {
        allSeries.push({
          id: `${key}::model_midpoint`,
          name: `${scenarioName} · Model rate`,
          type: 'line',
          data: midpoint,
          lineStyle: { color: colour, type: 'dashed', width: 1.5, opacity: 0.85 },
          itemStyle: { color: colour },
          color: colour,
          symbol: 'none',
          connectNulls: true,
          z: 2,
        });
      }
    }

    // Observed scatter (circle area ∝ n)
    const scatter = pts.map((p) => ({
      value: [p.bin_start, p.rate],
      symbolSize: sizeFor(p.x),
      _x: p.x,
      _y: p.y,
      _fitted_at: p.fitted_at,
      _hdi_lower: p.hdi_lower,
      _hdi_upper: p.hdi_upper,
      _posterior_mean: p.posterior_mean,
    }));
    allSeries.push({
      id: `${key}::observed`,
      name: `${scenarioName} · Observed`,
      type: 'scatter',
      data: scatter,
      color: colour,
      itemStyle: {
        color: hexToRgba(colour, 0.35),
        borderColor: colour,
        borderWidth: 1,
      },
      emphasis: { itemStyle: { color: hexToRgba(colour, 0.7) } },
      z: 3,
    });
  }

  // Size legend: compact horizontal row top-right of chart area.
  // Format: "Cohort size:  ·  ●  ●●  ●●●"  with value labels under each bubble.
  const sizeLegendGraphics: any[] = [];
  if (maxX > 0) {
    const fmtN = (n: number): string => {
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
      if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
      return String(n);
    };
    const smallN = Math.max(1, Math.round(maxX * 0.1));
    const medN = Math.max(2, Math.round(maxX * 0.4));
    const largeN = maxX;
    // Place top-right in grid, left of the right-edge. top=14 aligns with legend.
    const baseTop = 14;
    const baseRight = 16;
    const gap = 34;                 // horizontal spacing between bubbles
    const labelOffsetY = 12;        // value label below bubble
    const itemsDesc = [
      { n: largeN, px: sizeFor(largeN) },
      { n: medN,   px: sizeFor(medN) },
      { n: smallN, px: sizeFor(smallN) },
    ];
    // Rightmost first so labels align cleanly
    let rightCursor = baseRight;
    for (const it of itemsDesc) {
      sizeLegendGraphics.push({
        type: 'circle',
        right: rightCursor + (MAX_PX / 2) - (it.px / 2),
        top: baseTop + (MAX_PX / 2) - (it.px / 2),
        shape: { r: it.px / 2 },
        style: { fill: 'rgba(128,128,128,0.25)', stroke: c.textSecondary, lineWidth: 1 },
        silent: true,
      });
      sizeLegendGraphics.push({
        type: 'text',
        right: rightCursor - 4,
        top: baseTop + MAX_PX + labelOffsetY - 10,
        style: { text: fmtN(it.n), fontSize: 9, fill: c.textSecondary, align: 'right' },
        silent: true,
      });
      rightCursor += gap;
    }
    // Caption to the left of the bubbles
    sizeLegendGraphics.push({
      type: 'text',
      right: rightCursor - 4,
      top: baseTop + (MAX_PX / 2) - 5,
      style: { text: 'Cohort n', fontSize: 9, fill: c.textSecondary, align: 'right' },
      silent: true,
    });
  }

  // Legend: concepts (HDI band / Model rate / Observed) once with neutral
  // styling via first-scenario series references; one swatch per additional
  // scenario. Same pattern as daily_conversions.
  const firstScenarioName = keys.length ? (scenarioMeta?.[keys[0]]?.name || keys[0]) : '';
  const showLegend = settings.show_legend ?? true;

  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        lineStyle: { color: c.textMuted, width: 1, type: 'dashed', opacity: 0.6 },
      },
      ...echartsTooltipStyle(),
      formatter: (params: any) => {
        const items = Array.isArray(params) ? params : [params];
        if (items.length === 0) return '';
        const raw = items[0]?.axisValue ?? items[0]?.value?.[0];
        const d = typeof raw === 'number' ? new Date(raw) : new Date(String(raw));
        const title = Number.isNaN(d.getTime())
          ? String(raw)
          : `${d.getUTCDate()}-${d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}-${d.toLocaleDateString('en-GB', { year: '2-digit', timeZone: 'UTC' })}`;
        const fmtPct = (v: any): string =>
          (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—' : `${(Number(v) * 100).toFixed(1)}%`;
        const lines = items
          .filter((it: any) => it?.seriesName && !String(it.seriesName).startsWith('__'))
          .map((it: any) => `${it?.seriesName || 'Series'}: <strong>${fmtPct(it?.value?.[1])}</strong>`);
        return `<strong>${title}</strong><br/>${lines.join('<br/>')}`;
      },
    },
    legend: showLegend ? {
      top: 14, left: 12,
      textStyle: { fontSize: 8, color: c.text },
      itemGap: 6, itemWidth: 36, itemHeight: 8,
      data: allSeries
        .filter(s => {
          if (!s.name || s.name.startsWith('__')) return false;
          if (isSingleScenario) return true;
          // Multi: all concepts for first scenario, Observed swatch only for others.
          if (s.name.startsWith(`${firstScenarioName} · `)) return true;
          if (s.name.endsWith(' · Observed') && s.type === 'scatter') return true;
          return false;
        })
        .map(s => ({
          name: s.name,
          icon: s.type === 'scatter' ? 'circle' : (s.type === 'line' && s.areaStyle ? 'roundRect' : undefined),
        })),
      formatter: isSingleScenario ? (name: string) => {
        const dot = name.indexOf(' · ');
        return dot < 0 ? name : name.slice(dot + 3);
      } : (name: string) => {
        const dot = name.indexOf(' · ');
        if (dot < 0) return name;
        const prefix = name.slice(0, dot);
        const suffix = name.slice(dot + 3);
        if (prefix === firstScenarioName) return suffix;
        return prefix;
      },
    } : { show: false },
    grid: { left: 52, right: 16, bottom: 60, top: 32, containLabel: false },
    xAxis: {
      type: 'time',
      name: 'Cohort date',
      nameLocation: 'middle',
      nameGap: 30,
      nameTextStyle: { fontSize: 8, color: c.text },
      minInterval: 86400000,
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
      axisLine: { lineStyle: { color: c.border } },
      axisPointer: {
        snap: true,
        label: {
          formatter: (p: any) => {
            const d = new Date(Number(p.value));
            if (Number.isNaN(d.getTime())) return String(p.value);
            return `${d.getUTCDate()}-${d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}-${d.toLocaleDateString('en-GB', { year: '2-digit', timeZone: 'UTC' })}`;
          },
          fontSize: 9, color: c.tooltipText,
          backgroundColor: c.tooltipBg, borderColor: c.tooltipBorder, borderWidth: 1,
          padding: [2, 6],
        },
      },
    },
    yAxis: {
      type: 'value',
      name: 'Conversion rate',
      nameLocation: 'middle',
      nameGap: 40,
      nameTextStyle: { fontSize: 8, color: c.text },
      min: settings.y_axis_min ?? 0,
      max: settings.y_axis_max ?? undefined,
      axisLabel: {
        fontSize: 9,
        color: c.text,
        formatter: (v: number) => `${(v * 100).toFixed(0)}%`,
      },
      axisLine: { lineStyle: { color: c.border } },
      splitLine: { lineStyle: { color: c.gridLine, opacity: 0.5 } },
      axisPointer: {
        snap: true,
        label: {
          formatter: (p: any) => `${(Number(p.value) * 100).toFixed(1)}%`,
          fontSize: 9, color: c.tooltipText,
          backgroundColor: c.tooltipBg, borderColor: c.tooltipBorder, borderWidth: 1,
          padding: [2, 6],
        },
      },
    },
    graphic: sizeLegendGraphics.length > 0 ? sizeLegendGraphics : undefined,
    series: allSeries,
    ...(settings.animate === false ? { animation: false } : {}),
  };
}

