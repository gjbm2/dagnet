/**
 * Edge Context Menu Component
 * 
 * Context menu for graph edges with:
 * - Probability editing (with slider & balance button)
 * - Conditional probabilities editing
 * - Variant weight editing (for case edges)
 * - Data operations (Get/Put) for parameters with submenus
 * - Properties & Delete options
 */

import React, { useState } from 'react';
import { dataOperationsService } from '../services/dataOperationsService';
import ProbabilityInput from './ProbabilityInput';
import VariantWeightInput from './VariantWeightInput';
import { AutomatableField } from './AutomatableField';
import { roundTo4DP } from '../utils/rounding';
import { Folders, TrendingUpDown, ChevronRight, Database, DatabaseZap } from 'lucide-react';
import { fileRegistry } from '../contexts/TabContext';
import { useGraphStore } from '../contexts/GraphStoreContext';

interface EdgeContextMenuProps {
  x: number;
  y: number;
  edgeId: string;
  edgeData: any;
  graph: any;
  onClose: () => void;
  onUpdateGraph: (graph: any, historyLabel?: string, nodeId?: string) => void;
  onDeleteEdge: (edgeId: string) => void;
}

export const EdgeContextMenu: React.FC<EdgeContextMenuProps> = ({
  x,
  y,
  edgeId,
  edgeData,
  graph,
  onClose,
  onUpdateGraph,
  onDeleteEdge,
}) => {
  const [localData, setLocalData] = useState(edgeData);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const { window } = useGraphStore();
  
  // Create a setGraph wrapper that calls onUpdateGraph (which updates the tab-specific graph)
  const setGraph = (updatedGraph: any) => {
    onUpdateGraph(updatedGraph);
  };
  
  // Find the edge in the graph
  const edge = graph?.edges?.find((e: any) => e.uuid === edgeId || e.id === edgeId);
  
  // Check for connected parameters from the actual edge object
  // Check for file-based connections (parameter_id OR p.id) OR direct connections (connection field)
  // Note: parameter_id can be top-level OR nested in p.id (transform.ts maps p.id → parameter_id for ReactFlow)
  const parameterId = edge?.parameter_id || edge?.p?.id; // Prefer top-level, fallback to nested
  const hasProbabilityParam = !!parameterId || !!edge?.p?.connection;
  const hasConditionalParam = edge?.conditional_p && edge.conditional_p.length > 0;
  const costGbpParameterId = edge?.cost_gbp_parameter_id || edge?.cost_gbp?.id;
  const hasCostGbpParam = !!costGbpParameterId || !!edge?.cost_gbp?.connection;
  const costTimeParameterId = edge?.cost_time_parameter_id || edge?.cost_time?.id;
  const hasCostTimeParam = !!costTimeParameterId || !!edge?.cost_time?.connection;
  const hasAnyParam = hasProbabilityParam || hasConditionalParam || hasCostGbpParam || hasCostTimeParam;
  
  // Check if we have ANY connection (direct OR file) - for "Get from Source (direct)"
  // This matches LightningMenu behavior: always show direct option if any connection exists
  const getProbabilityConnectionName = (): string | undefined => {
    if (edge?.p?.connection) return edge.p.connection;
    if (parameterId) {
      const file = fileRegistry.getFile(`parameter-${parameterId}`);
      return file?.data?.connection;
    }
    return undefined;
  };
  const getCostGbpConnectionName = (): string | undefined => {
    if (edge?.cost_gbp?.connection) return edge.cost_gbp.connection;
    if (costGbpParameterId) {
      const file = fileRegistry.getFile(`parameter-${costGbpParameterId}`);
      return file?.data?.connection;
    }
    return undefined;
  };
  const getCostTimeConnectionName = (): string | undefined => {
    if (edge?.cost_time?.connection) return edge.cost_time.connection;
    if (costTimeParameterId) {
      const file = fileRegistry.getFile(`parameter-${costTimeParameterId}`);
      return file?.data?.connection;
    }
    return undefined;
  };
  
  const probabilityConnectionName = getProbabilityConnectionName();
  const costGbpConnectionName = getCostGbpConnectionName();
  const costTimeConnectionName = getCostTimeConnectionName();
  
  const hasProbabilityConnection = !!probabilityConnectionName;
  const hasCostGbpConnection = !!costGbpConnectionName;
  const hasCostTimeConnection = !!costTimeConnectionName;
  
  // Check if we have direct connections (without files) - for determining which handler to use
  const hasProbabilityDirectConnection = !!edge?.p?.connection && !parameterId;
  const hasCostGbpDirectConnection = !!edge?.cost_gbp?.connection && !costGbpParameterId;
  const hasCostTimeDirectConnection = !!edge?.cost_time?.connection && !costTimeParameterId;
  
  // Check if parameter files have connections (for versioned "Get from Source")
  const hasProbabilityFileConnection = !!parameterId && (() => {
    const file = fileRegistry.getFile(`parameter-${parameterId}`);
    return !!file?.data?.connection;
  })();
  const hasCostGbpFileConnection = !!costGbpParameterId && (() => {
    const file = fileRegistry.getFile(`parameter-${costGbpParameterId}`);
    return !!file?.data?.connection;
  })();
  const hasCostTimeFileConnection = !!costTimeParameterId && (() => {
    const file = fileRegistry.getFile(`parameter-${costTimeParameterId}`);
    return !!file?.data?.connection;
  })();
  
  // Check if it's a case edge with variants
  const isCaseEdge = edge?.case_id && edge?.case_variant;
  const caseNode = graph?.nodes?.find((n: any) => n.case?.id === edge?.case_id);
  const variant = caseNode?.case?.variants?.find((v: any) => v.name === edge?.case_variant);
  const variantIndex = caseNode?.case?.variants?.findIndex((v: any) => v.name === edge?.case_variant) ?? -1;
  const allVariants = caseNode?.case?.variants || [];
  
  // Calculate if probabilities are unbalanced (for balance button highlighting)
  const probabilitySiblings = graph?.edges?.filter((e: any) => {
    if (!edge) return false;
    if (edge.case_id && edge.case_variant) {
      return e.from === edge.from && 
             e.case_id === edge.case_id && 
             e.case_variant === edge.case_variant;
    }
    return e.from === edge.from;
  }) || [];
  const totalProbability = probabilitySiblings.reduce((sum, e) => sum + (e.p?.mean || 0), 0);
  const isProbabilityUnbalanced = Math.abs(totalProbability - 1.0) > 0.01; // More than 1% off
  
  // Calculate if variant weights are unbalanced
  const totalVariantWeight = allVariants.reduce((sum: number, v: any) => sum + (v.weight || 0), 0);
  const isVariantWeightUnbalanced = Math.abs(totalVariantWeight - 1.0) > 0.01;

  const handleGetFromFile = (paramType: 'probability' | 'conditional' | 'cost_gbp' | 'cost_time') => {
    let paramId: string | undefined;
    if (paramType === 'probability') paramId = parameterId; // Use resolved parameterId (p.id or parameter_id)
    if (paramType === 'conditional') paramId = parameterId; // Conditional uses same param file
    if (paramType === 'cost_gbp') paramId = costGbpParameterId;
    if (paramType === 'cost_time') paramId = costTimeParameterId;

    if (paramId) {
      dataOperationsService.getParameterFromFile({ 
        paramId, 
        edgeId,
        graph,
        setGraph
      });
    }
    onClose();
  };

  const handlePutToFile = (paramType: 'probability' | 'conditional' | 'cost_gbp' | 'cost_time') => {
    let paramId: string | undefined;
    if (paramType === 'probability') paramId = parameterId; // Use resolved parameterId (p.id or parameter_id)
    if (paramType === 'conditional') paramId = parameterId; // Conditional uses same param file
    if (paramType === 'cost_gbp') paramId = costGbpParameterId;
    if (paramType === 'cost_time') paramId = costTimeParameterId;

    if (paramId) {
      dataOperationsService.putParameterToFile({ 
        paramId, 
        edgeId,
        graph,
        setGraph
      });
    }
    onClose();
  };

  const handleGetFromSourceDirect = (paramType: 'probability' | 'cost_gbp' | 'cost_time') => {
    // Map paramType to paramSlot
    const paramSlot: 'p' | 'cost_gbp' | 'cost_time' = paramType === 'probability' ? 'p' : paramType;
    
    // Check if connection exists on edge OR in file
    const param = paramSlot === 'p' ? edge?.p : edge?.[paramSlot];
    let paramId: string | undefined;
    if (paramType === 'probability') paramId = parameterId; // Use resolved parameterId (p.id or parameter_id)
    if (paramType === 'cost_gbp') paramId = costGbpParameterId;
    if (paramType === 'cost_time') paramId = costTimeParameterId;
    
    // Check for connection on edge OR in file
    const hasEdgeConnection = !!param?.connection;
    const hasFileConnection = !!paramId && (() => {
      const file = fileRegistry.getFile(`parameter-${paramId}`);
      return !!file?.data?.connection;
    })();
    
    if (!hasEdgeConnection && !hasFileConnection) {
      console.warn(`[EdgeContextMenu] No connection found for ${paramSlot} (checked edge and file)`);
      return;
    }

    // Call getFromSourceDirect
    // If connection is on edge, use empty objectId (direct connection)
    // If connection is in file, use paramId (will load connection from file)
    dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: hasEdgeConnection ? '' : paramId || '', // Empty if direct, paramId if from file
      targetId: edgeId, // Edge UUID
      graph,
      setGraph,
      paramSlot, // 'p' | 'cost_gbp' | 'cost_time'
      window: window || undefined, // Use window from graph store
      dailyMode: false // Direct to graph - use aggregate mode, not daily
    });
    onClose();
  };

  const handleGetFromSourceVersioned = (paramType: 'probability' | 'cost_gbp' | 'cost_time') => {
    // Get parameter ID from edge (check both top-level and nested)
    let paramId: string | undefined;
    if (paramType === 'probability') paramId = parameterId; // Use resolved parameterId (p.id or parameter_id)
    if (paramType === 'cost_gbp') paramId = costGbpParameterId;
    if (paramType === 'cost_time') paramId = costTimeParameterId;

    if (!paramId) {
      console.warn(`[EdgeContextMenu] No parameter file ID found for ${paramType}`);
      return;
    }

    // Map paramType to paramSlot
    const paramSlot: 'p' | 'cost_gbp' | 'cost_time' = paramType === 'probability' ? 'p' : paramType;

    // Call getFromSource (versioned) - fetches to file then updates graph
    dataOperationsService.getFromSource({
      objectType: 'parameter',
      objectId: paramId, // Parameter file ID
      targetId: edgeId, // Edge UUID
      graph,
      setGraph,
      paramSlot, // 'p' | 'cost_gbp' | 'cost_time'
      window: window || undefined // Use window from graph store
    });
    onClose();
  };

  return (
    <div
      style={{
        position: 'fixed',
        left: x,
        top: y,
        background: 'white',
        border: '1px solid #ddd',
        borderRadius: '4px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        minWidth: '200px',
        padding: '8px',
        zIndex: 10000
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Probability editing section */}
      <div style={{ marginBottom: '12px' }}>
        <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', marginBottom: '4px', color: '#333' }}>
          Probability
        </label>
        <AutomatableField
          label="Probability"
          value={edge?.p?.mean || 0}
          overridden={edge?.p?.mean_overridden || false}
          onClearOverride={() => {
            if (graph) {
              const nextGraph = structuredClone(graph);
              const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeId || e.id === edgeId);
              if (edgeIndex >= 0 && nextGraph.edges[edgeIndex].p) {
                delete nextGraph.edges[edgeIndex].p.mean_overridden;
                if (nextGraph.metadata) {
                  nextGraph.metadata.updated_at = new Date().toISOString();
                }
                onUpdateGraph(nextGraph, 'Clear probability override', edgeId);
              }
            }
          }}
        >
          <ProbabilityInput
            value={localData?.probability || localData?.p?.mean || 0}
            isUnbalanced={isProbabilityUnbalanced}
            showBalanceButton={true}
            onChange={(value) => {
              setLocalData((prev: any) => ({ ...prev, probability: value }));
            }}
            onCommit={(value) => {
              if (graph) {
                const nextGraph = structuredClone(graph);
                const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeId || e.id === edgeId);
                if (edgeIndex >= 0) {
                  // Preserve existing p object properties (id, stdev, distribution, evidence, etc.)
                  nextGraph.edges[edgeIndex].p = {
                    ...nextGraph.edges[edgeIndex].p,
                    mean: value,
                    mean_overridden: true
                  };
                  if (nextGraph.metadata) {
                    nextGraph.metadata.updated_at = new Date().toISOString();
                  }
                  onUpdateGraph(nextGraph, 'Update edge probability', edgeId);
                }
              }
            }}
            onRebalance={(value) => {
            if (!graph || !edge) return;
            
            const siblings = graph.edges.filter((e: any) => {
              if (edge.case_id && edge.case_variant) {
                return e.id !== edge.id && 
                       e.from === edge.from && 
                       e.case_id === edge.case_id && 
                       e.case_variant === edge.case_variant;
              }
              return e.id !== edge.id && e.from === edge.from;
            });
            
            if (siblings.length > 0) {
              const nextGraph = structuredClone(graph);
              const currentValue = value;
              const remainingProbability = roundTo4DP(1 - currentValue);
              
              const currentEdgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeId || e.id === edgeId);
              if (currentEdgeIndex >= 0) {
                // Preserve existing p object properties
                nextGraph.edges[currentEdgeIndex].p = { 
                  ...nextGraph.edges[currentEdgeIndex].p,
                  mean: currentValue 
                };
                
                const siblingsTotal = siblings.reduce((sum, sib) => sum + (sib.p?.mean || 0), 0);
                
                if (siblingsTotal > 0) {
                  siblings.forEach(sibling => {
                    const siblingIndex = nextGraph.edges.findIndex((e: any) => 
                      (e.uuid === sibling.uuid && e.uuid) || (e.id === sibling.id && e.id)
                    );
                    if (siblingIndex >= 0) {
                      const siblingCurrentValue = sibling.p?.mean || 0;
                      const newValue = (siblingCurrentValue / siblingsTotal) * remainingProbability;
                      // Preserve existing p object properties
                      nextGraph.edges[siblingIndex].p = { 
                        ...nextGraph.edges[siblingIndex].p,
                        mean: newValue 
                      };
                    }
                  });
                } else {
                  const equalShare = remainingProbability / siblings.length;
                  siblings.forEach(sibling => {
                    const siblingIndex = nextGraph.edges.findIndex((e: any) => 
                      (e.uuid === sibling.uuid && e.uuid) || (e.id === sibling.id && e.id)
                    );
                    if (siblingIndex >= 0) {
                      // Preserve existing p object properties
                      nextGraph.edges[siblingIndex].p = { 
                        ...nextGraph.edges[siblingIndex].p,
                        mean: equalShare 
                      };
                    }
                  });
                }
                
                if (nextGraph.metadata) {
                  nextGraph.metadata.updated_at = new Date().toISOString();
                }
                onUpdateGraph(nextGraph, 'Auto-rebalance probabilities', edgeId);
              }
            }
          }}
          onClose={onClose}
          autoFocus={false}
          autoSelect={false}
            showSlider={true}
          />
        </AutomatableField>
      </div>

      {/* Conditional Probabilities editing */}
      {hasConditionalParam && (
        <div style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', marginBottom: '4px', color: '#333' }}>
            Conditional Probabilities
          </label>
          {edge.conditional_p.map((condP: any, cpIndex: number) => {
            // Defensive check: skip if condition structure is invalid (old schema)
            if (!condP.condition?.visited || !Array.isArray(condP.condition.visited)) {
              console.warn(`[EdgeContextMenu] Skipping conditional_p with invalid/old schema format at index ${cpIndex}:`, condP);
              return null;
            }
            
            return (
            <div key={cpIndex} style={{ marginBottom: '8px', padding: '6px', border: '1px solid #eee', borderRadius: '3px' }}>
              <div style={{ fontSize: '10px', color: '#666', marginBottom: '4px' }}>
                Condition: {condP.condition.visited.join(', ') || 'None'}
              </div>
              <ProbabilityInput
                value={condP.p.mean}
                onChange={(value) => {
                  if (graph) {
                    const nextGraph = structuredClone(graph);
                    const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeId || e.id === edgeId);
                    if (edgeIndex >= 0 && nextGraph.edges[edgeIndex].conditional_p) {
                      nextGraph.edges[edgeIndex].conditional_p[cpIndex].p.mean = value;
                      if (nextGraph.metadata) {
                        nextGraph.metadata.updated_at = new Date().toISOString();
                      }
                      onUpdateGraph(nextGraph);
                    }
                  }
                }}
                onCommit={(value) => {
                  // Already committed via onChange above
                }}
                onRebalance={(value) => {
                  if (!graph || !edge || !edge.conditional_p) return;
                  
                  const siblings = graph.edges.filter((e: any) => {
                    if (edge.case_id && edge.case_variant) {
                      return e.id !== edge.id && 
                             e.from === edge.from && 
                             e.case_id === edge.case_id && 
                             e.case_variant === edge.case_variant;
                    }
                    return e.id !== edge.id && e.from === edge.from;
                  });
                  
                  if (siblings.length > 0) {
                    const nextGraph = structuredClone(graph);
                    const currentValue = value;
                    const remainingProbability = roundTo4DP(1 - currentValue);
                    
                    const currentEdgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeId || e.id === edgeId);
                    if (currentEdgeIndex >= 0 && nextGraph.edges[currentEdgeIndex].conditional_p) {
                      nextGraph.edges[currentEdgeIndex].conditional_p[cpIndex].p.mean = currentValue;
                      
                      const currentCondition = edge.conditional_p[cpIndex];
                      // Defensive check: skip rebalance if condition structure is invalid
                      if (!currentCondition.condition?.visited || !Array.isArray(currentCondition.condition.visited)) {
                        console.warn('[EdgeContextMenu] Cannot rebalance conditional_p with invalid condition format');
                        return;
                      }
                      const conditionKey = JSON.stringify(currentCondition.condition.visited.sort());
                      
                      const siblingsWithSameCondition = siblings.filter(sibling => {
                        if (!sibling.conditional_p) return false;
                        return sibling.conditional_p.some((cp: any) => 
                          cp.condition?.visited && Array.isArray(cp.condition.visited) &&
                          JSON.stringify(cp.condition.visited.sort()) === conditionKey
                        );
                      });
                      
                      if (siblingsWithSameCondition.length > 0) {
                        const siblingsTotal = siblingsWithSameCondition.reduce((sum, sibling) => {
                          const matchingCondition = sibling.conditional_p?.find((cp: any) => 
                            cp.condition?.visited && Array.isArray(cp.condition.visited) &&
                            JSON.stringify(cp.condition.visited.sort()) === conditionKey
                          );
                          return sum + (matchingCondition?.p?.mean || 0);
                        }, 0);
                        
                        if (siblingsTotal > 0) {
                          siblingsWithSameCondition.forEach(sibling => {
                            const siblingIndex = nextGraph.edges.findIndex((e: any) => 
                              (e.uuid === sibling.uuid && e.uuid) || (e.id === sibling.id && e.id)
                            );
                            if (siblingIndex >= 0) {
                              const matchingCondition = sibling.conditional_p?.find((cp: any) => 
                                cp.condition?.visited && Array.isArray(cp.condition.visited) &&
                                JSON.stringify(cp.condition.visited.sort()) === conditionKey
                              );
                              if (matchingCondition && sibling.conditional_p) {
                                const conditionIndex = sibling.conditional_p.findIndex((cp: any) => 
                                  cp.condition?.visited && Array.isArray(cp.condition.visited) &&
                                  JSON.stringify(cp.condition.visited.sort()) === conditionKey
                                );
                                if (conditionIndex >= 0) {
                                  const siblingCurrentValue = matchingCondition.p?.mean || 0;
                                  const newValue = (siblingCurrentValue / siblingsTotal) * remainingProbability;
                                  if (nextGraph.edges[siblingIndex].conditional_p) {
                                    nextGraph.edges[siblingIndex].conditional_p[conditionIndex].p.mean = newValue;
                                  }
                                }
                              }
                            }
                          });
                        } else {
                          const equalShare = remainingProbability / siblingsWithSameCondition.length;
                          siblingsWithSameCondition.forEach(sibling => {
                            const siblingIndex = nextGraph.edges.findIndex((e: any) => 
                              (e.uuid === sibling.uuid && e.uuid) || (e.id === sibling.id && e.id)
                            );
                            if (siblingIndex >= 0) {
                              const matchingCondition = sibling.conditional_p?.find((cp: any) => 
                                cp.condition?.visited && Array.isArray(cp.condition.visited) &&
                                JSON.stringify(cp.condition.visited.sort()) === conditionKey
                              );
                              if (matchingCondition && sibling.conditional_p) {
                                const conditionIndex = sibling.conditional_p.findIndex((cp: any) => 
                                  cp.condition?.visited && Array.isArray(cp.condition.visited) &&
                                  JSON.stringify(cp.condition.visited.sort()) === conditionKey
                                );
                                if (conditionIndex >= 0) {
                                  if (nextGraph.edges[siblingIndex].conditional_p) {
                                    nextGraph.edges[siblingIndex].conditional_p[conditionIndex].p.mean = equalShare;
                                  }
                                }
                              }
                            }
                          });
                        }
                      }
                      
                      if (nextGraph.metadata) {
                        nextGraph.metadata.updated_at = new Date().toISOString();
                      }
                      onUpdateGraph(nextGraph, 'Auto-rebalance conditional probabilities', edgeId);
                    }
                  }
                }}
                onClose={onClose}
                autoFocus={false}
                autoSelect={false}
                showSlider={true}
                showBalanceButton={true}
              />
            </div>
            );
          })}
        </div>
      )}

      {/* Variant Weight editing for case edges */}
      {isCaseEdge && variant && (
        <div style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', marginBottom: '4px', color: '#333' }}>
            Variant Weight ({edge?.case_variant})
          </label>
          <AutomatableField
            label={`Variant Weight (${edge?.case_variant})`}
            value={variant.weight}
            overridden={variant.weight_overridden || false}
            onClearOverride={() => {
              if (graph && edge) {
                const nextGraph = structuredClone(graph);
                const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.case?.id === edge?.case_id);
                if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
                  const vIdx = nextGraph.nodes[nodeIndex].case.variants.findIndex((v: any) => v.name === edge?.case_variant);
                  if (vIdx >= 0) {
                    delete nextGraph.nodes[nodeIndex].case.variants[vIdx].weight_overridden;
                    if (nextGraph.metadata) {
                      nextGraph.metadata.updated_at = new Date().toISOString();
                    }
                    onUpdateGraph(nextGraph, 'Clear variant weight override', caseNode?.id);
                  }
                }
              }
            }}
          >
            <VariantWeightInput
              value={variant.weight}
              onChange={(value) => {
                // Optional: update local state if needed
              }}
              onCommit={(value) => {
                if (graph && edge) {
                  const nextGraph = structuredClone(graph);
                  const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.case?.id === edge?.case_id);
                  if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
                    const vIdx = nextGraph.nodes[nodeIndex].case.variants.findIndex((v: any) => v.name === edge?.case_variant);
                    if (vIdx >= 0) {
                      nextGraph.nodes[nodeIndex].case.variants[vIdx].weight = value;
                      nextGraph.nodes[nodeIndex].case.variants[vIdx].weight_overridden = true;
                      if (nextGraph.metadata) {
                        nextGraph.metadata.updated_at = new Date().toISOString();
                      }
                      onUpdateGraph(nextGraph, 'Update variant weight', caseNode?.id);
                    }
                  }
                }
              }}
            onRebalance={(value, currentIndex, variants) => {
              if (graph && edge) {
                const nextGraph = structuredClone(graph);
                const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.case?.id === edge?.case_id);
                if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
                  const vIdx = nextGraph.nodes[nodeIndex].case.variants.findIndex((v: any) => v.name === edge?.case_variant);
                  if (vIdx >= 0) {
                    nextGraph.nodes[nodeIndex].case.variants[vIdx].weight = value;
                    
                    const remainingWeight = 1 - value;
                    const otherVariants = variants.filter((v: any, i: number) => i !== vIdx);
                    const otherVariantsTotal = otherVariants.reduce((sum, v) => sum + (v.weight || 0), 0);
                    
                    if (otherVariantsTotal > 0) {
                      otherVariants.forEach(v => {
                        const otherIdx = nextGraph.nodes[nodeIndex].case!.variants!.findIndex((variant: any) => variant.name === v.name);
                        if (otherIdx !== undefined && otherIdx >= 0) {
                          const currentWeight = v.weight || 0;
                          const newWeight = (currentWeight / otherVariantsTotal) * remainingWeight;
                          nextGraph.nodes[nodeIndex].case!.variants![otherIdx].weight = newWeight;
                        }
                      });
                    } else {
                      const equalShare = remainingWeight / otherVariants.length;
                      otherVariants.forEach(v => {
                        const otherIdx = nextGraph.nodes[nodeIndex].case!.variants!.findIndex((variant: any) => variant.name === v.name);
                        if (otherIdx !== undefined && otherIdx >= 0) {
                          nextGraph.nodes[nodeIndex].case!.variants![otherIdx].weight = equalShare;
                        }
                      });
                    }
                    
                    if (nextGraph.metadata) {
                      nextGraph.metadata.updated_at = new Date().toISOString();
                    }
                    onUpdateGraph(nextGraph, 'Update and balance variant weights', caseNode?.id);
                  }
                }
              }
            }}
            onClose={onClose}
            currentIndex={variantIndex}
            allVariants={allVariants}
              autoFocus={false}
              autoSelect={false}
              showSlider={true}
              showBalanceButton={true}
            />
          </AutomatableField>
        </div>
      )}

      {/* Data operations (if any parameters connected) */}
      {hasAnyParam && (
        <>
          <div style={{ height: '1px', background: '#eee', margin: '8px 0' }} />
          
          {/* Probability parameter submenu */}
          {hasProbabilityParam && (
            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => setOpenSubmenu('probability')}
              onMouseLeave={() => setOpenSubmenu(null)}
            >
              <div
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  borderRadius: '2px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: openSubmenu === 'probability' ? '#f8f9fa' : 'white'
                }}
              >
                <span>Probability parameter</span>
                <ChevronRight size={14} style={{ color: '#666' }} />
              </div>
              
              {openSubmenu === 'probability' && (
                <div
                  style={{
                    position: 'absolute',
                    left: '100%',
                    top: 0,
                    background: 'white',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    minWidth: '200px',
                    padding: '4px',
                    zIndex: 10001,
                    marginLeft: '4px',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {/* Show "Get from Source (direct)" if there's ANY connection (direct OR file) */}
                  {/* Matches LightningMenu: always show direct option if any connection exists */}
                  {hasProbabilityConnection && (
                    <div
                      onClick={() => handleGetFromSourceDirect('probability')}
                      style={{
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        borderRadius: '2px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px'
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                    >
                      <span>Get from Source (direct){probabilityConnectionName ? ` (${probabilityConnectionName})` : ''}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                        <Database size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                        <TrendingUpDown size={12} />
                      </div>
                    </div>
                  )}
                  {/* Show "Get from Source" (versioned) if there's a parameter file with connection */}
                  {hasProbabilityFileConnection && (
                    <div
                      onClick={() => handleGetFromSourceVersioned('probability')}
                      style={{
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        borderRadius: '2px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px'
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                    >
                      <span>Get from Source{probabilityConnectionName ? ` (${probabilityConnectionName})` : ''}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                        <DatabaseZap size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                        <Folders size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>+</span>
                        <TrendingUpDown size={12} />
                      </div>
                    </div>
                  )}
                  {/* Show file operations if there's a parameter file */}
                  {parameterId && (
                    <>
                      <div
                        onClick={() => handleGetFromFile('probability')}
                        style={{
                          padding: '6px 12px',
                          cursor: 'pointer',
                          fontSize: '13px',
                          borderRadius: '2px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '16px'
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                      >
                        <span>Get data from file</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                          <Folders size={12} />
                          <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                          <TrendingUpDown size={12} />
                        </div>
                      </div>
                      <div
                        onClick={() => handlePutToFile('probability')}
                        style={{
                          padding: '6px 12px',
                          cursor: 'pointer',
                          fontSize: '13px',
                          borderRadius: '2px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '16px'
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                      >
                        <span>Put data to file</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                          <TrendingUpDown size={12} />
                          <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                          <Folders size={12} />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Conditional probability parameter submenu (if has conditionals) */}
          {hasConditionalParam && (
            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => setOpenSubmenu('conditional')}
              onMouseLeave={() => setOpenSubmenu(null)}
            >
              <div
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  borderRadius: '2px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: openSubmenu === 'conditional' ? '#f8f9fa' : 'white'
                }}
              >
                <span>Conditional prob. parameter</span>
                <ChevronRight size={14} style={{ color: '#666' }} />
              </div>
              
              {openSubmenu === 'conditional' && (
                <div
                  style={{
                    position: 'absolute',
                    left: '100%',
                    top: 0,
                    background: 'white',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    minWidth: '200px',
                    padding: '4px',
                    zIndex: 10001,
                    marginLeft: '4px',
                    whiteSpace: 'nowrap'
                  }}
                >
                  <div
                    onClick={() => handleGetFromFile('conditional')}
                    style={{
                      padding: '6px 12px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      borderRadius: '2px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '16px'
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                  >
                    <span>Get data from file</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                      <Folders size={12} />
                      <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                      <TrendingUpDown size={12} />
                    </div>
                  </div>
                  <div
                    onClick={() => handlePutToFile('conditional')}
                    style={{
                      padding: '6px 12px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      borderRadius: '2px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '16px'
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                  >
                    <span>Put data to file</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                      <TrendingUpDown size={12} />
                      <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                      <Folders size={12} />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Cost GBP parameter submenu */}
          {hasCostGbpParam && (
            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => setOpenSubmenu('cost_gbp')}
              onMouseLeave={() => setOpenSubmenu(null)}
            >
              <div
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  borderRadius: '2px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: openSubmenu === 'cost_gbp' ? '#f8f9fa' : 'white'
                }}
              >
                <span>Cost (£) parameter</span>
                <ChevronRight size={14} style={{ color: '#666' }} />
              </div>
              
              {openSubmenu === 'cost_gbp' && (
                <div
                  style={{
                    position: 'absolute',
                    left: '100%',
                    top: 0,
                    background: 'white',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    minWidth: '200px',
                    padding: '4px',
                    zIndex: 10001,
                    marginLeft: '4px',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {/* Show "Get from Source (direct)" if there's ANY connection (direct OR file) */}
                  {hasCostGbpConnection && (
                    <div
                      onClick={() => handleGetFromSourceDirect('cost_gbp')}
                      style={{
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        borderRadius: '2px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px'
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                    >
                      <span>Get from Source (direct){costGbpConnectionName ? ` (${costGbpConnectionName})` : ''}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                        <Database size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                        <TrendingUpDown size={12} />
                      </div>
                    </div>
                  )}
                  {/* Show "Get from Source" (versioned) if there's a parameter file with connection */}
                  {hasCostGbpFileConnection && (
                    <div
                      onClick={() => handleGetFromSourceVersioned('cost_gbp')}
                      style={{
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        borderRadius: '2px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px'
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                    >
                      <span>Get from Source{costGbpConnectionName ? ` (${costGbpConnectionName})` : ''}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                        <DatabaseZap size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                        <Folders size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>+</span>
                        <TrendingUpDown size={12} />
                      </div>
                    </div>
                  )}
                  {/* Show file operations if there's a parameter file */}
                  {costGbpParameterId && (
                    <>
                      <div
                        onClick={() => handleGetFromFile('cost_gbp')}
                        style={{
                          padding: '6px 12px',
                          cursor: 'pointer',
                          fontSize: '13px',
                          borderRadius: '2px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '16px'
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                      >
                        <span>Get data from file</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                          <Folders size={12} />
                          <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                          <TrendingUpDown size={12} />
                        </div>
                      </div>
                      <div
                        onClick={() => handlePutToFile('cost_gbp')}
                        style={{
                          padding: '6px 12px',
                          cursor: 'pointer',
                          fontSize: '13px',
                          borderRadius: '2px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '16px'
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                      >
                        <span>Put data to file</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                          <TrendingUpDown size={12} />
                          <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                          <Folders size={12} />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Cost Time parameter submenu */}
          {hasCostTimeParam && (
            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => setOpenSubmenu('cost_time')}
              onMouseLeave={() => setOpenSubmenu(null)}
            >
              <div
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  borderRadius: '2px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: openSubmenu === 'cost_time' ? '#f8f9fa' : 'white'
                }}
              >
                <span>Duration parameter</span>
                <ChevronRight size={14} style={{ color: '#666' }} />
              </div>
              
              {openSubmenu === 'cost_time' && (
                <div
                  style={{
                    position: 'absolute',
                    left: '100%',
                    top: 0,
                    background: 'white',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    minWidth: '200px',
                    padding: '4px',
                    zIndex: 10001,
                    marginLeft: '4px',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {/* Show "Get from Source (direct)" if there's ANY connection (direct OR file) */}
                  {hasCostTimeConnection && (
                    <div
                      onClick={() => handleGetFromSourceDirect('cost_time')}
                      style={{
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        borderRadius: '2px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px'
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                    >
                      <span>Get from Source (direct){costTimeConnectionName ? ` (${costTimeConnectionName})` : ''}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                        <Database size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                        <TrendingUpDown size={12} />
                      </div>
                    </div>
                  )}
                  {/* Show "Get from Source" (versioned) if there's a parameter file with connection */}
                  {hasCostTimeFileConnection && (
                    <div
                      onClick={() => handleGetFromSourceVersioned('cost_time')}
                      style={{
                        padding: '6px 12px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        borderRadius: '2px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px'
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                    >
                      <span>Get from Source{costTimeConnectionName ? ` (${costTimeConnectionName})` : ''}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                        <DatabaseZap size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                        <Folders size={12} />
                        <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>+</span>
                        <TrendingUpDown size={12} />
                      </div>
                    </div>
                  )}
                  {/* Show file operations if there's a parameter file */}
                  {costTimeParameterId && (
                    <>
                      <div
                        onClick={() => handleGetFromFile('cost_time')}
                        style={{
                          padding: '6px 12px',
                          cursor: 'pointer',
                          fontSize: '13px',
                          borderRadius: '2px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '16px'
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                      >
                        <span>Get data from file</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                          <Folders size={12} />
                          <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                          <TrendingUpDown size={12} />
                        </div>
                      </div>
                      <div
                        onClick={() => handlePutToFile('cost_time')}
                        style={{
                          padding: '6px 12px',
                          cursor: 'pointer',
                          fontSize: '13px',
                          borderRadius: '2px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '16px'
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                      >
                        <span>Put data to file</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                          <TrendingUpDown size={12} />
                          <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                          <Folders size={12} />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div style={{ height: '1px', background: '#eee', margin: '8px 0' }} />

      {/* Properties */}
      <div
        onClick={() => {
          window.dispatchEvent(new CustomEvent('dagnet:openPropertiesPanel'));
          onClose();
        }}
        style={{
          padding: '8px 12px',
          cursor: 'pointer',
          fontSize: '13px',
          borderRadius: '2px',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
      >
        Properties
      </div>

      {/* Delete */}
      <div
        onClick={() => {
          onDeleteEdge(edgeId);
          onClose();
        }}
        style={{
          padding: '8px 12px',
          cursor: 'pointer',
          fontSize: '13px',
          color: '#dc3545',
          borderRadius: '2px'
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
      >
        Delete edge
      </div>
    </div>
  );
};
