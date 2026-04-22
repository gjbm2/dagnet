import React from 'react';
import type { ViewMode } from '../types/chartRecipe';

/**
 * Analysis Display Settings Registry
 *
 * Maps chart_kind → available display settings.
 * One definition drives three surfaces: properties panel, inline chart controls, context menu.
 * All settings persist in CanvasAnalysisDisplay (graph JSON).
 *
 * ## Display class rendering contract
 *
 * Each `DisplaySettingType` maps to a standard UI component per surface:
 *
 * | Type         | Props panel              | Inline               | Context menu            |
 * |--------------|--------------------------|----------------------|-------------------------|
 * | radio        | Radio group / btn group  | Compact button group | Submenu with items      |
 * | checkbox     | Checkbox + label         | Toggle icon          | Checkmark menu item     |
 * | select       | Dropdown                 | Compact dropdown     | Submenu with items      |
 * | slider       | Range slider + value     | (not used inline)    | (not used in menu)      |
 * | number-range | Number input             | (not used inline)    | (not used in menu)      |
 * | text         | Text input               | (not used inline)    | (not used in menu)      |
 * | list         | Editable list + add/del  | (not used inline)    | (not used in menu)      |
 *
 * When `overridable: true`, the props panel wraps the control in `AutomatableField`
 * (ZapOff toggle: null = auto, non-null = manual override).
 *
 * All settings are OPTIONAL. Charts render with no display overrides using defaults
 * from the registry. The UI shows defaults as placeholders, making the "auto" state visible.
 *
 * See: docs/current/project-canvas/implementation-plan.md Phase 3d
 */

export type DisplaySettingType = 'radio' | 'checkbox' | 'select' | 'slider' | 'number-range' | 'list' | 'text';

export interface DisplaySettingOption {
  value: string | number;
  label: string;
}

/**
 * Schema for list-type settings (e.g. reference lines).
 * Each field describes a property of each item in the list.
 */
export interface ListItemFieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'colour' | 'select';
  options?: DisplaySettingOption[];
  defaultValue?: any;
}

export interface DisplaySettingDef {
  key: string;
  label: string;
  shortLabel?: string;
  type: DisplaySettingType;
  options?: DisplaySettingOption[];
  defaultValue: any;
  /** Show in the chart properties panel (Section 4) */
  propsPanel: boolean;
  /**
   * Inline visibility tier inside the chart chrome.
   *  'full'  = shown inline in tab mode (more screen space)
   *  'brief' = shown inline in both tab AND canvas mode (key settings only)
   *  false   = never shown inline (props panel / modal only)
   */
  inline: 'full' | 'brief' | false;
  /** Show in the right-click context menu (later implementation phase) */
  contextMenu: boolean;
  /**
   * If true, the setting supports "auto vs manual" state.
   * When auto, the chart derives the value; when manual, the user's value is used.
   * UI: AutomatableField wrapper with ZapOff toggle.
   */
  overridable?: boolean;
  /** For type='list': schema for each item in the list */
  itemFields?: ListItemFieldDef[];
  /**
   * Optional toolbar group key. Settings with the same `group` are rendered
   * together inside a single `cfp-pill-group` wrapper in the inline toolbar.
   */
  group?: string;
  /**
   * If true, changing this setting affects backend computation (not just rendering).
   * The setting value is included in the chart deps signature and sent to the backend
   * in the analysis request, so changes trigger a full recompute.
   */
  computeAffecting?: boolean;
}

// ============================================================
// Common setting groups — shared across chart kinds
// ============================================================

/** Axis extent overrides (auto-derived by default, user can override) */
const COMMON_AXIS_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'y_axis_min',
    label: 'Y-axis min',
    type: 'number-range',
    defaultValue: null,
    propsPanel: true,
    inline: false,
    contextMenu: false,
    overridable: true,
  },
  {
    key: 'y_axis_max',
    label: 'Y-axis max',
    type: 'number-range',
    defaultValue: null,
    propsPanel: true,
    inline: false,
    contextMenu: false,
    overridable: true,
  },
  {
    key: 'x_axis_min',
    label: 'X-axis min',
    type: 'number-range',
    defaultValue: null,
    propsPanel: true,
    inline: false,
    contextMenu: false,
    overridable: true,
  },
  {
    key: 'x_axis_max',
    label: 'X-axis max',
    type: 'number-range',
    defaultValue: null,
    propsPanel: true,
    inline: false,
    contextMenu: false,
    overridable: true,
  },
  {
    key: 'axis_label_rotation',
    label: 'Label rotation',
    type: 'radio',
    options: [
      { value: '0', label: '0°' },
      { value: '30', label: '30°' },
      { value: '45', label: '45°' },
      { value: '60', label: '60°' },
      { value: '90', label: '90°' },
    ],
    defaultValue: 'auto',
    propsPanel: true,
    inline: false,
    contextMenu: false,
    overridable: true,
  },
  {
    key: 'axis_label_format',
    label: 'Number format',
    type: 'radio',
    options: [
      { value: 'percent', label: 'Percentage' },
      { value: 'decimal_2', label: '2 decimals' },
      { value: 'decimal_0', label: 'Whole number' },
      { value: 'compact', label: 'Compact (1.2K)' },
    ],
    defaultValue: 'auto',
    propsPanel: true,
    inline: false,
    contextMenu: false,
  },
  {
    key: 'y_axis_title',
    label: 'Y-axis title',
    type: 'text',
    defaultValue: null,
    propsPanel: true,
    inline: false,
    contextMenu: false,
    overridable: true,
  },
  {
    key: 'show_grid_lines',
    label: 'Grid lines',
    type: 'radio',
    options: [
      { value: 'horizontal', label: 'Horizontal' },
      { value: 'vertical', label: 'Vertical' },
      { value: 'both', label: 'Both' },
      { value: 'none', label: 'None' },
    ],
    defaultValue: 'horizontal',
    propsPanel: true,
    inline: false,
    contextMenu: false,
  },
  {
    key: 'grid_line_style',
    label: 'Grid line style',
    type: 'radio',
    options: [
      { value: 'solid', label: 'Solid' },
      { value: 'dashed', label: 'Dashed' },
      { value: 'dotted', label: 'Dotted' },
    ],
    defaultValue: 'dashed',
    propsPanel: true,
    inline: false,
    contextMenu: false,
  },
];

/** Legend display */
const COMMON_LEGEND_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'show_legend',
    label: 'Show legend',
    type: 'checkbox',
    defaultValue: true,
    propsPanel: true,
    inline: 'brief',
    contextMenu: true,
    group: 'legend',
  },
  {
    key: 'legend_position',
    label: 'Legend position',
    shortLabel: 'Legend',
    type: 'radio',
    options: [
      { value: 'top', label: 'Top' },
      { value: 'bottom', label: 'Bottom' },
      { value: 'left', label: 'Left' },
      { value: 'right', label: 'Right' },
    ],
    defaultValue: 'top',
    propsPanel: true,
    inline: 'brief',
    contextMenu: true,
    group: 'legend',
  },
];

/** Data labels on bars/points */
const COMMON_LABEL_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'show_labels',
    label: 'Show data labels',
    type: 'checkbox',
    defaultValue: null,
    propsPanel: true,
    inline: false,
    contextMenu: true,
    overridable: true,
  },
  {
    key: 'label_font_size',
    label: 'Label font size',
    type: 'number-range',
    defaultValue: null,
    propsPanel: true,
    inline: false,
    contextMenu: false,
    overridable: true,
  },
];

// Confidence intervals — hidden until backend provides ci_lower/ci_upper in result data
const COMMON_CONFIDENCE_SETTINGS: DisplaySettingDef[] = [
  // {
  //   key: 'show_confidence',
  //   ...
  // },
  // {
  //   key: 'confidence_level',
  //   ...
  // },
];

/** Axis scale type */
const COMMON_SCALE_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'y_axis_scale',
    label: 'Y-axis scale',
    type: 'radio',
    options: [
      { value: 'linear', label: 'Linear' },
      { value: 'log', label: 'Logarithmic' },
    ],
    defaultValue: 'linear',
    propsPanel: true,
    inline: false,
    contextMenu: true,
  },
];

/** Trend/regression overlay */
const COMMON_TREND_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'show_trend_line',
    label: 'Show trend line',
    type: 'checkbox',
    defaultValue: false,
    propsPanel: true,
    inline: 'full',
    contextMenu: true,
  },
];

/** Sort order for bar/category charts */
const COMMON_SORT_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'sort_by',
    label: 'Sort by',
    type: 'radio',
    options: [
      { value: 'graph_order', label: 'Graph order' },
      { value: 'value', label: 'Value' },
      { value: 'name', label: 'Name' },
    ],
    defaultValue: 'graph_order',
    propsPanel: true,
    inline: false,
    contextMenu: true,
  },
  {
    key: 'sort_direction',
    label: 'Sort direction',
    type: 'radio',
    options: [
      { value: 'asc', label: 'Ascending' },
      { value: 'desc', label: 'Descending' },
    ],
    defaultValue: 'desc',
    propsPanel: true,
    inline: false,
    contextMenu: false,
  },
];

/** Grouping/aggregation for time-series charts */
const COMMON_GROUPING_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'time_grouping',
    label: 'Group by',
    type: 'radio',
    options: [
      { value: 'day', label: 'Day' },
      { value: 'week', label: 'Week' },
      { value: 'month', label: 'Month' },
    ],
    defaultValue: 'day',
    propsPanel: true,
    inline: 'full',
    contextMenu: true,
  },
];

/** Series presentation type (bar vs line) for charts that support both */
const COMMON_SERIES_TYPE_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'series_type',
    label: 'Series type',
    type: 'radio',
    options: [
      { value: 'bar', label: 'Bar' },
      { value: 'line', label: 'Line' },
    ],
    defaultValue: 'bar',
    propsPanel: true,
    inline: 'full',
    contextMenu: true,
  },
];

/** Line smoothing for line charts / line overlays */
const COMMON_SMOOTHING_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'smooth',
    label: 'Smooth lines',
    type: 'checkbox',
    defaultValue: false,
    propsPanel: true,
    inline: false,
    contextMenu: true,
  },
];

/** Reference lines — horizontal/vertical markers at specific values */
const COMMON_REFERENCE_LINE_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'reference_lines',
    label: 'Reference lines',
    type: 'list',
    defaultValue: [],
    propsPanel: true,
    inline: false,
    contextMenu: false,
    itemFields: [
      { key: 'value', label: 'Value', type: 'number' },
      { key: 'label', label: 'Label', type: 'text', defaultValue: '' },
      { key: 'colour', label: 'Colour', type: 'colour', defaultValue: '#9CA3AF' },
      {
        key: 'line_style',
        label: 'Style',
        type: 'select',
        options: [
          { value: 'solid', label: 'Solid' },
          { value: 'dashed', label: 'Dashed' },
          { value: 'dotted', label: 'Dotted' },
        ],
        defaultValue: 'dashed',
      },
    ],
  },
];

/** Tooltip behaviour */
const COMMON_TOOLTIP_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'show_tooltip',
    label: 'Show tooltips',
    type: 'checkbox',
    defaultValue: true,
    propsPanel: true,
    inline: false,
    contextMenu: false,
  },
  {
    key: 'tooltip_mode',
    label: 'Tooltip trigger',
    type: 'radio',
    options: [
      { value: 'item', label: 'Item (single point)' },
      { value: 'axis', label: 'Axis (all series)' },
    ],
    defaultValue: 'item',
    propsPanel: true,
    inline: false,
    contextMenu: false,
  },
];

/**
 * Font size presets — numeric px values for S/M/L/XL.
 * Custom numeric values (e.g. from drag-to-canvas capture) are also valid.
 */
export const FONT_SIZE_PRESETS = { S: 8, M: 10, L: 13, XL: 16 } as const;
export const FONT_SIZE_DEFAULT = FONT_SIZE_PRESETS.M;

/**
 * Resolve a font_size display value to numeric px.
 * Accepts: number (pass-through), legacy string 'S'/'M'/'L'/'XL', or nullish (→ default).
 */
export function resolveFontSizePx(value: unknown): number {
  if (typeof value === 'number' && value > 0) return value;
  if (typeof value === 'string' && value in FONT_SIZE_PRESETS) {
    return FONT_SIZE_PRESETS[value as keyof typeof FONT_SIZE_PRESETS];
  }
  return FONT_SIZE_DEFAULT;
}

/**
 * Compute a CSS zoom factor from a font_size value.
 * Scales the ENTIRE element proportionally (padding, borders, icons, gaps)
 * rather than only text. Returns 1 at default (M/10px), <1 for S, >1 for L/XL.
 */
export function fontSizeZoom(value: unknown): number {
  return resolveFontSizePx(value) / FONT_SIZE_DEFAULT;
}

/**
 * Shared font size setting — ONE definition used by charts, cards, and tables.
 * Stores numeric px. Radio options map to FONT_SIZE_PRESETS.
 */
export const FONT_SIZE_SETTING: DisplaySettingDef = {
  key: 'font_size',
  label: 'Font size',
  shortLabel: 'Font',
  type: 'radio',
  options: [
    { value: FONT_SIZE_PRESETS.S, label: 'S' },
    { value: FONT_SIZE_PRESETS.M, label: 'M' },
    { value: FONT_SIZE_PRESETS.L, label: 'L' },
    { value: FONT_SIZE_PRESETS.XL, label: 'XL' },
  ],
  defaultValue: FONT_SIZE_DEFAULT,
  propsPanel: true,
  inline: 'brief',
  contextMenu: true,
};

/**
 * Scale-with-canvas toggle. When false, content maintains constant screen size
 * via CSS zoom compensation (zoom: 1/canvasZoom).
 */
export const SCALE_WITH_CANVAS_SETTING: DisplaySettingDef = {
  key: 'scale_with_canvas',
  label: 'Scale with canvas',
  shortLabel: 'Scale',
  type: 'checkbox',
  defaultValue: true,
  propsPanel: true,
  inline: 'brief',
  contextMenu: true,
};

/** Common settings included in every chart kind + cards + table. */
const COMMON_FONT_SIZE_SETTINGS: DisplaySettingDef[] = [FONT_SIZE_SETTING, SCALE_WITH_CANVAS_SETTING];

/**
 * Derive concrete font sizes from a numeric base font_size px (used by charts via ECharts).
 * Accepts numeric px or legacy string 'S'/'M'/'L'/'XL'.
 */
export function chartFontScale(size: number | string | null | undefined): {
  axisTitlePx: number;
  axisLabelPx: number;
  legendPx: number;
  dataLabelPx: number;
  tooltipPx: number;
  markLabelPx: number;
} {
  const base = resolveFontSizePx(size);
  // Scale all roles proportionally from the base.
  // At base=10 (M): axis=8, label=9, legend=9, data=7, tooltip=12, mark=8.
  const scale = base / FONT_SIZE_DEFAULT;
  return {
    axisTitlePx: Math.round(8 * scale),
    axisLabelPx: Math.round(9 * scale),
    legendPx: Math.round(9 * scale),
    dataLabelPx: Math.round(7 * scale),
    tooltipPx: Math.round(12 * scale),
    markLabelPx: Math.round(8 * scale),
  };
}

/** Animation controls */
const COMMON_ANIMATION_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'animate',
    label: 'Animate transitions',
    type: 'checkbox',
    defaultValue: true,
    propsPanel: true,
    inline: false,
    contextMenu: false,
  },
];

/** Missing data handling for line/time-series charts */
const COMMON_MISSING_DATA_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'missing_data',
    label: 'Missing data',
    type: 'radio',
    options: [
      { value: 'connect', label: 'Connect (bridge gaps)' },
      { value: 'break', label: 'Break (show gap)' },
      { value: 'zero', label: 'Treat as zero' },
    ],
    defaultValue: 'break',
    propsPanel: true,
    inline: false,
    contextMenu: false,
  },
];

/** Stacking mode for multi-series bar charts */
const COMMON_STACK_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'stack_mode',
    label: 'Stack mode',
    type: 'radio',
    options: [
      { value: 'grouped', label: 'Grouped (side by side)' },
      { value: 'stacked', label: 'Stacked' },
      { value: 'stacked_100', label: 'Stacked 100%' },
    ],
    defaultValue: 'grouped',
    propsPanel: true,
    inline: 'full',
    contextMenu: true,
  },
];

/** Metric basis for charts that support both proportional and absolute rendering */
const COMMON_METRIC_MODE_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'metric_mode',
    label: 'Metric',
    type: 'radio',
    options: [
      { value: 'proportional', label: 'Proportional' },
      { value: 'absolute', label: 'Absolute' },
    ],
    defaultValue: 'proportional',
    propsPanel: true,
    inline: 'full',
    contextMenu: true,
  },
];

/** Stacking mode for comparison bar charts (default to stacked scenario comparison) */
const COMPARISON_STACK_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'stack_mode',
    label: 'Stack mode',
    type: 'radio',
    options: [
      { value: 'grouped', label: 'Grouped (side by side)' },
      { value: 'stacked', label: 'Stacked' },
      { value: 'stacked_100', label: 'Stacked 100%' },
    ],
    defaultValue: 'stacked',
    propsPanel: true,
    inline: 'full',
    contextMenu: true,
  },
];

/** Point marker controls for line charts */
const COMMON_MARKER_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'show_markers',
    label: 'Show point markers',
    type: 'checkbox',
    defaultValue: null,
    propsPanel: true,
    inline: false,
    contextMenu: true,
    overridable: true,
  },
  {
    key: 'marker_size',
    label: 'Marker size',
    type: 'number-range',
    defaultValue: null,
    propsPanel: true,
    inline: false,
    contextMenu: false,
    overridable: true,
  },
];

/** Area fill under lines */
const COMMON_AREA_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'area_fill',
    label: 'Area fill',
    type: 'checkbox',
    defaultValue: false,
    propsPanel: true,
    inline: false,
    contextMenu: true,
  },
];

/** Cumulative vs absolute toggle for time-series */
const COMMON_CUMULATIVE_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'cumulative',
    label: 'Cumulative values',
    type: 'checkbox',
    defaultValue: false,
    propsPanel: true,
    inline: 'full',
    contextMenu: true,
  },
];

/** Moving average / smoothing window for noisy time-series data */
const COMMON_MOVING_AVERAGE_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'moving_average',
    label: 'Moving average',
    type: 'radio',
    options: [
      { value: 'none', label: 'None (raw)' },
      { value: '3d', label: '3-day' },
      { value: '7d', label: '7-day' },
      { value: '14d', label: '14-day' },
      { value: '30d', label: '30-day' },
    ],
    defaultValue: 'none',
    propsPanel: true,
    inline: 'full',
    contextMenu: true,
  },
  {
    key: 'show_raw_with_average',
    label: 'Show raw data alongside average',
    type: 'checkbox',
    defaultValue: true,
    propsPanel: true,
    inline: false,
    contextMenu: false,
  },
];

/** Bar spacing and width controls */
const COMMON_BAR_SPACING_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'bar_width',
    label: 'Bar width',
    type: 'radio',
    options: [
      { value: 'thin', label: 'Thin' },
      { value: 'medium', label: 'Medium' },
      { value: 'wide', label: 'Wide' },
      { value: 'full', label: 'Full' },
    ],
    defaultValue: 'medium',
    propsPanel: true,
    inline: false,
    contextMenu: false,
  },
  {
    key: 'bar_gap',
    label: 'Gap between bars',
    type: 'radio',
    options: [
      { value: 'none', label: 'None' },
      { value: 'small', label: 'Small' },
      { value: 'medium', label: 'Medium' },
      { value: 'large', label: 'Large' },
    ],
    defaultValue: 'small',
    propsPanel: true,
    inline: false,
    contextMenu: false,
  },
];

/** Label position for bar/funnel charts */
const COMMON_LABEL_POSITION_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'label_position',
    label: 'Label position',
    type: 'radio',
    options: [
      { value: 'inside', label: 'Inside' },
      { value: 'top', label: 'Above' },
      { value: 'outside', label: 'Outside' },
    ],
    defaultValue: 'top',
    propsPanel: true,
    inline: false,
    contextMenu: false,
  },
];

/** Bridge-chart-specific waterfall display settings */
const BRIDGE_SPECIFIC_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'orientation',
    label: 'Orientation',
    type: 'radio',
    options: [
      { value: 'vertical', label: 'Vertical' },
      { value: 'horizontal', label: 'Horizontal' },
    ],
    defaultValue: 'vertical',
    propsPanel: true,
    inline: 'brief',
    contextMenu: true,
  },
  {
    key: 'show_running_total',
    label: 'Running total line',
    type: 'checkbox',
    defaultValue: true,
    propsPanel: true,
    inline: false,
    contextMenu: true,
  },
  {
    key: 'show_connectors',
    label: 'Show waterfall connectors',
    type: 'checkbox',
    defaultValue: true,
    propsPanel: true,
    inline: false,
    contextMenu: false,
  },
];

/** Funnel-chart-specific settings */
const FUNNEL_SPECIFIC_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'metric',
    label: 'Metric',
    type: 'radio',
    options: [
      { value: 'cumulative_probability', label: 'Cumulative' },
      { value: 'step_probability', label: 'Step' },
    ],
    defaultValue: 'cumulative_probability',
    propsPanel: true,
    inline: 'full',
    contextMenu: true,
  },
  {
    key: 'funnel_y_mode',
    label: 'Y axis',
    type: 'radio',
    options: [
      { value: 'rate', label: 'Rate' },
      { value: 'count', label: 'Count (n/k)' },
    ],
    defaultValue: 'rate',
    propsPanel: true,
    inline: 'brief',
    contextMenu: true,
  },
  {
    key: 'funnel_show_hilo',
    label: 'Hi/Lo bands',
    shortLabel: 'Hi/Lo',
    type: 'checkbox',
    defaultValue: true,
    propsPanel: true,
    inline: 'brief',
    contextMenu: true,
  },
  // layout_mode (combined/separate) — hidden until multi-chart layout logic is implemented
  // {
  //   key: 'layout_mode',
  //   ...
  // },
  {
    key: 'funnel_direction',
    label: 'Direction',
    type: 'radio',
    options: [
      { value: 'top_to_bottom', label: 'Top to bottom' },
      { value: 'left_to_right', label: 'Left to right' },
    ],
    defaultValue: 'top_to_bottom',
    propsPanel: true,
    inline: false,
    contextMenu: false,
  },
  {
    key: 'show_dropoff',
    label: 'Show dropoff percentages',
    type: 'checkbox',
    defaultValue: false,
    propsPanel: true,
    inline: false,
    contextMenu: true,
  },
];

/**
 * Per-chart-kind display settings.
 * Grows organically as charting features mature.
 */
export const CHART_DISPLAY_SETTINGS: Record<string, DisplaySettingDef[]> = {
  info: [
    ...COMMON_FONT_SIZE_SETTINGS,
  ],

  bridge: [
    ...COMMON_FONT_SIZE_SETTINGS,
    ...BRIDGE_SPECIFIC_SETTINGS,
    ...COMMON_AXIS_SETTINGS,
    ...COMMON_LEGEND_SETTINGS,
    ...COMMON_LABEL_SETTINGS,
    ...COMMON_LABEL_POSITION_SETTINGS,
    ...COMMON_BAR_SPACING_SETTINGS,
    ...COMMON_SORT_SETTINGS,
    ...COMMON_TOOLTIP_SETTINGS,
    ...COMMON_ANIMATION_SETTINGS,
    ...COMMON_REFERENCE_LINE_SETTINGS,
  ],

  funnel: [
    ...COMMON_FONT_SIZE_SETTINGS,
    ...FUNNEL_SPECIFIC_SETTINGS,
    ...COMMON_AXIS_SETTINGS,
    ...COMMON_LEGEND_SETTINGS,
    ...COMMON_LABEL_SETTINGS,
    ...COMMON_LABEL_POSITION_SETTINGS,
    ...COMMON_CONFIDENCE_SETTINGS,
    ...COMMON_TOOLTIP_SETTINGS,
    ...COMMON_ANIMATION_SETTINGS,
    ...COMMON_REFERENCE_LINE_SETTINGS,
  ],

  histogram: [
    ...COMMON_FONT_SIZE_SETTINGS,
    ...COMMON_AXIS_SETTINGS,
    ...COMMON_LEGEND_SETTINGS,
    ...COMMON_LABEL_SETTINGS,
    ...COMMON_BAR_SPACING_SETTINGS,
    ...COMMON_SCALE_SETTINGS,
    ...COMMON_TOOLTIP_SETTINGS,
    ...COMMON_ANIMATION_SETTINGS,
    ...COMMON_REFERENCE_LINE_SETTINGS,
  ],

  bar_grouped: [
    ...COMMON_FONT_SIZE_SETTINGS,
    ...COMMON_AXIS_SETTINGS,
    ...COMMON_LEGEND_SETTINGS,
    ...COMMON_LABEL_SETTINGS,
    ...COMMON_LABEL_POSITION_SETTINGS,
    ...COMMON_METRIC_MODE_SETTINGS,
    ...COMMON_BAR_SPACING_SETTINGS,
    ...COMPARISON_STACK_SETTINGS,
    ...COMMON_SORT_SETTINGS,
    ...COMMON_TOOLTIP_SETTINGS,
    ...COMMON_ANIMATION_SETTINGS,
    ...COMMON_REFERENCE_LINE_SETTINGS,
  ],

  pie: [
    ...COMMON_FONT_SIZE_SETTINGS,
    ...COMMON_AXIS_SETTINGS,
    ...COMMON_LEGEND_SETTINGS,
    ...COMMON_LABEL_SETTINGS,
    ...COMMON_TOOLTIP_SETTINGS,
    ...COMMON_ANIMATION_SETTINGS,
    ...COMMON_REFERENCE_LINE_SETTINGS,
  ],

  time_series: [
    ...COMMON_FONT_SIZE_SETTINGS,
    ...COMMON_SERIES_TYPE_SETTINGS,
    ...COMMON_AXIS_SETTINGS,
    ...COMMON_LEGEND_SETTINGS,
    ...COMMON_LABEL_SETTINGS,
    ...COMMON_METRIC_MODE_SETTINGS,
    ...COMMON_GROUPING_SETTINGS,
    ...COMMON_MOVING_AVERAGE_SETTINGS,
    ...COMMON_SMOOTHING_SETTINGS,
    ...COMMON_MARKER_SETTINGS,
    ...COMMON_AREA_SETTINGS,
    ...COMMON_STACK_SETTINGS,
    ...COMMON_TOOLTIP_SETTINGS,
    ...COMMON_ANIMATION_SETTINGS,
    ...COMMON_REFERENCE_LINE_SETTINGS,
  ],

  daily_conversions: [
    ...COMMON_FONT_SIZE_SETTINGS,
    ...COMMON_SERIES_TYPE_SETTINGS,
    ...COMMON_AXIS_SETTINGS,
    ...COMMON_LEGEND_SETTINGS,
    ...COMMON_LABEL_SETTINGS,
    ...COMMON_GROUPING_SETTINGS,
    ...COMMON_MOVING_AVERAGE_SETTINGS,
    ...COMMON_CONFIDENCE_SETTINGS,
    ...COMMON_SCALE_SETTINGS,
    ...COMMON_TREND_SETTINGS,
    ...COMMON_SMOOTHING_SETTINGS,
    ...COMMON_MARKER_SETTINGS,
    ...COMMON_AREA_SETTINGS,
    ...COMMON_CUMULATIVE_SETTINGS,
    ...COMMON_MISSING_DATA_SETTINGS,
    ...COMMON_STACK_SETTINGS,
    ...COMMON_TOOLTIP_SETTINGS,
    ...COMMON_ANIMATION_SETTINGS,
    ...COMMON_REFERENCE_LINE_SETTINGS,
    {
      key: 'bayes_band_level',
      label: 'Forecast band',
      shortLabel: 'Band',
      type: 'radio',
      options: [
        { value: 'off', label: 'Off' },
        { value: '80', label: '80%' },
        { value: '90', label: '90%' },
        { value: '95', label: '95%' },
        { value: '99', label: '99%' },
        { value: 'blend', label: 'Blend' },
      ],
      defaultValue: 'blend',
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: false,
    },
    {
      key: 'show_latency_bands',
      label: 'Latency lines',
      shortLabel: 'Lat. lines',
      type: 'checkbox',
      defaultValue: false,
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: true,
    },
    {
      key: 'show_bars',
      label: 'Show bars',
      shortLabel: 'Bars',
      type: 'checkbox',
      defaultValue: true,
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: false,
    },
    {
      key: 'show_rates',
      label: 'Show rates',
      shortLabel: 'Rates',
      type: 'checkbox',
      defaultValue: true,
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: false,
    },
    {
      key: 'smooth_lines',
      label: 'Smooth',
      shortLabel: 'Smooth',
      type: 'checkbox',
      defaultValue: true,
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: false,
    },
    {
      key: 'moving_avg',
      label: 'Moving avg',
      shortLabel: 'MA',
      type: 'radio',
      options: [
        { value: 'off', label: 'Off' },
        { value: 'l3d', label: 'SMA 3d' },
        { value: 'l7d', label: 'SMA 7d' },
        { value: 'ewma3d', label: 'EWMA 3d' },
        { value: 'ewma7d', label: 'EWMA 7d' },
      ],
      defaultValue: 'off',
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: false,
    },
    {
      key: 'aggregate',
      label: 'Aggregate',
      shortLabel: 'Agg.',
      type: 'radio',
      options: [
        { value: 'daily', label: 'Daily' },
        { value: 'weekly', label: 'Weekly' },
        { value: 'monthly', label: 'Monthly' },
      ],
      defaultValue: 'daily',
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: false,
    },
  ],

  // Conversion Rate — doc 49 Part B. Non-latency edges only.
  // Three controls: bin size, show bands, show midpoint.
  conversion_rate: [
    ...COMMON_FONT_SIZE_SETTINGS,
    ...COMMON_AXIS_SETTINGS,
    ...COMMON_LEGEND_SETTINGS,
    ...COMMON_LABEL_SETTINGS,
    ...COMMON_TOOLTIP_SETTINGS,
    ...COMMON_ANIMATION_SETTINGS,
    ...COMMON_REFERENCE_LINE_SETTINGS,
    {
      key: 'bin_size',
      label: 'Bin size',
      shortLabel: 'Bin',
      type: 'radio',
      options: [
        { value: 'day', label: 'Day' },
        { value: 'week', label: 'Week' },
        { value: 'month', label: 'Month' },
      ],
      defaultValue: 'day',
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: true,
    },
    {
      key: 'show_epistemic_bands',
      label: 'Epistemic bands',
      shortLabel: 'Bands',
      type: 'checkbox',
      defaultValue: true,
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: false,
    },
    {
      key: 'show_model_midpoint',
      label: 'Model midpoint',
      shortLabel: 'Midpoint',
      type: 'checkbox',
      defaultValue: true,
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: false,
    },
  ],

  cohort_maturity: [
    ...COMMON_FONT_SIZE_SETTINGS,
    ...COMMON_AXIS_SETTINGS,
    ...COMMON_LEGEND_SETTINGS,
    ...COMMON_LABEL_SETTINGS,
    ...COMMON_GROUPING_SETTINGS,
    ...COMMON_MOVING_AVERAGE_SETTINGS,
    ...COMMON_CONFIDENCE_SETTINGS,
    {
      key: 'show_forecast_shading',
      label: 'Forecast shading',
      shortLabel: 'Shading',
      type: 'checkbox',
      defaultValue: true,
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: false,
    },
    {
      key: 'chart_mode',
      label: 'Chart mode',
      shortLabel: 'Mode',
      type: 'radio',
      options: [
        { value: 'rate', label: 'Rate (%)' },
        { value: 'count', label: 'Count (k)' },
      ],
      defaultValue: 'rate',
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: false,
    },
    {
      key: 'show_model_promoted',
      label: 'Model: promoted',
      shortLabel: 'Best',
      type: 'checkbox',
      defaultValue: false,
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: false,
      group: 'Model',
    },
    {
      key: 'show_model_analytic',
      label: 'Model: analytic (FE)',
      shortLabel: 'FE fit',
      type: 'checkbox',
      defaultValue: false,
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: false,
      group: 'Model',
    },
    {
      key: 'show_model_analytic_be',
      label: 'Model: analytic (BE)',
      shortLabel: 'BE fit',
      type: 'checkbox',
      defaultValue: false,
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: false,
      group: 'Model',
    },
    {
      key: 'show_model_bayesian',
      label: 'Model: Bayesian',
      shortLabel: 'Bayes',
      type: 'checkbox',
      defaultValue: false,
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: false,
      group: 'Model',
    },
    {
      key: 'bayes_band_level',
      label: 'Bayes band',
      shortLabel: 'Band',
      type: 'radio',
      options: [
        { value: 'off', label: 'Off' },
        { value: '80', label: '80%' },
        { value: '90', label: '90%' },
        { value: '95', label: '95%' },
        { value: '99', label: '99%' },
        { value: 'blend', label: 'Blend' },
      ],
      defaultValue: 'blend',
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: false,
    },
    {
      key: 'continuous_forecast',
      label: 'Sampling mode',
      shortLabel: 'Sampling',
      type: 'radio',
      options: [
        { value: 'binomial', label: 'Binomial' },
        { value: 'normal', label: 'Normal' },
        { value: 'none', label: 'None' },
      ],
      defaultValue: 'binomial',
      propsPanel: true,
      inline: false,
      contextMenu: false,
      computeAffecting: true,
    },
    {
      key: 'tau_extent',
      label: 'Age axis extent',
      shortLabel: 'x-axis',
      type: 'radio',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: '7', label: '7d' },
        { value: '14', label: '14d' },
        { value: '30', label: '30d' },
        { value: '60', label: '60d' },
        { value: '90', label: '90d' },
      ],
      defaultValue: 'auto',
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: true,
      group: 'x-axis',
    },
    {
      key: 'rate_extent',
      label: 'Rate axis extent',
      shortLabel: 'y-axis',
      type: 'radio',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: '1', label: '100%' },
      ],
      defaultValue: 'auto',
      propsPanel: true,
      inline: 'brief',
      contextMenu: false,
      computeAffecting: false,
      group: 'y-axis',
    },
    ...COMMON_SMOOTHING_SETTINGS,
    ...COMMON_MARKER_SETTINGS,
    ...COMMON_AREA_SETTINGS,
    ...COMMON_MISSING_DATA_SETTINGS,
    ...COMMON_TOOLTIP_SETTINGS,
    ...COMMON_ANIMATION_SETTINGS,
    ...COMMON_REFERENCE_LINE_SETTINGS,
  ],

  surprise_gauge: [
    ...COMMON_FONT_SIZE_SETTINGS,
    ...COMMON_AXIS_SETTINGS,
    ...COMMON_LABEL_SETTINGS,
    {
      key: 'surprise_scenario_scope',
      label: 'Scenarios',
      shortLabel: 'Scenarios',
      type: 'radio',
      options: [
        { value: 'focused', label: 'Latest' },
        { value: 'all_visible', label: 'Compare' },
      ],
      defaultValue: 'focused',
      propsPanel: true,
      inline: 'brief',
      contextMenu: true,
      computeAffecting: false,
    },
    {
      key: 'surprise_var',
      label: 'Metric',
      shortLabel: 'Metric',
      type: 'radio',
      options: [
        { value: 'p', label: 'Rate' },
        { value: 'completeness', label: 'Completeness' },
        { value: 'all', label: 'Both' },
      ],
      defaultValue: 'p',
      propsPanel: true,
      inline: 'brief',
      contextMenu: true,
      computeAffecting: false,
    },
    {
      key: 'surprise_colour_scheme',
      label: 'Colour scheme',
      shortLabel: 'Colours',
      type: 'radio',
      options: [
        { value: 'symmetric', label: 'R-A-G-A-R' },
        { value: 'directional_positive', label: 'R-A-G' },
        { value: 'directional_negative', label: 'G-A-R' },
      ],
      defaultValue: 'symmetric',
      propsPanel: true,
      inline: 'brief',
      contextMenu: true,
      computeAffecting: false,
    },
    ...COMMON_LEGEND_SETTINGS,
    ...COMMON_TOOLTIP_SETTINGS,
    ...COMMON_ANIMATION_SETTINGS,
    ...COMMON_REFERENCE_LINE_SETTINGS,
  ],
};

/**
 * Cross-chart-kind settings that apply when view_mode === 'cards'.
 */
export const CARDS_DISPLAY_SETTINGS: DisplaySettingDef[] = [
  FONT_SIZE_SETTING,
  SCALE_WITH_CANVAS_SETTING,
  {
    key: 'cards_collapsed',
    label: 'Collapsed cards',
    type: 'list',
    defaultValue: [],
    propsPanel: false,
    inline: false,
    contextMenu: false,
  },
];

/**
 * Cross-chart-kind settings that apply when view_mode === 'table'.
 */
export const TABLE_DISPLAY_SETTINGS: DisplaySettingDef[] = [
  FONT_SIZE_SETTING,
  SCALE_WITH_CANVAS_SETTING,
  {
    key: 'table_striped',
    label: 'Striped',
    shortLabel: 'Striped',
    type: 'checkbox',
    defaultValue: true,
    propsPanel: true,
    inline: 'brief',
    contextMenu: true,
  },
  {
    key: 'table_sort_column',
    label: 'Sort column',
    type: 'text',
    defaultValue: '',
    propsPanel: false,
    inline: false,
    contextMenu: false,
  },
  {
    key: 'table_sort_direction',
    label: 'Sort direction',
    type: 'radio',
    options: [
      { value: 'asc', label: 'Ascending' },
      { value: 'desc', label: 'Descending' },
    ],
    defaultValue: 'asc',
    propsPanel: false,
    inline: false,
    contextMenu: false,
  },
  // Column management — persisted but not shown in props panel or inline toolbar.
  // Managed directly via the table's column header context menu.
  {
    key: 'table_hidden_columns',
    label: 'Hidden columns',
    type: 'list',
    defaultValue: [],
    propsPanel: false,
    inline: false,
    contextMenu: false,
  },
  {
    key: 'table_column_order',
    label: 'Column order',
    type: 'list',
    defaultValue: [],
    propsPanel: false,
    inline: false,
    contextMenu: false,
  },
  {
    key: 'table_column_widths',
    label: 'Column widths',
    type: 'text',
    defaultValue: '',
    propsPanel: false,
    inline: false,
    contextMenu: false,
  },
];

/**
 * Get display settings for a given chart kind (or cards/table mode).
 */
export function getDisplaySettings(chartKind: string | undefined, viewMode: ViewMode): DisplaySettingDef[] {
  if (viewMode === 'cards') return CARDS_DISPLAY_SETTINGS;
  if (viewMode === 'table') return TABLE_DISPLAY_SETTINGS;
  if (!chartKind) return [];
  return CHART_DISPLAY_SETTINGS[chartKind] || [];
}

/**
 * Get display settings filtered by surface.
 *
 * For the 'inline' surface, an optional `context` narrows the result:
 *   - 'tab'    -> all inline settings (full + brief)
 *   - 'canvas' -> only brief inline settings
 *   - omitted  -> all inline settings (backward compatible)
 */
export function getDisplaySettingsForSurface(
  chartKind: string | undefined,
  viewMode: ViewMode,
  surface: 'propsPanel' | 'inline' | 'contextMenu',
  context?: 'canvas' | 'tab',
): DisplaySettingDef[] {
  const all = getDisplaySettings(chartKind, viewMode);
  if (surface === 'inline') {
    if (context === 'canvas') return all.filter(s => s.inline === 'brief');
    return all.filter(s => s.inline !== false);
  }
  return all.filter(s => s[surface]);
}

/**
 * Resolve the effective value of a display setting from the display object.
 */
export function resolveDisplaySetting(display: Record<string, unknown> | undefined, setting: DisplaySettingDef): any {
  if (display && setting.key in display) return display[setting.key];
  return setting.defaultValue;
}

/**
 * Extract the compute-affecting display settings for a given chart kind,
 * resolved against the current display object (falling back to defaults).
 * Returns a plain object suitable for inclusion in deps signatures and
 * backend request payloads.
 */
export function resolveComputeAffectingDisplay(
  chartKind: string | undefined,
  display: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const allSettings = chartKind ? (CHART_DISPLAY_SETTINGS as Record<string, DisplaySettingDef[]>)[chartKind] : undefined;
  if (!allSettings) return undefined;
  const caSettings = allSettings.filter(s => s.computeAffecting);
  if (caSettings.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const s of caSettings) {
    out[s.key] = resolveDisplaySetting(display, s);
  }
  return out;
}

/**
 * Context menu item shape for registry-driven display settings.
 * Matches ContextMenuItem from ContextMenu.tsx but defined here to avoid circular imports.
 */
export interface ContextMenuSettingItem {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  checked?: boolean;
  submenu?: ContextMenuSettingItem[];
}

/**
 * Context menu option icon builders — keyed by setting key → option value.
 * Returns a React node (e.g. gradient swatch) shown before the option label.
 */
const CONTEXT_MENU_OPTION_ICONS: Record<string, Record<string | number, () => React.ReactNode>> = {
  surprise_colour_scheme: {
    symmetric: () => React.createElement('span', { className: 'colour-scheme-swatch colour-scheme-swatch--symmetric' }),
    directional_positive: () => React.createElement('span', { className: 'colour-scheme-swatch colour-scheme-swatch--directional-positive' }),
    directional_negative: () => React.createElement('span', { className: 'colour-scheme-swatch colour-scheme-swatch--directional-negative' }),
  },
};

/**
 * Build context menu items from display settings marked contextMenu: true.
 * Used by CanvasAnalysisContextMenu to render the Display submenu.
 *
 * - checkbox: flat item, checked when active, toggle on click
 * - radio/select: parent with submenu, each option checked when selected
 */
export function buildContextMenuSettingItems(
  chartKind: string | undefined,
  viewMode: ViewMode,
  display: Record<string, unknown> | undefined,
  onChange: (key: string, value: any) => void,
): ContextMenuSettingItem[] {
  const settings = getDisplaySettingsForSurface(chartKind, viewMode, 'contextMenu');
  if (settings.length === 0) return [];

  const result: ContextMenuSettingItem[] = [];
  for (const setting of settings) {
    const value = resolveDisplaySetting(display, setting);

    if (setting.type === 'checkbox') {
      const isOn = !!value;
      result.push({
        label: setting.label,
        checked: isOn,
        onClick: () => onChange(setting.key, !isOn),
      });
    } else if ((setting.type === 'radio' || setting.type === 'select') && setting.options) {
      const iconBuilders = CONTEXT_MENU_OPTION_ICONS[setting.key];
      const submenu = setting.options.map((opt) => ({
        label: opt.label,
        checked: value == opt.value,
        onClick: () => onChange(setting.key, opt.value),
        ...(iconBuilders?.[opt.value] ? { icon: iconBuilders[opt.value]() } : {}),
      }));
      result.push({ label: setting.label, onClick: () => {}, submenu });
    }
  }
  return result;
}
