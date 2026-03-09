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
  value: string;
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
  },
  {
    key: 'legend_position',
    label: 'Legend position',
    type: 'radio',
    options: [
      { value: 'top', label: 'Top' },
      { value: 'bottom', label: 'Bottom' },
      { value: 'right', label: 'Right' },
      { value: 'none', label: 'None' },
    ],
    defaultValue: 'top',
    propsPanel: true,
    inline: false,
    contextMenu: false,
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
  bridge: [
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
    ...COMMON_AXIS_SETTINGS,
    ...COMMON_LEGEND_SETTINGS,
    ...COMMON_LABEL_SETTINGS,
    ...COMMON_BAR_SPACING_SETTINGS,
    ...COMMON_SCALE_SETTINGS,
    ...COMMON_TOOLTIP_SETTINGS,
    ...COMMON_ANIMATION_SETTINGS,
    ...COMMON_REFERENCE_LINE_SETTINGS,
  ],

  daily_conversions: [
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
  ],

  cohort_maturity: [
    ...COMMON_AXIS_SETTINGS,
    ...COMMON_LEGEND_SETTINGS,
    ...COMMON_LABEL_SETTINGS,
    ...COMMON_GROUPING_SETTINGS,
    ...COMMON_MOVING_AVERAGE_SETTINGS,
    ...COMMON_CONFIDENCE_SETTINGS,
    ...COMMON_SMOOTHING_SETTINGS,
    ...COMMON_MARKER_SETTINGS,
    ...COMMON_AREA_SETTINGS,
    ...COMMON_MISSING_DATA_SETTINGS,
    ...COMMON_TOOLTIP_SETTINGS,
    ...COMMON_ANIMATION_SETTINGS,
    ...COMMON_REFERENCE_LINE_SETTINGS,
  ],
};

/**
 * Cross-chart-kind settings that apply when view_mode === 'cards'.
 */
export const CARDS_DISPLAY_SETTINGS: DisplaySettingDef[] = [
  {
    key: 'cards_font_size',
    label: 'Font size',
    type: 'radio',
    options: [
      { value: 'S', label: 'S' },
      { value: 'M', label: 'M' },
      { value: 'L', label: 'L' },
      { value: 'XL', label: 'XL' },
    ],
    defaultValue: 'M',
    propsPanel: true,
    inline: false,
    contextMenu: true,
  },
];

/**
 * Get display settings for a given chart kind (or cards mode).
 */
export function getDisplaySettings(chartKind: string | undefined, viewMode: 'chart' | 'cards'): DisplaySettingDef[] {
  if (viewMode === 'cards') return CARDS_DISPLAY_SETTINGS;
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
  viewMode: 'chart' | 'cards',
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
