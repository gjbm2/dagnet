/**
 * analysisECharts/cohortComparisonBuilders.ts
 *
 * Cohort maturity and comparison chart builders.
 *
 * Extracted from analysisEChartsService.ts — AEC-PR5.
 */

import type { AnalysisResult } from '../../lib/graphComputeClient';
import {
  echartsThemeColours,
  echartsTooltipStyle,
  getDimLabel,
  getDimOrder,
  wrapAxisLabel,
  getScenarioTitleWithBasis,
  darkenHex,
} from './echartsCommon';

// ─── Band fill patterns ─────────────────────────────────────────────────────

type BandPattern = 'diagonal' | 'reverse_diagonal' | 'stipple';

/**
 * Generate ECharts graphic children for a fill pattern clipped to a polygon.
 * All three patterns produce lines or circles inside the bounding box,
 * then the caller clips them to the polygon boundary.
 */
function generatePatternChildren(
  pts: number[][],
  pattern: BandPattern,
  stroke: string,
): any[] {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  const h = maxY - minY;
  const w = maxX - minX;
  const children: any[] = [];

  if (pattern === 'diagonal') {
    const gap = 5;
    const diag = w + h;
    for (let d = 0; d < diag; d += gap) {
      children.push({
        type: 'line',
        shape: { x1: minX + d, y1: minY, x2: minX + d - h, y2: maxY },
        style: { stroke, lineWidth: 1 },
        silent: true,
      });
    }
  } else if (pattern === 'reverse_diagonal') {
    const gap = 5;
    const diag = w + h;
    for (let d = 0; d < diag; d += gap) {
      children.push({
        type: 'line',
        shape: { x1: minX + d - h, y1: minY, x2: minX + d, y2: maxY },
        style: { stroke, lineWidth: 1 },
        silent: true,
      });
    }
  } else if (pattern === 'stipple') {
    const gap = 6;
    const r = 1;
    for (let x = minX + gap / 2; x < maxX; x += gap) {
      for (let y = minY + gap / 2; y < maxY; y += gap) {
        children.push({
          type: 'circle',
          shape: { cx: x, cy: y, r },
          style: { fill: stroke },
          silent: true,
        });
      }
    }
  }
  return children;
}

/** SVG path legend icons for each band pattern. */
const BAND_PATTERN_ICONS: Record<BandPattern, string> = {
  diagonal: 'path://M0,0L4,8M4,0L8,8M8,0L12,8',
  reverse_diagonal: 'path://M4,0L0,8M8,0L4,8M12,0L8,8',
  stipple: 'path://M2,2A1,1,0,1,1,2,2.01M6,6A1,1,0,1,1,6,6.01M10,2A1,1,0,1,1,10,2.01M2,6A1,1,0,1,1,2,6.01M10,6A1,1,0,1,1,10,6.01M6,2A1,1,0,1,1,6,2.01',
};

/** Map source name → band fill pattern. */
const SOURCE_BAND_PATTERNS: Record<string, BandPattern> = {
  bayesian: 'diagonal',
  analytic: 'stipple',
  analytic_be: 'reverse_diagonal',
};

// ─── Builders ───────────────────────────────────────────────────────────────

/**
 * Build ECharts option for cohort maturity (age-aligned τ-curve).
 *
 * Segments per scenario:
 *  - solid: τ ≤ tauSolidMax (all cohorts have reached this age)
 *  - dashed: tauSolidMax < τ ≤ tauFutureMax (some cohorts still maturing)
 *  - future: τ > tauFutureMax (forecast-only synthetic frames)
 *
 * Visibility modes (per-scenario):
 *  - 'f+e': evidence base line + forecast crown fill + future tail
 *  - 'e': evidence only (no forecast)
 *  - 'f': forecast only (projected_rate as a single dashed line)
 *
 * Optionally overlays a model CDF curve from result.metadata.model_curves.
 */
export function buildCohortMaturityEChartsOption(
  result: any,
  settings: Record<string, any> = {},
  extra?: {
    visibleScenarioIds?: string[];
    scenarioVisibilityModes?: Record<string, 'f+e' | 'f' | 'e'>;
    subjectId?: string;
  },
): any | null {
  const rows: any[] = Array.isArray(result?.data) ? result.data : [];
  if (rows.length === 0) return null;

  const c = echartsThemeColours();
  const visibleScenarioIds = extra?.visibleScenarioIds || ['current'];
  const scenarioMeta: any = result?.dimension_values?.scenario_id || {};

  const subjectIds = [...new Set(rows.map((r: any) => String(r?.subject_id)).filter(Boolean))];
  const effectiveSubjectId = extra?.subjectId || subjectIds[0] || 'subject';

  const filteredRows = rows
    .filter((r: any) => String(r?.subject_id) === effectiveSubjectId)
    .filter((r: any) => visibleScenarioIds.includes(String(r?.scenario_id)));

  // Axis metadata
  let maxTau: number | null = null;
  let tauSolidMax: number | null = null;
  let tauFutureMax: number | null = null;
  let boundaryDate: string | null = null;
  for (const r of filteredRows) {
    const tau = Number(r?.tau_days);
    if (Number.isFinite(tau)) maxTau = Math.max(maxTau ?? 0, tau);
    const ts = Number(r?.tau_solid_max);
    const tf = Number(r?.tau_future_max);
    if (Number.isFinite(ts)) tauSolidMax = Math.max(tauSolidMax ?? 0, ts);
    if (Number.isFinite(tf)) tauFutureMax = Math.max(tauFutureMax ?? 0, tf);
    const b = r?.boundary_date;
    if (typeof b === 'string' && b) boundaryDate = b;
  }
  const solidMax = tauSolidMax ?? 0;
  const futureMax = tauFutureMax ?? 0;

  // Check for any signal at all
  let hasAnySignal = false;
  for (const r of filteredRows) {
    const base = r?.rate;
    const proj = r?.projected_rate;
    const mid = r?.midpoint;
    if ((typeof base === 'number' && Number.isFinite(base))
        || (typeof proj === 'number' && Number.isFinite(proj))
        || (typeof mid === 'number' && Number.isFinite(mid))) {
      hasAnySignal = true;
      break;
    }
  }
  // Also pass if model curves exist (f mode may have no rows but has curves)
  if (!hasAnySignal && result?.metadata?.model_curves) hasAnySignal = true;
  if (!hasAnySignal) return null;

  // Parse rows into per-scenario point arrays
  type FanBands = Record<string, [number, number]>;  // e.g. { '80': [lo, hi], '90': ... }
  type RowPoint = {
    tauDays: number;
    baseRate: number | null;
    projectedRate: number | null;
    midpoint: number | null;
    fanUpper: number | null;
    fanLower: number | null;
    fanBands: FanBands | null;
    tauSolidMax: number | null;
    tauFutureMax: number | null;
    cohortsExpected: number | null;
    cohortsInDenom: number | null;
    cohortsCoveredBase: number | null;
    cohortsCoveredProjected: number | null;
    evidenceY: number | null;
    evidenceX: number | null;
    forecastY: number | null;
    forecastX: number | null;
    ratePure: number | null;
    modelMidpoint: number | null;
    modelFanUpper: number | null;
    modelFanLower: number | null;
    modelBands: FanBands | null;
  };
  const byScenario = new Map<string, RowPoint[]>();
  for (const r of filteredRows) {
    const sid = String(r?.scenario_id);
    const tau = Number(r?.tau_days);
    if (!sid || !Number.isFinite(tau)) continue;
    if (maxTau !== null && Number.isFinite(maxTau) && tau > maxTau) continue;

    const parse = (v: any) => (v === null || v === undefined) ? null : (Number.isFinite(Number(v)) ? Number(v) : null);

    if (!byScenario.has(sid)) byScenario.set(sid, []);
    // Parse fan_bands: { '80': [lo, hi], '90': [lo, hi], ... }
    let fanBands: FanBands | null = null;
    if (r?.fan_bands && typeof r.fan_bands === 'object') {
      fanBands = {};
      for (const [level, bounds] of Object.entries(r.fan_bands)) {
        if (Array.isArray(bounds) && bounds.length === 2) {
          fanBands[level] = [Number(bounds[0]), Number(bounds[1])];
        }
      }
    }

    byScenario.get(sid)!.push({
      tauDays: tau,
      baseRate: parse(r?.rate),
      projectedRate: parse(r?.projected_rate),
      midpoint: parse(r?.midpoint),
      fanUpper: parse(r?.fan_upper),
      fanLower: parse(r?.fan_lower),
      fanBands,
      tauSolidMax: parse(r?.tau_solid_max),
      tauFutureMax: parse(r?.tau_future_max),
      cohortsExpected: parse(r?.cohorts_expected),
      cohortsInDenom: parse(r?.cohorts_in_denominator),
      cohortsCoveredBase: parse(r?.cohorts_covered_base),
      cohortsCoveredProjected: parse(r?.cohorts_covered_projected),
      evidenceY: parse(r?.evidence_y),
      evidenceX: parse(r?.evidence_x),
      forecastY: parse(r?.forecast_y),
      forecastX: parse(r?.forecast_x),
      ratePure: parse(r?.rate_pure),
      modelMidpoint: parse(r?.model_midpoint),
      modelFanUpper: parse(r?.model_fan_upper),
      modelFanLower: parse(r?.model_fan_lower),
      modelBands: (() => {
        if (r?.model_bands && typeof r.model_bands === 'object') {
          const mb: FanBands = {};
          for (const [level, bounds] of Object.entries(r.model_bands)) {
            if (Array.isArray(bounds) && bounds.length === 2) {
              mb[level] = [Number(bounds[0]), Number(bounds[1])];
            }
          }
          return mb;
        }
        return null;
      })(),
    });
  }

  const mkLine = (args: {
    id: string;
    name?: string;
    colour?: string;
    lineType: 'solid' | 'dashed' | 'dotted';
    opacity?: number;
    data: Array<{ value: [number, number | null]; [k: string]: any }>;
    showSymbol?: boolean;
    areaStyle?: any;
    z?: number;
    smooth?: boolean;
    emphasis?: any;
    showInLegend?: boolean;
    darken?: boolean;
  }): any | null => {
    if (args.data.length === 0) return null;
    const inLegend = args.showInLegend !== false && !!args.name;
    const lineColour = (args.darken !== false && args.colour) ? darkenHex(args.colour, 0.3) : args.colour;
    return {
      id: args.id,
      ...(args.name ? { name: args.name } : {}),
      type: 'line',
      showSymbol: args.showSymbol ?? false,
      symbolSize: 6,
      smooth: args.smooth ?? (settings.smooth || false),
      connectNulls: false,
      lineStyle: { width: 2, color: lineColour, type: args.lineType, opacity: args.opacity ?? 1 },
      itemStyle: { color: lineColour, opacity: args.opacity ?? 1 },
      emphasis: args.emphasis ?? { focus: 'series' },
      ...(args.areaStyle ? { areaStyle: args.areaStyle } : {}),
      ...(args.z !== undefined ? { z: args.z } : {}),
      ...(!inLegend ? { legendHoverLink: false } : {}),
      data: args.data,
    };
  };

  const chartMode = String(settings.chart_mode ?? 'rate');
  const forecastDecal = { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [3, 3], rotation: -Math.PI / 4 } as any;

  const seriesOut: any[] = [];
  for (const scenarioId of Array.from(byScenario.keys()).sort()) {
    const name = scenarioMeta?.[scenarioId]?.name || scenarioId;
    const colour = scenarioMeta?.[scenarioId]?.colour;
    const points = (byScenario.get(scenarioId) || []).slice().sort((a, b) => a.tauDays - b.tauDays);

    // Per-scenario epoch boundaries (each scenario has its own anchor range).
    const sSolidMax = points.reduce((m, p) => p.tauSolidMax !== null ? Math.max(m, p.tauSolidMax) : m, 0);
    const sFutureMax = points.reduce((m, p) => p.tauFutureMax !== null ? Math.max(m, p.tauFutureMax) : m, 0);

    const mode = extra?.scenarioVisibilityModes?.[scenarioId]
      ?? (scenarioMeta?.[scenarioId]?.visibility_mode as any)
      ?? 'f+e';

    // ── Count mode: stacked bar chart of evidence + forecast ──────────
    if (chartMode === 'count') {
      // Determine x-axis display limit for count bars
      const extSetting = settings.tau_extent ?? settings.x_axis_max;
      const countTauMax = (extSetting && extSetting !== 'auto' && extSetting !== 'Auto' && Number.isFinite(Number(extSetting)))
        ? Number(extSetting)
        : (maxTau ?? sFutureMax);

      let lastEvidenceY = 0;
      const evidenceData: number[][] = [];
      const forecastData: number[][] = [];
      for (const p of points) {
        if (p.tauDays >= countTauMax) continue;
        const ey = p.evidenceY ?? lastEvidenceY;
        if (p.evidenceY != null) lastEvidenceY = p.evidenceY;
        const fy = p.forecastY ?? ey;
        evidenceData.push([p.tauDays, ey]);
        forecastData.push([p.tauDays, fy]);
      }
      const scenarioLabel = name || scenarioId;
      const scenarioColour = colour;
      // Stacked bars per scenario: evidence (solid base) + forecast-only
      // (striated top).  Different scenarios sit side by side.
      const forecastOnlyData = evidenceData.map(([tau, ey], i) => {
        const fy = forecastData[i]?.[1] ?? ey;
        return [tau, Math.max(0, fy - ey)];
      });
      seriesOut.push({
        id: `${scenarioId}::evidence_count`,
        name: `${scenarioLabel} evidence`,
        type: 'bar',
        stack: scenarioId,
        itemStyle: { color: scenarioColour },
        emphasis: { focus: 'series' },
        data: evidenceData.map(d => d[1]),
      });
      seriesOut.push({
        id: `${scenarioId}::forecast_count`,
        name: `${scenarioLabel} forecast`,
        type: 'bar',
        stack: scenarioId,
        itemStyle: { color: scenarioColour, opacity: 0.4, decal: forecastDecal },
        emphasis: { focus: 'series' },
        data: forecastOnlyData.map(d => d[1]),
      });
      // Collect tau categories for count mode x-axis
      if (!(seriesOut as any).__countCategories) {
        (seriesOut as any).__countCategories = evidenceData.map(d => d[0]);
      }
      // Don't continue yet — fall through to the shading block below.
    }

    if (chartMode !== 'count') {
    const toMeta = (p: RowPoint) => ({
      tauDays: p.tauDays,
      baseRate: p.baseRate,
      projectedRate: p.projectedRate,
      boundaryDate,
      cohortsExpected: p.cohortsExpected,
      cohortsInDenom: p.cohortsInDenom,
      cohortsCoveredBase: p.cohortsCoveredBase,
      cohortsCoveredProjected: p.cohortsCoveredProjected,
      evidenceY: p.evidenceY,
      evidenceX: p.evidenceX,
      forecastY: p.forecastY,
      forecastX: p.forecastX,
    });

    if (mode === 'f') {
      // Forecast-only mode: unconditional model prediction.
      // Midpoint = median of p × CDF(tau) across posterior draws.
      // Fan = quantiles of those draws (parameter uncertainty only).
      const modelMidPts = points
        .filter(p => p.modelMidpoint !== null)
        .map(p => ({ value: [p.tauDays, p.modelMidpoint] as [number, number | null], ...toMeta(p) }));
      const sModelMid = mkLine({
        id: `${scenarioId}::modelMidpoint`, name: `${name} (model)`, colour, lineType: 'dashed', opacity: 0.85,
        data: modelMidPts,
        smooth: true,
      });
      if (sModelMid) seriesOut.push(sModelMid);
      // Fan polygons use model_bands — rendered in the fan section below
      // (mode !== 'e' gate lets it through).
    }

    if (mode !== 'f') {
      // Solid line (epoch A): complete evidence — all cohorts present.
      const solidPts = points.filter(p => p.tauDays <= sSolidMax).map(p => ({ value: [p.tauDays, p.baseRate] as [number, number | null], ...toMeta(p) }));
      const sSolid = mkLine({
        id: `${scenarioId}::solid`, name, colour, lineType: 'solid',
        data: solidPts, showSymbol: solidPts.length <= 12,
        smooth: true,
      });
      if (sSolid) seriesOut.push(sSolid);
    }

    if (mode === 'e') {
      // Evidence only: dashed line in epoch B using pure evidence rate
      // (only cohorts with real observations at this tau contribute).
      // No projected x, no midpoint, no fan.
      const dashedPurePts = points
        .filter(p => p.tauDays >= sSolidMax && p.tauDays <= sFutureMax && p.ratePure !== null)
        .map(p => ({ value: [p.tauDays, p.ratePure] as [number, number | null], ...toMeta(p) }));
      const sDashedPure = mkLine({
        id: `${scenarioId}::dashedEvidence`, colour, lineType: 'dashed', opacity: 0.75,
        data: dashedPurePts,
        smooth: true,
      });
      if (sDashedPure) seriesOut.push(sDashedPure);
    }

    if (mode === 'f+e') {
      // Dashed line (epoch B): incomplete evidence — some cohorts dropped out.
      // Uses blended rate (observed x for mature, projected x for immature).
      const dashedEvidencePts = points.filter(p => p.tauDays >= sSolidMax && p.tauDays <= sFutureMax).map(p => ({ value: [p.tauDays, p.baseRate] as [number, number | null], ...toMeta(p) }));
      const sDashedEv = mkLine({
        id: `${scenarioId}::dashedEvidence`, colour, lineType: 'dashed', opacity: 0.75,
        data: dashedEvidencePts,
        smooth: true,
      });
      if (sDashedEv) seriesOut.push(sDashedEv);

      // Dotted line (epochs B+C): best estimate midpoint — evidence + model.
      const midpointPts = points.filter(p => p.tauDays >= sSolidMax && p.midpoint !== null).map(p => ({ value: [p.tauDays, p.midpoint] as [number, number | null], ...toMeta(p) }));
      const sMidpoint = mkLine({
        id: `${scenarioId}::midpoint`, name: 'Total Forecast (e+f)', colour, lineType: 'dotted', opacity: 0.6,
        data: midpointPts,
        smooth: true,
        showInLegend: false,
      });
      if (sMidpoint) seriesOut.push(sMidpoint);
    }

    // Fan chart polygons — per-scenario uncertainty bands.
    // Blend mode: 4 overlaid semi-transparent polygons (99/95/90/80%).
    // Single-band mode: one polygon at the selected level.
    // Each layer is ~5% alpha so they build up gently and multiple
    // scenarios remain visible through each other.
    if (mode !== 'e') {
      const bandSetting = String(settings.bayes_band_level ?? 'blend');
      const isOff = bandSetting === 'off' || bandSetting === 'Off';
      const isBlend = !isOff && (bandSetting === 'blend' || bandSetting === 'Blend');

      // Determine which band levels to draw (widest first for correct layering)
      const bandLevels = isOff
        ? []
        : isBlend
          ? ['99', '95', '90', '80']
          : [bandSetting];

      // Base colour for fan (hex without alpha)
      const baseHex = colour || (c.text === '#e0e0e0' ? '#c8c8c8' : '#646464');

      // Debug: check if points have fan_bands with real width
      const _dbgFanPts = points.filter(p => p.fanBands && Object.values(p.fanBands).some(b => b[1] - b[0] > 0.001));
      console.log(`[fan_debug] scenario=${scenarioId} bandSetting=${bandSetting} isOff=${isOff} isBlend=${isBlend} levels=${bandLevels.join(',')} pts_with_bands=${_dbgFanPts.length}/${points.length} mode=${mode}`);
      if (_dbgFanPts.length > 0) {
        const _s = _dbgFanPts[0];
        console.log(`[fan_debug] sample tau=${_s.tauDays} bands=`, _s.fanBands);
      }

      for (const level of bandLevels) {
        // Build polygon data from fan_bands (f+e) or model_bands (f)
        const poly: Array<[number, number, number]> = [];
        for (const p of points) {
          const bands = mode === 'f' ? p.modelBands : p.fanBands;
          if (bands && bands[level]) {
            const [lo, hi] = bands[level];
            if (Number.isFinite(lo) && Number.isFinite(hi)) {
              poly.push([p.tauDays, hi, lo]);
            }
          } else if (!isBlend && p.fanUpper !== null && p.fanLower !== null) {
            // Single-band fallback (rows without fan_bands)
            poly.push([p.tauDays, p.fanUpper, p.fanLower]);
          }
        }

        if (poly.length === 0) continue;

        // Alpha: ~5% per layer in blend, ~15% for single band
        const alphaHex = isBlend ? '0D' : '26';  // 0D = 5%, 26 = 15%
        const fillColour = `${baseHex}${alphaHex}`;

        seriesOut.push({
          id: `${scenarioId}::fan::${level}`,
          type: 'custom' as any,
          coordinateSystem: 'cartesian2d',
          encode: { x: 0, y: 1 },
          renderItem: (params: any, api: any) => {
            if (params.dataIndex !== 0) return;
            const pts: number[][] = [];
            for (let i = 0; i < poly.length; i++) {
              pts.push(api.coord([poly[i][0], poly[i][1]]));
            }
            for (let i = poly.length - 1; i >= 0; i--) {
              pts.push(api.coord([poly[i][0], poly[i][2]]));
            }
            const gr = params.coordSys;
            return {
              type: 'polygon',
              shape: { points: pts, smooth: 0.3 },
              style: { fill: fillColour, stroke: 'none' },
              clipPath: { type: 'rect', shape: { x: gr.x, y: gr.y, width: gr.width, height: gr.height } },
              silent: true,
            };
          },
          data: poly,
          z: 2,
          silent: true,
        });
      }
    }
    } // end if (chartMode !== 'count')

    // ── Forecast shading + data fade (both rate and count modes) ──────
    if (settings.show_forecast_shading !== false) {
      // Use the scenario colour, or fall back to ECharts default palette.
      const echartsDefaultPalette = ['#5470c6','#91cc75','#fac858','#ee6666','#73c0de','#3ba272','#fc8452','#9a60b4','#ea7ccc'];
      const scenarioIndex = Array.from(byScenario.keys()).sort().indexOf(scenarioId);
      const shadingColour = colour || echartsDefaultPalette[scenarioIndex % echartsDefaultPalette.length];
      const fadeOpacity = (tau: number, base: number): number => {
        if (tau <= sSolidMax) return base;
        if (tau >= sFutureMax) return base * 0.8;
        const t = (tau - sSolidMax) / Math.max(1, sFutureMax - sSolidMax);
        return base * (1 - 0.2 * t);
      };
      for (const s of seriesOut) {
        if (typeof s.id !== 'string' || !s.id.startsWith(`${scenarioId}::`)) continue;
        if (s.id.includes('shading')) continue;
        if (!Array.isArray(s.data)) continue;
        const baseOpacity = s.itemStyle?.opacity ?? 1.0;
        s.data = s.data.map((d: any) => {
          const tau = Array.isArray(d) ? d[0] : d?.value?.[0];
          if (typeof tau !== 'number' || tau <= sSolidMax) return d;
          const val = Array.isArray(d) ? d : d?.value;
          return { value: val, itemStyle: { ...d?.itemStyle, opacity: fadeOpacity(tau, baseOpacity) } };
        });
      }
      seriesOut.push({
        id: `${scenarioId}::forecast_shading`,
        name: '_shading',
        type: 'custom' as any,
        coordinateSystem: 'cartesian2d',
        z: 0, silent: true,
        data: [[0]],
        renderItem: (params: any, api: any) => {
          if (params.dataIndex !== 0) return;
          const gridRect = params.coordSys;
          // On category axis, api.coord takes category index; on value axis, tau value.
          const cats = (seriesOut as any).__countCategories as number[] | undefined;
          const solidVal = cats ? cats.findIndex(t => t >= sSolidMax) : sSolidMax;
          const futureVal = cats ? cats.findIndex(t => t >= sFutureMax) : sFutureMax;
          const endVal = cats ? cats.length - 1 : 1e6;
          const xSolid = api.coord([solidVal >= 0 ? solidVal : 0, 0])[0];
          const xFuture = api.coord([futureVal >= 0 ? futureVal : solidVal, 0])[0];
          const xAxisEnd = api.coord([endVal, 0])[0];
          const xEnd = Math.min(xAxisEnd, gridRect.x + gridRect.width);
          const y = gridRect.y;
          const h = gridRect.height;
          const hexToRgba = (hex: string, a: number) => {
            const r = parseInt(hex.slice(1, 3), 16) || 0;
            const g = parseInt(hex.slice(3, 5), 16) || 0;
            const b = parseInt(hex.slice(5, 7), 16) || 0;
            return `rgba(${r},${g},${b},${a})`;
          };
          // Diagonal hatch lines for the forecast region (standard app pattern)
          const hatchGap = 8;
          const hatchStroke = hexToRgba(shadingColour, 0.20);
          const makeHatch = (rx: number, ry: number, rw: number, rh: number) => {
            const lines: any[] = [];
            const diag = rw + rh;
            for (let d = 0; d < diag; d += hatchGap) {
              lines.push({
                type: 'line',
                shape: { x1: rx + d, y1: ry, x2: rx + d - rh, y2: ry + rh },
                style: { stroke: hatchStroke, lineWidth: 1 },
                silent: true,
              });
            }
            return {
              type: 'group', children: lines,
              clipPath: { type: 'rect', shape: { x: rx, y: ry, width: rw, height: rh } },
            };
          };
          const children: any[] = [];
          // Unified forecast hatch: one continuous set of lines from
          // xSolid → xEnd.  A gradient stroke fades 0 → 0.20 alpha
          // across epoch B (xSolid → xFuture), then holds constant
          // 0.20 through epoch C (xFuture → xEnd).
          const hatchStart = Math.min(xSolid, xFuture); // handle edge case where solid==future
          if (xEnd > hatchStart) {
            const totalW = xEnd - hatchStart;
            // Gradient stop: where epoch B ends as a fraction of the total span.
            const bFrac = totalW > 0 ? Math.min(1, (xFuture - hatchStart) / totalW) : 0;
            const allLines: any[] = [];
            const diag = totalW + h;
            for (let d = 0; d < diag; d += hatchGap) {
              allLines.push({
                type: 'line',
                shape: { x1: hatchStart + d, y1: y, x2: hatchStart + d - h, y2: y + h },
                style: {
                  stroke: {
                    type: 'linear',
                    x: hatchStart, y: 0, x2: xEnd, y2: 0,
                    global: true,
                    colorStops: [
                      { offset: 0, color: hexToRgba(shadingColour, 0) },
                      { offset: bFrac, color: hexToRgba(shadingColour, 0.20) },
                      { offset: 1, color: hexToRgba(shadingColour, 0.20) },
                    ],
                  },
                  lineWidth: 1,
                },
                silent: true,
              });
            }
            children.push({
              type: 'group', children: allLines,
              clipPath: { type: 'rect', shape: { x: hatchStart, y, width: totalW, height: h } },
            });
          }
          return { type: 'group', children };
        },
      });
    }
  }

  // Model overlay neutral colour — always in scope for legend data builder.
  const modelColour = c.text === '#e0e0e0' ? '#9ca3af' : '#6b7280'; // grey-400 / grey-500

  // Model CDF overlay
  const modelCurves = result?.metadata?.model_curves;
  let promotedBandRendered = false;
  let promotedSource: string = 'analytic';
  if (modelCurves && typeof modelCurves === 'object') {
    const entry = modelCurves[effectiveSubjectId];
    // ── Model overlay styling ──────────────────────────────────────────
    // Colours are reserved for scenarios.  Model sources are distinguished
    // by stroke style only, using a single neutral colour.
    // Dash patterns per source (large enough to read in legend key):
    //   Bayesian   = dotted             ·····
    //   FE         = dot/dash           ─ · ─ · ─
    //   BE         = dot-dot/dash       ─ ·· ─ ·· ─
    const MODEL_DASH: Record<string, number[]> = {
      bayesian:    [3, 3],
      analytic:    [12, 5, 3, 5],
      analytic_be: [12, 4, 3, 4, 3, 4],
    };
    const MODEL_LABEL: Record<string, string> = {
      bayesian: 'Bayesian', analytic: 'Analytic (FE)', analytic_be: 'Analytic (BE)',
    };

    // In 'f' mode, always show the model curve — it IS the chart content.
    // The model curve is per-subject (shared across scenarios), so check
    // if any scenario is in 'f' mode to force it visible.
    const hasForecastOnlyScenario = Array.from(byScenario.keys()).some(sid => {
      const m = extra?.scenarioVisibilityModes?.[sid]
        ?? (scenarioMeta?.[sid]?.visibility_mode as any)
        ?? 'f+e';
      return m === 'f';
    });
    const showPromoted = hasForecastOnlyScenario || settings.show_model_promoted !== false;
    promotedSource = entry?.params?.promoted_source || entry?.promotedSource || 'analytic';
    const isBayesianPromoted = promotedSource === 'bayesian';

    if (showPromoted && entry?.curve && Array.isArray(entry.curve) && entry.curve.length > 0) {
      const data = entry.curve
        .filter((p: any) => typeof p?.tau_days === 'number' && typeof p?.model_rate === 'number')
        .map((p: any) => ({ value: [p.tau_days, p.model_rate] }));
      if (data.length > 0) {
        const dash = MODEL_DASH[promotedSource] || MODEL_DASH.analytic;
        seriesOut.push({
          id: 'model_cdf',
          name: MODEL_LABEL[promotedSource] || promotedSource,
          type: 'line',
          showSymbol: false,
          smooth: true,
          connectNulls: false,
          lineStyle: { width: 2, color: modelColour, type: dash as any, opacity: 0.85 },
          itemStyle: { color: modelColour },
          emphasis: { disabled: true },
          z: 10,
          data,
        });
        if (maxTau !== null) {
          const curveMax = data[data.length - 1]?.value?.[0];
          if (typeof curveMax === 'number' && Number.isFinite(curveMax) && curveMax > maxTau) {
            maxTau = curveMax;
          }
        }
      }
    }
    // Method B comparison curve — only relevant when promoted source is analytic.
    if (showPromoted && !isBayesianPromoted && entry?.methodBCurve && Array.isArray(entry.methodBCurve) && entry.methodBCurve.length > 0) {
      const methodBData = entry.methodBCurve
        .filter((p: any) => typeof p?.tau_days === 'number' && typeof p?.model_rate === 'number')
        .map((p: any) => ({ value: [p.tau_days, p.model_rate] }));
      if (methodBData.length > 0) {
        seriesOut.push({
          id: 'model_cdf_method_b',
          name: 'Analytic B (old)',
          type: 'line',
          showSymbol: false,
          smooth: true,
          connectNulls: false,
          lineStyle: { width: 2, color: modelColour, type: [2, 2] as any, opacity: 0.5 },
          itemStyle: { color: modelColour },
          emphasis: { disabled: true },
          z: 10,
          data: methodBData,
        });
        if (maxTau !== null) {
          const curveMax = methodBData[methodBData.length - 1]?.value?.[0];
          if (typeof curveMax === 'number' && Number.isFinite(curveMax) && curveMax > maxTau) {
            maxTau = curveMax;
          }
        }
      }
    }
    // Confidence band — rendered when promoted source has band data (Bayesian or heuristic dispersion).
    // Rendered as a hatched polygon (diagonal lines) to stay neutral on colour.
    const _srcPromotedBand = entry?.sourceModelCurves?.[promotedSource]?.band_upper;
    const _srcBayesBand = entry?.sourceModelCurves?.bayesian?.band_upper;
    const hasDispersion = showPromoted && (entry?.bayesBandUpper || entry?.params?.bayes_mu_sd > 0 || _srcPromotedBand || _srcBayesBand);
    let bandUpper = hasDispersion ? entry?.bayesBandUpper : undefined;
    let bandLower = hasDispersion ? entry?.bayesBandLower : undefined;
    if (hasDispersion && !bandUpper) {
      // Fallback: check per-source curves for band data (any source, not just bayesian)
      const srcPromoted = entry?.sourceModelCurves?.[promotedSource];
      const srcBayes = entry?.sourceModelCurves?.bayesian;
      const srcWithBands = srcPromoted?.band_upper ? srcPromoted : srcBayes;
      if (srcWithBands?.band_upper) bandUpper = srcWithBands.band_upper;
      if (srcWithBands?.band_lower) bandLower = srcWithBands.band_lower;
    }
    promotedBandRendered = false;
    const bandStroke = c.text === '#e0e0e0' ? 'rgba(156,163,175,0.45)' : 'rgba(107,114,128,0.40)';
    if (Array.isArray(bandUpper) && bandUpper.length > 0 && Array.isArray(bandLower) && bandLower.length > 0) {
      const upperPts = bandUpper
        .filter((p: any) => typeof p?.tau_days === 'number' && typeof p?.model_rate === 'number');
      const lowerPts = bandLower
        .filter((p: any) => typeof p?.tau_days === 'number' && typeof p?.model_rate === 'number');
      if (upperPts.length > 0 && lowerPts.length > 0) {
        promotedBandRendered = true;
        const polyData = upperPts.map((p: any, i: number) => {
          const lower = i < lowerPts.length ? lowerPts[i].model_rate : p.model_rate;
          return [p.tau_days, p.model_rate, lower];
        });
        const promotedPattern: BandPattern = SOURCE_BAND_PATTERNS[promotedSource] || 'diagonal';
        seriesOut.push({
          id: 'bayes_band',
          name: `Promoted 90% band`,
          type: 'custom' as any,
          coordinateSystem: 'cartesian2d',
          encode: { x: 0, y: 1 },
          renderItem: (params: any, api: any) => {
            if (params.dataIndex !== 0) return;
            const pts: number[][] = [];
            for (let i = 0; i < polyData.length; i++) pts.push(api.coord([polyData[i][0], polyData[i][1]]));
            for (let i = polyData.length - 1; i >= 0; i--) pts.push(api.coord([polyData[i][0], polyData[i][2]]));
            const gr = params.coordSys;
            return {
              type: 'group',
              children: [{
                type: 'group',
                children: generatePatternChildren(pts, promotedPattern, bandStroke),
                clipPath: { type: 'polygon', shape: { points: pts, smooth: false } },
              }],
              clipPath: { type: 'rect', shape: { x: gr.x, y: gr.y, width: gr.width, height: gr.height } },
              silent: true,
            };
          },
          data: polyData,
          z: 1,
          silent: true,
        });
      }
    }
    // --- Per-source model curve overlays ---
    // Controlled by display settings: show_model_analytic, show_model_analytic_be, show_model_bayesian.
    // Falls back to the legacy bayesCurve/methodBCurve if sourceModelCurves not present.
    const sourceModelCurves = entry?.sourceModelCurves;
    if (sourceModelCurves && typeof sourceModelCurves === 'object') {
      const sourceStyles: Record<string, { dash: number[]; name: string; settingKey: string; z: number }> = {
        analytic:    { dash: MODEL_DASH.analytic,    name: 'Analytic (FE)', settingKey: 'show_model_analytic',    z: 10 },
        analytic_be: { dash: MODEL_DASH.analytic_be, name: 'Analytic (BE)', settingKey: 'show_model_analytic_be', z: 10 },
        bayesian:    { dash: MODEL_DASH.bayesian,    name: 'Bayesian',      settingKey: 'show_model_bayesian',    z: 11 },
      };

      for (const [srcName, srcData] of Object.entries(sourceModelCurves)) {
        const style = sourceStyles[srcName];
        if (!style) continue;
        // Check display setting — default off unless explicitly enabled
        if (!settings[style.settingKey]) continue;
        // Skip if this source is already rendered as the promoted curve
        if (showPromoted && srcName === promotedSource) continue;

        const srcCurve = (srcData as any)?.curve;
        if (!Array.isArray(srcCurve) || srcCurve.length === 0) continue;
        const curveData = srcCurve
          .filter((p: any) => typeof p?.tau_days === 'number' && typeof p?.model_rate === 'number')
          .map((p: any) => ({ value: [p.tau_days, p.model_rate] }));
        if (curveData.length === 0) continue;

        seriesOut.push({
          id: `model_cdf_${srcName}`,
          name: style.name,
          type: 'line',
          showSymbol: false,
          smooth: true,
          connectNulls: false,
          lineStyle: { width: 2, color: modelColour, type: style.dash as any, opacity: 0.85 },
          itemStyle: { color: modelColour },
          emphasis: { disabled: true },
          z: style.z,
          data: curveData,
        });
        if (maxTau !== null) {
          const curveMax = curveData[curveData.length - 1]?.value?.[0];
          if (typeof curveMax === 'number' && Number.isFinite(curveMax) && curveMax > maxTau) {
            maxTau = curveMax;
          }
        }

        // Per-source confidence band — each source gets its own pattern.
        // Renders independently (not gated by promotedBandRendered) so
        // multiple source bands can be visible simultaneously.
        {
          const bandUpperSrc = (srcData as any)?.band_upper;
          const bandLowerSrc = (srcData as any)?.band_lower;
          if (Array.isArray(bandUpperSrc) && bandUpperSrc.length > 0 && Array.isArray(bandLowerSrc) && bandLowerSrc.length > 0) {
            const upperPtsSrc = bandUpperSrc.filter((p: any) => typeof p?.tau_days === 'number' && typeof p?.model_rate === 'number');
            const lowerPtsSrc = bandLowerSrc.filter((p: any) => typeof p?.tau_days === 'number' && typeof p?.model_rate === 'number');
            if (upperPtsSrc.length > 0 && lowerPtsSrc.length > 0) {
              const polyDataSrc = upperPtsSrc.map((p: any, i: number) => {
                const lower = i < lowerPtsSrc.length ? lowerPtsSrc[i].model_rate : p.model_rate;
                return [p.tau_days, p.model_rate, lower];
              });
              const srcPattern: BandPattern = SOURCE_BAND_PATTERNS[srcName] || 'diagonal';
              const bandName = `${style.name} 90% band`;
              seriesOut.push({
                id: `band_${srcName}`,
                name: bandName,
                type: 'custom' as any,
                coordinateSystem: 'cartesian2d',
                encode: { x: 0, y: 1 },
                renderItem: (params: any, api: any) => {
                  if (params.dataIndex !== 0) return;
                  const pts: number[][] = [];
                  for (let i = 0; i < polyDataSrc.length; i++) pts.push(api.coord([polyDataSrc[i][0], polyDataSrc[i][1]]));
                  for (let i = polyDataSrc.length - 1; i >= 0; i--) pts.push(api.coord([polyDataSrc[i][0], polyDataSrc[i][2]]));
                  const gr = params.coordSys;
                  return {
                    type: 'group',
                    children: [{
                      type: 'group',
                      children: generatePatternChildren(pts, srcPattern, bandStroke),
                      clipPath: { type: 'polygon', shape: { points: pts, smooth: false } },
                    }],
                    clipPath: { type: 'rect', shape: { x: gr.x, y: gr.y, width: gr.width, height: gr.height } },
                    silent: true,
                  };
                },
                data: polyDataSrc,
                z: 9,
                silent: true,
              });
            }
          }
        }
      }
    } else {
      // Legacy fallback: use bayesCurve from old format
      if (entry?.bayesCurve && Array.isArray(entry.bayesCurve) && entry.bayesCurve.length > 0) {
        const bayesData = entry.bayesCurve
          .filter((p: any) => typeof p?.tau_days === 'number' && typeof p?.model_rate === 'number')
          .map((p: any) => ({ value: [p.tau_days, p.model_rate] }));
        if (bayesData.length > 0) {
          seriesOut.push({
            id: 'model_cdf_bayes',
            name: 'Bayesian Model',
            type: 'line',
            showSymbol: false,
            smooth: true,
            connectNulls: false,
            lineStyle: { width: 2, color: modelColour, type: MODEL_DASH.bayesian as any, opacity: 0.85 },
            itemStyle: { color: modelColour },
            emphasis: { disabled: true },
            z: 11,
            data: bayesData,
          });
          if (maxTau !== null) {
            const curveMax = bayesData[bayesData.length - 1]?.value?.[0];
            if (typeof curveMax === 'number' && Number.isFinite(curveMax) && curveMax > maxTau) {
              maxTau = curveMax;
            }
          }
        }
      }
    }

  }

  // Y-axis max: scan ONLY rendered series in seriesOut.  Everything in
  // seriesOut is visible; everything not in seriesOut is hidden.  No raw
  // metadata scan — the axis adapts purely to what's on screen.
  let maxRate = 0;
  for (const s of seriesOut) {
    // Fan series: [tau, upper, lower] — check upper (index 1)
    if (typeof s.id === 'string' && s.id.endsWith('::fan')) {
      for (const d of (s.data || [])) {
        const v = Array.isArray(d) ? d[1] : undefined;
        if (typeof v === 'number' && Number.isFinite(v) && v > maxRate) maxRate = v;
      }
      continue;
    }
    // Band series (bayes_band, band_*): custom render [tau, upper, lower]
    if (s.id === 'bayes_band' || (typeof s.id === 'string' && s.id.startsWith('band_'))) {
      for (const d of (s.data || [])) {
        const v = Array.isArray(d) ? d[1] : undefined;
        if (typeof v === 'number' && Number.isFinite(v) && v > maxRate) maxRate = v;
      }
      continue;
    }
    // Standard series: { value: [x, y] }
    for (const d of (s.data || [])) {
      const v = d?.value?.[1];
      if (typeof v === 'number' && Number.isFinite(v) && v > maxRate) maxRate = v;
    }
  }
  // Adaptive grid: 1% steps below 10%, 5% steps above.
  // Prevents excessive headroom on small values (e.g. 5% data → 10% axis).
  const _headroom = maxRate * 1.15;
  const _grid = _headroom < 0.10 ? 100 : 20;
  const yMaxAuto = Math.min(1.0, Math.max(0.02, Math.ceil(_headroom * _grid) / _grid));
  const yMaxSetting = settings.rate_extent ?? settings.y_axis_max;
  const yMax = (yMaxSetting && yMaxSetting !== 'auto' && Number.isFinite(Number(yMaxSetting)))
    ? Number(yMaxSetting) : yMaxAuto;
  const showLegend = settings.show_legend ?? true;
  const legendPos = (settings.legend_position as string) || 'top';

  const fmtPercent = (v: number | null | undefined): string =>
    (v === null || v === undefined || !Number.isFinite(v)) ? '—' : `${(v * 100).toFixed(1)}%`;

  // Build tooltip metadata lookup by tau — ECharts strips custom keys
  // from data items, so we side-load the metadata for the formatter.
  // Use the first scenario's points (tooltip shows one scenario at a time).
  const tooltipMeta: Record<number, any> = {};
  for (const pts of byScenario.values()) {
    for (const p of pts) {
      if (tooltipMeta[p.tauDays] === undefined) {
        tooltipMeta[p.tauDays] = {
          baseRate: p.baseRate,
          ratePure: p.ratePure,
          projectedRate: p.projectedRate,
          midpoint: p.midpoint,
          boundaryDate,
          evidenceY: p.evidenceY,
          evidenceX: p.evidenceX,
          forecastY: p.forecastY,
          forecastX: p.forecastX,
          cohortsExpected: p.cohortsExpected,
          cohortsInDenom: p.cohortsInDenom,
          cohortsCoveredBase: p.cohortsCoveredBase,
          cohortsCoveredProjected: p.cohortsCoveredProjected,
        };
      }
    }
  }

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
        const first = items[0];
        const tauDays = typeof first?.value?.[0] === 'number' ? first.value[0] : Number(first?.value?.[0]);

        const best = items.find((it: any) => it?.data?.baseRate !== undefined || it?.data?.projectedRate !== undefined)?.data ?? first?.data ?? {};
        // ECharts strips custom keys from data items — look up metadata
        // from the side map built during series construction.
        const metaKey = Number.isFinite(tauDays) ? tauDays : -1;
        const meta = (tooltipMeta as any)?.[metaKey] ?? {};
        const bd = typeof best?.boundaryDate === 'string' ? best.boundaryDate : (boundaryDate || '');
        const title = Number.isFinite(tauDays)
          ? `Age: ${tauDays} day(s) · As at ${bd}`
          : `As at ${bd}`;

        const excludeIds = new Set(['model_cdf', 'bayes_band']);
        const scenarioItems = items.filter((it: any) => !excludeIds.has(it?.seriesId));
        const lines = scenarioItems
          .filter((it: any, idx: number, arr: any[]) => arr.findIndex((x: any) => String(x?.seriesName) === String(it?.seriesName)) === idx)
          .map((it: any) => `${it?.seriesName || 'Scenario'}: <strong>${fmtPercent(it?.value?.[1])}</strong>`);

        const extra_: string[] = [];
        if (meta?.evidenceX != null && meta?.evidenceY != null) {
          extra_.push(`evidence n=${meta.evidenceX.toFixed(0)}, k=${meta.evidenceY.toFixed(0)} (${fmtPercent(meta.baseRate)})`);
        }
        if (meta?.forecastX != null && meta?.forecastY != null) {
          const fRate = meta.forecastX > 0 ? meta.forecastY / meta.forecastX : null;
          extra_.push(`forecast n=${meta.forecastX.toFixed(1)}, k=${meta.forecastY.toFixed(1)} (${fmtPercent(fRate)})`);
        }
        const modelItem = items.find((it: any) => it?.seriesId === 'model_cdf');
        if (modelItem) {
          const mv = modelItem?.value?.[1];
          if (typeof mv === 'number' && Number.isFinite(mv)) extra_.push(`Model CDF: <strong>${fmtPercent(mv)}</strong>`);
        }
        const ce = meta?.cohortsExpected;
        const cd = meta?.cohortsInDenom;
        if (typeof ce === 'number' && typeof cd === 'number') extra_.push(`Cohorts: <strong>${cd}/${ce}</strong> in denominator`);
        const cb = meta?.cohortsCoveredBase;
        const cp = meta?.cohortsCoveredProjected;
        if (typeof cb === 'number' && typeof cp === 'number') extra_.push(`Coverage: base <strong>${cb}</strong> · proj <strong>${cp}</strong> (at this τ)`);

        return `<strong>${title}</strong><br/>${[...lines, ...extra_].join('<br/>')}`;
      },
    },
    grid: { left: 52, right: 16, bottom: 60, top: seriesOut.length > 2 ? 58 : 42, containLabel: false },
    xAxis: {
      type: chartMode === 'count' ? 'category' as const : 'value' as const,
      ...(chartMode === 'count' ? { data: (seriesOut as any).__countCategories || [] } : {}),
      name: settings.x_axis_title ?? 'Age (days since cohort date)',
      nameLocation: 'middle',
      nameGap: 30,
      nameTextStyle: { fontSize: 8, color: c.text },
      ...(chartMode !== 'count' ? { min: settings.x_axis_min ?? 0 } : {}),
      ...(() => {
        if (chartMode === 'count') return {};
        const ext = settings.tau_extent ?? settings.x_axis_max;
        if (ext && ext !== 'auto' && ext !== 'Auto' && Number.isFinite(Number(ext))) return { max: Number(ext) };
        // Auto: clamp to data extent so ECharts doesn't round up beyond the curves
        if (maxTau !== null && Number.isFinite(maxTau)) return { max: maxTau };
        return {};
      })(),
      axisLabel: { fontSize: 9, color: c.text, formatter: (v: number) => `${Math.round(v)}` },
      axisPointer: {
        snap: true,
        label: {
          formatter: (p: any) => `${Math.round(p.value)} days`,
          fontSize: 9, color: c.tooltipText,
          backgroundColor: c.tooltipBg, borderColor: c.tooltipBorder, borderWidth: 1,
          padding: [2, 6],
        },
      },
    },
    yAxis: {
      type: (settings.y_axis_scale === 'log') ? 'log' : 'value',
      min: settings.y_axis_min ?? 0,
      max: chartMode === 'count' ? undefined : yMax,
      name: settings.y_axis_title ?? (chartMode === 'count' ? 'Conversions (k)' : 'Conversion rate'),
      nameLocation: 'middle',
      nameGap: chartMode === 'count' ? 55 : 45,
      nameTextStyle: { fontSize: 8, color: c.text },
      axisLabel: { fontSize: 9, color: c.text, formatter: chartMode === 'count'
        ? (v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`
        : (v: number) => `${(v * 100).toFixed(0)}%` },
      splitLine: { lineStyle: { color: c.gridLine } },
      axisPointer: {
        snap: true,
        label: {
          formatter: chartMode === 'count'
            ? (p: any) => `${Math.round(Number(p.value))}`
            : (p: any) => `${(Number(p.value) * 100).toFixed(1)}%`,
          fontSize: 9, color: c.tooltipText,
          backgroundColor: c.tooltipBg, borderColor: c.tooltipBorder, borderWidth: 1,
          padding: [2, 6],
        },
      },
    },
    legend: showLegend ? {
      ...(legendPos === 'bottom' ? { bottom: 4, left: 'center' }
        : legendPos === 'left' ? { top: 'middle', left: 4, orient: 'vertical' as const }
        : legendPos === 'right' ? { top: 'middle', right: 4, orient: 'vertical' as const }
        : { top: 14, left: 12 }),
      textStyle: { fontSize: 8, color: c.text }, itemGap: 6, itemWidth: 36, itemHeight: 8,
      data: seriesOut.filter(s => s.name && !s.name.startsWith('_')).map(s => {
        const isModel = typeof s.id === 'string' && (s.id.startsWith('model_cdf') || s.id === 'bayes_band' || s.id.startsWith('band_'));
        const isBand = typeof s.id === 'string' && (s.id === 'bayes_band' || s.id.startsWith('band_'));
        if (isBand) {
          // Pattern-specific legend icon based on source
          const bandSrcName = typeof s.id === 'string' && s.id.startsWith('band_') ? s.id.slice(5) : 'bayesian';
          const bandPattern: BandPattern = SOURCE_BAND_PATTERNS[bandSrcName] || 'diagonal';
          const icon = BAND_PATTERN_ICONS[bandPattern];
          return { name: s.name, icon, itemStyle: { color: 'none', borderColor: modelColour, borderWidth: 1 } };
        }
        // Scenario series: coloured rectangle. Model series: no icon override
        // so ECharts draws the actual lineStyle (dash pattern) from the series.
        return isModel ? { name: s.name } : { name: s.name, icon: 'roundRect' };
      }),
    } : { show: false },
    series: seriesOut,
    dagnet_meta: {
      subject_id: effectiveSubjectId,
      anchor: { from: result?.metadata?.anchor_from, to: result?.metadata?.anchor_to },
      sweep: { from: result?.metadata?.sweep_from, to: result?.metadata?.sweep_to },
    },
    ...(settings.animate === false ? { animation: false } : {}),
  };
}

// ============================================================
// Unified dispatch — single entry point for all chart kinds
// ============================================================

type ChartKindId = 'funnel' | 'bridge' | 'histogram' | 'daily_conversions' | 'cohort_maturity';

/**
 * Build ECharts options for any chart kind from a unified interface.
 *
 * This is the single codepath: AnalysisChartContainer calls this with
 * (chartKind, result, resolvedSettings) and gets back an ECharts option object.
 *
 * Settings come from the display settings registry (resolveDisplaySetting).
 * The dispatch translates resolvedSettings to per-builder args internally.
 */
/**
 * Build ECharts option for lag_fit analysis.
 *
 * Dual-axis chart:
 *   Left y-axis  — cumulative fraction (fitted CDF + observed cohort scatter)
 *   Right y-axis — daily probability mass (PMF bars)
 *   x-axis       — lag in days
 *   markLines    — median and t95
 */
export function buildLagFitEChartsOption(
  result: AnalysisResult,
  _settings: Record<string, any>,
): any {
  const c = echartsThemeColours();
  const rows: any[] = result.data ?? [];
  const meta = rows.find(r => r.row_type === 'meta');
  const curveRows = rows.filter(r => r.row_type === 'curve');
  const cohortRows = rows.filter(r => r.row_type === 'cohort');

  if (!meta || curveRows.length === 0) return null;

  const { t95, median, edge_label } = meta;
  const CDF_COLOUR = c.text;
  const SCATTER_COLOUR = '#3b82f6';
  const BAR_COLOUR = c.textMuted;

  const tValues = curveRows.map((r: any) => r.t as number);
  const pdfValues = curveRows.map((r: any) => r.pdf as number);
  const cdfValues = curveRows.map((r: any) => r.cdf as number);

  const scatterData = cohortRows.map((r: any) => ({
    value: [r.age as number, r.observed_cdf as number],
    n: r.n, k: r.k, date: r.date,
  }));

  const markLines: any[] = [];
  if (Number.isFinite(median) && median > 0) {
    markLines.push({
      xAxis: Math.round(median),
      lineStyle: { color: c.textSecondary, type: 'dashed', width: 1, opacity: 0.7 },
      label: { show: true, formatter: `med ${Number(median).toFixed(1)}d`, color: c.textSecondary, fontSize: 9, position: 'start' },
    });
  }
  if (Number.isFinite(t95) && t95 > 0) {
    markLines.push({
      xAxis: Math.round(t95),
      lineStyle: { color: c.textMuted, type: 'dashed', width: 1, opacity: 0.6 },
      label: { show: true, formatter: `t95 ${Number(t95).toFixed(1)}d`, color: c.textMuted, fontSize: 9, position: 'end' },
    });
  }

  const fmtPct = (v: number) => (v * 100).toFixed(1) + '%';

  return {
    backgroundColor: 'transparent',
    grid: { top: 32, right: 60, bottom: 60, left: 52, containLabel: false },
    xAxis: {
      type: 'value', name: 'Lag (days)',
      nameTextStyle: { color: c.text, fontSize: 8 },
      min: 0, max: tValues[tValues.length - 1] ?? 100,
      axisLabel: { color: c.text, fontSize: 9 },
      axisLine: { lineStyle: { color: c.gridLine } },
      splitLine: { lineStyle: { color: c.gridLine } },
    },
    yAxis: [
      {
        type: 'value', name: 'Cumulative fraction',
        nameTextStyle: { color: c.text, fontSize: 8 },
        min: 0, max: 1,
        axisLabel: { color: c.text, fontSize: 9, formatter: fmtPct },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: c.gridLine } },
      },
      {
        type: 'value', name: 'Daily PDF',
        nameTextStyle: { color: BAR_COLOUR, fontSize: 8 },
        position: 'right',
        axisLabel: { color: BAR_COLOUR, fontSize: 9, formatter: (v: number) => v.toFixed(3) },
        axisLine: { show: false },
        splitLine: { show: false },
      },
    ],
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'line' },
      ...echartsTooltipStyle(),
      formatter: (params: any[]) => {
        if (!params?.length) return '';
        const t = params[0]?.axisValue ?? '';
        let html = `<div style="font-weight:600;margin-bottom:4px">Day ${t}</div>`;
        for (const p of params) {
          if (p.value === null || p.value === undefined) continue;
          const val = Array.isArray(p.value) ? p.value[1] : p.value;
          const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:5px;vertical-align:middle"></span>`;
          const formatted = p.seriesName === 'PDF (daily)' ? Number(val).toFixed(2) : fmtPct(Number(val));
          html += `<div>${dot}${p.seriesName}: <b>${formatted}</b></div>`;
        }
        return html;
      },
    },
    legend: {
      bottom: 0,
      textStyle: { color: c.text, fontSize: 9 },
      data: ['PDF (daily)', 'Fitted CDF', 'Observed completeness'],
    },
    series: [
      {
        name: 'PDF (daily)', type: 'bar', yAxisIndex: 1,
        data: tValues.map((t, i) => [t, pdfValues[i]]),
        barWidth: '80%',
        itemStyle: { color: BAR_COLOUR, opacity: 0.6 },
        emphasis: { itemStyle: { opacity: 1 } },
        markLine: markLines.length ? { silent: true, symbol: 'none', data: markLines } : undefined,
      },
      {
        name: 'Fitted CDF', type: 'line', yAxisIndex: 0,
        data: tValues.map((t, i) => [t, cdfValues[i]]),
        showSymbol: false, smooth: false,
        lineStyle: { color: CDF_COLOUR, width: 2.5 },
        itemStyle: { color: CDF_COLOUR },
      },
      {
        name: 'Observed completeness', type: 'scatter', yAxisIndex: 0,
        data: scatterData,
        symbolSize: 7,
        itemStyle: { color: SCATTER_COLOUR, opacity: 0.85 },
        emphasis: { itemStyle: { opacity: 1 } },
        tooltip: {
          formatter: (p: any) => {
            const [age, obs] = p.value;
            return [`<b>Age ${age} days</b>`, `Observed: ${fmtPct(obs)}`, `n=${p.data.n}, k=${p.data.k}`, p.data.date].join('<br/>');
          },
        },
      },
    ],
  };
}

type ComparisonChartOptionArgs = {
  scenarioIds?: string[];
  layout?: {
    widthPx?: number;
    heightPx?: number;
  };
  ui?: {
    showToolbox?: boolean;
  };
};

function buildComparisonChartState(
  result: AnalysisResult,
  settings: Record<string, any> = {},
  args: ComparisonChartOptionArgs = {},
) {
  const dims = result.semantics?.dimensions || [];
  const metrics = result.semantics?.metrics || [];
  const primaryDim = dims.find(d => d.id !== 'scenario_id' && d.role === 'primary') || dims.find(d => d.id !== 'scenario_id');
  const scenarioDim = dims.find(d => d.id === 'scenario_id' || d.type === 'scenario');
  if (!primaryDim) return null;

  const primaryMetricId = metrics.find(m => m.role === 'primary')?.id || metrics[0]?.id;
  if (!primaryMetricId) return null;

  const rows = Array.isArray(result.data) ? result.data : [];
  const scenarioIdField = scenarioDim?.id || 'scenario_id';
  const allScenarioIds = Array.from(new Set(rows
    .map(r => (r?.[scenarioIdField] != null ? String(r[scenarioIdField]) : ''))
    .filter(Boolean)));
  const scenarioIds = (args.scenarioIds && args.scenarioIds.length ? args.scenarioIds : allScenarioIds).filter(Boolean);

  const primaryIdField = primaryDim.id;
  const primaryIds = Array.from(new Set(rows
    .map(r => (r?.[primaryIdField] != null ? String(r[primaryIdField]) : ''))
    .filter(Boolean)))
    .sort((a, b) => getDimOrder(result.dimension_values, primaryIdField, a) - getDimOrder(result.dimension_values, primaryIdField, b));

  const byPrimaryAndScenario = new Map<string, any>();
  for (const row of rows) {
    const pid = row?.[primaryIdField];
    const sid = row?.[scenarioIdField];
    if (pid == null) continue;
    const key = `${String(pid)}::${sid == null ? '' : String(sid)}`;
    byPrimaryAndScenario.set(key, row);
  }

  const hasEvidenceMean = metrics.some(m => m.id === 'evidence_mean');
  const hasForecastMean = metrics.some(m => m.id === 'forecast_mean');
  const hasEvidenceK = metrics.some(m => m.id === 'evidence_k');
  const hasForecastK = metrics.some(m => m.id === 'forecast_k');
  const metricModeAbsolute = settings.metric_mode === 'absolute';
  const allFERendered = scenarioIds.length > 0
    && scenarioIds.every(sid => ((result.dimension_values?.scenario_id?.[sid] as any)?.visibility_mode || 'f+e') === 'f+e');
  const shouldShowFESplit = allFERendered && (
    (metricModeAbsolute && hasEvidenceK && hasForecastK)
    || (!metricModeAbsolute && hasEvidenceMean && hasForecastMean)
  );

  const comparisonColours = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444', '#6366f1'];
  const colourForPrimary = (primaryId: string, idx: number) =>
    result.dimension_values?.[primaryIdField]?.[primaryId]?.colour || comparisonColours[idx % comparisonColours.length];
  const hexToRgba = (hex: string, alpha: number): string => {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    const r = parseInt(m[1], 16);
    const g = parseInt(m[2], 16);
    const b = parseInt(m[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };
  const forecastDecal = { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [3, 3], rotation: -Math.PI / 4 } as any;
  const num = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const fmtValue = (v: number | null) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (metricModeAbsolute) return Math.round(v).toLocaleString();
    return `${(v * 100).toFixed(1)}%`;
  };
  const getRow = (primaryId: string, scenarioId?: string) =>
    byPrimaryAndScenario.get(`${primaryId}::${scenarioId || ''}`) || null;
  const getTotalValue = (row: any): number | null => {
    if (!row) return null;
    if (metricModeAbsolute) {
      const visibilityMode = row?.visibility_mode || 'f+e';
      if (visibilityMode === 'f') return num(row?.forecast_k);
      if (visibilityMode === 'e') return num(row?.evidence_k);
      return num(row?.forecast_k) ?? num(row?.evidence_k);
    }
    return num(row?.[primaryMetricId]);
  };
  const getEvidenceValue = (row: any): number | null => metricModeAbsolute ? num(row?.evidence_k) : num(row?.evidence_mean);

  return {
    primaryDim,
    scenarioIds,
    primaryIds,
    shouldShowFESplit,
    metricModeAbsolute,
    colourForPrimary,
    hexToRgba,
    forecastDecal,
    fmtValue,
    getRow,
    getTotalValue,
    getEvidenceValue,
  };
}

export function buildComparisonBarEChartsOption(
  result: AnalysisResult,
  settings: Record<string, any> = {},
  args: ComparisonChartOptionArgs = {},
): any | null {
  const state = buildComparisonChartState(result, settings, args);
  if (!state) return null;

  const {
    primaryDim,
    scenarioIds,
    primaryIds,
    shouldShowFESplit,
    metricModeAbsolute,
    colourForPrimary,
    hexToRgba,
    forecastDecal,
    fmtValue,
    getRow,
    getTotalValue,
    getEvidenceValue,
  } = state;

  const showToolbox = args.ui?.showToolbox ?? false;
  const widthPx = args.layout?.widthPx && Number.isFinite(args.layout.widthPx) ? args.layout.widthPx : 400;
  const categoryIsScenario = scenarioIds.length > 1;
  const requestedStackMode = typeof settings.stack_mode === 'string' ? settings.stack_mode : undefined;
  const effectiveStackMode = requestedStackMode || (categoryIsScenario ? 'stacked' : 'grouped');
  const useScenarioStack = categoryIsScenario && effectiveStackMode !== 'grouped';
  const categories = categoryIsScenario
    ? scenarioIds.map(sid => getScenarioTitleWithBasis(result, sid))
    : primaryIds.map(pid => getDimLabel(result.dimension_values, primaryDim.id, pid));
  const categoryCount = Math.max(1, categories.length);
  const perCategoryPx = widthPx / Math.max(1, categoryCount);
  const barLabelRotate =
    categoryCount >= 14 || widthPx < 300 ? 60 :
    categoryCount >= 8 || perCategoryPx < 52 ? 45 :
    categoryCount >= 5 && perCategoryPx < 80 ? 30 :
    0;
  const seriesCountForDensity = categoryIsScenario ? primaryIds.length : (shouldShowFESplit ? 2 : 1);
  const showValueLabels = (categoryCount * Math.max(1, seriesCountForDensity)) <= 18;

  const series: any[] = [];
  if (categoryIsScenario) {
    primaryIds.forEach((pid, idx) => {
      const branchLabel = getDimLabel(result.dimension_values, primaryDim.id, pid);
      const colour = colourForPrimary(pid, idx);
      if (shouldShowFESplit) {
        series.push({
          name: `${branchLabel} — e`,
          type: 'bar',
          stack: useScenarioStack ? 'comparison' : pid,
          ...(effectiveStackMode === 'stacked_100' ? { stackStrategy: 'percentage' as const } : null),
          itemStyle: { color: hexToRgba(colour, 0.9) },
          label: { show: false },
          data: scenarioIds.map(sid => {
            const row = getRow(pid, sid);
            const total = getTotalValue(row);
            const evidence = getEvidenceValue(row);
            const ev = typeof evidence === 'number' && typeof total === 'number'
              ? Math.min(total, evidence)
              : (typeof evidence === 'number' ? evidence : 0);
            return { value: ev, __raw: row, __total: total };
          }),
        });
        series.push({
          name: `${branchLabel} — f−e`,
          type: 'bar',
          stack: useScenarioStack ? 'comparison' : pid,
          ...(effectiveStackMode === 'stacked_100' ? { stackStrategy: 'percentage' as const } : null),
          itemStyle: { color: hexToRgba(colour, 0.4), decal: forecastDecal },
          label: {
            show: showValueLabels && !useScenarioStack,
            position: 'top',
            formatter: (p: any) => fmtValue(typeof p?.data?.__total === 'number' ? p.data.__total : null),
            fontSize: 7,
            color: echartsThemeColours().text,
          },
          data: scenarioIds.map(sid => {
            const row = getRow(pid, sid);
            const total = getTotalValue(row);
            const evidence = getEvidenceValue(row);
            const ev = typeof evidence === 'number' && typeof total === 'number'
              ? Math.min(total, evidence)
              : (typeof evidence === 'number' ? evidence : 0);
            const residual = typeof total === 'number' ? Math.max(0, total - ev) : 0;
            return { value: residual, __raw: row, __total: total };
          }),
        });
      } else {
        series.push({
          name: branchLabel,
          type: 'bar',
          ...(useScenarioStack ? { stack: 'comparison' } : null),
          ...(effectiveStackMode === 'stacked_100' ? { stackStrategy: 'percentage' as const } : null),
          itemStyle: { color: colour },
          label: {
            show: showValueLabels && !useScenarioStack,
            position: 'top',
            formatter: (p: any) => fmtValue(typeof p?.value === 'number' ? p.value : null),
            fontSize: 7,
            color: echartsThemeColours().text,
          },
          labelLayout: showValueLabels ? { hideOverlap: true } : undefined,
          data: scenarioIds.map(sid => {
            const row = getRow(pid, sid);
            return { value: getTotalValue(row) ?? 0, __raw: row };
          }),
        });
      }
    });
  } else {
    const scenarioId = scenarioIds[0];
    if (shouldShowFESplit) {
      series.push({
        name: 'Evidence',
        type: 'bar',
        stack: 'comparison',
        ...(effectiveStackMode === 'stacked_100' ? { stackStrategy: 'percentage' as const } : null),
        label: { show: false },
        data: primaryIds.map((pid, idx) => {
          const row = getRow(pid, scenarioId);
          const total = getTotalValue(row);
          const evidence = getEvidenceValue(row);
          const ev = typeof evidence === 'number' && typeof total === 'number'
            ? Math.min(total, evidence)
            : (typeof evidence === 'number' ? evidence : 0);
          return {
            value: ev,
            itemStyle: { color: hexToRgba(colourForPrimary(pid, idx), 0.9) },
            __raw: row,
            __total: total,
          };
        }),
      });
      series.push({
        name: 'Forecast − Evidence',
        type: 'bar',
        stack: 'comparison',
        ...(effectiveStackMode === 'stacked_100' ? { stackStrategy: 'percentage' as const } : null),
        label: {
          show: showValueLabels,
          position: 'top',
          formatter: (p: any) => fmtValue(typeof p?.data?.__total === 'number' ? p.data.__total : null),
          fontSize: 7,
          color: echartsThemeColours().text,
        },
        data: primaryIds.map((pid, idx) => {
          const row = getRow(pid, scenarioId);
          const total = getTotalValue(row);
          const evidence = getEvidenceValue(row);
          const ev = typeof evidence === 'number' && typeof total === 'number'
            ? Math.min(total, evidence)
            : (typeof evidence === 'number' ? evidence : 0);
          const residual = typeof total === 'number' ? Math.max(0, total - ev) : 0;
          return {
            value: residual,
            itemStyle: { color: hexToRgba(colourForPrimary(pid, idx), 0.4), decal: forecastDecal },
            __raw: row,
            __total: total,
          };
        }),
      });
    } else {
      series.push({
        name: scenarioId ? getScenarioTitleWithBasis(result, scenarioId) : 'Comparison',
        type: 'bar',
        label: {
          show: showValueLabels,
          position: 'top',
          formatter: (p: any) => fmtValue(typeof p?.value === 'number' ? p.value : null),
          fontSize: 7,
          color: echartsThemeColours().text,
        },
        labelLayout: showValueLabels ? { hideOverlap: true } : undefined,
        data: primaryIds.map((pid, idx) => {
          const row = getRow(pid, scenarioId);
          return {
            value: getTotalValue(row) ?? 0,
            itemStyle: { color: colourForPrimary(pid, idx) },
            __raw: row,
          };
        }),
      });
    }
  }

  return {
    __dagnet_skip_stack_mode: true,
    animation: false,
    backgroundColor: 'transparent',
    toolbox: showToolbox
      ? {
          show: true,
          right: 8,
          top: 8,
          feature: { saveAsImage: { show: true }, restore: { show: true } },
        }
      : { show: false },
    legend: { show: true, top: 0, left: 0, textStyle: { color: echartsThemeColours().text, fontSize: 9 } },
    grid: { left: 8, right: 16, top: showToolbox ? 34 : 22, bottom: barLabelRotate ? 58 : 42, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      confine: true,
      ...echartsTooltipStyle(),
      formatter: (params: any) => {
        const ps = Array.isArray(params) ? params : [params];
        const title = ps[0]?.axisValueLabel ?? '';
        const lines = [`<div style="font-size:11px;line-height:1.25;">`, `<div style="font-weight:600;margin-bottom:4px;">${title}</div>`];
        for (const p of ps) {
          if (typeof p?.value !== 'number' || !Number.isFinite(p.value) || p.value === 0) continue;
          lines.push(`<div>${p.marker || ''}${p.seriesName}: ${fmtValue(p.value)}</div>`);
        }
        lines.push(`</div>`);
        return lines.join('');
      },
    },
    xAxis: {
      type: 'category',
      data: categories.map(c => wrapAxisLabel(c)),
      axisLabel: {
        interval: 0,
        rotate: barLabelRotate,
        fontSize: 9,
        lineHeight: 12,
        hideOverlap: true,
        align: barLabelRotate ? ('right' as const) : ('center' as const),
        verticalAlign: barLabelRotate ? ('middle' as const) : ('top' as const),
        color: echartsThemeColours().text,
      },
      axisLine: { lineStyle: { color: echartsThemeColours().border } },
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        formatter: (v: number) => metricModeAbsolute ? Math.round(v).toString() : `${Math.round(v * 100)}%`,
        fontSize: 9,
        color: echartsThemeColours().text,
      },
      splitLine: { lineStyle: { color: echartsThemeColours().gridLine } },
      axisLine: { lineStyle: { color: echartsThemeColours().border } },
    },
    series,
  };
}

export function buildComparisonPieEChartsOption(
  result: AnalysisResult,
  settings: Record<string, any> = {},
  args: ComparisonChartOptionArgs = {},
): any | null {
  const state = buildComparisonChartState(result, settings, args);
  if (!state) return null;

  const {
    primaryDim,
    scenarioIds,
    primaryIds,
    metricModeAbsolute,
    colourForPrimary,
    fmtValue,
    getRow,
    getTotalValue,
  } = state;

  if (scenarioIds.length !== 1) return null;
  const scenarioId = scenarioIds[0];
  const data = primaryIds.map((pid, idx) => {
    const row = getRow(pid, scenarioId);
    return {
      name: getDimLabel(result.dimension_values, primaryDim.id, pid),
      value: getTotalValue(row) ?? 0,
      itemStyle: { color: colourForPrimary(pid, idx) },
      __raw: row,
    };
  });

  return {
    animation: false,
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      confine: true,
      ...echartsTooltipStyle(),
      formatter: (p: any) => {
        const v = typeof p?.value === 'number' ? p.value : null;
        return [`<div style="font-size:11px;line-height:1.25;">`, `<div style="font-weight:600;margin-bottom:4px;">${p?.name || ''}</div>`, `<div>${metricModeAbsolute ? 'Value' : 'Share'}: ${fmtValue(v)}</div>`, `</div>`].join('');
      },
    },
    legend: { show: true, top: 0, left: 0, textStyle: { color: echartsThemeColours().text, fontSize: 9 } },
    series: [
      {
        name: scenarioId ? getScenarioTitleWithBasis(result, scenarioId) : 'Comparison',
        type: 'pie',
        radius: '65%',
        center: ['50%', '58%'],
        label: {
          show: true,
          formatter: (p: any) => `${p.name}\n${metricModeAbsolute ? fmtValue(typeof p?.value === 'number' ? p.value : null) : `${Math.round(p.percent)}%`}`,
          fontSize: 7,
          color: echartsThemeColours().text,
        },
        labelLayout: { hideOverlap: true },
        data,
      },
    ],
  };
}

export function buildComparisonTimeSeriesEChartsOption(
  result: AnalysisResult,
  settings: Record<string, any> = {},
  args: ComparisonChartOptionArgs = {},
): any | null {
  const rows: any[] = Array.isArray(result?.data) ? result.data : [];
  if (rows.length === 0) return null;
  const c = echartsThemeColours();
  const visibleScenarioIds = args.scenarioIds && args.scenarioIds.length ? args.scenarioIds : ['current'];
  const filteredRows = rows.filter((r: any) => visibleScenarioIds.includes(String(r?.scenario_id)));
  if (filteredRows.length === 0) return null;

  const branchMeta: any = result?.dimension_values?.branch || {};
  const scenarioMeta: any = result?.dimension_values?.scenario_id || {};
  const branchIds = Array.from(new Set(filteredRows.map((r: any) => String(r?.branch)).filter(Boolean)))
    .sort((a, b) => getDimOrder(result.dimension_values, 'branch', a) - getDimOrder(result.dimension_values, 'branch', b));
  const dates = Array.from(new Set(filteredRows.map((r: any) => String(r?.date)).filter(Boolean))).sort();
  if (dates.length === 0) return null;

  const scenarioId = visibleScenarioIds[0];
  const visibilityMode = scenarioMeta?.[scenarioId]?.visibility_mode ?? 'f+e';
  const metricModeAbsolute = settings.metric_mode === 'absolute';
  const seriesType = settings.series_type ?? 'bar';
  const showSmooth = settings.smooth ?? false;
  const showMarkers = settings.show_markers;
  const showValueLabels = dates.length * branchIds.length <= 24;

  const comparisonColours = ['#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444', '#6366f1'];
  const colourForBranch = (branchId: string, idx: number) => branchMeta?.[branchId]?.colour || comparisonColours[idx % comparisonColours.length];
  const hexToRgba = (hex: string, alpha: number): string => {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    const r = parseInt(m[1], 16);
    const g = parseInt(m[2], 16);
    const b = parseInt(m[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };
  const forecastDecal = { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [3, 3], rotation: -Math.PI / 4 } as any;
  const pointsByBranchAndDate = new Map<string, any>();
  for (const row of filteredRows) {
    pointsByBranchAndDate.set(`${String(row.branch)}::${String(row.date)}`, row);
  }
  const fmtValue = (v: number | null) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (metricModeAbsolute) return Math.round(v).toLocaleString();
    return `${(v * 100).toFixed(1)}%`;
  };
  const getPoint = (branchId: string, date: string) => pointsByBranchAndDate.get(`${branchId}::${date}`) || null;
  const getValue = (row: any) => {
    if (!row) return null;
    if (metricModeAbsolute) {
      if (visibilityMode === 'e') return typeof row.evidence_y === 'number' ? row.evidence_y : row.y;
      if (visibilityMode === 'f') return typeof row.projected_y === 'number' ? row.projected_y : (typeof row.forecast_y === 'number' ? row.forecast_y : row.y);
      return typeof row.projected_y === 'number' ? row.projected_y : row.y;
    }
    const x = Number(row.x ?? 0);
    if (visibilityMode === 'e') {
      return x > 0 && typeof row.evidence_y === 'number' ? row.evidence_y / x : row.rate;
    }
    if (visibilityMode === 'f') {
      return x > 0 && typeof row.projected_y === 'number' ? row.projected_y / x : row.rate;
    }
    return x > 0 && typeof row.projected_y === 'number' ? row.projected_y / x : row.rate;
  };

  const shouldShowFESplit = visibilityMode === 'f+e'
    && filteredRows.some((r: any) => typeof r.evidence_y === 'number')
    && filteredRows.some((r: any) => typeof r.forecast_y === 'number');

  const series: any[] = [];
  for (let i = 0; i < branchIds.length; i++) {
    const branchId = branchIds[i];
    const branchName = branchMeta?.[branchId]?.name || branchId;
    const colour = colourForBranch(branchId, i);
    if (shouldShowFESplit) {
      series.push({
        name: `${branchName} — e`,
        type: seriesType === 'line' ? 'line' : 'bar',
        stack: 'comparison',
        showSymbol: seriesType === 'line' ? (showMarkers ?? (dates.length <= 20)) : undefined,
        smooth: seriesType === 'line' ? showSmooth : undefined,
        lineStyle: seriesType === 'line' ? { width: 2, color: hexToRgba(colour, 0.9) } : undefined,
        itemStyle: { color: hexToRgba(colour, 0.9) },
        areaStyle: seriesType === 'line' && settings.area_fill ? { opacity: 0.18 } : undefined,
        label: { show: false },
        data: dates.map(d => {
          const row = getPoint(branchId, d);
          const x = Number(row?.x ?? 0);
          const evidenceValue = metricModeAbsolute
            ? (typeof row?.evidence_y === 'number' ? row.evidence_y : 0)
            : (x > 0 && typeof row?.evidence_y === 'number' ? row.evidence_y / x : 0);
          const total = getValue(row);
          return [d, evidenceValue, { __total: total }];
        }),
      });
      series.push({
        name: `${branchName} — f−e`,
        type: seriesType === 'line' ? 'line' : 'bar',
        stack: 'comparison',
        showSymbol: seriesType === 'line' ? false : undefined,
        smooth: seriesType === 'line' ? showSmooth : undefined,
        lineStyle: seriesType === 'line' ? { width: 2, color: hexToRgba(colour, 0.45), type: 'dashed' } : undefined,
        itemStyle: { color: hexToRgba(colour, 0.45), decal: forecastDecal },
        areaStyle: seriesType === 'line' && settings.area_fill ? { opacity: 0.12 } : undefined,
        label: {
          show: showValueLabels && seriesType !== 'line',
          position: 'top',
          formatter: (p: any) => fmtValue(typeof p?.value?.[2]?.__total === 'number' ? p.value[2].__total : null),
          fontSize: 7,
          color: c.text,
        },
        data: dates.map(d => {
          const row = getPoint(branchId, d);
          const x = Number(row?.x ?? 0);
          const evidenceValue = metricModeAbsolute
            ? (typeof row?.evidence_y === 'number' ? row.evidence_y : 0)
            : (x > 0 && typeof row?.evidence_y === 'number' ? row.evidence_y / x : 0);
          const total = getValue(row);
          const residual = typeof total === 'number' ? Math.max(0, total - evidenceValue) : 0;
          return [d, residual, { __total: total }];
        }),
      });
    } else {
      series.push({
        name: branchName,
        type: seriesType === 'line' ? 'line' : 'bar',
        stack: 'comparison',
        showSymbol: seriesType === 'line' ? (showMarkers ?? (dates.length <= 20)) : undefined,
        smooth: seriesType === 'line' ? showSmooth : undefined,
        lineStyle: seriesType === 'line' ? { width: 2, color: colour } : undefined,
        itemStyle: { color: colour },
        areaStyle: seriesType === 'line' && settings.area_fill ? { opacity: 0.16 } : undefined,
        label: {
          show: showValueLabels && seriesType !== 'line',
          position: 'top',
          formatter: (p: any) => fmtValue(Array.isArray(p?.value) ? p.value[1] : null),
          fontSize: 9,
          color: c.text,
        },
        labelLayout: showValueLabels ? { hideOverlap: true } : undefined,
        data: dates.map(d => {
          const row = getPoint(branchId, d);
          return [d, getValue(row) ?? 0];
        }),
      });
    }
  }

  return {
    __dagnet_skip_stack_mode: true,
    animation: false,
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...echartsTooltipStyle(),
      formatter: (params: any) => {
        const items = Array.isArray(params) ? params : [params];
        const first = items[0];
        const dateRaw = Array.isArray(first?.value) ? first.value[0] : first?.axisValue;
        const dateStr = String(dateRaw || '');
        const lines = items.map((it: any) => {
          const val = Array.isArray(it?.value) ? it.value[1] : it?.value;
          return `${it?.marker || ''} ${it?.seriesName || ''}: <strong>${fmtValue(typeof val === 'number' ? val : null)}</strong>`;
        });
        return `<strong>${dateStr}</strong><br/>${lines.join('<br/>')}`;
      },
    },
    grid: { left: 52, right: 16, bottom: 60, top: series.length > 3 ? 72 : 46, containLabel: false },
    xAxis: {
      type: 'time',
      name: settings.y_axis_title ?? 'Cohort date',
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
    yAxis: [{
      type: 'value',
      name: metricModeAbsolute ? 'Conversions' : 'Rate',
      nameLocation: 'middle',
      nameGap: 45,
      nameTextStyle: { fontSize: 8, color: c.text },
      min: settings.y_axis_min ?? 0,
      max: settings.y_axis_max ?? undefined,
      axisLabel: {
        fontSize: 9,
        color: c.text,
        formatter: (value: number) => metricModeAbsolute
          ? (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toString())
          : `${Math.round(value * 100)}%`,
      },
    }],
    legend: {
      show: settings.show_legend ?? true,
      top: 0,
      textStyle: { color: c.text, fontSize: 9 },
    },
    series,
  };
}
