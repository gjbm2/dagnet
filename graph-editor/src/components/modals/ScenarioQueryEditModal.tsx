/**
 * Scenario Query Edit Modal
 * 
 * Modal for editing a live scenario's queryDSL.
 * REUSES the existing QueryExpressionEditor component.
 * 
 * Shows:
 * - Editable DSL input (via QueryExpressionEditor)
 * - Read-only preview of effective DSL (inherited base + editing)
 * - Save & Refresh / Cancel buttons
 */

import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertCircle, Info } from 'lucide-react';
import { QueryExpressionEditor } from '../QueryExpressionEditor';
import { computeEffectiveFetchDSL } from '../../services/scenarioRegenerationService';
import './Modal.css';

interface ScenarioQueryEditModalProps {
  isOpen: boolean;
  scenarioName: string;
  currentDSL: string;
  inheritedDSL: string;  // The DSL inherited from base + lower live scenarios
  onSave: (newDSL: string) => void;
  onClose: () => void;
}

export function ScenarioQueryEditModal({ 
  isOpen, 
  scenarioName,
  currentDSL, 
  inheritedDSL,
  onSave, 
  onClose 
}: ScenarioQueryEditModalProps) {
  const [draftDSL, setDraftDSL] = useState(currentDSL);
  
  // Update draft when modal opens with new value
  useEffect(() => {
    if (isOpen) {
      setDraftDSL(currentDSL);
    }
  }, [isOpen, currentDSL]);
  
  // Compute effective DSL preview
  const effectiveDSL = useMemo(() => {
    if (!draftDSL) return inheritedDSL || '';
    return computeEffectiveFetchDSL(inheritedDSL, draftDSL);
  }, [draftDSL, inheritedDSL]);
  
  // Check if DSL has changed
  const hasChanges = draftDSL !== currentDSL;
  
  if (!isOpen) return null;
  
  const handleSave = () => {
    onSave(draftDSL);
    onClose();
  };
  
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
    // Cmd/Ctrl+Enter to save
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && hasChanges) {
      handleSave();
    }
  };
  
  // Use portal to escape parent stacking context
  return createPortal(
    <div className="modal-overlay" onClick={onClose} onKeyDown={handleKeyDown}>
      <div 
        className="modal-container" 
        onClick={(e) => e.stopPropagation()} 
        style={{ maxWidth: '600px' }}
      >
        <div className="modal-header">
          <h2 className="modal-title">Edit Live Scenario Query</h2>
          <button onClick={onClose} className="modal-close-btn">
            <X size={20} />
          </button>
        </div>
        
        <div className="modal-body">
          {/* Scenario name */}
          <div style={{ marginBottom: '16px' }}>
            <span style={{ fontSize: '13px', color: '#6B7280' }}>Scenario: </span>
            <span style={{ fontSize: '14px', fontWeight: 500, color: '#374151' }}>{scenarioName}</span>
          </div>
          
          {/* Hint */}
          <div style={{ 
            display: 'flex', 
            alignItems: 'flex-start', 
            gap: '8px', 
            padding: '10px 12px', 
            marginBottom: '16px', 
            background: '#F0F9FF', 
            border: '1px solid #BAE6FD', 
            borderRadius: '6px',
            fontSize: '12px',
            color: '#0369A1'
          }}>
            <Info size={16} style={{ flexShrink: 0, marginTop: '1px' }} />
            <div>
              <strong>Scenario DSL Fragment</strong>
              <p style={{ margin: '4px 0 0 0' }}>
                This DSL is combined with the inherited base DSL. You can specify:
              </p>
              <ul style={{ margin: '4px 0 0 0', paddingLeft: '16px' }}>
                <li><code>window()</code> — override time window</li>
                <li><code>context()</code> — override context filters</li>
                <li><code>case()</code>, <code>visited()</code> — what-if conditions</li>
              </ul>
            </div>
          </div>
          
          {/* DSL Editor */}
          <div className="modal-field">
            <label className="modal-label">Query DSL</label>
            <QueryExpressionEditor
              value={draftDSL}
              onChange={(value) => setDraftDSL(value)}
              graph={null}
              height="100px"
              placeholder="e.g., window(-7d:-1d) or context(channel:google)"
              readonly={false}
            />
          </div>
          
          {/* Effective DSL Preview */}
          <div className="modal-field">
            <label className="modal-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              Effective DSL (Preview)
              <span style={{ fontWeight: 'normal', fontSize: '11px', color: '#9CA3AF' }}>
                = inherited + your fragment
              </span>
            </label>
            <div style={{
              padding: '10px 12px',
              background: '#F9FAFB',
              border: '1px solid #E5E7EB',
              borderRadius: '4px',
              fontFamily: 'Monaco, Menlo, monospace',
              fontSize: '12px',
              color: '#374151',
              minHeight: '40px',
              wordBreak: 'break-all'
            }}>
              {effectiveDSL || <span style={{ color: '#9CA3AF', fontStyle: 'italic' }}>No DSL</span>}
            </div>
          </div>
          
          {/* Inherited DSL info */}
          {inheritedDSL && (
            <div style={{ 
              fontSize: '11px', 
              color: '#6B7280',
              marginTop: '8px'
            }}>
              <strong>Inherited from base:</strong>{' '}
              <code style={{ background: '#F3F4F6', padding: '2px 4px', borderRadius: '2px' }}>
                {inheritedDSL}
              </code>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="modal-btn modal-btn-secondary">
            Cancel
          </button>
          <button 
            onClick={handleSave} 
            className="modal-btn modal-btn-primary"
            disabled={!hasChanges}
            title={hasChanges ? 'Save changes and refresh scenario' : 'No changes to save'}
          >
            Save & Refresh
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default ScenarioQueryEditModal;

