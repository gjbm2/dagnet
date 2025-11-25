/**
 * Context Value Selector
 * 
 * Shared dropdown component for selecting context values.
 * Used in two modes:
 * - 'single-key': Per-chip dropdown for swapping values
 * - 'multi-key': Add Context dropdown with accordion sections
 */

import React, { useState } from 'react';
import type { ContextValue } from '../services/contextRegistry';
import './ContextValueSelector.css';

interface ContextKeySection {
  id: string;
  name: string;
  values: ContextValue[];
  otherPolicy?: 'null' | 'computed' | 'explicit' | 'undefined';
}

interface ContextValueSelectorProps {
  mode: 'single-key' | 'multi-key';
  contextKey?: string; // For single-key mode
  availableKeys?: ContextKeySection[]; // For multi-key mode
  availableValues?: ContextValue[]; // For single-key mode
  currentValues?: string[]; // Currently selected value IDs
  currentContextKey?: string; // For multi-key mode: which key is currently active
  onApply: (selectedKey: string, selectedValues: string[]) => void;
  onCancel: () => void;
  anchorEl?: HTMLElement | null;
  otherPolicy?: 'null' | 'computed' | 'explicit' | 'undefined'; // For single-key mode
  onShowAll?: () => Promise<ContextKeySection[]>; // Callback to load all contexts (not just pinned)
  showingAll?: boolean; // Whether we're currently showing all contexts
}

export function ContextValueSelector({
  mode,
  contextKey,
  availableKeys = [],
  availableValues = [],
  currentValues = [],
  currentContextKey,
  onApply,
  onCancel,
  anchorEl,
  otherPolicy,
  onShowAll,
  showingAll = false
}: ContextValueSelectorProps) {
  const [selectedValues, setSelectedValues] = useState<Set<string>>(
    new Set(currentValues)
  );
  
  // Initialize expanded sections based on current selection
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => {
    if (mode === 'multi-key' && currentContextKey) {
      // If there's a current selection, only expand that key
      return new Set([currentContextKey]);
    }
    return new Set();
  });
  
  const [activeKey, setActiveKey] = useState<string | null>(
    contextKey || currentContextKey || null
  );
  
  // Expand all sections when keys are loaded (only if no current selection)
  React.useEffect(() => {
    if (mode === 'multi-key' && availableKeys.length > 0 && expandedSections.size === 0 && !currentContextKey) {
      setExpandedSections(new Set(availableKeys.map(k => k.id)));
    }
  }, [mode, availableKeys, expandedSections.size, currentContextKey]);
  
  // Check if all values are selected for current mode
  const allValuesSelected = mode === 'single-key' 
    ? availableValues.length > 0 && selectedValues.size === availableValues.length
    : activeKey 
      ? (() => {
          const section = availableKeys.find(k => k.id === activeKey);
          return section && section.values.length > 0 && selectedValues.size === section.values.length;
        })()
      : false;
  
  // Check if current key/section is MECE (otherPolicy allows treating all-values as complete)
  const isMECE = mode === 'single-key'
    ? otherPolicy !== 'undefined'
    : activeKey
      ? (() => {
          const section = availableKeys.find(k => k.id === activeKey);
          return section?.otherPolicy !== 'undefined';
        })()
      : false;
  
  const handleToggle = (valueId: string, keyId: string) => {
    // When user selects from a different section: clear selections and switch active key
    if (activeKey !== keyId) {
      setActiveKey(keyId);
      // Collapse all other sections
      setExpandedSections(new Set([keyId]));
      // Start fresh with just this value selected
      setSelectedValues(new Set([valueId]));
      return;
    }
    
    // Same key: toggle value in existing selection
    const newSelected = new Set(selectedValues);
    if (newSelected.has(valueId)) {
      newSelected.delete(valueId);
    } else {
      newSelected.add(valueId);
    }
    setSelectedValues(newSelected);
  };
  
  const handleSectionToggle = (keyId: string) => {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(keyId)) {
      newExpanded.delete(keyId);
    } else {
      newExpanded.add(keyId);
    }
    setExpandedSections(newExpanded);
  };
  
  const handleApply = () => {
    if (mode === 'single-key' && contextKey) {
      onApply(contextKey, Array.from(selectedValues));
    } else if (mode === 'multi-key' && activeKey) {
      onApply(activeKey, Array.from(selectedValues));
    }
  };
  
  const handleCancel = () => {
    onCancel();
  };
  
  return (
    <div className={`context-value-selector context-value-selector-${mode}`}>
      {/* Header */}
      <div className="context-selector-header">
        {mode === 'single-key' && contextKey && (
          <span className="context-selector-title">
            {contextKey.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
            {allValuesSelected && isMECE && <span style={{ color: '#6B7280', fontWeight: 'normal' }}> (All)</span>}
          </span>
        )}
        {mode === 'multi-key' && (
          <span className="context-selector-title">Add Context</span>
        )}
      </div>
      
      {/* Value list - single-key mode */}
      {mode === 'single-key' && (
        <div className="context-selector-body">
          {availableValues.map(value => (
            <label 
              key={value.id} 
              className="context-value-option"
              style={{ opacity: allValuesSelected && isMECE ? 0.5 : 1 }}
            >
              <input
                type="checkbox"
                checked={selectedValues.has(value.id)}
                onChange={() => handleToggle(value.id, contextKey || '')}
                disabled={allValuesSelected && isMECE}
              />
              <span className="context-value-label">{value.label}</span>
            </label>
          ))}
        </div>
      )}
      
      {/* Accordion sections - multi-key mode */}
      {mode === 'multi-key' && (
        <div className="context-selector-body">
          {availableKeys.map(keySection => (
            <div key={keySection.id} className="context-key-section">
              <button
                className={`context-key-header ${expandedSections.has(keySection.id) ? 'expanded' : ''}`}
                onClick={() => handleSectionToggle(keySection.id)}
              >
                <span>{expandedSections.has(keySection.id) ? '▾' : '▸'}</span>
                <span>
                  {keySection.name}
                  {activeKey === keySection.id && allValuesSelected && keySection.otherPolicy !== 'undefined' && (
                    <span style={{ color: '#6B7280', fontWeight: 'normal' }}> (All)</span>
                  )}
                </span>
              </button>
              {expandedSections.has(keySection.id) && (
                <div className="context-key-values">
                  {keySection.values.map(value => {
                    const sectionAllSelected = activeKey === keySection.id && allValuesSelected;
                    const sectionIsMECE = keySection.otherPolicy !== 'undefined';
                    const shouldGrey = sectionAllSelected && sectionIsMECE;
                    
                    return (
                      <label 
                        key={value.id} 
                        className="context-value-option"
                        style={{ opacity: shouldGrey ? 0.5 : 1 }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedValues.has(value.id)}
                          onChange={() => handleToggle(value.id, keySection.id)}
                          disabled={shouldGrey}
                        />
                        <span className="context-value-label">{value.label}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
          
          {/* Show All button - only show if callback provided and not already showing all */}
          {onShowAll && !showingAll && (
            <button 
              className="context-show-all-button"
              onClick={async () => {
                const allSections = await onShowAll();
                // Expand all new sections
                setExpandedSections(new Set(allSections.map(s => s.id)));
              }}
            >
              Show all contexts...
            </button>
          )}
          {showingAll && (
            <div className="context-show-all-indicator">
              Showing all available contexts
            </div>
          )}
        </div>
      )}
      
      {/* Actions */}
      <div className="context-selector-actions">
        <button onClick={handleApply} className="context-selector-apply">
          Apply
        </button>
        <button onClick={handleCancel} className="context-selector-cancel">
          Cancel
        </button>
      </div>
    </div>
  );
}

