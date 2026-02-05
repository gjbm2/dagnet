/**
 * Pinned Query Modal
 * 
 * Modal for editing graph.dataInterestsDSL with live preview of implied slices.
 * Uses React Portal to render at document root (escapes parent stacking context).
 */

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { explodeDSL } from '../../lib/dslExplosion';
import { validatePinnedDataInterestsDSL } from '../../services/slicePlanValidationService';
import { QueryExpressionEditor } from '../QueryExpressionEditor';
import { QUERY_FUNCTIONS } from '../../lib/queryDSL';
import './Modal.css';

interface PinnedQueryModalProps {
  isOpen: boolean;
  currentDSL: string;
  dailyFetch: boolean;
  onSave: (newDSL: string, dailyFetch: boolean) => void;
  onClose: () => void;
}

export function PinnedQueryModal({ isOpen, currentDSL, dailyFetch, onSave, onClose }: PinnedQueryModalProps) {
  const [draftDSL, setDraftDSL] = useState(currentDSL);
  const [draftDailyFetch, setDraftDailyFetch] = useState(dailyFetch);
  const [impliedSlices, setImpliedSlices] = useState<string[]>([]);
  const [sliceCount, setSliceCount] = useState(0);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);
  
  // Update drafts when modal opens with new values
  useEffect(() => {
    if (isOpen) {
      setDraftDSL(currentDSL);
      setDraftDailyFetch(dailyFetch);
    }
  }, [isOpen, currentDSL, dailyFetch]);
  
  // Calculate implied slices when draft changes
  useEffect(() => {
    const calculateSlices = async () => {
      if (!draftDSL) {
        setImpliedSlices([]);
        setSliceCount(0);
        return;
      }
      
      try {
        // Use TypeScript DSL explosion (local, fast)
        const slices = await explodeDSL(draftDSL);
        setImpliedSlices(slices.slice(0, 20)); // Show first 20
        setSliceCount(slices.length);
      } catch (err) {
        console.error('Failed to explode DSL:', err);
        setImpliedSlices([]);
        setSliceCount(0);
      }
    };
    
    calculateSlices();
  }, [draftDSL]);

  // Live (non-blocking) validation warnings for pinned DSL while editing.
  // UI is a pure access point: all logic lives in slicePlanValidationService.
  useEffect(() => {
    if (!isOpen) {
      setValidationWarnings([]);
      return;
    }

    let cancelled = false;
    const handle = window.setTimeout(() => {
      validatePinnedDataInterestsDSL(draftDSL)
        .then((res) => {
          if (cancelled) return;
          setValidationWarnings(res.warnings);
        })
        .catch((e) => {
          // Warnings are advisory only; never block typing.
          console.warn('[PinnedQueryModal] Failed to validate pinned DSL:', e);
          if (!cancelled) setValidationWarnings([]);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [draftDSL, isOpen]);
  
  if (!isOpen) return null;
  
  const handleSave = () => {
    onSave(draftDSL, draftDailyFetch);
    onClose();
  };
  
  // Use portal to escape parent stacking context (WindowSelector has z-index: 55)
  // This ensures modal appears above sidebar (z-index: 100)
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '700px' }}>
        <div className="modal-header">
          <h2 className="modal-title">Pinned Data Interests</h2>
          <button onClick={onClose} className="modal-close-btn">
            <X size={20} />
          </button>
        </div>
        
        <div className="modal-body">
          <p style={{ marginBottom: '16px', fontSize: '13px', color: '#6B7280', lineHeight: '1.5' }}>
            Controls which context slices are fetched automatically overnight and suggested in the Context dropdown.
            Use semicolons to separate multiple clauses. Example: <code>context(channel);context(browser-type).window(-90d:)</code>
          </p>
          
          <div style={{ marginBottom: '16px' }}>
            <QueryExpressionEditor
              value={draftDSL}
              onChange={(value) => setDraftDSL(value)}
              graph={null}
              allowedFunctions={[...new Set(['or', ...QUERY_FUNCTIONS])]}
              height="120px"
              placeholder="context(key);context(key).window(start:end)"
              readonly={false}
            />
            {validationWarnings.length > 0 && (
              <div
                style={{
                  marginTop: '10px',
                  padding: '10px 12px',
                  background: '#FEF3C7',
                  border: '1px solid #FDE047',
                  borderRadius: '4px',
                  fontSize: '12px',
                  color: '#854D0E',
                  lineHeight: '1.4',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: '6px' }}>Warnings</div>
                <ul style={{ margin: 0, paddingLeft: '16px' }}>
                  {validationWarnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            <div style={{ fontSize: '11px', color: '#6B7280', marginTop: '4px', fontFamily: 'monospace' }}>
              💡 Tip: Use ; or or() for alternatives. Examples:<br/>
              • <code>context(channel);context(browser-type)</code><br/>
              • <code>or(context(channel:google),context(channel:meta)).window(1-Jan-25:31-Dec-25)</code><br/>
              • <code>(context(channel);context(browser)).window(-90d:)</code>
            </div>
          </div>
          
          <div>
            <strong style={{ display: 'block', marginBottom: '8px', fontSize: '13px', color: '#374151' }}>
              Implied slices: {sliceCount}
            </strong>
            {sliceCount > 500 && (
              <div style={{ padding: '8px 12px', marginBottom: '8px', background: '#FEE2E2', border: '1px solid #FCA5A5', borderRadius: '4px', fontSize: '12px', color: '#991B1B' }}>
                ⚠️ Warning: {sliceCount} slices exceeds recommended limit (500)
              </div>
            )}
            {sliceCount > 50 && sliceCount <= 500 && (
              <div style={{ padding: '8px 12px', marginBottom: '8px', background: '#FEF3C7', border: '1px solid #FDE047', borderRadius: '4px', fontSize: '12px', color: '#854D0E' }}>
                ⚠️ Note: {sliceCount} slices may impact nightly run performance
              </div>
            )}
            <ul style={{ listStyle: 'none', padding: '8px', margin: '8px 0 0 0', maxHeight: '200px', overflowY: 'auto', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '4px' }}>
              {impliedSlices.map((slice, i) => (
                <li key={i} style={{ padding: '4px 0', fontSize: '12px', fontFamily: 'Monaco, monospace', color: '#374151' }}>{slice}</li>
              ))}
              {sliceCount > 20 && (
                <li style={{ padding: '4px 0', fontStyle: 'italic', color: '#6B7280', fontSize: '12px' }}>
                  ... and {sliceCount - 20} more slices
                </li>
              )}
            </ul>
          </div>
          
          <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #E5E7EB' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={draftDailyFetch}
                onChange={(e) => setDraftDailyFetch(e.target.checked)}
                style={{ width: '16px', height: '16px' }}
              />
              <span style={{ fontSize: '13px', color: '#374151', fontWeight: 500 }}>
                Fetch daily
              </span>
            </label>
            <p style={{ fontSize: '11px', color: '#6B7280', marginTop: '4px', marginLeft: '24px' }}>
              Include this graph in unattended nightly automation runs (when using <code style={{ background: '#F3F4F6', padding: '1px 4px', borderRadius: '2px' }}>?retrieveall</code> without specifying graph names)
            </p>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="modal-btn modal-btn-secondary">
            Cancel
          </button>
          <button onClick={handleSave} className="modal-btn modal-btn-primary">
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

