import React, { useState } from 'react';
import { Info } from 'lucide-react';
import { EnhancedSelector } from './EnhancedSelector';
import { QueryExpressionEditor } from './QueryExpressionEditor';
import { AutomatableField } from './AutomatableField';
import { ParameterSection } from './ParameterSection';
import { ColorSelector } from './ColorSelector';
import { CONDITIONAL_COLOR_PALETTE, getConditionalColor } from '@/lib/conditionalColors';
import './ConditionalProbabilityEditor.css';

// Match the updated graph schema structure
interface ConditionalCondition {
  // Semantic constraint: WHEN this conditional applies (runtime evaluation)
  condition: string;  // "visited(promo)" or "context(device:mobile)"
  
  // Full data retrieval query: HOW to fetch data from external sources
  query?: string;  // "from(checkout).to(purchase).visited(promo)"
  query_overridden?: boolean;  // If true, don't regenerate via MSMDC
  
  // Probability data
  p: {
    mean?: number;
    stdev?: number;
    distribution?: string;
    mean_overridden?: boolean;
    stdev_overridden?: boolean;
    distribution_overridden?: boolean;
    locked?: boolean;
    parameter_id?: string;
  };
  
  // Display color for this condition
  color?: string;
}

interface ConditionalProbabilityEditorProps {
  /** Current list of conditions */
  conditions: ConditionalCondition[];
  /** Callback when conditions change */
  onChange: (conditions: ConditionalCondition[]) => void;
  /** Current graph for node selection */
  graph?: any;
  /** Edge ID for query auto-generation context */
  edgeId?: string;
  /** Edge object (for color picker) */
  edge?: any;
  /** Callback when parameter updates (for individual conditional param) */
  onUpdateParam?: (index: number, changes: any) => void;
  /** Callback for rebalancing conditional probabilities */
  onRebalanceParam?: (index: number) => void;
  /** Map of condition index to whether it's unbalanced */
  isConditionalUnbalanced?: Map<number, boolean>;
  /** Callback when condition color changes (index, color) */
  onUpdateConditionColor?: (index: number, color: string | undefined) => Promise<void>;
  /** Callback when condition is removed (for UpdateManager integration) */
  onRemoveCondition?: (index: number) => Promise<void>;
}

/**
 * Conditional Probability Editor Component
 * 
 * Manages conditional probabilities for edges using QueryExpressionEditor.
 * 
 * Features:
 * - Add/remove condition cards
 * - Monaco-based condition editor (semantic constraints)
 * - Monaco-based query editor (full retrieval path)
 * - Parameter connection per condition
 * - OR logic between conditions (top-to-bottom evaluation)
 */
export function ConditionalProbabilityEditor({
  conditions,
  onChange,
  graph,
  edgeId,
  edge,
  onUpdateParam,
  onRebalanceParam,
  isConditionalUnbalanced,
  onUpdateConditionColor,
  onRemoveCondition
}: ConditionalProbabilityEditorProps) {
  const [expandedConditionIndex, setExpandedConditionIndex] = useState<number | null>(null);
  
  // Local state for condition/query editing (prevent eager updates)
  const [localConditions, setLocalConditions] = useState<{[index: number]: {condition: string; query: string}}>({});

  const addCondition = () => {
    onChange([
      ...conditions,
      {
        condition: '',  // Empty condition (user will fill in)
        query: '',      // Empty query (will be auto-generated or manually set)
        query_overridden: false,
        p: { mean: 0.5 }  // Default probability parameter with mean
      }
    ]);
    setExpandedConditionIndex(conditions.length); // Expand the new condition
  };

  const removeCondition = async (index: number) => {
    if (onRemoveCondition) {
      // Use UpdateManager for proper sibling deletion
      await onRemoveCondition(index);
    } else {
      // Fallback: just remove from local array
      onChange(conditions.filter((_, i) => i !== index));
    }
    if (expandedConditionIndex === index) {
      setExpandedConditionIndex(null);
    }
  };

  const updateCondition = (index: number, updates: Partial<ConditionalCondition>) => {
    const newConditions = [...conditions];
    newConditions[index] = { ...newConditions[index], ...updates };
    onChange(newConditions);
  };

  return (
    <div className="conditional-probability-editor">
      {/* Conditions List */}
      {conditions.length === 0 && (
        <div className="conditional-probability-empty">
          No conditional probabilities defined.
        </div>
      )}

      {conditions.map((condition, index) => {
        const isExpanded = expandedConditionIndex === index;
        
        // Handle both old format {visited: [...]} and new format (string)
        const conditionDisplay = typeof condition.condition === 'string' 
          ? condition.condition
          : '';
        
        return (
          <div key={index} className="conditional-probability-condition">
            {/* Condition Header */}
            <div 
              className="conditional-probability-condition-header"
              onClick={() => setExpandedConditionIndex(isExpanded ? null : index)}
            >
              <span className="conditional-probability-condition-icon">
                {isExpanded ? '▼' : '▶'}
              </span>
              <span className="conditional-probability-condition-label">
                Condition {index + 1}
                {conditionDisplay && (
                  <span className="conditional-probability-condition-summary">
                    {' '}— {conditionDisplay}
                  </span>
                )}
              </span>
              <button
                type="button"
                className="conditional-probability-remove-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  removeCondition(index);
                }}
                title="Remove condition"
              >
                ✕
              </button>
            </div>

            {/* Condition Content (expanded) */}
            {isExpanded && (
              <div className="conditional-probability-condition-content">
                {/* Condition Editor (Semantic: WHEN this applies) */}
                <div className="conditional-probability-field" style={{ marginBottom: '20px' }}>
                  <AutomatableField
                    label="Condition (when this applies)"
                    labelExtra={
                      <span title="Semantic constraint that determines when this conditional probability applies. Examples: visited(promo), context(device:mobile), case(test:treatment)">
                        <Info size={14} style={{ color: '#9CA3AF', cursor: 'help' }} />
                      </span>
                    }
                    layout="label-above"
                    value={localConditions[index]?.condition !== undefined ? localConditions[index].condition : (typeof condition.condition === 'string' ? condition.condition : '')}
                    overridden={false}  // Conditions are always user-defined
                    onClearOverride={() => {}}
                  >
                    <QueryExpressionEditor
                      value={localConditions[index]?.condition !== undefined ? localConditions[index].condition : (typeof condition.condition === 'string' ? condition.condition : '')}
                      onChange={(newCondition) => {
                        // Store in local state during editing
                        setLocalConditions(prev => ({
                          ...prev,
                          [index]: { ...prev[index], condition: newCondition }
                        }));
                      }}
                      onBlur={(currentValue) => {
                        if (currentValue !== condition.condition) {
                          updateCondition(index, { condition: currentValue });
                        }
                      }}
                      graph={graph}
                      edgeId={edgeId}
                      placeholder="visited(node) or context(key:value)"
                      height="50px"
                    />
                  </AutomatableField>
                </div>

                {/* Parameter Section - Same as edge parameters */}
                <ParameterSection
                  graph={graph}
                  objectType="edge"
                  objectId={edgeId || ''}
                  paramSlot="p"
                  param={condition.p}
                  onUpdate={(changes) => {
                    if (onUpdateParam) {
                      onUpdateParam(index, changes);
                    } else {
                      updateCondition(index, { p: { ...condition.p, ...changes } });
                    }
                  }}
                  onRebalance={() => {
                    if (onRebalanceParam) {
                      // Pass condition index only - handler uses current graph value
                      onRebalanceParam(index);
                    }
                  }}
                  label="Conditional Probability"
                  showBalanceButton={true}
                  isUnbalanced={isConditionalUnbalanced?.get(index) || false}
                  showQueryEditor={false}
                />
                
                {/* Query Editor (Full: HOW to retrieve data) */}
                <div className="conditional-probability-field" style={{ marginTop: '24px', paddingTop: '20px', borderTop: '1px solid #E5E7EB' }}>
                  <AutomatableField
                    label="Data Retrieval Query (full path)"
                    labelExtra={
                      <span title="Full query expression for retrieving data from external sources. Usually auto-generated from condition + edge topology via MSMDC algorithm.">
                        <Info size={14} style={{ color: '#9CA3AF', cursor: 'help' }} />
                      </span>
                    }
                    layout="label-above"
                    value={localConditions[index]?.query !== undefined ? localConditions[index].query : (condition.query || '')}
                    overridden={condition.query_overridden || false}
                    onClearOverride={() => {
                      updateCondition(index, { 
                        query: '', 
                        query_overridden: false 
                      });
                    }}
                  >
                    <QueryExpressionEditor
                      value={localConditions[index]?.query !== undefined ? localConditions[index].query : (condition.query || '')}
                      onChange={(newQuery) => {
                        // Store in local state during editing
                        setLocalConditions(prev => ({
                          ...prev,
                          [index]: { ...prev[index], query: newQuery }
                        }));
                      }}
                      onBlur={(currentValue) => {
                        if (currentValue !== condition.query) {
                          updateCondition(index, { 
                            query: currentValue,
                            query_overridden: true 
                          });
                        }
                      }}
                      graph={graph}
                      edgeId={edgeId}
                      placeholder="from(node).to(node).visited(...)"
                      height="50px"
                    />
                  </AutomatableField>
                </div>
                
                {/* Color picker for this condition */}
                {onUpdateConditionColor && (
                  <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #E5E7EB' }}>
                    <ColorSelector
                      label="Condition Color"
                      value={condition.color || getConditionalColor(edge) || '#4ade80'}
                      onChange={async (color) => {
                        if (onUpdateConditionColor) {
                          await onUpdateConditionColor(index, color);
                        } else {
                          updateCondition(index, { color });
                        }
                      }}
                      presetColors={CONDITIONAL_COLOR_PALETTE.map(color => ({ name: color, value: color }))}
                      showClear={!!condition.color}
                      onClear={async () => {
                        if (onUpdateConditionColor) {
                          await onUpdateConditionColor(index, undefined);
                        } else {
                          updateCondition(index, { color: undefined });
                        }
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Add Condition Button */}
      <button
        type="button"
        className="property-add-btn"
        style={{ width: '100%', marginTop: '12px' }}
        onClick={addCondition}
        title="Add a new conditional probability"
      >
        + Conditional Probability
      </button>
    </div>
  );
}

