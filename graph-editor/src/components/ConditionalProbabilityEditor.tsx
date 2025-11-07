import React, { useState } from 'react';
import { Info } from 'lucide-react';
import { EnhancedSelector } from './EnhancedSelector';
import { QueryExpressionEditor } from './QueryExpressionEditor';
import { AutomatableField } from './AutomatableField';
import { ParameterSection } from './ParameterSection';
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
  /** Callback when parameter updates (for individual conditional param) */
  onUpdateParam?: (index: number, changes: any) => void;
  /** Callback for rebalancing conditional probabilities */
  onRebalanceParam?: (index: number, newValue: number) => void;
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
  onUpdateParam,
  onRebalanceParam
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
          : (condition.condition as any)?.visited?.length > 0
            ? `visited(${(condition.condition as any).visited.join(', ')})`
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
                      onBlur={() => {
                        const localCond = localConditions[index]?.condition;
                        if (localCond !== undefined && localCond !== condition.condition) {
                          updateCondition(index, { condition: localCond });
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
                  onRebalance={(newValue) => {
                    if (onRebalanceParam) {
                      onRebalanceParam(index, newValue);
                    }
                  }}
                  label="Conditional Probability"
                  showBalanceButton={true}
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
                      onBlur={() => {
                        const localQuery = localConditions[index]?.query;
                        if (localQuery !== undefined && localQuery !== condition.query) {
                          updateCondition(index, { 
                            query: localQuery,
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

