/**
 * To Base Confirm Modal
 * 
 * Confirmation modal shown before "To Base" operation when some live scenarios
 * require data fetch (not cached).
 * 
 * Design Reference: docs/current/project-live-scenarios/design.md §4.4
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle, Download } from 'lucide-react';
import './Modal.css';

interface ToBaseConfirmModalProps {
  isOpen: boolean;
  scenariosNeedingFetch: number;
  totalLiveScenarios: number;
  newBaseDSL: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ToBaseConfirmModal({
  isOpen,
  scenariosNeedingFetch,
  totalLiveScenarios,
  newBaseDSL,
  onConfirm,
  onCancel,
}: ToBaseConfirmModalProps) {
  if (!isOpen) return null;

  const allCached = scenariosNeedingFetch === 0;

  return createPortal(
    <div className="modal-overlay" onClick={onCancel}>
      <div 
        className="modal-container" 
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '480px' }}
      >
        <div className="modal-header">
          <h2 className="modal-title">
            {allCached ? 'Update Base DSL' : 'Confirm Base Update'}
          </h2>
          <button onClick={onCancel} className="modal-close-btn">
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          {/* Warning if fetch needed */}
          {!allCached && (
            <div style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '12px',
              padding: '12px 14px',
              marginBottom: '16px',
              background: '#FEF3C7',
              border: '1px solid #FCD34D',
              borderRadius: '6px',
            }}>
              <AlertTriangle size={20} style={{ color: '#D97706', flexShrink: 0, marginTop: '2px' }} />
              <div style={{ fontSize: '13px', color: '#92400E' }}>
                <strong>{scenariosNeedingFetch} of {totalLiveScenarios}</strong> live scenarios 
                require data fetch from external sources.
                <p style={{ margin: '6px 0 0 0', fontSize: '12px', color: '#A16207' }}>
                  This may take a moment depending on the data sources.
                </p>
              </div>
            </div>
          )}

          {/* New Base DSL preview */}
          <div style={{ marginBottom: '16px' }}>
            <label style={{ 
              display: 'block', 
              fontSize: '12px', 
              fontWeight: 500, 
              color: '#6B7280',
              marginBottom: '6px' 
            }}>
              New Base DSL:
            </label>
            <div style={{
              padding: '10px 12px',
              background: '#F9FAFB',
              border: '1px solid #E5E7EB',
              borderRadius: '4px',
              fontFamily: 'Monaco, Menlo, monospace',
              fontSize: '12px',
              color: '#374151',
              wordBreak: 'break-all',
            }}>
              {newBaseDSL || <span style={{ color: '#9CA3AF', fontStyle: 'italic' }}>No DSL</span>}
            </div>
          </div>

          {/* Summary */}
          <div style={{ fontSize: '13px', color: '#4B5563' }}>
            This will:
            <ul style={{ margin: '8px 0 0 0', paddingLeft: '20px' }}>
              <li>Set the Base DSL to the current query</li>
              <li>Regenerate all {totalLiveScenarios} live scenario{totalLiveScenarios !== 1 ? 's' : ''}</li>
              {!allCached && (
                <li style={{ color: '#D97706' }}>
                  <Download size={12} style={{ display: 'inline', marginRight: '4px' }} />
                  Fetch fresh data for {scenariosNeedingFetch} scenario{scenariosNeedingFetch !== 1 ? 's' : ''}
                </li>
              )}
            </ul>
          </div>
        </div>

        <div className="modal-footer">
          <button onClick={onCancel} className="modal-btn modal-btn-secondary">
            Cancel
          </button>
          <button onClick={onConfirm} className="modal-btn modal-btn-primary">
            {allCached ? 'Update Base' : 'Update & Fetch'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default ToBaseConfirmModal;

