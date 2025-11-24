/**
 * Pinned Query Modal
 * 
 * Modal for editing graph.dataInterestsDSL with live preview of implied slices.
 */

import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { explodeDSL, countAtomicSlices } from '../../lib/dslExplosion';
import { QueryExpressionEditor } from '../QueryExpressionEditor';
import './Modal.css';

interface PinnedQueryModalProps {
  isOpen: boolean;
  currentDSL: string;
  onSave: (newDSL: string) => void;
  onClose: () => void;
}

export function PinnedQueryModal({ isOpen, currentDSL, onSave, onClose }: PinnedQueryModalProps) {
  const [draftDSL, setDraftDSL] = useState(currentDSL);
  const [impliedSlices, setImpliedSlices] = useState<string[]>([]);
  const [sliceCount, setSliceCount] = useState(0);
  
  // Update draft when modal opens with new value
  useEffect(() => {
    if (isOpen) {
      setDraftDSL(currentDSL);
    }
  }, [isOpen, currentDSL]);
  
  // Calculate implied slices when draft changes
  useEffect(() => {
    const calculateSlices = async () => {
      if (!draftDSL) {
        setImpliedSlices([]);
        setSliceCount(0);
        return;
      }
      
      try {
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
  
  if (!isOpen) return null;
  
  const handleSave = () => {
    onSave(draftDSL);
    onClose();
  };
  
  return (
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
              height="120px"
              placeholder="context(key);context(key).window(start:end)"
              readonly={false}
            />
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
            <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0 0', maxHeight: '200px', overflowY: 'auto', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '4px', padding: '8px' }}>
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
    </div>
  );
}

