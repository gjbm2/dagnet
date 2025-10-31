import React, { useState } from 'react';
import { EnhancedSelector } from './EnhancedSelector';
import './ConditionalProbabilityEditor.css';

// Match the graph schema structure
interface ConditionalCondition {
  condition: {
    visited: string[];
  };
  p: {
    mean?: number;
    stdev?: number;
    locked?: boolean;
    parameter_id?: string;
  };
}

interface ConditionalProbabilityEditorProps {
  /** Current list of conditions */
  conditions: ConditionalCondition[];
  /** Callback when conditions change */
  onChange: (conditions: ConditionalCondition[]) => void;
  /** Current graph for node selection */
  graph?: any;
}

/**
 * Conditional Probability Editor Component
 * 
 * Manages conditional probabilities for edges.
 * Features:
 * - Add/remove condition cards
 * - Chip-based node selection (AND logic within condition)
 * - Parameter connection per condition
 * - OR logic between conditions (top-to-bottom evaluation)
 */
export function ConditionalProbabilityEditor({
  conditions,
  onChange,
  graph
}: ConditionalProbabilityEditorProps) {
  const [expandedConditionIndex, setExpandedConditionIndex] = useState<number | null>(null);

  const addCondition = () => {
    onChange([
      ...conditions,
      {
        condition: { visited: [] },
        p: {}
      }
    ]);
    setExpandedConditionIndex(conditions.length); // Expand the new condition
  };

  const removeCondition = (index: number) => {
    onChange(conditions.filter((_, i) => i !== index));
    if (expandedConditionIndex === index) {
      setExpandedConditionIndex(null);
    }
  };

  const updateCondition = (index: number, updates: { condition?: { visited: string[] }; p?: Partial<ConditionalCondition['p']> }) => {
    const newConditions = [...conditions];
    if (updates.condition) {
      newConditions[index].condition = updates.condition;
    }
    if (updates.p) {
      newConditions[index].p = { ...newConditions[index].p, ...updates.p };
    }
    onChange(newConditions);
  };

  const addNodeToCondition = (conditionIndex: number, nodeId: string) => {
    const cond = conditions[conditionIndex];
    if (!cond.condition.visited.includes(nodeId)) {
      updateCondition(conditionIndex, {
        condition: { visited: [...cond.condition.visited, nodeId] }
      });
    }
  };

  const removeNodeFromCondition = (conditionIndex: number, nodeId: string) => {
    const cond = conditions[conditionIndex];
    updateCondition(conditionIndex, {
      condition: { visited: cond.condition.visited.filter(id => id !== nodeId) }
    });
  };

  return (
    <div className="conditional-probability-editor">
      {/* Header */}
      <div className="conditional-probability-header">
        <span className="conditional-probability-title">Conditional Probabilities</span>
        <button
          type="button"
          className="conditional-probability-add-btn"
          onClick={addCondition}
        >
          + Add Condition
        </button>
      </div>

      {/* Conditions List */}
      {conditions.length === 0 && (
        <div className="conditional-probability-empty">
          No conditional probabilities defined. Click "Add Condition" to create one.
        </div>
      )}

      {conditions.map((condition, index) => {
        const isExpanded = expandedConditionIndex === index;
        
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
                {condition.condition.visited.length > 0 && (
                  <span className="conditional-probability-condition-summary">
                    {' '}— If visited: {condition.condition.visited.join(' AND ')}
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
                {/* Node Selection */}
                <div className="conditional-probability-field">
                  <label>If Visited (AND logic):</label>
                  
                  {/* Chips for selected nodes */}
                  <div className="conditional-probability-chips">
                    {condition.condition.visited.map(nodeId => (
                      <div key={nodeId} className="conditional-probability-chip">
                        <span>visited({nodeId})</span>
                        <button
                          type="button"
                          onClick={() => removeNodeFromCondition(index, nodeId)}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Node Selector */}
                  <EnhancedSelector
                    type="node"
                    value=""
                    onChange={(nodeId) => {
                      if (nodeId) {
                        addNodeToCondition(index, nodeId);
                      }
                    }}
                    placeholder="Select node to add..."
                    showCurrentGraphGroup={true}
                  />
                </div>

                {/* Parameter Connection */}
                <div className="conditional-probability-field">
                  <EnhancedSelector
                    type="parameter"
                    parameterType="probability"
                    value={condition.p.parameter_id || ''}
                    onChange={(paramId) => {
                      updateCondition(index, { p: { parameter_id: paramId || undefined } });
                    }}
                    onPullFromRegistry={async () => {
                      // TODO: Load parameter values
                      console.log('Pull probability from registry');
                    }}
                    label="Probability Parameter"
                    placeholder="Select or enter parameter ID..."
                  />
                </div>

                {/* Manual Probability Input (if no parameter) */}
                {!condition.p.parameter_id && (
                  <div className="conditional-probability-field">
                    <label>Or enter probability manually:</label>
                    <div className="conditional-probability-manual-inputs">
                      <div>
                        <label className="conditional-probability-field-label">Mean</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max="1"
                          value={condition.p.mean ?? ''}
                          onChange={(e) => {
                            const value = e.target.value === '' ? undefined : parseFloat(e.target.value);
                            updateCondition(index, { p: { mean: value } });
                          }}
                          placeholder="0.0 - 1.0"
                        />
                      </div>
                      <div>
                        <label className="conditional-probability-field-label">Stdev</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={condition.p.stdev ?? ''}
                          onChange={(e) => {
                            const value = e.target.value === '' ? undefined : parseFloat(e.target.value);
                            updateCondition(index, { p: { stdev: value } });
                          }}
                          placeholder="Optional"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Help Text */}
      {conditions.length > 0 && (
        <div className="conditional-probability-help">
          💡 Conditions are evaluated top-to-bottom (OR logic between conditions).
          Within each condition, all nodes must be visited (AND logic).
        </div>
      )}
    </div>
  );
}

