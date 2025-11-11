/**
 * Parameter Editor Component
 * 
 * Generalized component for parameter editing in context menus.
 * Handles ALL parameter types: probability, conditional_p, variant_weight.
 * 
 * Wraps ProbabilityInput/VariantWeightInput in AutomatableField.
 * Handles override flags and rebalancing via UpdateManager.
 */

import React from 'react';
import ProbabilityInput from './ProbabilityInput';
import VariantWeightInput from './VariantWeightInput';
import { AutomatableField } from './AutomatableField';

interface ParameterEditorProps {
  // Parameter data
  value: number;
  overridden: boolean;
  isUnbalanced?: boolean;
  
  // Parameter type determines UI
  paramType: 'probability' | 'conditional_p' | 'variant_weight';
  
  // Context
  graph: any;
  objectId: string; // edgeId or nodeId
  paramSlot?: 'p' | 'cost_gbp' | 'cost_time';
  conditionalIndex?: number; // For conditional_p
  variantIndex?: number; // For variant weights
  allVariants?: any[]; // For variant weights
  
  // Handlers
  onCommit: (value: number) => void;
  onChange?: (value: number) => void; // Optional: for onChange without history (if not provided, uses onCommit)
  onRebalance?: () => void;
  onClearOverride: () => void;
  
  // Display
  label?: string;
  conditionDisplay?: string; // For conditional_p
  disabled?: boolean;
  onClose?: () => void;
}

/**
 * ParameterEditor - Generalized parameter editing component for context menus
 * 
 * Handles ALL parameter types with zero special cases.
 * Uses UpdateManager for rebalancing (preserves origin value).
 */
export function ParameterEditor({
  value,
  overridden,
  isUnbalanced = false,
  paramType,
  graph,
  objectId,
  paramSlot,
  conditionalIndex,
  variantIndex,
  allVariants = [],
  onCommit,
  onChange,
  onRebalance,
  onClearOverride,
  label,
  conditionDisplay,
  disabled = false,
  onClose
}: ParameterEditorProps) {
  
  if (paramType === 'variant_weight') {
    return (
      <AutomatableField
        label={label || `Variant Weight`}
        value={value}
        overridden={overridden}
        onClearOverride={onClearOverride}
      >
        <VariantWeightInput
          value={value}
          onChange={(newValue) => {
            // Update graph immediately while dragging (no history)
            if (onChange) {
              onChange(newValue);
            } else {
              onCommit(newValue); // Fallback if onChange not provided
            }
          }}
          onCommit={onCommit}
          onRebalance={onRebalance ? async (ignoredValue: number, ignoredIdx: number, ignoredVars: any[]) => {
            // Ignore all args - handler uses current graph value
            await onRebalance();
          } : () => {}}
          onClose={onClose}
          currentIndex={variantIndex ?? 0}
          allVariants={allVariants}
          autoFocus={false}
          autoSelect={false}
          showSlider={true}
          showBalanceButton={true}
        />
      </AutomatableField>
    );
  }
  
  // Probability or conditional_p
  return (
    <div style={{ marginBottom: paramType === 'conditional_p' ? '8px' : '12px', padding: paramType === 'conditional_p' ? '6px' : '0', border: paramType === 'conditional_p' ? '1px solid #eee' : 'none', borderRadius: paramType === 'conditional_p' ? '3px' : '0' }}>
      {paramType === 'conditional_p' && conditionDisplay && (
        <div style={{ fontSize: '10px', color: '#666', marginBottom: '4px' }}>
          Condition: {conditionDisplay}
        </div>
      )}
      <AutomatableField
        label={label || (paramType === 'conditional_p' ? 'Conditional Probability' : 'Probability')}
        value={value}
        overridden={overridden}
        onClearOverride={onClearOverride}
      >
        <ProbabilityInput
          value={value}
          onChange={(newValue) => {
            // Update graph immediately while dragging (provides real-time feedback)
            // NO history entry - only visual update
            if (onChange) {
              onChange(newValue);
            } else {
              onCommit(newValue); // Fallback if onChange not provided
            }
          }}
          onCommit={onCommit}
          onRebalance={onRebalance ? async (ignoredValue: number) => {
            // Ignore value from ProbabilityInput - handler uses current graph value
            // ProbabilityInput calls onRebalance(value), but we don't need it
            if (onRebalance) {
              await onRebalance();
            }
          } : undefined}
          isUnbalanced={isUnbalanced}
          showBalanceButton={paramType === 'conditional_p' || paramType === 'probability'}
          onClose={onClose}
          autoFocus={false}
          autoSelect={false}
          showSlider={true}
          disabled={disabled}
        />
      </AutomatableField>
    </div>
  );
}

