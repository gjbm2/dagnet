/**
 * settingPillRenderer — shared toolbar pill rendering for display settings.
 *
 * ONE code path for rendering inline display setting controls (radio pills,
 * checkboxes) used by both AnalysisChartContainer and ExpressionToolbarTray.
 */

import React from 'react';
import {
  TrendingUp, Sigma,
  BarChart3, LineChart, Percent, Hash,
  ArrowUpDown, ArrowLeftRight,
  ArrowUp, ArrowDown, ArrowLeft, ArrowRight,
  Scaling,
} from 'lucide-react';
import type { DisplaySettingDef } from '../../lib/analysisDisplaySettingsRegistry';
import { resolveDisplaySetting } from '../../lib/analysisDisplaySettingsRegistry';

/**
 * onChange signature: supports single-key `(key, val)` and batch `({ key1: val1, key2: val2 })`.
 * Batch mode is used by the merged legend control to atomically set both show_legend and legend_position.
 */
export type SettingChangeHandler = (keyOrBatch: string | Record<string, any>, val?: any) => void;

const CHECKBOX_ICONS: Record<string, React.ComponentType<{ size?: number | string }>> = {
  show_trend_line: TrendingUp,
  cumulative: Sigma,
  scale_with_canvas: Scaling,
};

const OPTION_ICONS: Record<string, Record<string | number, React.ComponentType<{ size?: number | string }>>> = {
  series_type: { bar: BarChart3, line: LineChart },
  metric_mode: { proportional: Percent, absolute: Hash },
  orientation: { vertical: ArrowUpDown, horizontal: ArrowLeftRight },
  legend_position: { top: ArrowUp, bottom: ArrowDown, left: ArrowLeft, right: ArrowRight },
};

/** Inline gradient swatch for colour scheme radio pills. */
function ColourSchemeSwatch({ variant }: { variant: string }) {
  return <span className={`colour-scheme-swatch colour-scheme-swatch--${variant}`} />;
}

const OPTION_CUSTOM_RENDERERS: Record<string, Record<string | number, () => React.ReactNode>> = {
  surprise_colour_scheme: {
    symmetric: () => <ColourSchemeSwatch variant="symmetric" />,
    directional_positive: () => <ColourSchemeSwatch variant="directional-positive" />,
    directional_negative: () => <ColourSchemeSwatch variant="directional-negative" />,
  },
};

const OPTION_SHORT_LABELS: Record<string, Record<string | number, string>> = {
  time_grouping: { day: 'D', week: 'W', month: 'M' },
  stack_mode: { grouped: 'Grp', stacked: 'Stk', stacked_100: '100%' },
  funnel_metric: { cumulative_probability: 'Cum', step_probability: 'Step' },
  metric: { cumulative_probability: 'Cum', step_probability: 'Step' },
};

function renderTrayCheckbox(
  setting: DisplaySettingDef,
  value: any,
  onChange: SettingChangeHandler,
) {
  const Icon = CHECKBOX_ICONS[setting.key];
  return (
    <button
      key={setting.key}
      type="button"
      className={`cfp-pill${value ? ' active' : ''}`}
      onClick={() => onChange(setting.key, !value)}
      title={setting.label}
    >
      {Icon ? <Icon size={13} /> : (setting.shortLabel || setting.label)}
    </button>
  );
}

function renderTrayRadio(
  setting: DisplaySettingDef,
  value: any,
  onChange: SettingChangeHandler,
) {
  if (!setting.options) return null;
  const icons = OPTION_ICONS[setting.key];
  const shorts = OPTION_SHORT_LABELS[setting.key];

  // For select-style (dropdown) rendering
  if (setting.type === 'select') {
    return (
      <select
        key={setting.key}
        value={value ?? ''}
        onChange={e => onChange(setting.key, e.target.value)}
        className="cfp-select"
        title={setting.label}
      >
        {setting.options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    );
  }

  const groupLabel = setting.shortLabel || setting.label;
  return (
    <span key={setting.key} className="cfp-pill-group" title={setting.label}>
      <span className="cfp-group-label">{groupLabel}</span>
      {setting.options.map(opt => {
        const Icon = icons?.[opt.value];
        const short = shorts?.[opt.value];
        const customRenderer = OPTION_CUSTOM_RENDERERS[setting.key]?.[opt.value];
        // Use loose equality for value comparison to handle string/number coercion
        // (e.g. font_size stored as "10" vs option value 10)
        const isActive = value == opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            className={`cfp-pill${isActive ? ' active' : ''}`}
            onClick={() => onChange(setting.key, opt.value)}
            title={`${setting.label}: ${opt.label}`}
          >
            {customRenderer ? customRenderer() : Icon ? <Icon size={13} /> : (short || opt.label)}
          </button>
        );
      })}
    </span>
  );
}

/** Render a single setting (checkbox or radio group). */
export function renderTraySetting(
  setting: DisplaySettingDef,
  display: Record<string, unknown> | undefined,
  onChange: SettingChangeHandler,
) {
  const value = resolveDisplaySetting(display, setting);
  if (setting.type === 'checkbox') return renderTrayCheckbox(setting, value, onChange);
  if (setting.type === 'radio' || setting.type === 'select') return renderTrayRadio(setting, value, onChange);
  return null;
}

/** Render a single element for each setting inside a group wrapper (no nested group chrome). */
export function renderTraySettingBare(
  setting: DisplaySettingDef,
  display: Record<string, unknown> | undefined,
  onChange: SettingChangeHandler,
) {
  const value = resolveDisplaySetting(display, setting);
  if (setting.type === 'checkbox') return renderTrayCheckbox(setting, value, onChange);
  if (setting.type === 'radio') {
    if (!setting.options) return null;
    const icons = OPTION_ICONS[setting.key];
    const shorts = OPTION_SHORT_LABELS[setting.key];
    return setting.options.map(opt => {
      const Icon = icons?.[opt.value];
      const short = shorts?.[opt.value];
      const customRenderer = OPTION_CUSTOM_RENDERERS[setting.key]?.[opt.value];
      const isActive = value == opt.value;
      return (
        <button
          key={opt.value}
          type="button"
          className={`cfp-pill${isActive ? ' active' : ''}`}
          onClick={() => onChange(setting.key, opt.value)}
          title={`${setting.label}: ${opt.label}`}
        >
          {customRenderer ? customRenderer() : Icon ? <Icon size={13} /> : (short || opt.label)}
        </button>
      );
    });
  }
  return null;
}

/**
 * Legend group: merged toggle+position control.
 * Clicking active position toggles legend off. Clicking any position turns it on.
 */
function renderLegendGroup(
  groupSettings: DisplaySettingDef[],
  display: Record<string, unknown> | undefined,
  onChange: SettingChangeHandler,
): React.ReactNode {
  const toggleSetting = groupSettings.find(s => s.key === 'show_legend');
  const posSetting = groupSettings.find(s => s.key === 'legend_position');
  if (!posSetting?.options) {
    // Fallback: render normally
    return groupSettings.map(gs => renderTraySettingBare(gs, display, onChange));
  }
  const isOn = toggleSetting ? !!resolveDisplaySetting(display, toggleSetting) : true;
  const pos = resolveDisplaySetting(display, posSetting);
  const icons = OPTION_ICONS[posSetting.key];

  return (
    <span key="grp-legend" className="cfp-pill-group" title="Legend">
      <span className="cfp-group-label">Legend</span>
      {posSetting.options.map(opt => {
        const Icon = icons?.[opt.value];
        const isActive = isOn && pos == opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            className={`cfp-pill${isActive ? ' active' : ''}`}
            onClick={() => {
              if (isActive) {
                // Toggle off
                onChange('show_legend', false);
              } else {
                // Turn on + set position — batch to avoid second call overwriting first
                onChange({ show_legend: true, legend_position: opt.value });
              }
            }}
            title={isActive ? 'Hide legend' : `Legend: ${opt.label}`}
          >
            {Icon ? <Icon size={13} /> : opt.label}
          </button>
        );
      })}
    </span>
  );
}

/**
 * Render toolbar settings, merging adjacent settings that share a `group` key
 * into a single `cfp-pill-group` wrapper.
 */
export function renderTraySettings(
  settings: DisplaySettingDef[],
  display: Record<string, unknown> | undefined,
  onChange: SettingChangeHandler,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < settings.length) {
    const s = settings[i];
    if (s.group) {
      const groupSettings: DisplaySettingDef[] = [s];
      while (i + 1 < settings.length && settings[i + 1].group === s.group) {
        groupSettings.push(settings[++i]);
      }
      // Legend group: special merged toggle+position control
      if (s.group === 'legend') {
        out.push(renderLegendGroup(groupSettings, display, onChange));
      } else if (groupSettings.length === 1) {
        out.push(renderTraySetting(s, display, onChange));
      } else {
        const labelSetting = groupSettings.find(g => g.shortLabel) || groupSettings.find(g => g.type === 'radio');
        const groupLabel = labelSetting?.shortLabel || labelSetting?.label || s.group;
        out.push(
          <span key={`grp-${s.group}`} className="cfp-pill-group" title={groupLabel}>
            <span className="cfp-group-label">{groupLabel}</span>
            {groupSettings.map(gs => renderTraySettingBare(gs, display, onChange))}
          </span>,
        );
      }
    } else {
      out.push(renderTraySetting(s, display, onChange));
    }
    i++;
  }
  return out;
}
