/**
 * ChartSettingsSection -- shared chart settings component.
 *
 * Renders title, view mode, chart kind (auto/pinned), and registry-driven
 * display settings. Reused across:
 *   - Canvas analysis properties panel
 *   - Analytics panel (rolled-up, below analysis type)
 *   - Chart tab settings modal (future)
 */

import React, { useMemo, useState, useEffect } from 'react';
import { ZapOff, Settings } from 'lucide-react';
import CollapsibleSection from '../CollapsibleSection';
import { AutomatableField } from '../AutomatableField';
import { getDisplaySettingsForSurface } from '../../lib/analysisDisplaySettingsRegistry';
import type { DisplaySettingDef } from '../../lib/analysisDisplaySettingsRegistry';

const CHART_KIND_LABELS: Record<string, string> = {
  funnel: 'Funnel',
  bridge: 'Bridge',
  histogram: 'Lag Histogram',
  daily_conversions: 'Daily Conversions',
  cohort_maturity: 'Cohort Maturity',
  bar_grouped: 'Comparison',
  pie: 'Pie',
  time_series: 'Time Series',
};

/**
 * Visual grouping for display settings.
 * Keys that share a group prefix are rendered under a shared heading.
 */
const SETTING_GROUP: Record<string, string> = {
  metric: 'Chart-specific',
  metric_mode: 'Chart-specific',
  funnel_direction: 'Chart-specific',
  show_dropoff: 'Chart-specific',
  orientation: 'Chart-specific',
  show_running_total: 'Chart-specific',
  show_connectors: 'Chart-specific',
  series_type: 'Chart-specific',
  cumulative: 'Chart-specific',
  stack_mode: 'Chart-specific',
  time_grouping: 'Chart-specific',
  moving_average: 'Chart-specific',
  show_raw_with_average: 'Chart-specific',
  smooth: 'Chart-specific',
  missing_data: 'Chart-specific',
  y_axis_min: 'Axes',
  y_axis_max: 'Axes',
  x_axis_min: 'Axes',
  x_axis_max: 'Axes',
  y_axis_title: 'Axes',
  y_axis_scale: 'Axes',
  axis_label_rotation: 'Axes',
  axis_label_format: 'Axes',
  show_grid_lines: 'Grid',
  grid_line_style: 'Grid',
  show_legend: 'Legend',
  legend_position: 'Legend',
  show_labels: 'Labels',
  label_font_size: 'Labels',
  label_position: 'Labels',
  show_markers: 'Points & area',
  marker_size: 'Points & area',
  area_fill: 'Points & area',
  show_trend_line: 'Points & area',
  bar_width: 'Bar spacing',
  bar_gap: 'Bar spacing',
  sort_by: 'Sorting',
  sort_direction: 'Sorting',
  show_tooltip: 'Tooltips',
  tooltip_mode: 'Tooltips',
  animate: 'Animation',
  reference_lines: 'Reference lines',
};

interface ChartSettingsSectionProps {
  title?: string;
  onTitleChange?: (title: string) => void;
  viewMode: 'chart' | 'cards';
  onViewModeChange: (mode: 'chart' | 'cards') => void;
  chartKind?: string;
  effectiveChartKind?: string;
  onChartKindChange: (kind: string | undefined) => void;
  chartKindOptions: string[];
  display?: Record<string, unknown>;
  onDisplayChange: (key: string, value: any) => void;
  onClearAllOverrides?: () => void;
  defaultOpen?: boolean;
}

function renderSettingControl(
  setting: DisplaySettingDef,
  currentValue: any,
  onDisplayChange: (key: string, value: any) => void,
) {
  if (setting.type === 'checkbox') {
    return (
      <label className="chart-settings-checkbox">
        <input
          type="checkbox"
          checked={!!currentValue}
          onChange={(e) => onDisplayChange(setting.key, e.target.checked)}
        />
        <span>{setting.label}</span>
      </label>
    );
  }
  if (setting.type === 'radio' && setting.options) {
    return (
      <div className="chart-settings-chips">
        {setting.options.map((opt: any) => (
          <button
            key={opt.value}
            type="button"
            className={`chart-settings-chip${currentValue === opt.value ? ' active' : ''}`}
            onClick={() => onDisplayChange(setting.key, opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    );
  }
  if (setting.type === 'number-range') {
    return (
      <input
        className="property-input"
        type="number"
        value={currentValue ?? ''}
        placeholder="Auto"
        style={{ fontSize: 11, width: 80 }}
        onChange={(e) => onDisplayChange(setting.key, e.target.value === '' ? null : Number(e.target.value))}
      />
    );
  }
  if (setting.type === 'text') {
    return (
      <input
        className="property-input"
        type="text"
        value={currentValue ?? ''}
        placeholder="Auto"
        style={{ fontSize: 11 }}
        onChange={(e) => onDisplayChange(setting.key, e.target.value || null)}
      />
    );
  }
  return null;
}

export function ChartSettingsSection({
  title,
  onTitleChange,
  viewMode,
  onViewModeChange,
  chartKind,
  effectiveChartKind,
  onChartKindChange,
  chartKindOptions,
  display,
  onDisplayChange,
  onClearAllOverrides,
  defaultOpen = true,
}: ChartSettingsSectionProps) {
  const settingsKind = effectiveChartKind || chartKind;
  const displaySettings = useMemo(() => {
    return getDisplaySettingsForSurface(settingsKind, viewMode, 'propsPanel');
  }, [settingsKind, viewMode]);

  const overrideCount = useMemo(() => {
    return displaySettings.filter((s: any) => s.overridable && display?.[s.key] != null).length;
  }, [displaySettings, display]);

  const groupedSettings = useMemo(() => {
    const groups: Array<{ label: string; settings: DisplaySettingDef[] }> = [];
    let currentGroup: { label: string; settings: DisplaySettingDef[] } | null = null;

    for (const s of displaySettings) {
      const groupLabel = SETTING_GROUP[s.key] || 'Other';
      if (!currentGroup || currentGroup.label !== groupLabel) {
        currentGroup = { label: groupLabel, settings: [] };
        groups.push(currentGroup);
      }
      currentGroup.settings.push(s);
    }
    return groups;
  }, [displaySettings]);

  // Local state for title -- commit to graph only on blur to avoid re-render focus loss
  const [localTitle, setLocalTitle] = useState(title || '');
  useEffect(() => { setLocalTitle(title || ''); }, [title]);

  const sectionTitle = useMemo(() => {
    if (overrideCount === 0 || !onClearAllOverrides) return 'Chart Settings';
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        Chart Settings
        <button
          type="button"
          className="chart-settings-header-clear"
          onClick={(e) => { e.stopPropagation(); onClearAllOverrides(); }}
          title={`Clear ${overrideCount} override${overrideCount > 1 ? 's' : ''}`}
        >
          <ZapOff size={10} />
          <span>{overrideCount}</span>
        </button>
      </span>
    );
  }, [overrideCount, onClearAllOverrides]);

  return (
    <CollapsibleSection
      title={sectionTitle}
      defaultOpen={defaultOpen}
      icon={Settings}
    >
      <div className="chart-settings-body">
        {/* Title */}
        {onTitleChange && (
          <div className="chart-settings-row">
            <label className="chart-settings-label">Title</label>
            <input
              className="property-input"
              type="text"
              value={localTitle}
              placeholder="Chart title"
              onChange={(e) => setLocalTitle(e.target.value)}
              onBlur={() => { if (localTitle !== (title || '')) onTitleChange(localTitle); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
          </div>
        )}

        {/* View Mode */}
        <div className="chart-settings-row">
          <label className="chart-settings-label">View</label>
          <div className="chart-settings-chips" style={{ flex: 1 }}>
            {(['chart', 'cards'] as const).map(mode => (
              <button
                key={mode}
                className="chart-settings-toggle-btn"
                onClick={() => onViewModeChange(mode)}
                style={{
                  flex: 1, border: '1px solid',
                  borderColor: viewMode === mode ? 'var(--accent-primary)' : 'var(--border-primary)',
                  background: viewMode === mode ? 'var(--accent-primary)' : 'transparent',
                  color: viewMode === mode ? 'var(--text-inverse)' : 'inherit',
                  textTransform: 'capitalize',
                }}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        {/* Chart Kind */}
        {viewMode === 'chart' && (
          <div className="chart-settings-row">
            <AutomatableField
              label="Chart kind"
              value={chartKind || 'auto'}
              overridden={!!chartKind}
              onClearOverride={() => onChartKindChange(undefined)}
            >
              {chartKindOptions.length > 0 ? (
                <div className="chart-settings-chips">
                  <button
                    type="button"
                    className={`chart-settings-chip${!chartKind ? ' active' : ''}`}
                    onClick={() => onChartKindChange(undefined)}
                    style={{ fontStyle: 'italic' }}
                  >
                    Auto
                  </button>
                  {chartKindOptions.map(kind => (
                    <button
                      key={kind}
                      type="button"
                      className={`chart-settings-chip${kind === chartKind ? ' active' : ''}`}
                      onClick={() => onChartKindChange(kind)}
                    >
                      {CHART_KIND_LABELS[kind] || kind}
                    </button>
                  ))}
                </div>
              ) : (
                <select
                  className="property-input"
                  style={{ fontSize: 12 }}
                  value={chartKind || ''}
                  onChange={(e) => onChartKindChange(e.target.value || undefined)}
                >
                  <option value="">Auto</option>
                  {Object.entries(CHART_KIND_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              )}
            </AutomatableField>
          </div>
        )}

        {/* Display Settings — grouped */}
        {groupedSettings.length > 0 && (
          <>
            {groupedSettings.map((group, gi) => (
              <div key={`${group.label}-${gi}`} className="chart-settings-group">
                <div className="chart-settings-group-label">{group.label}</div>
                {group.settings.map((setting) => {
                  const rawValue = display?.[setting.key];
                  const currentValue = rawValue ?? setting.defaultValue;
                  const isOverridden = rawValue != null;

                  const control = renderSettingControl(setting, currentValue, onDisplayChange);
                  if (!control) return null;

                  const isCheckbox = setting.type === 'checkbox';

                  return (
                    <div key={setting.key} className="chart-settings-row">
                      {!isCheckbox && <label className="chart-settings-label">{setting.label}</label>}
                      <AutomatableField
                        label={setting.label}
                        value={currentValue}
                        overridden={isOverridden}
                        onClearOverride={() => onDisplayChange(setting.key, null)}
                      >
                        {control}
                      </AutomatableField>
                    </div>
                  );
                })}
              </div>
            ))}
          </>
        )}
      </div>
    </CollapsibleSection>
  );
}
