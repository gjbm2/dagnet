/**
 * analysisECharts/echartsCommon.ts
 *
 * Theming primitives, shared tooltip style, common display-settings applicator,
 * and small metadata/label helpers used across all ECharts chart builders.
 *
 * Extracted from analysisEChartsService.ts — AEC-PR1.
 */

import type { AnalysisResult, DimensionValueMeta } from '../../lib/graphComputeClient';
import { chartFontScale } from '../../lib/analysisDisplaySettingsRegistry';
import { isDarkMode } from '../../theme/objectTypeTheme';

// ─── Theming ────────────────────────────────────────────────────────────────

/** ECharts colour palette that respects current theme. Call at render time. */
export function echartsThemeColours() {
  const dark = isDarkMode();
  return {
    text: dark ? '#e0e0e0' : '#374151',
    textSecondary: dark ? '#aaa' : '#6b7280',
    textMuted: dark ? '#888' : '#9ca3af',
    border: dark ? '#404040' : '#e5e7eb',
    gridLine: dark ? '#333' : '#e5e7eb',
    bg: dark ? '#1e1e1e' : '#ffffff',
    tooltipBg: dark ? '#2d2d2d' : '#fff',
    tooltipBorder: dark ? '#555' : '#ccc',
    tooltipText: dark ? '#e0e0e0' : '#333',
  };
}

/** Shared tooltip styling for all ECharts instances */
export function echartsTooltipStyle() {
  const c = echartsThemeColours();
  return {
    backgroundColor: c.tooltipBg,
    borderColor: c.tooltipBorder,
    textStyle: { color: c.tooltipText },
    // Render tooltip as a direct child of <body> so it escapes overflow:hidden
    // containers (canvas analysis nodes, chart viewports, etc.)
    appendToBody: true,
  };
}

// ─── Common display-settings applicator ─────────────────────────────────────

/**
 * Apply common display settings to a built ECharts option object.
 * Called at the end of every builder so common settings are handled uniformly.
 * Mutates `opt` in place and returns it.
 */
export function applyCommonSettings(opt: any, settings: Record<string, any>): any {
  if (!opt) return opt;
  const c = echartsThemeColours();

  // ── Legend ──
  const legendVisible = settings.show_legend !== false && !(opt.legend?.show === false);
  if (settings.show_legend === false) {
    opt.legend = { show: false };
  } else if (opt.legend && opt.legend.show !== false) {
    const pos = settings.legend_position;
    if (pos === 'bottom') {
      opt.legend.top = undefined;
      opt.legend.bottom = 0;
    } else if (pos === 'left') {
      opt.legend.top = undefined;
      opt.legend.right = undefined;
      opt.legend.left = 0;
      opt.legend.orient = 'vertical';
    } else if (pos === 'right') {
      opt.legend.top = undefined;
      opt.legend.left = undefined;
      opt.legend.right = 0;
      opt.legend.orient = 'vertical';
    }
  }

  // ── Grid margin adjustment for legend ──
  // Only adjust pixel-based margins; skip percentage-based values (the builder chose % deliberately).
  const isPixel = (v: any): boolean => typeof v === 'number' || (typeof v === 'string' && !v.endsWith('%'));
  if (opt.grid && legendVisible) {
    const pos = settings.legend_position || 'top';
    const g = opt.grid;
    const hasToolbox = opt.toolbox?.show === true;
    if ((pos === 'top' || pos === undefined) && isPixel(g.top)) {
      g.top = Math.max(parseInt(g.top, 10) || 0, 40);
    } else if (pos === 'bottom') {
      if (isPixel(g.bottom)) g.bottom = Math.max(parseInt(g.bottom, 10) || 0, 48);
      // Reclaim top space if builder reserved it for a top legend.
      if (isPixel(g.top)) {
        const minTop = hasToolbox ? 34 : 16;
        const cur = parseInt(g.top, 10) || 0;
        if (cur > minTop) g.top = minTop;
      }
    } else if (pos === 'left') {
      if (isPixel(g.left)) g.left = Math.max(parseInt(g.left, 10) || 0, 120);
      if (isPixel(g.top)) {
        const minTop = hasToolbox ? 34 : 16;
        const cur = parseInt(g.top, 10) || 0;
        if (cur > minTop) g.top = minTop;
      }
    } else if (pos === 'right') {
      if (isPixel(g.right)) g.right = Math.max(parseInt(g.right, 10) || 0, 120);
      // Reclaim top space if builder reserved it for a top legend.
      if (isPixel(g.top)) {
        const minTop = hasToolbox ? 34 : 16;
        const cur = parseInt(g.top, 10) || 0;
        if (cur > minTop) g.top = minTop;
      }
    }
  } else if (opt.grid && !legendVisible && isPixel(opt.grid.top)) {
    // Legend hidden — builders may have reserved space for it; compact the top margin.
    const hasToolbox = opt.toolbox?.show === true;
    const minTop = hasToolbox ? 34 : 16;
    const current = parseInt(opt.grid.top, 10) || 0;
    if (current > minTop) {
      opt.grid.top = minTop;
    }
  }

  // ── Grid lines ──
  const gridLines = settings.show_grid_lines;
  const gridStyle = settings.grid_line_style ?? 'dashed';
  const gridLineStyleObj = { type: gridStyle, color: c.gridLine };
  if (gridLines !== undefined) {
    const yAxes = Array.isArray(opt.yAxis) ? opt.yAxis : (opt.yAxis ? [opt.yAxis] : []);
    const xAxes = Array.isArray(opt.xAxis) ? opt.xAxis : (opt.xAxis ? [opt.xAxis] : []);
    const showH = gridLines === 'horizontal' || gridLines === 'both';
    const showV = gridLines === 'vertical' || gridLines === 'both';
    for (const y of yAxes) { y.splitLine = { show: showH, lineStyle: gridLineStyleObj }; }
    for (const x of xAxes) {
      if (!x.splitLine) x.splitLine = {};
      x.splitLine.show = showV;
      if (showV) x.splitLine.lineStyle = gridLineStyleObj;
    }
    if (gridLines === 'none') {
      for (const y of yAxes) y.splitLine = { show: false };
      for (const x of xAxes) x.splitLine = { show: false };
    }
  }

  // ── Axis label rotation ──
  const rotation = settings.axis_label_rotation;
  if (rotation !== undefined && rotation !== 'auto') {
    const angle = Number(rotation);
    if (Number.isFinite(angle)) {
      const xAxes = Array.isArray(opt.xAxis) ? opt.xAxis : (opt.xAxis ? [opt.xAxis] : []);
      for (const x of xAxes) {
        if (!x.axisLabel) x.axisLabel = {};
        x.axisLabel.rotate = angle;
      }
    }
  }

  // ── Axis label format ──
  const fmt = settings.axis_label_format;
  if (fmt && fmt !== 'auto') {
    const fmtFn = (v: number) => {
      if (fmt === 'percent') return `${(v * 100).toFixed(0)}%`;
      if (fmt === 'decimal_2') return v.toFixed(2);
      if (fmt === 'decimal_0') return Math.round(v).toString();
      if (fmt === 'compact') {
        if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
        if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
        return v.toString();
      }
      return v.toString();
    };
    const yAxes = Array.isArray(opt.yAxis) ? opt.yAxis : (opt.yAxis ? [opt.yAxis] : []);
    for (const y of yAxes) {
      if (!y.axisLabel) y.axisLabel = {};
      y.axisLabel.formatter = fmtFn;
    }
  }

  // ── Tooltip ──
  if (settings.show_tooltip === false) {
    opt.tooltip = { show: false };
  } else if (opt.tooltip) {
    const mode = settings.tooltip_mode;
    if (mode === 'item') opt.tooltip.trigger = 'item';
    else if (mode === 'axis') opt.tooltip.trigger = 'axis';
  }

  // ── Animation ──
  if (settings.animate === false) {
    opt.animation = false;
  } else {
    // Halve ECharts default (1000ms → 500ms) for snappier load feel
    opt.animationDuration = opt.animationDuration ?? 500;
  }

  // ── Data labels (series-level) ──
  const showLabels = settings.show_labels;
  const labelFontSize = settings.label_font_size;
  const labelPosition = settings.label_position;
  if (showLabels !== undefined || labelFontSize !== undefined || labelPosition !== undefined) {
    for (const s of (opt.series || [])) {
      if (!s.label) s.label = {};
      if (showLabels !== undefined && showLabels !== null) s.label.show = !!showLabels;
      if (labelFontSize !== undefined && labelFontSize !== null) s.label.fontSize = labelFontSize;
      if (labelPosition !== undefined) s.label.position = labelPosition;
    }
  }

  // ── Chart font size (global scale) ──
  const fontSizeSetting = settings.font_size ?? settings.chart_font_size;
  if (fontSizeSetting) {
    const fs = chartFontScale(fontSizeSetting);
    // Axis titles (nameTextStyle)
    const allAxes = [
      ...(Array.isArray(opt.xAxis) ? opt.xAxis : opt.xAxis ? [opt.xAxis] : []),
      ...(Array.isArray(opt.yAxis) ? opt.yAxis : opt.yAxis ? [opt.yAxis] : []),
    ];
    for (const ax of allAxes) {
      if (ax.nameTextStyle) ax.nameTextStyle.fontSize = fs.axisTitlePx;
      else if (ax.name) ax.nameTextStyle = { fontSize: fs.axisTitlePx, color: c.text };
      if (ax.axisLabel) ax.axisLabel.fontSize = fs.axisLabelPx;
    }
    // Legend
    if (opt.legend && opt.legend.show !== false) {
      if (!opt.legend.textStyle) opt.legend.textStyle = {};
      opt.legend.textStyle.fontSize = fs.legendPx;
    }
    // Tooltip
    if (opt.tooltip && opt.tooltip.show !== false) {
      if (!opt.tooltip.textStyle) opt.tooltip.textStyle = {};
      opt.tooltip.textStyle.fontSize = fs.tooltipPx;
    }
    // Series data labels (only if label_font_size not explicitly set)
    if (labelFontSize === undefined || labelFontSize === null) {
      for (const s of (opt.series || [])) {
        if (s.label && s.label.fontSize !== undefined) s.label.fontSize = fs.dataLabelPx;
      }
    }
  }

  return opt;
}

// ─── Metadata / label helpers ───────────────────────────────────────────────

export function isConversionFunnelResult(result: AnalysisResult): boolean {
  return result.analysis_type === 'conversion_funnel' || result.analysis_name === 'Conversion Funnel';
}

export function getDimLabel(dimensionValues: Record<string, Record<string, DimensionValueMeta>> | undefined, dimId: string, valueId: string): string {
  return dimensionValues?.[dimId]?.[valueId]?.name ?? valueId;
}

export function getDimOrder(dimensionValues: Record<string, Record<string, DimensionValueMeta>> | undefined, dimId: string, valueId: string): number {
  const order = (dimensionValues?.[dimId]?.[valueId] as any)?.order;
  return typeof order === 'number' && Number.isFinite(order) ? order : 0;
}

/**
 * Wrap a label string across multiple lines, splitting on word boundaries
 * (spaces, hyphens, underscores, slashes, etc.) and hard-breaking long tokens.
 */
export function wrapAxisLabel(raw: string, maxCharsPerLine = 12, maxLines = 2): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const parts = s.split(/[\s/|._:\-–—]+/g).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  const push = () => { if (current.trim()) lines.push(current.trim()); current = ''; };
  for (const p of parts) {
    const chunks: string[] = [];
    if (p.length > maxCharsPerLine) {
      for (let i = 0; i < p.length; i += maxCharsPerLine) chunks.push(p.slice(i, i + maxCharsPerLine));
    } else {
      chunks.push(p);
    }
    for (const token of chunks) {
      const next = current ? `${current} ${token}` : token;
      if (next.length > maxCharsPerLine) { push(); current = token; } else { current = next; }
      if (lines.length >= maxLines) break;
    }
    if (lines.length >= maxLines) break;
  }
  push();
  return lines.slice(0, maxLines).join('\n') || s;
}

export function getScenarioTitleWithBasis(result: AnalysisResult, scenarioId: string): string {
  const name = getDimLabel(result.dimension_values, 'scenario_id', scenarioId);
  const basis = (result.dimension_values?.scenario_id?.[scenarioId] as any)?.probability_label;
  if (typeof basis === 'string' && basis.trim() && basis !== 'Probability') {
    return `${name} (${basis})`;
  }
  return name;
}
