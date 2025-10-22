import React, { useState, useCallback, useMemo } from 'react';
import { ConditionalProbability, GraphNode, GraphEdge } from '@/lib/types';
import { getUpstreamNodes, validateConditionalProbabilities } from '@/lib/conditionalValidation';
import { useGraphStore } from '@/lib/useGraphStore';
import { 
  getConditionalColor, 
  CONDITIONAL_COLOR_PALETTE,
  getNextAvailableColor,
  getSiblingEdges,
  getConditionSignature
} from '@/lib/conditionalColors';

interface ConditionalProbabilitiesSectionProps {
  edge: GraphEdge;
  graph: any;
  setGraph: (graph: any) => void;
  localConditionalP: ConditionalProbability[];
  setLocalConditionalP: (conditionalP: ConditionalProbability[]) => void;
  onLocalUpdate: (conditionalP: ConditionalProbability[]) => void;
  onUpdateColor: (color: string | undefined) => void;
}

export default function ConditionalProbabilitiesSection({ 
  edge, 
  graph,
  setGraph,
  localConditionalP,
  setLocalConditionalP,
  onLocalUpdate,
  onUpdateColor
}: ConditionalProbabilitiesSectionProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  
  // Get upstream nodes for condition selection
  const upstreamNodes = useMemo(() => {
    if (!graph) return [];
    return getUpstreamNodes(edge.from, graph);
  }, [graph, edge.from]);
  
  // Use local state from props (like variants do)
  const conditions = localConditionalP;
  
  // Get sibling edges and condition group info
  const siblings = useMemo(() => getSiblingEdges(edge, graph), [edge, graph]);
  const allEdgesWithConditions = useMemo(() => {
    return [edge, ...siblings].filter(e => e.conditional_p && e.conditional_p.length > 0);
  }, [edge, siblings]);
  
  // Run validation
  const validation = useMemo(() => {
    return validateConditionalProbabilities(graph);
  }, [graph]);
  
  // Find errors/warnings for this edge's source node
  const relevantErrors = validation.errors.filter(err => 
    err.message.includes(edge.from) || err.message.includes(edge.to)
  );
  const relevantWarnings = validation.warnings.filter(warn => 
    warn.message.includes(edge.from) || warn.message.includes(edge.to)
  );
  
  // Get condition signature for grouping
  const conditionSignature = conditions.length > 0 ? getConditionSignature(edge) : null;
  const edgesInGroup = conditionSignature ? allEdgesWithConditions.filter(e => 
    getConditionSignature(e) === conditionSignature
  ) : [];
  
  return (
    <div style={{ marginBottom: '20px' }}>
      <div 
        onClick={() => setIsExpanded(!isExpanded)}
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '10px',
          background: '#f8f9fa',
          borderRadius: '4px',
          cursor: 'pointer',
          marginBottom: isExpanded ? '12px' : '0',
          border: '1px solid #dee2e6'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontWeight: '600', fontSize: '13px' }}>
            🔀 Conditional Probabilities
          </span>
          {conditions.length > 0 && (
            <span style={{
              background: '#4ade80',
              color: 'white',
              padding: '2px 8px',
              borderRadius: '10px',
              fontSize: '11px',
              fontWeight: 'bold'
            }}>
              {conditions.length}
            </span>
          )}
        </div>
        <span style={{ fontSize: '14px', color: '#666' }}>
          {isExpanded ? '▾' : '▸'}
        </span>
      </div>

      {isExpanded && (
        <div>
          {/* List existing conditions */}
          {conditions.map((condition, index) => (
            <div
              key={index}
              style={{
                marginBottom: '12px',
                padding: '12px',
                border: '1px solid #ddd',
                borderRadius: '4px',
                background: '#f9f9f9'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontWeight: '600', fontSize: '12px' }}>Condition {index + 1}</span>
                <button
                  type="button"
                  onClick={() => {
                    const newConditions = conditions.filter((_, i) => i !== index);
                    onLocalUpdate(newConditions);
                  }}
                  style={{
                    background: '#dc3545',
                    color: 'white',
                    border: 'none',
                    borderRadius: '3px',
                    padding: '4px 8px',
                    cursor: 'pointer',
                    fontSize: '10px'
                  }}
                >
                  ✕ Remove
                </button>
              </div>

              {/* Upstream nodes selection */}
              <div style={{ marginBottom: '8px' }}>
                <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: '600' }}>
                  When visited nodes (select multiple):
                </label>
                <div style={{
                  border: '1px solid #ddd',
                  borderRadius: '3px',
                  padding: '8px',
                  background: 'white',
                  maxHeight: '120px',
                  overflowY: 'auto'
                }}>
                  {upstreamNodes.map((node) => (
                    <label
                      key={node.id}
                      style={{
                        display: 'block',
                        padding: '4px',
                        cursor: 'pointer',
                        fontSize: '12px'
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={
                          condition.condition.visited.includes(node.slug) || 
                          condition.condition.visited.includes(node.id)
                        }
                        onChange={(e) => {
                          const newConditions = [...conditions];
                          let visited = [...condition.condition.visited];
                          
                          if (e.target.checked) {
                            // ALWAYS use slug for new entries (immutable references)
                            if (!visited.includes(node.slug) && !visited.includes(node.id)) {
                              visited.push(node.slug);
                            }
                          } else {
                            // Remove both slug and ID (for backward compatibility)
                            visited = visited.filter(ref => ref !== node.slug && ref !== node.id);
                          }
                          
                          newConditions[index] = {
                            ...condition,
                            condition: { visited }
                          };
                          onLocalUpdate(newConditions);
                        }}
                        style={{ marginRight: '6px' }}
                      />
                      {node.label || node.slug}
                    </label>
                  ))}
                </div>
              </div>

              {/* Probability mean */}
              <div style={{ marginBottom: '8px' }}>
                <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: '600' }}>
                  Probability (mean)
                </label>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={condition.p.mean}
                    onChange={(e) => {
                      const newConditions = [...conditions];
                      newConditions[index] = {
                        ...condition,
                        p: { ...condition.p, mean: parseFloat(e.target.value) || 0 }
                      };
                      onLocalUpdate(newConditions);
                    }}
                    placeholder="0.5"
                    style={{
                      width: '60px',
                      padding: '4px',
                      border: '1px solid #ddd',
                      borderRadius: '3px',
                      boxSizing: 'border-box',
                      fontSize: '11px'
                    }}
                  />
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={condition.p.mean}
                    onChange={(e) => {
                      const newConditions = [...conditions];
                      newConditions[index] = {
                        ...condition,
                        p: { ...condition.p, mean: parseFloat(e.target.value) }
                      };
                      onLocalUpdate(newConditions);
                    }}
                    style={{
                      flex: 1,
                      height: '4px',
                      background: '#ddd',
                      outline: 'none',
                      borderRadius: '2px'
                    }}
                  />
                      <span style={{ fontSize: '10px', color: '#666', minWidth: '25px' }}>
                        {(condition.p.mean * 100).toFixed(0)}%
                      </span>
                      <button
                        onClick={() => {
                          if (!graph || !edge) return;
                          const siblings = graph.edges.filter((e: any) => {
                            // For case edges, only balance within the same variant
                            if (edge.case_id && edge.case_variant) {
                              return e.id !== edge.id && 
                                     e.from === edge.from && 
                                     e.case_id === edge.case_id && 
                                     e.case_variant === edge.case_variant;
                            }
                            // For regular edges, balance all edges from same source
                            return e.id !== edge.id && e.from === edge.from;
                          });
                          
                          if (siblings.length > 0) {
                            const nextGraph = structuredClone(graph);
                            const currentValue = condition.p.mean;
                            const remainingProbability = 1 - currentValue;
                            
                            // Calculate total current probability of siblings for this condition
                            const conditionKey = JSON.stringify(condition.condition.visited.sort());
                            const siblingsWithSameCondition = siblings.filter(sibling => {
                              if (!sibling.conditional_p) return false;
                              return sibling.conditional_p.some((cp: any) => 
                                JSON.stringify(cp.condition.visited.sort()) === conditionKey
                              );
                            });
                            
                            if (siblingsWithSameCondition.length > 0) {
                              // Calculate total current probability of siblings for this condition
                              const siblingsTotal = siblingsWithSameCondition.reduce((sum, sibling) => {
                                const matchingCondition = sibling.conditional_p?.find((cp: any) => 
                                  JSON.stringify(cp.condition.visited.sort()) === conditionKey
                                );
                                return sum + (matchingCondition?.p?.mean || 0);
                              }, 0);
                              
                              if (siblingsTotal > 0) {
                                // Rebalance siblings proportionally for this condition
                                siblingsWithSameCondition.forEach(sibling => {
                                  const siblingIndex = nextGraph.edges.findIndex((e: any) => e.id === sibling.id);
                                  if (siblingIndex >= 0) {
                                    const matchingCondition = sibling.conditional_p?.find((cp: any) => 
                                      JSON.stringify(cp.condition.visited.sort()) === conditionKey
                                    );
                                    if (matchingCondition) {
                                      const conditionIndex = sibling.conditional_p.findIndex((cp: any) => 
                                        JSON.stringify(cp.condition.visited.sort()) === conditionKey
                                      );
                                      if (conditionIndex >= 0) {
                                        const siblingCurrentValue = matchingCondition.p?.mean || 0;
                                        const newValue = (siblingCurrentValue / siblingsTotal) * remainingProbability;
                                        nextGraph.edges[siblingIndex].conditional_p[conditionIndex].p.mean = newValue;
                                      }
                                    }
                                  }
                                });
                              } else {
                                // If siblings have no probability for this condition, distribute equally
                                const equalShare = remainingProbability / siblingsWithSameCondition.length;
                                siblingsWithSameCondition.forEach(sibling => {
                                  const siblingIndex = nextGraph.edges.findIndex((e: any) => e.id === sibling.id);
                                  if (siblingIndex >= 0) {
                                    const matchingCondition = sibling.conditional_p?.find((cp: any) => 
                                      JSON.stringify(cp.condition.visited.sort()) === conditionKey
                                    );
                                    if (matchingCondition) {
                                      const conditionIndex = sibling.conditional_p.findIndex((cp: any) => 
                                        JSON.stringify(cp.condition.visited.sort()) === conditionKey
                                      );
                                      if (conditionIndex >= 0) {
                                        nextGraph.edges[siblingIndex].conditional_p[conditionIndex].p.mean = equalShare;
                                      }
                                    }
                                  }
                                });
                              }
                            }
                            
                            if (nextGraph.metadata) {
                              nextGraph.metadata.updated_at = new Date().toISOString();
                            }
                            setGraph(nextGraph);
                          }
                        }}
                        style={{
                          padding: '2px 4px',
                          fontSize: '9px',
                          backgroundColor: (() => {
                            if (!graph || !edge) return '#f8f9fa';
                            const siblings = graph.edges.filter((e: any) => {
                              // For case edges, only balance within the same variant
                              if (edge.case_id && edge.case_variant) {
                                return e.id !== edge.id && 
                                       e.from === edge.from && 
                                       e.case_id === edge.case_id && 
                                       e.case_variant === edge.case_variant;
                              }
                              // For regular edges, balance all edges from same source
                              return e.id !== edge.id && e.from === edge.from;
                            });
                            
                            if (siblings.length === 0) return '#f8f9fa';
                            
                            // Calculate total probability mass for this condition
                            const conditionKey = JSON.stringify(condition.condition.visited.sort());
                            const currentValue = condition.p.mean;
                            const siblingsTotal = siblings.reduce((sum, sibling) => {
                              if (!sibling.conditional_p) return sum;
                              const matchingCondition = sibling.conditional_p.find((cp: any) => 
                                JSON.stringify(cp.condition.visited.sort()) === conditionKey
                              );
                              return sum + (matchingCondition?.p?.mean || 0);
                            }, 0);
                            const totalMass = currentValue + siblingsTotal;
                            
                            // Light up if total mass is not close to 1.0
                            return Math.abs(totalMass - 1.0) > 0.01 ? '#fff3cd' : '#f8f9fa';
                          })(),
                          border: (() => {
                            if (!graph || !edge) return '1px solid #ddd';
                            const siblings = graph.edges.filter((e: any) => {
                              // For case edges, only balance within the same variant
                              if (edge.case_id && edge.case_variant) {
                                return e.id !== edge.id && 
                                       e.from === edge.from && 
                                       e.case_id === edge.case_id && 
                                       e.case_variant === edge.case_variant;
                              }
                              // For regular edges, balance all edges from same source
                              return e.id !== edge.id && e.from === edge.from;
                            });
                            
                            if (siblings.length === 0) return '1px solid #ddd';
                            
                            // Calculate total probability mass for this condition
                            const conditionKey = JSON.stringify(condition.condition.visited.sort());
                            const currentValue = condition.p.mean;
                            const siblingsTotal = siblings.reduce((sum, sibling) => {
                              if (!sibling.conditional_p) return sum;
                              const matchingCondition = sibling.conditional_p.find((cp: any) => 
                                JSON.stringify(cp.condition.visited.sort()) === conditionKey
                              );
                              return sum + (matchingCondition?.p?.mean || 0);
                            }, 0);
                            const totalMass = currentValue + siblingsTotal;
                            
                            // Light up if total mass is not close to 1.0
                            return Math.abs(totalMass - 1.0) > 0.01 ? '1px solid #ffc107' : '1px solid #ddd';
                          })(),
                          borderRadius: '2px',
                          cursor: 'pointer',
                          color: (() => {
                            if (!graph || !edge) return '#666';
                            const siblings = graph.edges.filter((e: any) => {
                              // For case edges, only balance within the same variant
                              if (edge.case_id && edge.case_variant) {
                                return e.id !== edge.id && 
                                       e.from === edge.from && 
                                       e.case_id === edge.case_id && 
                                       e.case_variant === edge.case_variant;
                              }
                              // For regular edges, balance all edges from same source
                              return e.id !== edge.id && e.from === edge.from;
                            });
                            
                            if (siblings.length === 0) return '#666';
                            
                            // Calculate total probability mass for this condition
                            const conditionKey = JSON.stringify(condition.condition.visited.sort());
                            const currentValue = condition.p.mean;
                            const siblingsTotal = siblings.reduce((sum, sibling) => {
                              if (!sibling.conditional_p) return sum;
                              const matchingCondition = sibling.conditional_p.find((cp: any) => 
                                JSON.stringify(cp.condition.visited.sort()) === conditionKey
                              );
                              return sum + (matchingCondition?.p?.mean || 0);
                            }, 0);
                            const totalMass = currentValue + siblingsTotal;
                            
                            // Light up if total mass is not close to 1.0
                            return Math.abs(totalMass - 1.0) > 0.01 ? '#856404' : '#666';
                          })()
                        }}
                        title="Rebalance sibling conditional probabilities for this condition"
                      >
                        ⚖️
                      </button>
                    </div>
                  </div>

              {/* Probability stdev */}
              <div>
                <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: '600' }}>
                  Std Dev (optional)
                </label>
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  value={condition.p.stdev || ''}
                  onChange={(e) => {
                    const newConditions = [...conditions];
                    newConditions[index] = {
                      ...condition,
                      p: { ...condition.p, stdev: parseFloat(e.target.value) || undefined }
                    };
                    onLocalUpdate(newConditions);
                  }}
                  placeholder="0.05"
                  style={{
                    width: '100%',
                    padding: '6px',
                    border: '1px solid #ddd',
                    borderRadius: '3px',
                    boxSizing: 'border-box',
                    fontSize: '12px'
                  }}
                />
              </div>
            </div>
          ))}

          {/* Validation errors and warnings */}
          {(relevantErrors.length > 0 || relevantWarnings.length > 0) && (
            <div style={{ marginBottom: '12px' }}>
              {relevantErrors.map((error, idx) => (
                <div key={`error-${idx}`} style={{
                  padding: '8px',
                  background: '#fee',
                  border: '1px solid #fcc',
                  borderRadius: '4px',
                  marginBottom: '4px',
                  fontSize: '11px',
                  color: '#c00'
                }}>
                  ⚠️ <strong>Error:</strong> {error.message}
                </div>
              ))}
              {relevantWarnings.map((warning, idx) => (
                <div key={`warning-${idx}`} style={{
                  padding: '8px',
                  background: '#fffbea',
                  border: '1px solid #ffd700',
                  borderRadius: '4px',
                  marginBottom: '4px',
                  fontSize: '11px',
                  color: '#856404'
                }}>
                  ⚠️ <strong>Warning:</strong> {warning.message}
                </div>
              ))}
            </div>
          )}

          {/* Condition group info */}
          {conditionSignature && edgesInGroup.length > 1 && (
            <div style={{
              padding: '10px',
              background: '#f8f9fa',
              border: '1px solid #dee2e6',
              borderRadius: '4px',
              marginBottom: '12px'
            }}>
              <div style={{ fontSize: '11px', fontWeight: '600', marginBottom: '6px', color: '#495057' }}>
                📦 Condition Group
              </div>
              <div style={{ fontSize: '11px', color: '#6c757d', marginBottom: '4px' }}>
                Affects <strong>{edgesInGroup.length}</strong> sibling edges
              </div>
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: '6px',
                fontSize: '11px',
                color: '#6c757d'
              }}>
                <span style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: '2px',
                  background: edge.display?.conditional_color || '#ccc',
                  display: 'inline-block'
                }}></span>
                <span>Shared color</span>
              </div>
            </div>
          )}

          {/* Add Condition button */}
          <button
            type="button"
            onClick={() => {
              // Create new condition for this edge (copying its current base probability)
              const newCondition = {
                condition: { visited: [] },
                p: { 
                  mean: edge.p?.mean ?? 0.5,
                  ...(edge.p?.stdev !== undefined ? { stdev: edge.p.stdev } : {})
                }
              };
              
              // Get all sibling edges (same source node)
              const siblings = getSiblingEdges(edge, graph);
              
              // Assign a fresh color for this condition group
              const color = getNextAvailableColor(graph);
              
              // Update ALL siblings (including this edge) in one transaction
              const nextGraph = structuredClone(graph);
              const edgeIds = [edge.id, ...siblings.map(s => s.id)];
              
              edgeIds.forEach(edgeId => {
                const edgeIndex = nextGraph.edges.findIndex((e: any) => 
                  e.id === edgeId || `${e.from}->${e.to}` === edgeId
                );
                
                if (edgeIndex >= 0) {
                  const targetEdge = nextGraph.edges[edgeIndex];
                  
                  // Create condition using this edge's base probability
                  const conditionForThisEdge = {
                    condition: { visited: [] },
                    p: { 
                      mean: targetEdge.p?.mean ?? 0.5,
                      ...(targetEdge.p?.stdev !== undefined ? { stdev: targetEdge.p.stdev } : {})
                    }
                  };
                  
                  // Add condition
                  if (!targetEdge.conditional_p) {
                    targetEdge.conditional_p = [];
                  }
                  targetEdge.conditional_p.push(conditionForThisEdge);
                  
                  // Set color
                  if (!targetEdge.display) {
                    targetEdge.display = {};
                  }
                  targetEdge.display.conditional_color = color;
                }
              });
              
              // Update metadata
              if (!nextGraph.metadata) nextGraph.metadata = {} as any;
              nextGraph.metadata.updated_at = new Date().toISOString();
              
              // Apply to graph
              setGraph(nextGraph);
              
              // Update local state for the current edge
              const newConditions = [...conditions, newCondition];
              setLocalConditionalP(newConditions);
            }}
            style={{
              background: '#28a745',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              padding: '8px 16px',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: '600',
              width: '100%',
              marginBottom: '12px'
            }}
          >
            + Add Condition
          </button>

          {/* Color picker for conditional edges */}
          {conditions.length > 0 && (
            <div style={{
              padding: '10px',
              background: 'white',
              borderRadius: '4px',
              border: '1px solid #e9ecef'
            }}>
              <div style={{ fontSize: '12px', fontWeight: '600', marginBottom: '8px' }}>
                Edge Color
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }}>
                {CONDITIONAL_COLOR_PALETTE.map((color) => (
                  <button
                    key={color}
                    onClick={() => onUpdateColor(color)}
                    style={{
                      width: '28px',
                      height: '28px',
                      borderRadius: '4px',
                      border: (edge.display?.conditional_color || getConditionalColor(edge)) === color
                        ? '3px solid #007bff'
                        : '1px solid #ddd',
                      background: color,
                      cursor: 'pointer',
                      padding: 0
                    }}
                    title={color}
                  />
                ))}
              </div>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <input
                  type="color"
                  value={edge.display?.conditional_color || getConditionalColor(edge) || '#4ade80'}
                  onChange={(e) => {
                    e.stopPropagation();
                    onUpdateColor(e.target.value);
                  }}
                  onInput={(e: React.FormEvent<HTMLInputElement>) => {
                    e.stopPropagation();
                    const target = e.target as HTMLInputElement;
                    onUpdateColor(target.value);
                  }}
                  style={{
                    width: '40px',
                    height: '28px',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                />
                <span style={{ fontSize: '11px', color: '#666', flex: 1 }}>
                  Current: {edge.display?.conditional_color || 'Auto'}
                </span>
                {edge.display?.conditional_color && (
                  <button
                    onClick={() => onUpdateColor(undefined)}
                    style={{
                      padding: '4px 8px',
                      fontSize: '11px',
                      background: '#f1f1f1',
                      border: '1px solid #ddd',
                      borderRadius: '3px',
                      cursor: 'pointer'
                    }}
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
          )}

          {conditions.length === 0 && (
            <div style={{ textAlign: 'center', padding: '20px', color: '#666' }}>
              <div style={{ fontSize: '24px', marginBottom: '8px' }}>🔀</div>
              <div style={{ fontSize: '13px' }}>No conditions defined</div>
              <div style={{ fontSize: '11px', marginTop: '4px', color: '#999' }}>
                Add conditions to vary probability based on visited nodes
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
