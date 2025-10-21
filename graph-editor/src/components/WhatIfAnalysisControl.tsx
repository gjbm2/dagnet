import React, { useState, useMemo, useCallback } from 'react';
import { useGraphStore } from '@/lib/useGraphStore';
import { getConditionalColor, getConditionSignature } from '@/lib/conditionalColors';

export default function WhatIfAnalysisControl() {
  const { graph, whatIfAnalysis, setWhatIfAnalysis, whatIfOverrides, setCaseOverride, setConditionalOverride, clearAllOverrides } = useGraphStore();
  const [isExpanded, setIsExpanded] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  // Get all case nodes and conditional edges
  const caseNodes = useMemo(() => {
    if (!graph) return [];
    return graph.nodes.filter(n => n.type === 'case' && n.case?.variants);
  }, [graph]);

  const conditionalEdges = useMemo(() => {
    if (!graph) return [];
    return graph.edges.filter(e => e.conditional_p && e.conditional_p.length > 0);
  }, [graph]);

  // Group conditional edges by condition signature
  const conditionGroups = useMemo(() => {
    if (!graph) return [];
    const groups = new Map<string, any[]>();
    
    conditionalEdges.forEach(edge => {
      const signature = getConditionSignature(edge);
      if (!groups.has(signature)) {
        groups.set(signature, []);
      }
      groups.get(signature)!.push(edge);
    });
    
    // Convert to array of objects
    return Array.from(groups.entries()).map(([signature, edges]) => ({
      signature,
      edges,
      color: edges[0]?.display?.conditional_color,
      // Create display name from first edge's conditions using node slugs
      displayName: edges[0]?.conditional_p?.[0]?.condition?.visited?.length > 0
        ? `visited(${edges[0].conditional_p[0].condition.visited.map((nodeId: string) => {
            const node = graph?.nodes.find((n: any) => n.id === nodeId);
            return node?.slug || node?.label || nodeId;
          }).join(', ')})`
        : 'Empty condition'
    }));
  }, [graph, conditionalEdges]);

  // Filter based on search
  const filteredCaseNodes = useMemo(() => {
    if (!searchTerm) return caseNodes;
    const term = searchTerm.toLowerCase();
    return caseNodes.filter(n => 
      (n.label?.toLowerCase().includes(term)) ||
      (n.slug?.toLowerCase().includes(term))
    );
  }, [caseNodes, searchTerm]);

  const filteredConditionGroups = useMemo(() => {
    if (!searchTerm) return conditionGroups;
    const term = searchTerm.toLowerCase();
    return conditionGroups.filter(group => 
      group.displayName.toLowerCase().includes(term) ||
      group.edges.some(e => 
        (e.slug?.toLowerCase().includes(term)) ||
        (e.id?.toLowerCase().includes(term))
      )
    );
  }, [conditionGroups, searchTerm]);

  // Count active overrides (including legacy whatIfAnalysis)
  const activeCount = (whatIfAnalysis ? 1 : 0) + 
                     (whatIfOverrides?.conditionalOverrides?.size || 0);

  // Get case node display name
  const getCaseNodeName = useCallback((nodeId: string) => {
    const node = graph?.nodes.find(n => n.id === nodeId);
    return node?.label || node?.slug || nodeId;
  }, [graph]);

  // Get conditional edge display name
  const getConditionalEdgeName = useCallback((edgeId: string) => {
    const edge = graph?.edges.find(e => e.id === edgeId);
    return edge?.slug || edge?.id || edgeId;
  }, [graph]);

  return (
    <div style={{
      background: '#f8f9fa',
      border: '1px solid #ddd',
      borderRadius: '6px',
      padding: '12px',
      marginBottom: '16px'
    }}>
      <div 
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          userSelect: 'none'
        }}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '18px' }}>🎭</span>
          <span style={{ fontWeight: '600', fontSize: '14px' }}>What-If Analysis</span>
          {activeCount > 0 && (
            <span style={{
              background: '#007bff',
              color: 'white',
              borderRadius: '12px',
              padding: '2px 8px',
              fontSize: '11px',
              fontWeight: '600'
            }}>
              {activeCount} active
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {activeCount > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setWhatIfAnalysis(null);
                clearAllOverrides();
              }}
              style={{
                padding: '4px 12px',
                fontSize: '12px',
                background: '#dc3545',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer'
              }}
            >
              Clear All
            </button>
          )}
          <span style={{ fontSize: '14px', color: '#666' }}>
            {isExpanded ? '▾' : '▸'}
          </span>
        </div>
      </div>

      {/* Active overrides chips */}
      {activeCount > 0 && !isExpanded && (
        <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {whatIfAnalysis && (
            <div
              style={{
                background: '#8B5CF6',
                color: 'white',
                padding: '4px 8px',
                borderRadius: '4px',
                fontSize: '11px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <span>🎭 {getCaseNodeName(whatIfAnalysis.caseNodeId)}: {whatIfAnalysis.selectedVariant}</span>
              <button
                onClick={() => setWhatIfAnalysis(null)}
                style={{
                  background: 'rgba(255,255,255,0.3)',
                  border: 'none',
                  color: 'white',
                  borderRadius: '3px',
                  cursor: 'pointer',
                  padding: '0 4px',
                  fontSize: '11px'
                }}
              >
                ×
              </button>
            </div>
          )}
          {Array.from(whatIfOverrides?.conditionalOverrides?.entries() || []).map(([edgeId, visitedNodes]) => {
            const edge = graph?.edges.find(e => e.id === edgeId);
            const edgeColor = edge ? (getConditionalColor(edge) || '#4ade80') : '#4ade80';
            return (
              <div
                key={edgeId}
                style={{
                  background: edgeColor,
                  color: 'white',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <span>🔀 {getConditionalEdgeName(edgeId)}</span>
                <button
                  onClick={() => setConditionalOverride(edgeId, null)}
                  style={{
                    background: 'rgba(255,255,255,0.3)',
                    border: 'none',
                    color: 'white',
                    borderRadius: '3px',
                    cursor: 'pointer',
                    padding: '0 4px',
                    fontSize: '11px'
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      {isExpanded && (
        <div style={{ marginTop: '12px' }}>
          {/* Search */}
          <input
            type="text"
            placeholder="Search cases or conditional edges..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              padding: '8px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              marginBottom: '12px',
              boxSizing: 'border-box'
            }}
          />

          {/* Case Nodes Section */}
          {filteredCaseNodes.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontWeight: '600', fontSize: '13px', marginBottom: '8px', color: '#8B5CF6' }}>
                🎭 Case Nodes
              </div>
              {filteredCaseNodes.map(node => {
                const isActive = whatIfAnalysis?.caseNodeId === node.id;
                const variants = node.case?.variants || [];
                const nodeColor = node.layout?.color || '#e5e7eb';
                
                return (
                  <div
                    key={node.id}
                    style={{
                      background: 'white',
                      padding: '10px',
                      marginBottom: '6px',
                      borderRadius: '4px',
                      border: isActive ? `2px solid ${nodeColor}` : '1px solid #e9ecef'
                    }}
                  >
                    <div style={{ 
                      fontWeight: '600', 
                      fontSize: '12px', 
                      marginBottom: '6px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px'
                    }}>
                      <div style={{
                        width: '16px',
                        height: '16px',
                        borderRadius: '2px',
                        background: nodeColor,
                        border: '1px solid rgba(0,0,0,0.2)',
                        flexShrink: 0
                      }} />
                      {node.label || node.slug}
                    </div>
                    <select
                      value={isActive ? whatIfAnalysis.selectedVariant : ''}
                      onChange={(e) => {
                        const variantName = e.target.value;
                        if (variantName) {
                          setWhatIfAnalysis({
                            caseNodeId: node.id,
                            selectedVariant: variantName
                          });
                        } else {
                          setWhatIfAnalysis(null);
                        }
                      }}
                      style={{
                        width: '100%',
                        padding: '6px',
                        border: '1px solid #ddd',
                        borderRadius: '4px',
                        fontSize: '12px',
                        background: isActive ? '#fff9e6' : 'white',
                        fontWeight: isActive ? 'bold' : 'normal'
                      }}
                    >
                      <option value="">All variants (actual weights)</option>
                      {variants.map(variant => (
                        <option key={variant.name} value={variant.name}>
                          {variant.name} - What if 100%?
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          )}

          {/* Condition Groups Section */}
          {filteredConditionGroups.length > 0 && (
            <div>
              <div style={{ fontWeight: '600', fontSize: '13px', marginBottom: '8px', color: '#4ade80' }}>
                🔀 Conditional Probability Groups
              </div>
              {filteredConditionGroups.map((group, groupIdx) => {
                // Check if any edge in this group has an active override
                const anyActive = group.edges.some(e => whatIfOverrides?.conditionalOverrides?.has(e.id));
                const groupColor = group.color || '#4ade80';
                
                return (
                  <div
                    key={group.signature}
                    style={{
                      background: 'white',
                      padding: '10px',
                      marginBottom: '6px',
                      borderRadius: '4px',
                      border: anyActive ? `2px solid ${groupColor}` : '1px solid #e9ecef'
                    }}
                  >
                    <div style={{ marginBottom: '6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                        <div style={{
                          width: '12px',
                          height: '12px',
                          borderRadius: '2px',
                          background: groupColor,
                          border: '1px solid #ddd'
                        }}></div>
                        <span style={{ fontWeight: '600', fontSize: '12px' }}>
                          {group.displayName}
                        </span>
                      </div>
                      <div style={{ fontSize: '10px', color: '#6c757d', marginLeft: '18px' }}>
                        Affects {group.edges.length} edge{group.edges.length > 1 ? 's' : ''}
                      </div>
                    </div>
                    <select
                      value={(() => {
                        if (!anyActive || !whatIfOverrides?.conditionalOverrides) return '';
                        const override = whatIfOverrides.conditionalOverrides.get(group.edges[0].id);
                        if (!override) return '';
                        // The override contains IDs, need to find matching option
                        // Match by comparing resolved IDs
                        const overrideIds = Array.from(override).sort().join(',');
                        const matchingCond = group.edges[0]?.conditional_p?.find(cond => {
                          const condIds = cond.condition.visited.map(ref => {
                            const nodeById = graph?.nodes.find(n => n.id === ref);
                            if (nodeById) return nodeById.id;
                            const nodeBySlug = graph?.nodes.find(n => n.slug === ref);
                            if (nodeBySlug) return nodeBySlug.id;
                            return ref;
                          }).sort().join(',');
                          return condIds === overrideIds;
                        });
                        return matchingCond ? matchingCond.condition.visited.join(',') : '';
                      })()}
                      onChange={(e) => {
                        const value = e.target.value;
                        // Apply to ALL edges in the group
                        group.edges.forEach(edge => {
                          if (!value) {
                            setConditionalOverride(edge.id, null);
                          } else {
                            const nodeRefs = value.split(',');
                            // Resolve all references (could be slugs or IDs) to actual IDs
                            const resolvedIds = nodeRefs.map(ref => {
                              // Try to find by ID first
                              const nodeById = graph?.nodes.find(n => n.id === ref);
                              if (nodeById) return nodeById.id;
                              // Try by slug
                              const nodeBySlug = graph?.nodes.find(n => n.slug === ref);
                              if (nodeBySlug) return nodeBySlug.id;
                              // Return as-is if not found
                              return ref;
                            });
                            setConditionalOverride(edge.id, new Set(resolvedIds));
                          }
                        });
                      }}
                      style={{
                        width: '100%',
                        padding: '6px',
                        border: '1px solid #ddd',
                        borderRadius: '4px',
                        fontSize: '12px',
                        background: anyActive ? '#fff9e6' : 'white',
                        fontWeight: anyActive ? 'bold' : 'normal'
                      }}
                    >
                      <option value="">Base probabilities</option>
                      {group.edges[0]?.conditional_p?.map((cond, idx) => {
                        const nodeNames = cond.condition.visited.map(nid => {
                          const n = graph?.nodes.find(node => node.id === nid);
                          return n?.label || n?.slug || nid;
                        }).join(', ');
                        return (
                          <option key={idx} value={cond.condition.visited.join(',')}>
                            What if: visited({nodeNames})?
                          </option>
                        );
                      })}
                    </select>
                  </div>
                );
              })}
            </div>
          )}

          {filteredCaseNodes.length === 0 && conditionalEdges.length === 0 && (
            <div style={{ textAlign: 'center', padding: '20px', color: '#666' }}>
              {searchTerm ? 'No matching cases or conditional edges' : 'No cases or conditional edges in this graph'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

