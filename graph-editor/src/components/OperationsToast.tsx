/**
 * Operations Toast
 *
 * Unified floating progress indicator at bottom-centre of the viewport.
 * Shows the primary active operation collapsed; expands on hover to list
 * all active + recently completed operations.
 *
 * Driven entirely by operationRegistryService — no direct react-hot-toast usage.
 */

import React, { useEffect, useState, useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useOperations } from '../hooks/useOperations';
import { operationRegistryService, type Operation, type OperationSubStep } from '../services/operationRegistryService';
import './OperationsToast.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max sub-steps shown in PrimaryRow before truncation. */
const MAX_VISIBLE_SUBSTEPS = 3;

/** Full opacity hold time after completion (ms). */
const OPAQUE_HOLD_MS = 8_000;
/** After opaque hold, fade to semi-transparent over this CSS transition (ms). */
const FADE_TRANSITION_MS = 2_000;
/** Semi-transparent hold before removal (ms). Errors never auto-remove. */
const SEMI_HOLD_MS = 20_000;
/** Total time before removal = OPAQUE_HOLD + FADE_TRANSITION + SEMI_HOLD. */
const REMOVE_DELAY_MS = OPAQUE_HOLD_MS + FADE_TRANSITION_MS + SEMI_HOLD_MS;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusIcon(status: Operation['status']): React.ReactNode {
  switch (status) {
    case 'pending':
      return <span className="ops-toast-item-icon" style={{ color: 'var(--text-secondary, #a0a0a0)' }}>○</span>;
    case 'countdown':
      return <span className="ops-toast-item-icon" style={{ color: '#f59e0b' }}>⏱</span>;
    case 'running':
      return <span className="ops-toast-item-icon"><span className="ops-toast-spinner small" /></span>;
    case 'complete':
      return <span className="ops-toast-item-icon" style={{ color: 'var(--success-color, #4caf50)' }}>✓</span>;
    case 'error':
      return <span className="ops-toast-item-icon" style={{ color: '#ef4444' }}>✗</span>;
    case 'cancelled':
      return <span className="ops-toast-item-icon" style={{ color: 'var(--text-secondary, #a0a0a0)' }}>—</span>;
    default:
      return null;
  }
}

function subStepIcon(status: OperationSubStep['status']): React.ReactNode {
  switch (status) {
    case 'pending':
      return <span className="ops-toast-substep-icon" style={{ color: 'var(--text-secondary, #a0a0a0)' }}>○</span>;
    case 'running':
      return <span className="ops-toast-substep-icon"><span className="ops-toast-spinner small" /></span>;
    case 'complete':
      return <span className="ops-toast-substep-icon" style={{ color: 'var(--success-color, #4caf50)' }}>✓</span>;
    case 'error':
      return <span className="ops-toast-substep-icon" style={{ color: '#ef4444' }}>✗</span>;
    default:
      return null;
  }
}

function progressPercent(op: Operation): number | undefined {
  if (!op.progress || op.progress.total <= 0) return undefined;
  return Math.round((op.progress.current / op.progress.total) * 100);
}

function formatCount(op: Operation): string | undefined {
  if (!op.progress) return undefined;
  return `${op.progress.current}/${op.progress.total}`;
}

/** Pick the "primary" operation to show in the collapsed view. */
function pickPrimary(active: Operation[]): Operation | undefined {
  return (
    active.find((o) => o.status === 'running') ??
    active.find((o) => o.status === 'countdown') ??
    active[0]
  );
}

/** Determine the fade class for a completed operation. */
function fadeClass(op: Operation, now: number, isHovered: boolean): string {
  if (isHovered) return '';
  // Errors persist until manually dismissed — no fading.
  if (op.status === 'error') return '';
  if (!op.completedAtMs) return '';
  const age = now - op.completedAtMs;
  if (age < OPAQUE_HOLD_MS) return '';
  if (age < OPAQUE_HOLD_MS + FADE_TRANSITION_MS) return 'fading';
  return 'faded';
}

/** Should this completed op still be visible? */
function isVisible(op: Operation, now: number, isHovered: boolean): boolean {
  // Errors always visible until dismissed.
  if (op.status === 'error') return true;
  if (isHovered) return true;
  if (!op.completedAtMs) return true;
  return now - op.completedAtMs < REMOVE_DELAY_MS;
}

/** Open the session log tab, targeting entries for a specific operation. */
function openSessionLogForOperation(operationId?: string): void {
  void import('../services/sessionLogService').then(({ sessionLogService }) => {
    void sessionLogService.openLogTab().then(() => {
      if (operationId) {
        // Dispatch an event that SessionLogViewer can pick up to scroll/filter.
        // Even if the viewer doesn't handle this yet, the wiring is in place.
        window.dispatchEvent(
          new CustomEvent('dagnet:sessionLogFocus', { detail: { operationId } })
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ProgressBar({ op, className }: { op: Operation; className?: string }) {
  const pct = progressPercent(op);

  const countdownPct =
    op.status === 'countdown' &&
    op.countdownTotalSeconds != null &&
    op.countdownTotalSeconds > 0 &&
    op.countdownSecondsRemaining != null
      ? Math.round((op.countdownSecondsRemaining / op.countdownTotalSeconds) * 100)
      : undefined;

  const effectivePct = pct ?? countdownPct;
  const isIndeterminate = op.status === 'running' && effectivePct === undefined;

  // Suppress CSS transition when the operation changes OR when switching
  // from indeterminate to determinate (first progress report arrives).
  // Without this the bar animates from the indeterminate 30% width down
  // to the first real value (e.g. 5%), which looks wrong.
  const prevOpIdRef = useRef(op.id);
  const wasIndeterminateRef = useRef(isIndeterminate);
  const [suppressTransition, setSuppressTransition] = useState(false);
  useEffect(() => {
    const opChanged = op.id !== prevOpIdRef.current;
    const becameDeterminate = wasIndeterminateRef.current && !isIndeterminate;

    prevOpIdRef.current = op.id;
    wasIndeterminateRef.current = isIndeterminate;

    if (opChanged || becameDeterminate) {
      setSuppressTransition(true);
      const raf = requestAnimationFrame(() => setSuppressTransition(false));
      return () => cancelAnimationFrame(raf);
    }
  }, [op.id, isIndeterminate]);

  const barClass = [
    'ops-toast-bar',
    op.status === 'complete' ? 'complete' : '',
    op.status === 'error' ? 'error' : '',
    op.status === 'countdown' ? 'countdown' : '',
    isIndeterminate ? 'indeterminate' : '',
    suppressTransition ? 'no-transition' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="ops-toast-bar-container">
      <div className={barClass} style={effectivePct !== undefined ? { width: `${effectivePct}%` } : undefined} />
    </div>
  );
}

function SubSteps({ subSteps, max }: { subSteps: OperationSubStep[]; max?: number }) {
  const limit = max ?? subSteps.length;
  const visible = subSteps.slice(0, limit);
  const hidden = subSteps.length - visible.length;

  return (
    <div className="ops-toast-substeps">
      {visible.map((s, i) => (
        <div key={i} className="ops-toast-substep">
          {subStepIcon(s.status)}
          <span className="ops-toast-substep-label">
            {s.label}
            {s.detail ? ` — ${s.detail}` : ''}
          </span>
        </div>
      ))}
      {hidden > 0 && (
        <div className="ops-toast-substep ops-toast-substep-overflow">
          <span className="ops-toast-substep-label">and {hidden} more…</span>
        </div>
      )}
    </div>
  );
}

/** Primary (always-visible) row showing the most important active operation. */
function PrimaryRow({ op }: { op: Operation }) {
  const count = formatCount(op);

  const labelLines = op.label.split('\n');
  const mainLabel = labelLines[0];
  const detailLines = labelLines.slice(1);
  const progressDetail = op.progress?.detail;

  const isCountdown = op.status === 'countdown';
  const isNonTerminal = op.status !== 'complete' && op.status !== 'error' && op.status !== 'cancelled';

  const handlePauseResume = useCallback(() => {
    if (op.countdownPaused) {
      operationRegistryService.resumeCountdown(op.id);
    } else {
      operationRegistryService.pauseCountdown(op.id);
    }
  }, [op.id, op.countdownPaused]);

  return (
    <div className="ops-toast-primary">
      <div className="ops-toast-header">
        <span className="ops-toast-label" title={mainLabel}>
          {mainLabel}
          {isCountdown && op.countdownPaused && (
            <span className="ops-toast-paused-badge">paused</span>
          )}
        </span>
        <span className="ops-toast-meta">
          {isCountdown && op.countdownSecondsRemaining !== undefined && (
            <span>{op.countdownSecondsRemaining}s</span>
          )}
          {count && <span>{count}</span>}
          {isCountdown && (
            <>
              <span>·</span>
              <button className="ops-toast-cancel" onClick={handlePauseResume}>
                {op.countdownPaused ? 'Resume' : 'Pause'}
              </button>
            </>
          )}
          {op.cancellable && op.onCancel && isNonTerminal && (
            <>
              <span>·</span>
              <button className="ops-toast-cancel" onClick={op.onCancel}>Cancel</button>
            </>
          )}
          <button
            className="ops-toast-log-btn"
            onClick={() => openSessionLogForOperation(op.id)}
            title="View in session log"
          >
            ↗
          </button>
        </span>
      </div>
      {(detailLines.length > 0 || progressDetail) && (
        <div className="ops-toast-details">
          {detailLines.map((line, i) => (
            <div key={i} className="ops-toast-detail-line">{line}</div>
          ))}
          {progressDetail && (
            <div className="ops-toast-detail-line">{progressDetail}</div>
          )}
        </div>
      )}
      {op.subSteps && op.subSteps.length > 0 && <SubSteps subSteps={op.subSteps} max={MAX_VISIBLE_SUBSTEPS} />}
      {(op.status === 'running' || op.status === 'countdown') && <ProgressBar op={op} />}
    </div>
  );
}

/** A compact row in the expanded list for a single operation. */
function ListItem({ op, fade }: { op: Operation; fade: string }) {
  const pct = progressPercent(op);
  const isTerminal = op.status === 'complete' || op.status === 'error' || op.status === 'cancelled';

  return (
    <div className={`ops-toast-item ${fade}`}>
      {statusIcon(op.status)}
      <div className="ops-toast-item-body">
        <div className="ops-toast-item-label" title={op.label}>
          {op.label.split('\n')[0]}
          {op.status === 'countdown' && op.countdownSecondsRemaining !== undefined && (
            <span style={{ color: 'var(--text-secondary, #a0a0a0)', marginLeft: 6 }}>
              {op.countdownSecondsRemaining}s
            </span>
          )}
          {op.error && (
            <span style={{ color: '#ef4444', marginLeft: 6 }}>{op.error}</span>
          )}
          {isTerminal && op.action && (
            <button className="ops-toast-action-btn" onClick={op.action.onClick}>
              {op.action.label}
            </button>
          )}
        </div>
        {op.progress && op.progress.total > 0 && !isTerminal && (
          <div className="ops-toast-item-bar">
            <div
              className={`ops-toast-item-bar-fill ${op.status === 'complete' ? 'complete' : ''} ${op.status === 'error' ? 'error' : ''}`}
              style={{ width: `${pct ?? 0}%` }}
            />
          </div>
        )}
        {op.progress?.detail && (
          <div className="ops-toast-item-detail">{op.progress.detail}</div>
        )}
      </div>
      {!isTerminal && op.cancellable && op.onCancel && (
        <button className="ops-toast-cancel" onClick={op.onCancel} title="Cancel">✗</button>
      )}
      <button
        className="ops-toast-log-btn"
        onClick={() => openSessionLogForOperation(op.id)}
        title="View in session log"
      >
        ↗
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drag hook — lets user reposition the toast anywhere in the viewport
// ---------------------------------------------------------------------------

function useDrag(containerRef: React.RefObject<HTMLDivElement | null>) {
  // Store position as bottom + left to preserve bottom-anchoring (toast grows upward).
  const [offset, setOffset] = useState<{ left: number; bottom: number } | null>(null);
  const dragState = useRef<{ startX: number; startY: number; origLeft: number; origBottom: number } | null>(null);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    // Don't drag when clicking interactive elements
    const tag = (e.target as HTMLElement).tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'input') return;
    if ((e.target as HTMLElement).closest('button, a, input')) return;

    const el = containerRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left,
      origBottom: window.innerHeight - rect.bottom,
    };
    el.setPointerCapture(e.pointerId);
  }, [containerRef]);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const ds = dragState.current;
    if (!ds) return;

    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;

    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();

    // Clamp left so toast stays in viewport horizontally
    const left = Math.max(0, Math.min(window.innerWidth - rect.width, ds.origLeft + dx));
    // Clamp bottom (dy positive = mouse moved down = bottom decreases)
    const bottom = Math.max(0, Math.min(window.innerHeight - rect.height, ds.origBottom - dy));

    setOffset({ left, bottom });
  }, [containerRef]);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return;
    const el = containerRef.current;
    if (el) el.releasePointerCapture(e.pointerId);
    dragState.current = null;
  }, [containerRef]);

  const style: React.CSSProperties | undefined = offset
    ? { left: offset.left, bottom: offset.bottom, transform: 'none' }
    : undefined;

  return { style, onPointerDown, onPointerMove, onPointerUp };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function OperationsToast(): React.ReactElement | null {
  const { active, recent } = useOperations();
  const [now, setNow] = useState(Date.now);
  const [isHovered, setIsHovered] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const drag = useDrag(containerRef);

  // Reset dismissed flag when new operations arrive.
  const prevActiveLen = useRef(active.length);
  useEffect(() => {
    if (active.length > prevActiveLen.current) {
      setDismissed(false);
    }
    prevActiveLen.current = active.length;
  }, [active.length]);

  // Tick every second while there are recent items to manage fade timing.
  useEffect(() => {
    if (recent.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [recent.length]);

  // Filter recent to only those that should still be visible.
  const visibleRecent = recent.filter((o) => isVisible(o, now, isHovered));

  const primary = pickPrimary(active);
  const hasContent = active.length > 0 || visibleRecent.length > 0;

  // "Most recent completed" — shown in primary slot when no active ops.
  const recentCompletion = active.length === 0 ? visibleRecent[0] : undefined;

  const handleDismiss = useCallback(() => {
    operationRegistryService.clearRecent();
    setDismissed(true);
  }, []);

  const handleMouseEnter = useCallback(() => setIsHovered(true), []);
  const handleMouseLeave = useCallback(() => setIsHovered(false), []);

  // Build lists: other active ops (always visible) + recent (hover-only).
  const otherActive = active.filter((o) => o !== primary);

  // Actionable errors (e.g. "Resolve conflicts") must be always-visible,
  // not buried in the hover-only recent list where the button is unreachable.
  const actionableRecent = visibleRecent.filter((o) => o.status === 'error' && o.action);
  const nonActionableRecent = visibleRecent.filter((o) => !(o.status === 'error' && o.action));

  if (!hasContent || dismissed) return null;

  // Container-level fade: when only faded recent ops remain (no active, not hovered).
  const containerFade =
    active.length === 0 &&
    !isHovered &&
    visibleRecent.length > 0 &&
    visibleRecent.every((o) => {
      if (o.status === 'error') return false;
      return o.completedAtMs ? now - o.completedAtMs >= OPAQUE_HOLD_MS : false;
    })
      ? 'ops-toast-container-fading'
      : '';

  return (
    <div
      ref={containerRef}
      className={`ops-toast ${containerFade}`}
      style={drag.style}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
    >
      {/* Close button (visible on hover) */}
      <button
        className="ops-toast-close"
        onClick={handleDismiss}
        title="Dismiss"
      >
        ✕
      </button>

      {/* Other active operations + actionable errors — always visible */}
      {(otherActive.length > 0 || actionableRecent.length > 0) && (
        <div className="ops-toast-active-list">
          {otherActive.length > 0 && (
            <div className="ops-toast-list-header">
              <span>Active ({otherActive.length})</span>
            </div>
          )}
          {otherActive.map((op) => (
            <ListItem key={op.id} op={op} fade="" />
          ))}
          {actionableRecent.map((op) => (
            <ListItem key={op.id} op={op} fade="" />
          ))}
        </div>
      )}

      {/* Recent/completed — hover-only */}
      <div className="ops-toast-list">
        {nonActionableRecent.length > 0 && (
          <>
            <div className="ops-toast-list-header">
              <span>Recent</span>
            </div>
            {nonActionableRecent.map((op) => (
              <ListItem
                key={op.id}
                op={op}
                fade={fadeClass(op, now, isHovered)}
              />
            ))}
          </>
        )}
      </div>

      {/* Primary row — at the bottom, closest to the anchor point */}
      {primary && <PrimaryRow op={primary} />}
      {!primary && recentCompletion && <CompletionRow op={recentCompletion} />}
    </div>
  );
}

/** Brief completion display when no active ops remain. */
function CompletionRow({ op }: { op: Operation }) {
  const outcomeClass =
    op.status === 'error' ? 'has-errors' : op.status === 'cancelled' ? 'cancelled' : 'success';
  const icon = op.status === 'error' ? '⚠️' : op.status === 'cancelled' ? '⏹️' : '✅';

  const labelLines = op.label.split('\n');

  return (
    <div className={`ops-toast-completion ${outcomeClass}`}>
      <div className="ops-toast-completion-icon">{icon}</div>
      <div className="ops-toast-completion-content">
        <div className="ops-toast-completion-main">{labelLines[0]}</div>
        {labelLines.slice(1).map((line, i) => (
          <div key={i} className="ops-toast-completion-detail">{line}</div>
        ))}
        {op.error && <div className="ops-toast-completion-detail">{op.error}</div>}
        {op.action && (
          <button className="ops-toast-action-btn" onClick={op.action.onClick}>
            {op.action.label}
          </button>
        )}
      </div>
    </div>
  );
}
