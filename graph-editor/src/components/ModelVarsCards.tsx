/**
 * ModelVarsCards — three-card source layout for model variable provenance.
 *
 * Renders Bayesian / Analytic / Manual cards with toggle-based source
 * selection.  Each card displays its ModelVarsEntry from edge.p.model_vars[].
 * The active (promoted) source is highlighted; users can pin a source via
 * the toggle button.
 *
 * Design: doc 15 §17.
 *
 * Layout zones (§17.1):
 *   1. Config fields (above cards) — handled by ParameterSection
 *   2. Source cards (this component) — Bayesian, Analytic, Manual
 *   3. Query (below cards) — handled by ParameterSection
 */

import React, { useCallback, useMemo, useState } from 'react';
import type {
  ModelVarsEntry,
  ModelSource,
  ModelSourcePreference,
  GraphModelSourcePreference,
  ModelVarsQuality,
  LatencyConfig,
} from '../types';
import {
  resolveActiveModelVars,
  effectivePreference,
  ukDateNow,
} from '../services/modelVarsResolution';
import { roundToDecimalPlaces } from '../utils/rounding';
import { LATENCY_HORIZON_DECIMAL_PLACES } from '../constants/latency';
import './ModelVarsCards.css';

// ── Types ────────────────────────────────────────────────────────────────────

interface ModelVarsCardsProps {
  /** The model_vars array from edge.p */
  modelVars?: ModelVarsEntry[];
  /** Edge-level preference (undefined = inherit graph default) */
  edgePreference?: ModelSourcePreference;
  /** Whether edge preference was explicitly set by user */
  edgePreferenceOverridden?: boolean;
  /** Graph-level preference */
  graphPreference?: GraphModelSourcePreference;
  /** Currently promoted scalars (for manual card placeholder display) */
  promotedMean?: number;
  promotedStdev?: number;
  /** Current promoted latency config (for manual card placeholders and analytic ZapOff) */
  promotedLatency?: LatencyConfig;
  /** Whether latency tracking is enabled on this edge */
  latencyEnabled?: boolean;
  /** Callback to update fields on edge.p (model_vars, preference, latency overrides) */
  onUpdate: (changes: Record<string, any>) => void;
  /** Disabled state */
  disabled?: boolean;
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

// ── Component ────────────────────────────────────────────────────────────────

export function ModelVarsCards({
  modelVars,
  edgePreference,
  edgePreferenceOverridden,
  graphPreference,
  promotedMean,
  promotedStdev,
  promotedLatency,
  latencyEnabled,
  onUpdate,
  disabled = false,
}: ModelVarsCardsProps) {
  const pref = effectivePreference(edgePreference, graphPreference);
  const activeEntry = resolveActiveModelVars(modelVars, pref);
  const activeSource = activeEntry?.source;

  const bayesian = findEntry(modelVars, 'bayesian');
  const analytic = findEntry(modelVars, 'analytic');
  const manual = findEntry(modelVars, 'manual');

  // §17.3.1: Toggle pin/unpin
  const handleToggle = useCallback((source: ModelSourcePreference) => {
    if (disabled) return;
    if (edgePreferenceOverridden && edgePreference === source) {
      // Unpin — revert to auto (§17.3.3)
      onUpdate({
        model_source_preference: undefined,
        model_source_preference_overridden: false,
      });
    } else {
      // Pin to this source
      onUpdate({
        model_source_preference: source,
        model_source_preference_overridden: true,
      });
    }
  }, [disabled, edgePreference, edgePreferenceOverridden, onUpdate]);

  // §5.3 + §17.2.3: Manual entry creation/update on edit
  const handleManualEdit = useCallback((field: string, value: number) => {
    const existing = findEntry(modelVars, 'manual');
    // Snapshot current promoted scalars on first edit (§5.3)
    const base: ModelVarsEntry = existing ?? {
      source: 'manual',
      source_at: ukDateNow(),
      probability: {
        mean: promotedMean ?? 0,
        stdev: promotedStdev ?? 0,
      },
      ...(latencyEnabled && promotedLatency?.mu != null ? {
        latency: {
          mu: promotedLatency.mu,
          sigma: promotedLatency.sigma ?? 0,
          t95: promotedLatency.t95 ?? 0,
          onset_delta_days: promotedLatency.onset_delta_days ?? 0,
          ...(promotedLatency.path_mu != null ? { path_mu: promotedLatency.path_mu } : {}),
          ...(promotedLatency.path_sigma != null ? { path_sigma: promotedLatency.path_sigma } : {}),
          ...(promotedLatency.path_t95 != null ? { path_t95: promotedLatency.path_t95 } : {}),
        },
      } : {}),
    };

    const updated: ModelVarsEntry = { ...base, source_at: ukDateNow() };

    // Apply the edit to the appropriate field
    if (field === 'mean' || field === 'stdev') {
      updated.probability = { ...updated.probability, [field]: value };
    } else {
      // Latency fields
      updated.latency = {
        ...(updated.latency ?? { mu: 0, sigma: 0, t95: 0, onset_delta_days: 0 }),
        [field]: value,
      };
    }

    // Upsert into array
    const nextVars = [...(modelVars ?? [])];
    const idx = nextVars.findIndex(e => e.source === 'manual');
    if (idx >= 0) nextVars[idx] = updated;
    else nextVars.push(updated);

    // §17.3.4: Auto-pin to manual on edit
    onUpdate({
      model_vars: nextVars,
      model_source_preference: 'manual',
      model_source_preference_overridden: true,
    });
  }, [modelVars, promotedMean, promotedStdev, promotedLatency, latencyEnabled, onUpdate]);

  // §17.2.2: Analytic card ZapOff fields update edge.p.latency directly
  const handleAnalyticLatencyOverride = useCallback((field: string, value: number | undefined, overridden: boolean) => {
    onUpdate({
      latency: {
        ...promotedLatency,
        [field]: value,
        [`${field}_overridden`]: overridden,
      },
    });
  }, [promotedLatency, onUpdate]);

  return (
    <div className="mv-cards">
      <BayesianCard
        entry={bayesian}
        isActive={activeSource === 'bayesian'}
        isPinned={edgePreferenceOverridden === true && edgePreference === 'bayesian'}
        onToggle={() => handleToggle('bayesian')}
        disabled={disabled}
      />
      <AnalyticCard
        entry={analytic}
        isActive={activeSource === 'analytic'}
        isPinned={edgePreferenceOverridden === true && edgePreference === 'analytic'}
        onToggle={() => handleToggle('analytic')}
        disabled={disabled}
        promotedLatency={promotedLatency}
        onLatencyOverride={handleAnalyticLatencyOverride}
      />
      <ManualCard
        entry={manual}
        isActive={activeSource === 'manual'}
        isPinned={edgePreferenceOverridden === true && edgePreference === 'manual'}
        onToggle={() => handleToggle('manual')}
        onEdit={handleManualEdit}
        promotedMean={promotedMean}
        promotedStdev={promotedStdev}
        promotedLatency={promotedLatency}
        latencyEnabled={latencyEnabled}
        disabled={disabled}
      />
    </div>
  );
}

// ── Shared sub-components ───────────────────────────────────────────────────

interface CardProps {
  isActive: boolean;
  isPinned: boolean;
  onToggle: () => void;
  disabled: boolean;
}

/** §17.3: Toggle button — grey (off), blue outline (auto-selected), green (pinned).
 *  §17.3.2: Hover previews as green when auto-selected (CSS handles this). */
function ToggleButton({ isActive, isPinned, onClick, disabled }: {
  isActive: boolean; isPinned: boolean; onClick: () => void; disabled: boolean;
}) {
  const cls = isPinned ? 'mv-toggle mv-toggle--pinned'
    : isActive ? 'mv-toggle mv-toggle--auto'
    : 'mv-toggle';
  return (
    <button
      className={cls}
      onClick={onClick}
      disabled={disabled}
      title={isPinned ? 'Click to unpin (use auto)' : isActive ? 'Auto-selected. Click to pin.' : 'Click to pin this source'}
    />
  );
}

/** §17.2 header: source name (left), active badge (centre-right), toggle (far right). */
function CardHeader({ title, isActive, isPinned, onToggle, disabled, dateLabel }: {
  title: string; isActive: boolean; isPinned: boolean;
  onToggle: () => void; disabled: boolean; dateLabel?: string;
}) {
  return (
    <div className="mv-card-header">
      <span className="mv-card-title">{title}</span>
      {dateLabel && <span className="mv-card-date">{dateLabel}</span>}
      <span className="mv-card-header-spacer" />
      {(isActive || isPinned) && (
        <span className={`mv-active-badge ${isPinned ? 'mv-active-badge--pinned' : ''}`}>
          {isPinned ? 'Pinned' : 'Active'}
        </span>
      )}
      <ToggleButton isActive={isActive} isPinned={isPinned} onClick={onToggle} disabled={disabled} />
    </div>
  );
}

function cardClass(isActive: boolean, isPinned: boolean): string {
  if (isPinned) return 'mv-card mv-card--pinned';
  if (isActive) return 'mv-card mv-card--active';
  return 'mv-card';
}

/** Read-only field row */
function ReadOnlyField({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="mv-row">
      <span className="mv-row-label">{label}</span>
      <span className="mv-row-value">{value}{unit ? <span className="mv-row-unit">{unit}</span> : null}</span>
    </div>
  );
}

// ── Bayesian card (§17.2.1) ─────────────────────────────────────────────────

function BayesianCard({ entry, isActive, isPinned, onToggle, disabled }: CardProps & { entry?: ModelVarsEntry }) {
  const [open, setOpen] = useState(true);

  return (
    <div className={cardClass(isActive, isPinned)}>
      <div className="mv-card-collapse-header" onClick={() => setOpen(!open)}>
        <span className={`mv-chevron ${open ? 'mv-chevron--open' : ''}`}>&#9654;</span>
        <CardHeader title="Bayesian" isActive={isActive} isPinned={isPinned}
          onToggle={onToggle} disabled={disabled}
          dateLabel={entry?.source_at} />
      </div>
      {open && (
        entry ? (
          <div className="mv-card-body">
            {/* Probability */}
            <div className="mv-section-label">Probability</div>
            <ReadOnlyField label="p" value={fmtPct(entry.probability.mean)} />
            <ReadOnlyField label="stdev" value={fmt(entry.probability.stdev)} />

            {/* Latency */}
            {entry.latency && (
              <>
                <div className="mv-section-label">Latency</div>
                <ReadOnlyField label="onset" value={fmt(entry.latency.onset_delta_days, 0)} unit="d" />
                <ReadOnlyField label="mu" value={fmt(entry.latency.mu, 3)} />
                <ReadOnlyField label="sigma" value={fmt(entry.latency.sigma, 3)} />
                <ReadOnlyField label="t95" value={fmt(entry.latency.t95, 1)} unit="d" />
                {entry.latency.path_mu != null && (
                  <>
                    <div className="mv-section-label">Path latency</div>
                    <ReadOnlyField label="path mu" value={fmt(entry.latency.path_mu, 3)} />
                    <ReadOnlyField label="path sigma" value={fmt(entry.latency.path_sigma, 3)} />
                    <ReadOnlyField label="path t95" value={fmt(entry.latency.path_t95, 1)} unit="d" />
                  </>
                )}
              </>
            )}

            {/* Quality (§17.2.1) */}
            {entry.quality && (
              <>
                <div className="mv-section-label">Quality</div>
                <QualitySection quality={entry.quality} />
              </>
            )}
          </div>
        ) : (
          <div className="mv-placeholder">No Bayesian model available.</div>
        )
      )}
    </div>
  );
}

// ── Analytic card (§17.2.2) ─────────────────────────────────────────────────

interface AnalyticCardProps extends CardProps {
  entry?: ModelVarsEntry;
  promotedLatency?: LatencyConfig;
  onLatencyOverride: (field: string, value: number | undefined, overridden: boolean) => void;
}

function AnalyticCard({ entry, isActive, isPinned, onToggle, disabled, promotedLatency, onLatencyOverride }: AnalyticCardProps) {
  const [open, setOpen] = useState(true);

  return (
    <div className={cardClass(isActive, isPinned)}>
      <div className="mv-card-collapse-header" onClick={() => setOpen(!open)}>
        <span className={`mv-chevron ${open ? 'mv-chevron--open' : ''}`}>&#9654;</span>
        <CardHeader title="Analytic" isActive={isActive} isPinned={isPinned}
          onToggle={onToggle} disabled={disabled}
          dateLabel={entry?.source_at} />
      </div>
      {open && (
        entry ? (
          <div className="mv-card-body">
            {/* Probability (read-only) */}
            <div className="mv-section-label">Probability</div>
            <ReadOnlyField label="p" value={fmtPct(entry.probability.mean)} />
            <ReadOnlyField label="stdev" value={fmt(entry.probability.stdev)} />

            {/* Latency — mu/sigma read-only, onset/t95/path_t95 overridable (ZapOff) */}
            {entry.latency && (
              <>
                <div className="mv-section-label">Latency</div>
                <ReadOnlyField label="mu" value={fmt(entry.latency.mu, 3)} />
                <ReadOnlyField label="sigma" value={fmt(entry.latency.sigma, 3)} />
                {/* ZapOff: onset (§17.2.2) */}
                <ZapOffField
                  label="onset"
                  value={promotedLatency?.onset_delta_days}
                  overridden={promotedLatency?.onset_delta_days_overridden || false}
                  unit="d"
                  step={1}
                  dp={0}
                  disabled={disabled}
                  onCommit={(v) => onLatencyOverride('onset_delta_days', v, true)}
                  onClearOverride={() => onLatencyOverride('onset_delta_days', promotedLatency?.onset_delta_days, false)}
                />
                {/* ZapOff: t95 (§17.2.2) */}
                <ZapOffField
                  label="t95"
                  value={promotedLatency?.t95}
                  overridden={promotedLatency?.t95_overridden || false}
                  unit="d"
                  step={0.01}
                  dp={LATENCY_HORIZON_DECIMAL_PLACES}
                  disabled={disabled}
                  onCommit={(v) => onLatencyOverride('t95', v, true)}
                  onClearOverride={() => onLatencyOverride('t95', promotedLatency?.t95, false)}
                />
                {/* Path-level (read-only mu/sigma, ZapOff path_t95) */}
                {entry.latency.path_mu != null && (
                  <>
                    <div className="mv-section-label">Path latency</div>
                    <ReadOnlyField label="path mu" value={fmt(entry.latency.path_mu, 3)} />
                    <ReadOnlyField label="path sigma" value={fmt(entry.latency.path_sigma, 3)} />
                    {/* ZapOff: path_t95 (§17.2.2) */}
                    <ZapOffField
                      label="path t95"
                      value={promotedLatency?.path_t95}
                      overridden={promotedLatency?.path_t95_overridden || false}
                      unit="d"
                      step={0.01}
                      dp={LATENCY_HORIZON_DECIMAL_PLACES}
                      disabled={disabled}
                      onCommit={(v) => onLatencyOverride('path_t95', v, true)}
                      onClearOverride={() => onLatencyOverride('path_t95', promotedLatency?.path_t95, false)}
                    />
                  </>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="mv-placeholder">No analytic data.</div>
        )
      )}
    </div>
  );
}

// ── Manual card (§17.2.3) ───────────────────────────────────────────────────

interface ManualCardProps extends CardProps {
  entry?: ModelVarsEntry;
  onEdit: (field: string, value: number) => void;
  promotedMean?: number;
  promotedStdev?: number;
  promotedLatency?: LatencyConfig;
  latencyEnabled?: boolean;
}

function ManualCard({
  entry, isActive, isPinned, onToggle, onEdit,
  promotedMean, promotedStdev, promotedLatency, latencyEnabled, disabled,
}: ManualCardProps) {
  // §17.2.3: Always expanded (not collapsible)
  // When no manual entry: show promoted values as read-only placeholders.
  // When manual entry exists: show manual values, all editable.
  const hasEntry = !!entry;
  const prob = entry?.probability ?? { mean: promotedMean ?? 0, stdev: promotedStdev ?? 0 };
  const lat = entry?.latency ?? (latencyEnabled && promotedLatency?.mu != null ? {
    mu: promotedLatency.mu,
    sigma: promotedLatency.sigma ?? 0,
    t95: promotedLatency.t95 ?? 0,
    onset_delta_days: promotedLatency.onset_delta_days ?? 0,
    path_mu: promotedLatency.path_mu,
    path_sigma: promotedLatency.path_sigma,
    path_t95: promotedLatency.path_t95,
  } : undefined);

  return (
    <div className={cardClass(isActive, isPinned)}>
      <CardHeader title="Manual" isActive={isActive} isPinned={isPinned}
        onToggle={onToggle} disabled={disabled}
        dateLabel={entry?.source_at} />
      <div className="mv-card-body">
        {/* Probability */}
        <div className="mv-section-label">Probability</div>
        <EditableField label="p" value={prob.mean} format="pct"
          hasEntry={hasEntry} disabled={disabled}
          onCommit={(v) => onEdit('mean', v)} />
        <EditableField label="stdev" value={prob.stdev} format="dec4"
          hasEntry={hasEntry} disabled={disabled}
          onCommit={(v) => onEdit('stdev', v)} />

        {/* Latency (§17.2.3: when latency tracking enabled) */}
        {latencyEnabled && lat && (
          <>
            <div className="mv-section-label">Latency</div>
            <EditableField label="mu" value={lat.mu} format="dec3"
              hasEntry={hasEntry} disabled={disabled}
              onCommit={(v) => onEdit('mu', v)} />
            <EditableField label="sigma" value={lat.sigma} format="dec3"
              hasEntry={hasEntry} disabled={disabled}
              onCommit={(v) => onEdit('sigma', v)} />
            <EditableField label="t95" value={lat.t95} format="dec1" unit="d"
              hasEntry={hasEntry} disabled={disabled}
              onCommit={(v) => onEdit('t95', v)} />
            <EditableField label="onset" value={lat.onset_delta_days} format="dec0" unit="d"
              hasEntry={hasEntry} disabled={disabled}
              onCommit={(v) => onEdit('onset_delta_days', v)} />
            {lat.path_mu != null && (
              <>
                <div className="mv-section-label">Path latency</div>
                <EditableField label="path mu" value={lat.path_mu} format="dec3"
                  hasEntry={hasEntry} disabled={disabled}
                  onCommit={(v) => onEdit('path_mu', v)} />
                <EditableField label="path sigma" value={lat.path_sigma} format="dec3"
                  hasEntry={hasEntry} disabled={disabled}
                  onCommit={(v) => onEdit('path_sigma', v)} />
                <EditableField label="path t95" value={lat.path_t95} format="dec1" unit="d"
                  hasEntry={hasEntry} disabled={disabled}
                  onCommit={(v) => onEdit('path_t95', v)} />
              </>
            )}
          </>
        )}

        {!hasEntry && (
          <div className="mv-placeholder">Edit any field to create manual override</div>
        )}
      </div>
    </div>
  );
}

// ── Editable field (Manual card) ────────────────────────────────────────────

type FieldFormat = 'pct' | 'dec0' | 'dec1' | 'dec3' | 'dec4';

function formatFieldValue(v: number | undefined | null, format: FieldFormat): string {
  if (v === undefined || v === null) return '';
  switch (format) {
    case 'pct': return (v * 100).toFixed(1);
    case 'dec0': return v.toFixed(0);
    case 'dec1': return v.toFixed(1);
    case 'dec3': return v.toFixed(3);
    case 'dec4': return v.toFixed(4);
  }
}

function parseFieldValue(raw: string, format: FieldFormat): number | undefined {
  const v = parseFloat(raw);
  if (isNaN(v)) return undefined;
  return format === 'pct' ? v / 100 : v;
}

function EditableField({ label, value, format, unit, hasEntry, disabled, onCommit }: {
  label: string; value?: number | null; format: FieldFormat; unit?: string;
  hasEntry: boolean; disabled: boolean; onCommit: (v: number) => void;
}) {
  const [local, setLocal] = useState('');
  const [editing, setEditing] = useState(false);
  const displayValue = formatFieldValue(value, format);

  return (
    <div className="mv-row">
      <span className="mv-row-label">{label}</span>
      <span className="mv-row-value">
        <input
          className={`mv-edit-input ${!hasEntry ? 'mv-edit-input--placeholder' : ''}`}
          type="number"
          step="any"
          value={editing ? local : displayValue}
          placeholder={displayValue || '–'}
          disabled={disabled}
          readOnly={!hasEntry && !editing}
          onFocus={() => {
            setEditing(true);
            setLocal(displayValue);
          }}
          onBlur={() => {
            setEditing(false);
            const parsed = parseFieldValue(local, format);
            if (parsed !== undefined && parsed !== value) {
              onCommit(parsed);
            }
            setLocal('');
          }}
          onChange={(e) => setLocal(e.target.value)}
        />
        {unit && <span className="mv-row-unit">{unit}</span>}
        {format === 'pct' && <span className="mv-row-unit">%</span>}
      </span>
    </div>
  );
}

// ── ZapOff field (Analytic card overridable fields) ─────────────────────────

function ZapOffField({ label, value, overridden, unit, step, dp, disabled, onCommit, onClearOverride }: {
  label: string; value?: number; overridden: boolean; unit?: string;
  step: number; dp: number; disabled: boolean;
  onCommit: (v: number | undefined) => void;
  onClearOverride: () => void;
}) {
  const [local, setLocal] = useState('');
  const [editing, setEditing] = useState(false);
  const displayValue = value !== undefined ? roundToDecimalPlaces(value, dp).toString() : '';

  return (
    <div className="mv-row mv-row--zapoff">
      <span className="mv-row-label">{label}</span>
      <span className="mv-row-value">
        <input
          className={`mv-edit-input ${overridden ? 'mv-edit-input--overridden' : ''}`}
          type="number"
          min={0}
          step={step}
          value={editing ? local : displayValue}
          placeholder="(computed)"
          disabled={disabled}
          onFocus={() => {
            setEditing(true);
            setLocal(displayValue);
          }}
          onBlur={() => {
            setEditing(false);
            const parsed = parseFloat(local);
            if (!isNaN(parsed) && parsed >= 0) {
              onCommit(roundToDecimalPlaces(parsed, dp));
            }
            setLocal('');
          }}
          onChange={(e) => setLocal(e.target.value)}
        />
        {unit && <span className="mv-row-unit">{unit}</span>}
      </span>
      {overridden && (
        <button
          className="mv-zapoff-btn"
          onClick={onClearOverride}
          disabled={disabled}
          title="Clear override — revert to computed value"
        >
          &#x26A1;
        </button>
      )}
    </div>
  );
}

// ── Quality section (§17.2.1) ───────────────────────────────────────────────

function QualitySection({ quality }: { quality: ModelVarsQuality }) {
  const passed = quality.gate_passed;
  return (
    <div className="mv-quality-section">
      <span className={`mv-gate-badge ${passed ? 'mv-gate-badge--passed' : 'mv-gate-badge--failed'}`}>
        {passed ? 'Gate passed' : 'Gate failed'}
      </span>
      <ReadOnlyField label="rhat" value={fmt(quality.rhat, 4)} />
      <ReadOnlyField label="ESS" value={String(Math.round(quality.ess))} />
      {quality.divergences > 0 && (
        <ReadOnlyField label="divergences" value={String(quality.divergences)} />
      )}
      <ReadOnlyField label="evidence" value={`${quality.evidence_grade}/3`} />
    </div>
  );
}
