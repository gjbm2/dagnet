/**
 * ChartSettingsSection -- shared chart settings component.
 *
 * Renders title, view mode, chart kind (auto/pinned), and registry-driven
 * display settings. Reused across:
 *   - Canvas analysis properties panel
 *   - Analytics panel (rolled-up, below analysis type)
 *   - Chart tab settings modal (future)
 */

import React, { useMemo } from 'react';
import { ZapOff, Settings } from 'lucide-react';
import CollapsibleSection from '../CollapsibleSection';
import { AutomatableField } from '../AutomatableField';
import { getDisplaySettingsForSurface, resolveDisplaySetting } from '../../lib/analysisDisplaySettingsRegistry';

const CHART_KIND_LABELS: Record<string, string> = {
  funnel: 'Funnel',
  bridge: 'Bridge',
  bridge_horizontal: 'Bridge (Horizontal)',
  histogram: 'Lag Histogram',
  daily_conversions: 'Daily Conversions',
  cohort_maturity: 'Cohort Maturity',
};

interface ChartSettingsSectionProps {
  title?: string;
  onTitleChange?: (title: string) => void;
  viewMode: 'chart' | 'cards';
  onViewModeChange: (mode: 'chart' | 'cards') => void;
  chartKind?: string;
  onChartKindChange: (kind: string | undefined) => void;
  chartKindOptions: string[];
  display?: Record<string, unknown>;
  onDisplayChange: (key: string, value: any) => void;
  onClearAllOverrides?: () => void;
  defaultOpen?: boolean;
}

export function ChartSettingsSection({
  title,
  onTitleChange,
  viewMode,
  onViewModeChange,
  chartKind,
  onChartKindChange,
  chartKindOptions,
  display,
  onDisplayChange,
  onClearAllOverrides,
  defaultOpen = true,
}: ChartSettingsSectionProps) {
  const displaySettings = useMemo(() => {
    return getDisplaySettingsForSurface(chartKind, viewMode, 'propsPanel');
  }, [chartKind, viewMode]);

  const overrideCount = useMemo(() => {
    return displaySettings.filter((s: any) => s.overridable && display?.[s.key] != null).length;
  }, [displaySettings, display]);

  return (
    <CollapsibleSection
      title={`Chart Settings${overrideCount > 0 ? ` (${overrideCount} override${overrideCount > 1 ? 's' : ''})` : ''}`}
      defaultOpen={defaultOpen}
      icon={Settings}
    >
      <div className="property-group">
        {/* Title */}
        {onTitleChange && (
          <div className="property-row">
            <label className="property-label">Title</label>
            <input
              className="property-input"
              type="text"
              value={title || ''}
              placeholder="Chart title"
              onChange={(e) => onTitleChange(e.target.value)}
            />
          </div>
        )}

        {/* View Mode */}
        <div className="property-row" style={{ marginTop: onTitleChange ? 8 : 0 }}>
          <label className="property-label">View</label>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['chart', 'cards'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => onViewModeChange(mode)}
                style={{
                  flex: 1, padding: '4px 8px', fontSize: 11, border: '1px solid',
                  borderColor: viewMode === mode ? 'var(--accent-colour, #3b82f6)' : '#d1d5db',
                  background: viewMode === mode ? 'var(--accent-colour, #3b82f6)' : 'transparent',
                  color: viewMode === mode ? '#fff' : 'inherit',
                  borderRadius: 4, cursor: 'pointer', textTransform: 'capitalize',
                }}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        {/* Chart Kind */}
        {viewMode === 'chart' && (
          <div style={{ marginTop: 8 }}>
            <AutomatableField
              label="Chart kind"
              value={chartKind || 'auto'}
              overridden={!!chartKind}
              onClearOverride={() => onChartKindChange(undefined)}
            >
              {chartKindOptions.length > 0 ? (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button
                    type="button"
                    onClick={() => onChartKindChange(undefined)}
                    style={{
                      border: '1px solid',
                      borderColor: !chartKind ? '#3b82f6' : '#e5e7eb',
                      background: !chartKind ? '#eff6ff' : '#ffffff',
                      color: !chartKind ? '#1d4ed8' : '#374151',
                      borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: 'pointer', fontStyle: 'italic',
                    }}
                  >
                    Auto
                  </button>
                  {chartKindOptions.map(kind => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => onChartKindChange(kind)}
                      style={{
                        border: '1px solid',
                        borderColor: kind === chartKind ? '#3b82f6' : '#e5e7eb',
                        background: kind === chartKind ? '#eff6ff' : '#ffffff',
                        color: kind === chartKind ? '#1d4ed8' : '#374151',
                        borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
                      }}
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

        {/* Display Settings */}
        {displaySettings.length > 0 && (
          <>
            {overrideCount > 0 && onClearAllOverrides && (
              <button
                type="button"
                onClick={onClearAllOverrides}
                style={{ fontSize: 10, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: 8, marginBottom: 4, textDecoration: 'underline' }}
              >
                <ZapOff size={10} style={{ marginRight: 3, verticalAlign: 'middle' }} />
                Clear {overrideCount} override{overrideCount > 1 ? 's' : ''}
              </button>
            )}
            {displaySettings.map((setting: any) => {
              const rawValue = display?.[setting.key];
              const currentValue = rawValue ?? setting.defaultValue;
              const isOverridden = setting.overridable && rawValue != null;

              const renderControl = () => {
                if (setting.type === 'checkbox') {
                  return (
                    <label className="property-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={!!currentValue}
                        onChange={(e) => onDisplayChange(setting.key, e.target.checked)}
                      />
                      {setting.label}
                    </label>
                  );
                }
                if (setting.type === 'radio' && setting.options) {
                  return (
                    <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                      {setting.options.map((opt: any) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => onDisplayChange(setting.key, opt.value)}
                          style={{
                            border: '1px solid',
                            borderColor: currentValue === opt.value ? '#3b82f6' : '#e5e7eb',
                            background: currentValue === opt.value ? '#eff6ff' : '#fff',
                            color: currentValue === opt.value ? '#1d4ed8' : '#374151',
                            borderRadius: 3, padding: '2px 8px', fontSize: 10, cursor: 'pointer',
                          }}
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
              };

              const control = renderControl();
              if (!control) return null;

              if (setting.overridable) {
                return (
                  <AutomatableField
                    key={setting.key}
                    label={setting.label}
                    value={currentValue}
                    overridden={isOverridden}
                    onClearOverride={() => onDisplayChange(setting.key, null)}
                  >
                    {control}
                  </AutomatableField>
                );
              }

              return (
                <div key={setting.key} className="property-row">
                  {setting.type !== 'checkbox' && <label className="property-label">{setting.label}</label>}
                  {control}
                </div>
              );
            })}
          </>
        )}
      </div>
    </CollapsibleSection>
  );
}
