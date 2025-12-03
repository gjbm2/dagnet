/**
 * BulkScenarioCreationModal
 * 
 * Modal for creating multiple live scenarios at once from a context key.
 * Shows a checkbox list of values with fetch indicators for those needing API calls.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, RefreshCw, Zap } from 'lucide-react';
import { fetchDataService } from '../../services/fetchDataService';
import { useGraphStore } from '../../contexts/GraphStoreContext';
import './Modal.css';

interface ContextValue {
  id: string;
  label: string;
}

interface BulkScenarioCreationModalProps {
  isOpen: boolean;
  contextKey: string;
  values: ContextValue[];
  baseDSL?: string;
  onClose: () => void;
  onCreate: (selectedValues: string[]) => void;
}

export function BulkScenarioCreationModal({
  isOpen,
  contextKey,
  values,
  baseDSL = '',
  onClose,
  onCreate
}: BulkScenarioCreationModalProps) {
  const graphStore = useGraphStore();
  const graph = graphStore?.getState().graph || null;
  
  // Selected values (starts with all selected)
  const [selectedValues, setSelectedValues] = useState<Set<string>>(new Set());
  // Fetch status for each value: true = needs fetch, false = cached
  const [fetchStatus, setFetchStatus] = useState<Record<string, boolean>>({});
  const [isChecking, setIsChecking] = useState(true);
  const [isCreating, setIsCreating] = useState(false);

  // Generate DSL for a context value
  const generateDSL = useCallback((valueId: string): string => {
    const contextPart = `context(${contextKey}:${valueId})`;
    return baseDSL ? `${baseDSL}.${contextPart}` : contextPart;
  }, [contextKey, baseDSL]);

  // Check cache status for all values on mount
  useEffect(() => {
    if (!isOpen || values.length === 0 || !graph) return;
    
    const checkCacheStatus = async () => {
      setIsChecking(true);
      
      const dsls = values.map(v => generateDSL(v.id));
      const results = fetchDataService.checkMultipleDSLsNeedFetch(dsls, graph);
      
      const status: Record<string, boolean> = {};
      results.forEach((result, idx) => {
        status[values[idx].id] = result.needsFetch;
      });
      
      setFetchStatus(status);
      // Select all by default
      setSelectedValues(new Set(values.map(v => v.id)));
      setIsChecking(false);
    };
    
    checkCacheStatus();
  }, [isOpen, values, graph, generateDSL]);

  // Count stats
  const selectedCount = selectedValues.size;
  const selectedNeedingFetch = useMemo(() => 
    Array.from(selectedValues).filter(v => fetchStatus[v]).length,
    [selectedValues, fetchStatus]
  );

  // Toggle selection
  const toggleValue = useCallback((valueId: string) => {
    setSelectedValues(prev => {
      const next = new Set(prev);
      if (next.has(valueId)) {
        next.delete(valueId);
      } else {
        next.add(valueId);
      }
      return next;
    });
  }, []);

  // Select all / none
  const selectAll = useCallback(() => {
    setSelectedValues(new Set(values.map(v => v.id)));
  }, [values]);

  const selectNone = useCallback(() => {
    setSelectedValues(new Set());
  }, []);

  // Select only cached
  const selectCached = useCallback(() => {
    setSelectedValues(new Set(values.filter(v => !fetchStatus[v.id]).map(v => v.id)));
  }, [values, fetchStatus]);

  // Handle create
  const handleCreate = useCallback(async () => {
    if (selectedCount === 0) return;
    
    setIsCreating(true);
    try {
      onCreate(Array.from(selectedValues));
      onClose();
    } finally {
      setIsCreating(false);
    }
  }, [selectedValues, selectedCount, onCreate, onClose]);

  // Handle cancel
  const handleCancel = useCallback(() => {
    if (isCreating) return;
    onClose();
  }, [isCreating, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && handleCancel()}>
      <div 
        className="modal-container" 
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '480px' }}
      >
        {/* Header */}
        <div className="modal-header">
          <h2 className="modal-title">
            Create Scenarios for '{contextKey}'
          </h2>
          <button onClick={handleCancel} className="modal-close-btn" disabled={isCreating}>
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="modal-body" style={{ maxHeight: '400px' }}>
          {isChecking ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#6B7280', padding: '20px' }}>
              <RefreshCw size={16} className="spin" />
              Checking cache status...
            </div>
          ) : (
            <>
              {/* Selection controls */}
              <div style={{ 
                display: 'flex', 
                gap: '8px', 
                marginBottom: '12px',
                fontSize: '12px'
              }}>
                <button
                  onClick={selectAll}
                  style={{
                    all: 'unset',
                    cursor: 'pointer',
                    color: '#3B82F6',
                    textDecoration: 'underline'
                  }}
                >
                  Select all
                </button>
                <span style={{ color: '#9CA3AF' }}>|</span>
                <button
                  onClick={selectNone}
                  style={{
                    all: 'unset',
                    cursor: 'pointer',
                    color: '#3B82F6',
                    textDecoration: 'underline'
                  }}
                >
                  Select none
                </button>
                {Object.values(fetchStatus).some(v => !v) && (
                  <>
                    <span style={{ color: '#9CA3AF' }}>|</span>
                    <button
                      onClick={selectCached}
                      style={{
                        all: 'unset',
                        cursor: 'pointer',
                        color: '#3B82F6',
                        textDecoration: 'underline'
                      }}
                    >
                      Cached only
                    </button>
                  </>
                )}
              </div>

              {/* Value list */}
              <div style={{ 
                border: '1px solid #E5E7EB',
                borderRadius: '6px',
                overflow: 'hidden'
              }}>
                {values.map((value, idx) => {
                  const isSelected = selectedValues.has(value.id);
                  const needsFetch = fetchStatus[value.id];
                  
                  return (
                    <div
                      key={value.id}
                      onClick={() => toggleValue(value.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        padding: '10px 12px',
                        cursor: 'pointer',
                        backgroundColor: isSelected ? '#F0F9FF' : 'transparent',
                        borderTop: idx > 0 ? '1px solid #E5E7EB' : 'none',
                        transition: 'background-color 0.1s'
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) e.currentTarget.style.backgroundColor = '#F9FAFB';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = isSelected ? '#F0F9FF' : 'transparent';
                      }}
                    >
                      {/* Checkbox */}
                      <div style={{
                        width: '18px',
                        height: '18px',
                        borderRadius: '4px',
                        border: isSelected ? 'none' : '2px solid #D1D5DB',
                        backgroundColor: isSelected ? '#3B82F6' : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0
                      }}>
                        {isSelected && <Check size={14} color="white" strokeWidth={3} />}
                      </div>
                      
                      {/* Label */}
                      <span style={{ 
                        flex: 1, 
                        fontSize: '14px',
                        color: '#374151'
                      }}>
                        {value.label || value.id}
                      </span>
                      
                      {/* Fetch indicator */}
                      {needsFetch && (
                        <span style={{
                          fontSize: '11px',
                          color: '#9CA3AF',
                          backgroundColor: '#F3F4F6',
                          padding: '2px 6px',
                          borderRadius: '4px'
                        }}>
                          fetch
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Summary */}
              {selectedCount > 0 && selectedNeedingFetch > 0 && (
                <p style={{
                  fontSize: '12px',
                  color: '#6B7280',
                  marginTop: '12px',
                  marginBottom: 0
                }}>
                  {selectedNeedingFetch} of {selectedCount} scenarios will require data fetch.
                </p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button
            onClick={handleCancel}
            className="modal-btn modal-btn-secondary"
            disabled={isCreating}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            className="modal-btn modal-btn-primary"
            disabled={isChecking || selectedCount === 0 || isCreating}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            {isCreating ? 'Creating...' : (
              <>
                Create {selectedCount} <Zap size={12} style={{ color: 'currentColor' }} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

