/**
 * ModelVarsCards — three-card source layout for model variable provenance.
 *
 * Renders Bayesian / Analytic / Output cards with toggle-based source
 * selection.  Each card displays its ModelVarsEntry from edge.p.model_vars[].
 * The active (promoted) source is highlighted; users can pin a source via
 * the toggle button.
 *
 * Design: doc 15 §17.
 *
 * Layout zones (§17.1):
 *   1. Config fields (above cards) — handled by ParameterSection
 *   2. Source cards (this component) — Bayesian, Analytic, Output
 *   3. Query (below cards) — handled by ParameterSection
 *
 * Styling: reuses CollapsibleSection for collapse, .property-input for inputs,
 * .collapsible-section-badge for badges, theme tokens for all colours.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ZapOff } from 'lucide-react';
import ProbabilityInput from './ProbabilityInput';
import type {
  ModelVarsEntry,
  ModelSource,
  ModelSourcePreference,
  GraphModelSourcePreference,
  LatencyConfig,
  LatencyPosterior,
  ProbabilityPosterior,
} from '../types';
import {
  resolveActiveModelVars,
  effectivePreference,
} from '../services/modelVarsResolution';
import { roundToDecimalPlaces } from '../utils/rounding';
import { LATENCY_HORIZON_DECIMAL_PLACES } from '../constants/latency';
import CollapsibleSection from './CollapsibleSection';
import { AutomatableField } from './AutomatableField';
import { BayesPosteriorCard } from './analytics/BayesPosteriorCard';
import { ModelCard } from './analytics/ModelCard';
import { useTheme } from '../contexts/ThemeContext';
import './ModelVarsCards.css';

// ── Types ────────────────────────────────────────────────────────────────────

interface ModelVarsCardsProps {
  modelVars?: ModelVarsEntry[];
  edgePreference?: ModelSourcePreference;
  edgePreferenceOverridden?: boolean;
  graphPreference?: GraphModelSourcePreference;
  promotedMean?: number;
  promotedStdev?: number;
  /** Per-field override flags (existing _overridden pattern) */
  meanOverridden?: boolean;
  stdevOverridden?: boolean;
  promotedLatency?: LatencyConfig;
  latencyEnabled?: boolean;
  onUpdate: (changes: Record<string, any>) => void;
  disabled?: boolean;
  /** Bayesian posteriors — full dispersion data for inline display */
  latencyPosterior?: LatencyPosterior;
  probabilityPosterior?: ProbabilityPosterior;
  /** Parameter ID — used to wire prior reset / history delete actions */
  paramId?: string;
  /** Reset priors for next Bayesian run (non-destructive). */
  onResetPriors?: () => void;
  /** Delete all fit history (destructive — requires caller to confirm first). */
  onDeleteHistory?: () => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findEntry(modelVars: ModelVarsEntry[] | undefined, source: ModelSource): ModelVarsEntry | undefined {
  return modelVars?.find(e => e.source === source);
}

function fmt(v: number | undefined | null, dp: number = 4): string {
  if (v === undefined || v === null) return '–';
  return v.toFixed(dp);
}

function fmtPct(v: number | undefined | null): string {
  if (v === undefined || v === null) return '–';
  return (v * 100).toFixed(1) + '%';
}

// ── Main component ──────────────────────────────────────────────────────────

export function ModelVarsCards({
  modelVars, edgePreference, edgePreferenceOverridden, graphPreference,
  promotedMean, promotedStdev, meanOverridden, stdevOverridden,
  promotedLatency, latencyEnabled,
  onUpdate, disabled = false,
  latencyPosterior, probabilityPosterior,
  paramId, onResetPriors, onDeleteHistory,
}: ModelVarsCardsProps) {
  const { theme } = useTheme();
  const pref = effectivePreference(edgePreference, graphPreference);
  const activeEntry = resolveActiveModelVars(modelVars, pref);
  const activeSource = activeEntry?.source;

  const bayesian = findEntry(modelVars, 'bayesian');
  const analytic = findEntry(modelVars, 'analytic');
  const manual = findEntry(modelVars, 'manual');

  // Collapse state: active card open, others closed. User can manually toggle.
  // Auto-open the active card when activeSource changes.
  const [bayesOpen, setBayesOpen] = useState(activeSource === 'bayesian');
  const [analyticOpen, setAnalyticOpen] = useState(activeSource === 'analytic');
  const prevSource = useRef(activeSource);
  useEffect(() => {
    if (activeSource !== prevSource.current) {
      setBayesOpen(activeSource === 'bayesian');
      setAnalyticOpen(activeSource === 'analytic');
      prevSource.current = activeSource;
    }
  }, [activeSource]);

  const handleToggle = useCallback((source: ModelSourcePreference) => {
    if (disabled) return;
    if (edgePreferenceOverridden && edgePreference === source) {
      // Already pinned to this source → unpin (revert to auto)
      onUpdate({ model_source_preference: undefined, model_source_preference_overridden: false });
    } else if (activeSource === source && !edgePreferenceOverridden) {
      // Auto-selected but user is turning it OFF → pin to manual (user decision)
      onUpdate({ model_source_preference: 'manual', model_source_preference_overridden: true });
    } else {
      // Not active or pinned elsewhere → pin to this source
      onUpdate({ model_source_preference: source, model_source_preference_overridden: true });
    }
  }, [disabled, edgePreference, edgePreferenceOverridden, activeSource, onUpdate]);

  // Output field commit: just set the field + override flag.
  // updateEdgeParam handles manual model_vars entry creation centrally (doc 15 §5.3).
  const handleOutputCommit = useCallback((field: string, value: number) => {
    if (field === 'mean') {
      onUpdate({ mean: value, mean_overridden: true });
    } else if (field === 'stdev') {
      onUpdate({ stdev: value, stdev_overridden: true });
    } else {
      // Latency fields — nested under latency object
      onUpdate({
        latency: {
          ...promotedLatency,
          [field]: value,
          ...(field === 't95' ? { t95_overridden: true } : {}),
          ...(field === 'onset_delta_days' ? { onset_delta_days_overridden: true } : {}),
        },
      });
    }
  }, [promotedLatency, onUpdate]);

  // Immediately flip source to manual on first keystroke (§17.3.4).
  // Uses _noHistory for synchronous setGraph.
  const handleOutputStartEdit = useCallback(() => {
    if (disabled) return;
    if (edgePreferenceOverridden && edgePreference === 'manual') return;
    onUpdate({
      model_source_preference: 'manual',
      model_source_preference_overridden: true,
      _noHistory: true,
    });
  }, [disabled, edgePreference, edgePreferenceOverridden, onUpdate]);

  const isPinned = (s: ModelSourcePreference) => edgePreferenceOverridden === true && edgePreference === s;
  const anyPinned = edgePreferenceOverridden === true;
  // §17.3: auto-on only when this source is active AND nothing is pinned.
  // If something is pinned, only the pinned source shows on.
  const isAutoOn = (s: ModelSource) => activeSource === s && !anyPinned;

  return (
    <div className="mv-cards">
      {/* ── Bayesian (§17.2.1) — collapsible, open only when active ── */}
      <div className={`mv-card-wrap ${isPinned('bayesian') ? 'mv-card-wrap--pinned' : isAutoOn('bayesian') ? 'mv-card-wrap--active' : ''}`}>
        <CollapsibleSection
          title={<>Bayesian{isAutoOn('bayesian') && <span className="collapsible-section-badge" style={{ marginLeft: '8px' }}>Auto</span>}</>}
          isOpen={bayesOpen}
          onToggle={() => setBayesOpen(!bayesOpen)}
          headerRight={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              {isPinned('bayesian') && <SourceOverrideIcon onClear={() => handleToggle('bayesian')} />}
              <PinToggle active={isAutoOn('bayesian')} pinned={isPinned('bayesian')}
                onClick={() => handleToggle('bayesian')} disabled={disabled} />
            </span>
          }
        >
          {bayesian ? (
            <BayesPosteriorCard
              probability={probabilityPosterior}
              latency={latencyPosterior}
              t95={bayesian.latency?.t95}
              pathT95={bayesian.latency?.path_t95}
              theme={theme}
              onResetPriors={onResetPriors}
              onDeleteHistory={onDeleteHistory}
            />
          ) : (
            <p style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '12px', margin: 0 }}>
              No Bayesian model available.
            </p>
          )}
        </CollapsibleSection>
      </div>

      {/* ── Analytic FE (§17.2.2) — collapsible, open only when active ── */}
      <div className={`mv-card-wrap ${isPinned('analytic') ? 'mv-card-wrap--pinned' : isAutoOn('analytic') ? 'mv-card-wrap--active' : ''}`}>
        <CollapsibleSection
          title={<>Analytic (FE){isAutoOn('analytic') && <span className="collapsible-section-badge" style={{ marginLeft: '8px' }}>Auto</span>}</>}
          isOpen={analyticOpen}
          onToggle={() => setAnalyticOpen(!analyticOpen)}
          headerRight={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              {isPinned('analytic') && <SourceOverrideIcon onClear={() => handleToggle('analytic')} />}
              <PinToggle active={isAutoOn('analytic')} pinned={isPinned('analytic')}
                onClick={() => handleToggle('analytic')} disabled={disabled} />
            </span>
          }
        >
          {analytic ? (
            <>
              <ModelCard entry={analytic} t95={promotedLatency?.promoted_t95 ?? promotedLatency?.t95}
                pathT95={promotedLatency?.promoted_path_t95 ?? promotedLatency?.path_t95}
                timestampLabel="Retrieved" />
              {/* t95 override controls (FE analytic card affordance) */}
              {analytic.latency && (
                <div style={{ padding: '0 10px' }}>
                  <LatencyZapOff field="t95" label="t95" unit="d" step={0.01} dp={LATENCY_HORIZON_DECIMAL_PLACES}
                    latency={promotedLatency} onUpdate={onUpdate} disabled={disabled} />
                  {analytic.latency?.path_mu != null && (
                    <LatencyZapOff field="path_t95" label="path t95" unit="d" step={0.01} dp={LATENCY_HORIZON_DECIMAL_PLACES}
                      latency={promotedLatency} onUpdate={onUpdate} disabled={disabled} />
                  )}
                </div>
              )}
            </>
          ) : (
            <p style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '12px', margin: 0 }}>
              No analytic data.
            </p>
          )}
        </CollapsibleSection>
      </div>

      {/* ── Output (§17.2.3) — collapsible, defaults open ── */}
      <div className={`mv-card-wrap ${isPinned('manual') ? 'mv-card-wrap--pinned' : isAutoOn('manual') ? 'mv-card-wrap--active' : ''}`}>
        <CollapsibleSection
          title={<>Output{isAutoOn('manual') && <span className="collapsible-section-badge" style={{ marginLeft: '8px' }}>Auto</span>}</>}
          defaultOpen={true}
          headerRight={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              {isPinned('manual') && <SourceOverrideIcon onClear={() => handleToggle('manual')} />}
              <PinToggle active={isAutoOn('manual')} pinned={isPinned('manual')}
                onClick={() => handleToggle('manual')} disabled={disabled} />
            </span>
          }
        >
          <OutputCardBody
            onCommit={handleOutputCommit}
            onStartEdit={handleOutputStartEdit}
            onClearFieldOverride={(flag, isLatency) => {
              if (isLatency) {
                onUpdate({ latency: { ...promotedLatency, [flag]: false } });
              } else {
                onUpdate({ [flag]: false });
              }
            }}
            promotedMean={promotedMean} promotedStdev={promotedStdev}
            meanOverridden={meanOverridden}
            stdevOverridden={stdevOverridden}
            promotedLatency={promotedLatency} latencyEnabled={latencyEnabled}
            disabled={disabled}
          />
        </CollapsibleSection>
      </div>
    </div>
  );
}

// ── Source override indicator (ZapOff) — shown on pinned card header ────────

function SourceOverrideIcon({ onClear }: { onClear: () => void }) {
  return (
    <button
      className="override-toggle"
      onClick={(e) => { e.stopPropagation(); onClear(); }}
      title="Clear source override — revert to auto"
      type="button"
      style={{ padding: '2px' }}
    >
      <ZapOff size={12} />
    </button>
  );
}

// ── Pin toggle (§17.3) — reuses toggle-track/thumb visual pattern ───────────

function PinToggle({ active, pinned, onClick, disabled }: {
  active: boolean; pinned: boolean; onClick: () => void; disabled: boolean;
}) {
  // §17.3.1: two states — grey (auto-on, thumb right) vs green (pinned, thumb right).
  // Not active = thumb left, grey track.
  const trackClass = `collapsible-section-toggle-track${pinned ? ' on-success' : active ? ' on-grey' : ''}`;
  return (
    <span
      onClick={(e) => { e.stopPropagation(); if (!disabled) onClick(); }}
      title={pinned ? 'Click to unpin (use auto)' : active ? 'Auto-selected. Click to pin.' : 'Click to pin this source'}
      style={{ display: 'inline-flex', alignItems: 'center', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1, flexShrink: 0 }}
    >
      <span className={trackClass} style={{ display: 'block' }}>
        <span className="collapsible-section-toggle-thumb" />
      </span>
    </span>
  );
}

// ── Shared layout helpers ───────────────────────────────────────────────────

function FieldGroup({ label, children, defaultCollapsed = false }: { label: string; children: React.ReactNode; defaultCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <div style={{ marginTop: '6px' }}>
      <div
        style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
          color: 'var(--text-muted)', marginBottom: '2px', cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setCollapsed(c => !c)}
      >
        <span style={{ display: 'inline-block', width: '10px', fontSize: '8px' }}>{collapsed ? '▶' : '▼'}</span>
        {label}
      </div>
      {!collapsed && <div style={{ paddingLeft: '10px' }}>{children}</div>}
    </div>
  );
}

function RoField({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="property-field-inline" style={{ minHeight: '16px', gap: '6px', marginBottom: '2px' }}>
      <label className="parameter-section-label" style={{ minWidth: '54px', fontSize: '11px' }}>{label}</label>
      <span style={{ fontSize: '11px', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)' }}>
        {value}{unit && <span style={{ color: 'var(--text-muted)', fontSize: '10px', marginLeft: '2px' }}>{unit}</span>}
      </span>
    </div>
  );
}

// ── Latency ZapOff field (wraps AutomatableField) ───────────────────────────

function LatencyZapOff({ field, label, unit, step, dp, latency, onUpdate, disabled }: {
  field: string; label: string; unit: string; step: number; dp: number;
  latency?: LatencyConfig; onUpdate: (changes: Record<string, any>) => void; disabled: boolean;
}) {
  const value = (latency as any)?.[field];
  const overridden = (latency as any)?.[`${field}_overridden`] || false;
  const [local, setLocal] = useState(value !== undefined ? String(roundToDecimalPlaces(value, dp)) : '');

  // Sync local when external changes
  React.useEffect(() => {
    setLocal(value !== undefined ? String(roundToDecimalPlaces(value, dp)) : '');
  }, [value, dp]);

  return (
    <AutomatableField
      label=""
      value={value ?? ''}
      overridden={overridden}
      onClearOverride={() => {
        onUpdate({ latency: { ...latency, [`${field}_overridden`]: false } });
      }}
    >
      <div className="property-field-inline" style={{ minHeight: '16px', gap: '6px', marginBottom: '2px' }}>
        <label className="parameter-section-label" style={{ minWidth: '54px', fontSize: '11px' }}>{label}</label>
        <input
          className="property-input"
          type="number"
          min={0}
          step={step}
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => {
            const parsed = parseFloat(local);
            if (!isNaN(parsed) && parsed >= 0) {
              const rounded = roundToDecimalPlaces(parsed, dp);
              setLocal(String(rounded));
              onUpdate({ latency: { ...latency, [field]: rounded, [`${field}_overridden`]: true } });
            }
          }}
          disabled={disabled}
          placeholder="(computed)"
          style={{ width: '70px', padding: '2px 6px', fontSize: '11px' }}
        />
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{unit}</span>
      </div>
    </AutomatableField>
  );
}

// ── Output card body (§17.2.3) ──────────────────────────────────────────────
// Each field uses AutomatableField for the standard override indicator.
// On blur, handleOutputCommit creates/updates the manual model_vars entry,
// sets _overridden, and pins to manual — all in one onUpdate call.

function OutputCardBody({ onCommit, onStartEdit, onClearFieldOverride, promotedMean, promotedStdev, meanOverridden, stdevOverridden, promotedLatency, latencyEnabled, disabled }: {
  onCommit: (field: string, value: number) => void;
  onStartEdit: () => void;
  onClearFieldOverride: (flag: string, isLatency?: boolean) => void;
  meanOverridden?: boolean; stdevOverridden?: boolean;
  promotedMean?: number; promotedStdev?: number; promotedLatency?: LatencyConfig;
  latencyEnabled?: boolean; disabled: boolean;
}) {
  return (
    <div>
      <FieldGroup label="Probability">
        <AutomatableField label="" value={promotedMean ?? 0} overridden={meanOverridden || false}
          onClearOverride={() => onClearFieldOverride('mean_overridden')}>
          <ProbabilityInput
            value={promotedMean ?? 0}
            onChange={(v) => { onStartEdit(); onCommit('mean', v); }}
            onCommit={(v) => onCommit('mean', v)}
            disabled={disabled}
            min={0} max={1} step={0.01}
          />
        </AutomatableField>
        <OutputInput label="stdev" field="stdev" value={promotedStdev} dp={4}
          overridden={stdevOverridden} onClearOverride={() => onClearFieldOverride('stdev_overridden')}
          onCommit={onCommit} onStartEdit={onStartEdit} disabled={disabled} />
      </FieldGroup>
      {/* Edge-level latency — only when latency tracking enabled */}
      {latencyEnabled && promotedLatency?.mu != null && (
        <FieldGroup label="Edge latency">
          <RoField label="μ" value={fmt(promotedLatency.mu, 3)} />
          <RoField label="σ" value={fmt(promotedLatency.sigma, 3)} />
          {/* Doc 19: t95 is read-only in Output card — user edits the input constraint elsewhere */}
          <RoField label="t95" value={fmt(promotedLatency.promoted_t95 ?? promotedLatency.t95, 1)} unit="d" />
          {/* Doc 19: onset is read-only in Output card — user edits the input constraint in Zone 1b above */}
          <RoField label="onset" value={fmt(promotedLatency.promoted_onset_delta_days ?? promotedLatency.onset_delta_days, 0)} unit="d" />
        </FieldGroup>
      )}
      {/* Path-level latency — shown whenever path values exist (topological, not gated on edge latency) */}
      {promotedLatency?.path_mu != null && (
        <FieldGroup label="Path latency">
          <RoField label="path μ" value={fmt(promotedLatency.path_mu, 3)} />
          <RoField label="path σ" value={fmt(promotedLatency.path_sigma, 3)} />
          <RoField label="path onset" value={fmt(promotedLatency.path_onset_delta_days, 0)} unit="d" />
          {/* Doc 19: path_t95 is read-only in Output card */}
          <RoField label="path t95" value={fmt(promotedLatency.promoted_path_t95 ?? promotedLatency.path_t95, 1)} unit="d" />
        </FieldGroup>
      )}
    </div>
  );
}

/** Single output field: AutomatableField + input with blur-to-commit. */
function OutputInput({ label, field, value, dp, pct, unit, overridden, onClearOverride, onCommit, onStartEdit, disabled }: {
  label: string; field: string; value?: number; dp: number; pct?: boolean; unit?: string;
  overridden?: boolean; onClearOverride?: () => void;
  onCommit: (field: string, value: number) => void;
  onStartEdit: () => void;
  disabled: boolean;
}) {
  const display = value !== undefined ? (pct ? (value * 100).toFixed(dp) : value.toFixed(dp)) : '';
  const [local, setLocal] = useState(display);
  const [dirty, setDirty] = useState(false);
  React.useEffect(() => { setLocal(display); }, [display]);

  return (
    <AutomatableField label="" value={value ?? ''} overridden={overridden || false} onClearOverride={onClearOverride || (() => {})}>
      <div className="property-field-inline" style={{ minHeight: '16px', gap: '6px', marginBottom: '2px' }}>
        <label className="parameter-section-label" style={{ minWidth: '54px', fontSize: '11px' }}>{label}</label>
        <input
          className="property-input"
          type="number" step="any" min={0}
          value={local}
          onChange={(e) => {
            setLocal(e.target.value);
            if (!dirty) {
              setDirty(true);
              onStartEdit(); // Immediately flip source on first keystroke
            }
          }}
          onBlur={() => {
            const raw = parseFloat(local);
            if (!isNaN(raw)) {
              const v = pct ? raw / 100 : raw;
              // Use tolerance to avoid spurious commits from float precision
              if (value === undefined || Math.abs(v - value) > 1e-9) {
                onCommit(field, v);
              }
            }
            setDirty(false);
          }}
          disabled={disabled}
          style={{ width: '60px', padding: '2px 6px', fontSize: '11px' }}
        />
        {pct && <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>%</span>}
        {unit && <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{unit}</span>}
      </div>
    </AutomatableField>
  );
}

