import React, { useState } from 'react';
import { Info, RefreshCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { EnhancedSelector } from './EnhancedSelector';
import { QueryExpressionEditor } from './QueryExpressionEditor';
import { AutomatableField } from './AutomatableField';
import { ParameterSection } from './ParameterSection';
import { ColourSelector } from './ColourSelector';
import { CONDITIONAL_COLOUR_PALETTE, getConditionalColour } from '@/lib/conditionalColours';
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
    id?: string;
  };
  
  // Display colour for this condition
  colour?: string;
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
  /** Edge object (for colour picker) */
  edge?: any;
  /** Callback when parameter updates (for individual conditional param) */
  onUpdateParam?: (index: number, changes: any) => void;
  /** Callback for rebalancing conditional probabilities */
  onRebalanceParam?: (index: number) => void;
  /** Map of condition index to whether it's unbalanced */
  isConditionalUnbalanced?: Map<number, boolean>;
  /** Callback when condition colour changes (index, colour) */
  onUpdateConditionColour?: (index: number, color: string | undefined) => Promise<void>;
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
  onUpdateConditionColour,
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

  // Regenerate query for a specific conditional using MSMDC
  const regenerateConditionalQuery = async (conditionalIndex: number) => {
    if (!edgeId || !graph) return;
    
    const loadingToast = toast.loading(`Regenerating query for conditional ${conditionalIndex + 1}...`);
    
    try {
      const { graphComputeClient } = await import('../lib/graphComputeClient');
      const { queryRegenerationService } = await import('../services/queryRegenerationService');
      
      // Transform graph to backend schema before sending
      const transformedGraph = queryRegenerationService.transformGraphForBackend(graph);
      
      // Call MSMDC to generate query for this specific conditional
      const response = await graphComputeClient.generateAllParameters(
        transformedGraph,
        undefined,  // downstreamOf
        undefined,  // literalWeights
        undefined,  // preserveCondition
        edgeId,     // edgeId
        conditionalIndex  // conditionalIndex - filter to this specific conditional
      );
      
      // Should only have one param for this conditional
      const conditionalQuery = response.parameters.find((param: any) => 
        param.paramType === 'edge_conditional_p'
      );
      
      if (conditionalQuery) {
        // Update the conditional with the new query
        updateCondition(conditionalIndex, {
          query: conditionalQuery.query,
          query_overridden: false  // Mark as auto-generated
        });
        
        toast.success('Query regenerated', { id: loadingToast });
      } else {
        toast.error('No query generated for this conditional', { id: loadingToast });
      }
    } catch (error) {
      console.error('Failed to regenerate conditional query:', error);
      toast.error(`Failed: ${error instanceof Error ? error.message : 'Unknown error'}`, { id: loadingToast });
    }
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span title="Full query expression for retrieving data from external sources. Usually auto-generated from condition + edge topology via MSMDC algorithm.">
                          <Info size={14} style={{ color: '#9CA3AF', cursor: 'help' }} />
                        </span>
                        <button
                          type="button"
                          onClick={() => regenerateConditionalQuery(index)}
                          title="Regenerate query for this conditional using MSMDC"
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: '2px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            color: '#6B7280',
                            transition: 'color 0.2s'
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.color = '#3B82F6'}
                          onMouseLeave={(e) => e.currentTarget.style.color = '#6B7280'}
                        >
                          <RefreshCcw size={14} />
                        </button>
                      </div>
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
                
                {/* Colour picker for this condition */}
                {onUpdateConditionColour && (
                  <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #E5E7EB' }}>
                    <ColourSelector
                      label="Condition Colour"
                      value={condition.colour || getConditionalColour(edge) || '#4ade80'}
                      onChange={async (colour) => {
                        if (onUpdateConditionColour) {
                          await onUpdateConditionColour(index, colour);
                        } else {
                          updateCondition(index, { colour });
                        }
                      }}
                      presetColours={CONDITIONAL_COLOUR_PALETTE.map(colour => ({ name: colour, value: colour }))}
                      showClear={!!condition.colour}
                      onClear={async () => {
                        if (onUpdateConditionColour) {
                          await onUpdateConditionColour(index, undefined);
                        } else {
                          updateCondition(index, { colour: undefined });
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

