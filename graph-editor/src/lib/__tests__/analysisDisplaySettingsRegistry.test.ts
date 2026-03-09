import { describe, it, expect } from 'vitest';
import {
  CHART_DISPLAY_SETTINGS,
  CARDS_DISPLAY_SETTINGS,
  getDisplaySettings,
  getDisplaySettingsForSurface,
  resolveDisplaySetting,
  type DisplaySettingDef,
} from '../analysisDisplaySettingsRegistry';

describe('analysisDisplaySettingsRegistry', () => {
  // ============================================================
  // Basic retrieval
  // ============================================================

  it('should return bridge settings for chart_kind "bridge"', () => {
    const settings = getDisplaySettings('bridge', 'chart');
    expect(settings.length).toBeGreaterThan(0);
    expect(settings.find(s => s.key === 'orientation')).toBeDefined();
  });

  it('should return funnel settings for chart_kind "funnel"', () => {
    const settings = getDisplaySettings('funnel', 'chart');
    expect(settings.find(s => s.key === 'metric')).toBeDefined();
    expect(settings.find(s => s.key === 'funnel_direction')).toBeDefined();
  });

  it('should return cards settings for view_mode "cards" regardless of chart_kind', () => {
    const settings = getDisplaySettings('bridge', 'cards');
    expect(settings).toBe(CARDS_DISPLAY_SETTINGS);
    expect(settings.find(s => s.key === 'cards_font_size')).toBeDefined();
  });

  it('should return empty array for unknown chart_kind', () => {
    expect(getDisplaySettings('unknown_kind', 'chart')).toEqual([]);
  });

  // ============================================================
  // Surface filtering
  // ============================================================

  it('should filter by propsPanel surface', () => {
    const all = getDisplaySettings('bridge', 'chart');
    const panel = getDisplaySettingsForSurface('bridge', 'chart', 'propsPanel');
    expect(panel.length).toBeLessThanOrEqual(all.length);
    expect(panel.every(s => s.propsPanel)).toBe(true);
  });

  it('should filter by inline surface (all inline settings)', () => {
    const inline = getDisplaySettingsForSurface('bridge', 'chart', 'inline');
    expect(inline.every(s => s.inline !== false)).toBe(true);
    expect(inline.find(s => s.key === 'orientation')).toBeDefined();
  });

  it('should filter inline by tab context (full + brief)', () => {
    const inline = getDisplaySettingsForSurface('bridge', 'chart', 'inline', 'tab');
    expect(inline.every(s => s.inline !== false)).toBe(true);
    expect(inline.find(s => s.key === 'orientation')).toBeDefined();
    expect(inline.find(s => s.key === 'show_legend')).toBeDefined();
  });

  it('should filter inline by canvas context (brief only)', () => {
    const inline = getDisplaySettingsForSurface('bridge', 'chart', 'inline', 'canvas');
    expect(inline.every(s => s.inline === 'brief')).toBe(true);
    expect(inline.find(s => s.key === 'orientation')).toBeDefined();
    expect(inline.find(s => s.key === 'show_legend')).toBeDefined();
  });

  it('should filter by contextMenu surface', () => {
    const ctx = getDisplaySettingsForSurface('bridge', 'chart', 'contextMenu');
    expect(ctx.every(s => s.contextMenu)).toBe(true);
    expect(ctx.find(s => s.key === 'orientation')).toBeDefined();
  });

  it('should return cards_font_size in contextMenu for cards mode', () => {
    const ctx = getDisplaySettingsForSurface(undefined, 'cards', 'contextMenu');
    expect(ctx.find(s => s.key === 'cards_font_size')).toBeDefined();
  });

  // ============================================================
  // Value resolution
  // ============================================================

  it('should resolve setting from display object', () => {
    const settings = getDisplaySettings('bridge', 'chart');
    const orientation = settings.find(s => s.key === 'orientation')!;
    expect(resolveDisplaySetting({ orientation: 'horizontal' }, orientation)).toBe('horizontal');
  });

  it('should fall back to default when display object missing key', () => {
    const settings = getDisplaySettings('bridge', 'chart');
    const orientation = settings.find(s => s.key === 'orientation')!;
    expect(resolveDisplaySetting({}, orientation)).toBe('vertical');
    expect(resolveDisplaySetting(undefined, orientation)).toBe('vertical');
  });

  // ============================================================
  // Capability group: AXIS — all chart kinds
  // ============================================================

  it('should include axis overrides for all chart kinds', () => {
    for (const kind of Object.keys(CHART_DISPLAY_SETTINGS)) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'y_axis_min'), `${kind} missing y_axis_min`).toBeDefined();
      expect(settings.find(s => s.key === 'y_axis_max'), `${kind} missing y_axis_max`).toBeDefined();
      expect(settings.find(s => s.key === 'x_axis_min'), `${kind} missing x_axis_min`).toBeDefined();
      expect(settings.find(s => s.key === 'axis_label_format'), `${kind} missing axis_label_format`).toBeDefined();
      expect(settings.find(s => s.key === 'show_grid_lines'), `${kind} missing show_grid_lines`).toBeDefined();
    }
  });

  it('axis settings should be overridable', () => {
    const settings = getDisplaySettings('bridge', 'chart');
    expect(settings.find(s => s.key === 'y_axis_min')!.overridable).toBe(true);
    expect(settings.find(s => s.key === 'y_axis_max')!.overridable).toBe(true);
    expect(settings.find(s => s.key === 'axis_label_rotation')!.overridable).toBe(true);
    expect(settings.find(s => s.key === 'y_axis_title')!.overridable).toBe(true);
  });

  // ============================================================
  // Capability group: LEGEND — all chart kinds
  // ============================================================

  it('should include legend settings for all chart kinds', () => {
    for (const kind of Object.keys(CHART_DISPLAY_SETTINGS)) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'show_legend'), `${kind} missing show_legend`).toBeDefined();
      expect(settings.find(s => s.key === 'legend_position'), `${kind} missing legend_position`).toBeDefined();
    }
  });

  // ============================================================
  // Capability group: LABELS — all chart kinds
  // ============================================================

  it('should include label settings for all chart kinds', () => {
    for (const kind of Object.keys(CHART_DISPLAY_SETTINGS)) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'show_labels'), `${kind} missing show_labels`).toBeDefined();
      expect(settings.find(s => s.key === 'label_font_size'), `${kind} missing label_font_size`).toBeDefined();
    }
  });

  it('show_labels should be overridable', () => {
    const settings = getDisplaySettings('bridge', 'chart');
    expect(settings.find(s => s.key === 'show_labels')!.overridable).toBe(true);
  });

  // ============================================================
  // Capability group: GROUPING — time-series only
  // ============================================================

  it('should include time grouping for time-series chart kinds', () => {
    for (const kind of ['daily_conversions', 'cohort_maturity']) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'time_grouping'), `${kind} missing time_grouping`).toBeDefined();
    }
  });

  it('should NOT include time grouping for non-time-series chart kinds', () => {
    for (const kind of ['bridge', 'funnel', 'histogram']) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'time_grouping'), `${kind} should not have time_grouping`).toBeUndefined();
    }
  });

  // ============================================================
  // Capability group: CONFIDENCE — funnel + time-series
  // ============================================================

  // Confidence settings hidden until backend provides CI data
  it('should NOT include confidence settings (hidden until backend support)', () => {
    for (const kind of ['funnel', 'daily_conversions', 'cohort_maturity', 'bridge', 'histogram']) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'show_confidence'), `${kind} should not have show_confidence`).toBeUndefined();
      expect(settings.find(s => s.key === 'confidence_level'), `${kind} should not have confidence_level`).toBeUndefined();
    }
  });

  // ============================================================
  // Capability group: SCALE — histogram + daily_conversions
  // ============================================================

  it('should include scale settings for histogram and daily_conversions', () => {
    for (const kind of ['histogram', 'daily_conversions']) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'y_axis_scale'), `${kind} missing y_axis_scale`).toBeDefined();
    }
  });

  it('should NOT include scale for bridge, funnel, cohort_maturity', () => {
    for (const kind of ['bridge', 'funnel', 'cohort_maturity']) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'y_axis_scale'), `${kind} should not have y_axis_scale`).toBeUndefined();
    }
  });

  // ============================================================
  // Capability group: TREND — daily_conversions only
  // ============================================================

  it('should include trend line for daily_conversions', () => {
    const settings = getDisplaySettings('daily_conversions', 'chart');
    expect(settings.find(s => s.key === 'show_trend_line')).toBeDefined();
  });

  it('should NOT include trend line for other kinds', () => {
    for (const kind of ['bridge', 'funnel', 'histogram', 'cohort_maturity']) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'show_trend_line'), `${kind} should not have show_trend_line`).toBeUndefined();
    }
  });

  // ============================================================
  // Capability group: SORT — bridge only
  // ============================================================

  it('should include sort settings for bridge kinds', () => {
    for (const kind of ['bridge']) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'sort_by'), `${kind} missing sort_by`).toBeDefined();
      expect(settings.find(s => s.key === 'sort_direction'), `${kind} missing sort_direction`).toBeDefined();
    }
  });

  // ============================================================
  // Capability group: SERIES TYPE — daily_conversions
  // ============================================================

  it('should include series_type for daily_conversions', () => {
    const settings = getDisplaySettings('daily_conversions', 'chart');
    expect(settings.find(s => s.key === 'series_type')).toBeDefined();
  });

  // ============================================================
  // Capability group: SMOOTHING — line-capable charts
  // ============================================================

  it('should include smooth for daily_conversions and cohort_maturity', () => {
    for (const kind of ['daily_conversions', 'cohort_maturity']) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'smooth'), `${kind} missing smooth`).toBeDefined();
    }
  });

  // ============================================================
  // Capability group: BAR SPACING — bar charts
  // ============================================================

  it('should include bar_gap for bar chart kinds', () => {
    for (const kind of ['bridge', 'histogram']) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'bar_gap'), `${kind} missing bar_gap`).toBeDefined();
    }
  });

  // ============================================================
  // Capability group: LABEL POSITION — bridge + funnel
  // ============================================================

  it('should include label_position for bridge and funnel kinds', () => {
    for (const kind of ['bridge', 'funnel']) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'label_position'), `${kind} missing label_position`).toBeDefined();
    }
  });

  // ============================================================
  // Capability group: REFERENCE LINES — all chart kinds
  // ============================================================

  it('should include reference_lines for all chart kinds', () => {
    for (const kind of Object.keys(CHART_DISPLAY_SETTINGS)) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'reference_lines'), `${kind} missing reference_lines`).toBeDefined();
    }
  });

  it('reference_lines should be a list type with itemFields', () => {
    const settings = getDisplaySettings('bridge', 'chart');
    const refLines = settings.find(s => s.key === 'reference_lines')!;
    expect(refLines.type).toBe('list');
    expect(refLines.itemFields).toBeDefined();
    expect(refLines.itemFields!.length).toBeGreaterThan(0);
    expect(refLines.itemFields!.find(f => f.key === 'value')).toBeDefined();
    expect(refLines.itemFields!.find(f => f.key === 'label')).toBeDefined();
    expect(refLines.itemFields!.find(f => f.key === 'colour')).toBeDefined();
    expect(refLines.itemFields!.find(f => f.key === 'line_style')).toBeDefined();
  });

  // ============================================================
  // Capability group: TOOLTIP — all chart kinds
  // ============================================================

  it('should include tooltip settings for all chart kinds', () => {
    for (const kind of Object.keys(CHART_DISPLAY_SETTINGS)) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'show_tooltip'), `${kind} missing show_tooltip`).toBeDefined();
      expect(settings.find(s => s.key === 'tooltip_mode'), `${kind} missing tooltip_mode`).toBeDefined();
    }
  });

  // ============================================================
  // Capability group: ANIMATION — all chart kinds
  // ============================================================

  it('should include animate for all chart kinds', () => {
    for (const kind of Object.keys(CHART_DISPLAY_SETTINGS)) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'animate'), `${kind} missing animate`).toBeDefined();
    }
  });

  // ============================================================
  // Capability group: MARKERS — line-capable time-series
  // ============================================================

  it('should include marker settings for daily_conversions and cohort_maturity', () => {
    for (const kind of ['daily_conversions', 'cohort_maturity']) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'show_markers'), `${kind} missing show_markers`).toBeDefined();
      expect(settings.find(s => s.key === 'marker_size'), `${kind} missing marker_size`).toBeDefined();
    }
  });

  // ============================================================
  // Capability group: AREA FILL — line-capable charts
  // ============================================================

  it('should include area_fill for daily_conversions and cohort_maturity', () => {
    for (const kind of ['daily_conversions', 'cohort_maturity']) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'area_fill'), `${kind} missing area_fill`).toBeDefined();
    }
  });

  // ============================================================
  // Capability group: MISSING DATA — time-series
  // ============================================================

  it('should include missing_data for time-series kinds', () => {
    for (const kind of ['daily_conversions', 'cohort_maturity']) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'missing_data'), `${kind} missing missing_data`).toBeDefined();
    }
  });

  // ============================================================
  // Capability group: STACK MODE — daily_conversions
  // ============================================================

  it('should include stack_mode for daily_conversions', () => {
    const settings = getDisplaySettings('daily_conversions', 'chart');
    expect(settings.find(s => s.key === 'stack_mode')).toBeDefined();
  });

  // ============================================================
  // Capability group: CUMULATIVE — daily_conversions
  // ============================================================

  it('should include cumulative for daily_conversions', () => {
    const settings = getDisplaySettings('daily_conversions', 'chart');
    expect(settings.find(s => s.key === 'cumulative')).toBeDefined();
  });

  // ============================================================
  // Capability group: MOVING AVERAGE — time-series
  // ============================================================

  it('should include moving_average for daily_conversions and cohort_maturity', () => {
    for (const kind of ['daily_conversions', 'cohort_maturity']) {
      const settings = getDisplaySettings(kind, 'chart');
      expect(settings.find(s => s.key === 'moving_average'), `${kind} missing moving_average`).toBeDefined();
      expect(settings.find(s => s.key === 'show_raw_with_average'), `${kind} missing show_raw_with_average`).toBeDefined();
    }
  });

  it('moving_average should be available inline (full) and in context menu', () => {
    const settings = getDisplaySettings('daily_conversions', 'chart');
    const ma = settings.find(s => s.key === 'moving_average')!;
    expect(ma.inline).toBe('full');
    expect(ma.contextMenu).toBe(true);
  });

  // ============================================================
  // Funnel-specific: direction and dropoff
  // ============================================================

  it('funnel should have direction and dropoff settings', () => {
    const settings = getDisplaySettings('funnel', 'chart');
    expect(settings.find(s => s.key === 'funnel_direction')).toBeDefined();
    expect(settings.find(s => s.key === 'show_dropoff')).toBeDefined();
  });

  // ============================================================
  // Bridge-specific settings
  // ============================================================

  it('bridge should have show_connectors', () => {
    const settings = getDisplaySettings('bridge', 'chart');
    expect(settings.find(s => s.key === 'show_connectors')).toBeDefined();
  });

  it('bridge should have both orientation and show_connectors', () => {
    const settings = getDisplaySettings('bridge', 'chart');
    expect(settings.find(s => s.key === 'show_connectors')).toBeDefined();
    expect(settings.find(s => s.key === 'orientation')).toBeDefined();
  });

  // ============================================================
  // Structural invariants
  // ============================================================

  it('every setting should have a valid type', () => {
    const validTypes = new Set(['radio', 'checkbox', 'select', 'slider', 'number-range', 'list', 'text']);
    for (const [kind, settings] of Object.entries(CHART_DISPLAY_SETTINGS)) {
      for (const s of settings) {
        expect(validTypes.has(s.type), `${kind}.${s.key} has invalid type "${s.type}"`).toBe(true);
      }
    }
    for (const s of CARDS_DISPLAY_SETTINGS) {
      expect(validTypes.has(s.type), `cards.${s.key} has invalid type "${s.type}"`).toBe(true);
    }
  });

  it('radio settings should have options', () => {
    for (const [kind, settings] of Object.entries(CHART_DISPLAY_SETTINGS)) {
      for (const s of settings) {
        if (s.type === 'radio') {
          expect(s.options, `${kind}.${s.key} is radio but has no options`).toBeDefined();
          expect(s.options!.length, `${kind}.${s.key} has empty options`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('list settings should have itemFields', () => {
    for (const [kind, settings] of Object.entries(CHART_DISPLAY_SETTINGS)) {
      for (const s of settings) {
        if (s.type === 'list') {
          expect(s.itemFields, `${kind}.${s.key} is list but has no itemFields`).toBeDefined();
          expect(s.itemFields!.length, `${kind}.${s.key} has empty itemFields`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('no duplicate keys within a chart kind', () => {
    for (const [kind, settings] of Object.entries(CHART_DISPLAY_SETTINGS)) {
      const keys = settings.map(s => s.key);
      const unique = new Set(keys);
      expect(keys.length, `${kind} has duplicate setting keys: ${keys.filter((k, i) => keys.indexOf(k) !== i)}`).toBe(unique.size);
    }
  });
});
