import React from 'react';
import { createPortal } from 'react-dom';
import './Modal.css';

export type StalenessUpdateActionKey = 'reload' | 'git-pull' | 'retrieve-all-slices';

export interface StalenessUpdateAction {
  key: StalenessUpdateActionKey;
  label: string;
  description: string;
  due: boolean;
  checked: boolean;
  disabled?: boolean;
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
  onClose: () => void;
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
}: StalenessUpdateModalProps) {
  if (!isOpen) return null;

  const anyChecked = actions.some(a => a.checked && !a.disabled);
  const anyDue = actions.some(a => a.due);
  const reloadChecked = actions.some(a => a.key === 'reload' && a.checked && !a.disabled);
  const otherChecked = actions.some(a => a.key !== 'reload' && a.checked && !a.disabled);

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
              <p style={{ marginTop: 0, marginBottom: 14, fontSize: 13, color: '#555', lineHeight: 1.4 }}>
                Select what you’d like to do now. Defaults are pre-selected based on what appears due.
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
                        <div style={{ fontSize: 12, color: a.due ? '#b45309' : '#6b7280', whiteSpace: 'nowrap' }}>
                          {a.due ? 'Due' : 'Not due'}
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
          <button className="modal-btn modal-btn-secondary" onClick={onClose}>
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


