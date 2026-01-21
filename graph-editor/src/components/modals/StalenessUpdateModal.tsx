import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import './Modal.css';
import {
  STALENESS_NUDGE_RETRIEVE_ALL_SLICES_AFTER_MS,
  STALENESS_NUDGE_GIT_PULL_LAST_DONE_RED_AFTER_MS,
} from '../../constants/staleness';

// Inject countdown spinner animation if not already present
const COUNTDOWN_STYLE_ID = 'staleness-countdown-keyframes';
function ensureCountdownStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(COUNTDOWN_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = COUNTDOWN_STYLE_ID;
  style.textContent = `
    @keyframes staleness-countdown-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }
  `;
  document.head.appendChild(style);
}

export type StalenessUpdateActionKey = 'reload' | 'git-pull' | 'retrieve-all-slices';
export type StalenessUpdateActionStatus = 'due' | 'blocked' | 'unknown' | 'not_due';

export interface StalenessUpdateAction {
  key: StalenessUpdateActionKey;
  label: string;
  description: string;
  due: boolean;
  checked: boolean;
  disabled?: boolean;
  /** Optional richer status (preferred over boolean `due` when present). */
  status?: StalenessUpdateActionStatus;
  /** For display: last completion time (ms since epoch). */
  lastDoneAtMs?: number;
}

export interface StalenessUpdateModalProps {
  isOpen: boolean;
  title?: string;
  actions: StalenessUpdateAction[];
  automaticMode: boolean;
  onToggleAutomaticMode: (enabled: boolean) => void;
  onToggle: (key: StalenessUpdateActionKey) => void;
  onRun: () => void;
  onSnooze: () => void;
  /** Backdrop/× close action (wired by caller; we use this for Snooze semantics). */
  onClose: () => void;
  /** Explicit dismiss action (wired by caller; we use this for "dismiss until next remote commit"). */
  onDismiss: () => void;
  /** Countdown seconds remaining (undefined = no countdown active). */
  countdownSeconds?: number;
  /** Called when countdown expires (hook handles the auto-pull). */
  onCountdownExpire?: () => void;
}

/**
 * Single consolidated "freshness" modal.
 *
 * IMPORTANT: This component is UI-only (no business logic).
 */
export function StalenessUpdateModal({
  isOpen,
  title = 'Updates recommended',
  actions,
  automaticMode,
  onToggleAutomaticMode,
  onToggle,
  onRun,
  onSnooze,
  onClose,
  onDismiss,
  countdownSeconds,
}: StalenessUpdateModalProps) {
  if (!isOpen) return null;

  const nowMs = Date.now();

  const statusLabelFor = (a: StalenessUpdateAction): string => {
    const s = a.status ?? (a.due ? 'due' : 'not_due');
    if (s === 'due') return 'Due';
    if (s === 'blocked') return 'Blocked';
    if (s === 'unknown') return 'Unknown';
    return 'Not due';
  };

  const statusColourFor = (a: StalenessUpdateAction): string => {
    const s = a.status ?? (a.due ? 'due' : 'not_due');
    if (s === 'due') return '#b45309'; // amber
    if (s === 'blocked') return '#1f2937'; // dark grey
    if (s === 'unknown') return '#6b7280'; // grey
    return '#6b7280';
  };

  const anyChecked = actions.some(a => a.checked && !a.disabled);
  const anyDue = actions.some(a => (a.status ?? (a.due ? 'due' : 'not_due')) !== 'not_due');
  const reloadChecked = actions.some(a => a.key === 'reload' && a.checked && !a.disabled);
  const otherChecked = actions.some(a => a.key !== 'reload' && a.checked && !a.disabled);
  const gitPullDue = actions.some(a => a.key === 'git-pull' && a.due);
  const hasCountdown = countdownSeconds !== undefined && countdownSeconds > 0 && gitPullDue;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const formatDmyHm = (ms: number) => {
    const d = new Date(ms);
    const day = d.getDate();
    const mon = MONTHS[d.getMonth()] ?? 'Jan';
    const yy = String(d.getFullYear()).slice(-2);
    const hh = pad2(d.getHours());
    const mm = pad2(d.getMinutes());
    return `${day}-${mon}-${yy} ${hh}:${mm}`;
  };

  const lastDoneRedAfterMsFor = (key: StalenessUpdateActionKey): number => {
    // Reload is version-delta driven; "Loaded at" is informational only.
    // Never colour it as "stale by time" to avoid implying a time-based trigger.
    if (key === 'reload') return Number.POSITIVE_INFINITY;
    if (key === 'git-pull') return STALENESS_NUDGE_GIT_PULL_LAST_DONE_RED_AFTER_MS;
    return STALENESS_NUDGE_RETRIEVE_ALL_SLICES_AFTER_MS;
  };

  const lastDoneColourFor = (key: StalenessUpdateActionKey, lastDoneAtMs?: number): string => {
    if (key === 'reload') return '#6b7280'; // grey (informational only)
    if (!lastDoneAtMs) return '#6b7280'; // grey (unknown/never)
    const age = Math.max(0, nowMs - lastDoneAtMs);
    const redAfter = lastDoneRedAfterMsFor(key);
    if (age > redAfter) return '#dc2626'; // red
    if (age > redAfter / 2) return '#b45309'; // amber
    return '#059669'; // green
  };

  // Ensure countdown animation styles are injected
  useEffect(() => {
    if (hasCountdown) ensureCountdownStyles();
  }, [hasCountdown]);

  const modalContent = (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '640px' }}>
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {!anyDue ? (
            <p style={{ margin: 0, fontSize: 13, color: '#555' }}>
              Nothing is due right now.
            </p>
          ) : (
            <>
              {hasCountdown && (
                <div
                  style={{
                    marginBottom: 14,
                    padding: '12px 14px',
                    background: 'linear-gradient(135deg, #1e3a5f 0%, #0f2744 100%)',
                    borderRadius: 8,
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: '50%',
                      border: '3px solid rgba(255,255,255,0.3)',
                      borderTopColor: '#60a5fa',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 16,
                      fontWeight: 700,
                      fontVariantNumeric: 'tabular-nums',
                      animation: 'staleness-countdown-pulse 1s ease-in-out infinite',
                    }}
                  >
                    {countdownSeconds}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>
                      Auto-pulling from repository in {countdownSeconds}s
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>
                      New data is available. Snooze or dismiss to cancel.
                    </div>
                  </div>
                </div>
              )}

              <p style={{ marginTop: 0, marginBottom: 14, fontSize: 13, color: '#555', lineHeight: 1.4 }}>
                Select what you'd like to do now. Some defaults are pre-selected based on what appears due.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {actions.map((a) => (
                  <label
                    key={a.key}
                    style={{
                      display: 'flex',
                      gap: 12,
                      padding: '10px 12px',
                      border: '1px solid #e5e7eb',
                      borderRadius: 6,
                      background: a.due ? '#fff' : '#f9fafb',
                      opacity: a.disabled ? 0.55 : 1,
                      cursor: a.disabled ? 'not-allowed' : 'pointer',
                      alignItems: 'flex-start',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={a.checked}
                      onChange={() => onToggle(a.key)}
                      disabled={a.disabled}
                      style={{ marginTop: 2 }}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>
                          {a.label}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                          <div style={{ fontSize: 12, color: statusColourFor(a), whiteSpace: 'nowrap' }}>
                            {statusLabelFor(a)}
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: lastDoneColourFor(a.key, a.lastDoneAtMs),
                              whiteSpace: 'nowrap',
                              fontVariantNumeric: 'tabular-nums',
                            }}
                            title={
                              a.key === 'reload'
                                ? (a.lastDoneAtMs ? `Page loaded: ${formatDmyHm(a.lastDoneAtMs)}` : 'Page loaded: unknown')
                                : (a.lastDoneAtMs ? `Last done: ${formatDmyHm(a.lastDoneAtMs)}` : 'Last done: Never')
                            }
                          >
                            {a.key === 'reload' ? 'Loaded' : 'Last'}: {a.lastDoneAtMs ? formatDmyHm(a.lastDoneAtMs) : (a.key === 'reload' ? 'Unknown' : 'Never')}
                          </div>
                        </div>
                      </div>
                      <div style={{ marginTop: 4, fontSize: 13, color: '#4b5563', lineHeight: 1.35 }}>
                        {a.description}
                      </div>
                    </div>
                  </label>
                ))}
              </div>

              <div style={{ marginTop: 14, fontSize: 12, color: '#6b7280', lineHeight: 1.35 }}>
                {reloadChecked && otherChecked ? (
                  <>
                    Note: you selected <strong>Reload</strong> alongside other actions. DagNet will run the selected actions
                    <strong> first</strong>, then reload. Nothing will run automatically after the refresh.
                  </>
                ) : (
                  <>
                    Note: no actions run automatically after a refresh (F5). If you want updates, use <strong>Run selected</strong>.
                  </>
                )}
              </div>

              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #e5e7eb' }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={automaticMode}
                    onChange={(e) => onToggleAutomaticMode(e.target.checked)}
                    style={{ marginTop: 2 }}
                  />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
                      Automatic mode
                    </div>
                    <div style={{ marginTop: 2, fontSize: 12, color: '#6b7280', lineHeight: 1.35 }}>
                      If enabled, DagNet will run the selected actions in a headless way (no extra prompts/flows) for this run.
                      This setting does not persist across refresh.
                    </div>
                  </div>
                </label>
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="modal-btn modal-btn-secondary" onClick={onSnooze}>
            Snooze 1 hour
          </button>
          <button className="modal-btn modal-btn-secondary" onClick={onDismiss}>
            Dismiss
          </button>
          <button className="modal-btn modal-btn-primary" onClick={onRun} disabled={!anyChecked}>
            Run selected
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}


