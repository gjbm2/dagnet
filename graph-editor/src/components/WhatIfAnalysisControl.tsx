import React, { useState, useMemo, useCallback } from 'react';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { useTabContext } from '../contexts/TabContext';
import { useWhatIfContext } from '../contexts/WhatIfContext';
import { getConditionalColor, getConditionSignature } from '@/lib/conditionalColors';

export default function WhatIfAnalysisControl({ tabId }: { tabId?: string }) {
  console.log(`[${new Date().toISOString()}] [WhatIfControl] RENDER START`);
  const { graph } = useGraphStore();
  const { tabs, operations: tabOps } = useTabContext();
  const whatIfCtx = useWhatIfContext();
  const ts = () => new Date().toISOString();
  const myTab = tabs.find(t => t.id === tabId);
  const [searchTerm, setSearchTerm] = useState('');
  
  // What-if state: prefer fast context (visual), fallback to tab state
  const whatIfAnalysis = (whatIfCtx?.whatIfAnalysis !== undefined ? whatIfCtx?.whatIfAnalysis : myTab?.editorState?.whatIfAnalysis);
  const caseOverrides = (whatIfCtx?.caseOverrides !== undefined ? whatIfCtx?.caseOverrides : (myTab?.editorState?.caseOverrides || {}));
  const conditionalOverrides = (whatIfCtx?.conditionalOverrides !== undefined ? whatIfCtx?.conditionalOverrides : (myTab?.editorState?.conditionalOverrides || {}));
  
  // Helper to update tab's what-if state
  const setWhatIfAnalysis = (analysis: any) => {
    if (whatIfCtx?.setWhatIfAnalysis) {
      console.log(`[${ts()}] [WhatIfControl] setWhatIfAnalysis`);
      whatIfCtx.setWhatIfAnalysis(analysis);
      return;
    }
    if (tabId) {
      console.log(`[${ts()}] [WhatIfControl] setWhatIfAnalysis via tabOps.updateTabState`);
      tabOps.updateTabState(tabId, { whatIfAnalysis: analysis });
    }
  };
  
  const setCaseOverride = (nodeId: string, variantName: string | null) => {
    performance.mark('whatif-setCaseOverride-start');
    console.log(`[${ts()}] [WhatIfControl] setCaseOverride called:`, { nodeId, variantName, tabId });
    // Mark start of a What-If update for latency measurement
    window.dispatchEvent(new CustomEvent('dagnet:whatif-start', { detail: { t0: performance.now(), tabId } }));
    performance.mark('whatif-after-dispatch');
    // No-op if value unchanged
    const current = (whatIfCtx?.caseOverrides ?? myTab?.editorState?.caseOverrides ?? {}) as Record<string, string>;
    if ((variantName === null && !(nodeId in current)) || (variantName !== null && current[nodeId] === variantName)) {
      console.log(`[${ts()}] [WhatIfControl] setCaseOverride no-op (unchanged)`);
      performance.mark('whatif-noop-end');
      performance.measure('⚡ whatif-noop', 'whatif-setCaseOverride-start', 'whatif-noop-end');
      return;
    }
    performance.mark('whatif-before-context-update');
    if (whatIfCtx?.setCaseOverride) {
      whatIfCtx.setCaseOverride(nodeId, variantName);
      performance.mark('whatif-after-context-update');
      performance.measure('⚡ whatif-context-update', 'whatif-before-context-update', 'whatif-after-context-update');
      performance.measure('⚡ whatif-setCaseOverride-TOTAL', 'whatif-setCaseOverride-start', 'whatif-after-context-update');
      console.log(`[${ts()}] [WhatIfControl] setCaseOverride completed (context path)`);
      return;
    }
    if (!tabId) return;
    const newOverrides = { ...caseOverrides };
    if (variantName === null) delete newOverrides[nodeId]; else newOverrides[nodeId] = variantName;
    console.log(`[${ts()}] [WhatIfControl] updateTabState(caseOverrides) start`);
    tabOps.updateTabState(tabId, { caseOverrides: newOverrides });
    performance.mark('whatif-after-tabstate-update');
    performance.measure('⚡ whatif-tabstate-update', 'whatif-before-context-update', 'whatif-after-tabstate-update');
    performance.measure('⚡ whatif-setCaseOverride-TOTAL', 'whatif-setCaseOverride-start', 'whatif-after-tabstate-update');
    console.log(`[${ts()}] [WhatIfControl] setCaseOverride completed (tabOps path)`);
  };
  
  const setConditionalOverride = (edgeId: string, value: Set<string> | null) => {
    if (whatIfCtx?.setConditionalOverride) {
      console.log(`[${ts()}] [WhatIfControl] setConditionalOverride`);
      whatIfCtx.setConditionalOverride(edgeId, value);
      return;
    }
    if (!tabId) return;
    const newOverrides = { ...conditionalOverrides } as Record<string, Set<string>>;
    if (value === null) delete newOverrides[edgeId]; else newOverrides[edgeId] = value;
    console.log(`[${ts()}] [WhatIfControl] updateTabState(conditionalOverrides) start`);
    tabOps.updateTabState(tabId, { conditionalOverrides: newOverrides });
  };
  
  const clearAllOverrides = () => {
    if (whatIfCtx?.clearAllOverrides) {
      console.log(`[${ts()}] [WhatIfControl] clearAllOverrides via context`);
      whatIfCtx.clearAllOverrides();
      return;
    }
    if (!tabId) return;
    console.log(`[${ts()}] [WhatIfControl] clearAllOverrides via tabOps.updateTabState`);
    tabOps.updateTabState(tabId, { whatIfAnalysis: null, caseOverrides: {}, conditionalOverrides: {} });
  };

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
      // Create display name from first edge's conditions using node ids
      displayName: edges[0]?.conditional_p?.[0]?.condition?.visited?.length > 0
        ? `visited(${edges[0].conditional_p[0].condition.visited.map((nodeRef: string) => {
            const node = graph?.nodes.find((n: any) => n.uuid === nodeRef || n.id === nodeRef);
            return node?.label || node?.id || nodeRef;
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
      (n.id?.toLowerCase().includes(term))
    );
  }, [caseNodes, searchTerm]);

  const filteredConditionGroups = useMemo(() => {
    if (!searchTerm) return conditionGroups;
    const term = searchTerm.toLowerCase();
    return conditionGroups.filter(group => 
      group.displayName.toLowerCase().includes(term) ||
      group.edges.some(e => 
        (e.id?.toLowerCase().includes(term)) ||
        (e.id?.toLowerCase().includes(term))
      )
    );
  }, [conditionGroups, searchTerm]);

  // Count active overrides (including whatIfAnalysis)
  const activeCount = (whatIfAnalysis ? 1 : 0) + 
                     Object.keys(caseOverrides).length +
                     Object.keys(conditionalOverrides).length;

  // Get case node display name
  const getCaseNodeName = useCallback((nodeRef: string) => {
    const node = graph?.nodes.find(n => n.uuid === nodeRef || n.id === nodeRef);
    return node?.label || node?.id || nodeRef;
  }, [graph]);

  // Get conditional edge display name
  const getConditionalEdgeName = useCallback((edgeId: string) => {
    const edge = graph?.edges.find(e => e.uuid === edgeId || e.id === edgeId);
    return edge?.id || edge?.id || edgeId;
  }, [graph]);

  return (
    <div>
      {/* Active overrides chips */}
      {activeCount > 0 && (
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
          {Object.entries(caseOverrides).map(([nodeRef, variant]) => {
            const node = graph?.nodes.find(n => n.uuid === nodeRef || n.id === nodeRef);
            const nodeColor = node?.layout?.color || '#8B5CF6';
            return (
              <div
                key={nodeRef}
                style={{
                  background: nodeColor,
                  color: 'white',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <span>🎭 {getCaseNodeName(nodeRef)}: {variant}</span>
                <button
                  onClick={() => setCaseOverride(nodeRef, null)}
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
          {(() => {
            // Group conditional overrides by condition signature to avoid duplicates
            const groupedOverrides = new Map<string, { visitedNodes: Set<string>, edgeIds: string[], color: string }>();
            
            Object.entries(conditionalOverrides).forEach(([edgeId, visitedNodes]) => {
              const edge = graph?.edges.find(e => e.uuid === edgeId || e.id === edgeId);
              const signature = Array.from(visitedNodes).sort().join(',');
              
              if (!groupedOverrides.has(signature)) {
                groupedOverrides.set(signature, {
                  visitedNodes,
                  edgeIds: [edgeId],
                  color: edge ? (getConditionalColor(edge) || '#4ade80') : '#4ade80'
                });
              } else {
                groupedOverrides.get(signature)!.edgeIds.push(edgeId);
              }
            });
            
            return Array.from(groupedOverrides.entries()).map(([signature, group]) => {
              // Display which nodes are forced as visited
              const nodeNames = Array.from(group.visitedNodes).map(nodeRef => {
                const node = graph?.nodes.find(n => n.uuid === nodeRef || n.id === nodeRef);
                return node?.label || node?.id || nodeRef;
              }).join(', ');
              
              return (
                <div
                  key={signature}
                  style={{
                    background: group.color,
                    color: 'white',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                >
                  <span>🔀 visited({nodeNames})</span>
                  <button
                    onClick={() => {
                      if (!tabId) return;
                      // Clear ALL edges with this condition
                      const newOverrides = { ...conditionalOverrides };
                      group.edgeIds.forEach(edgeId => {
                        delete newOverrides[edgeId];
                      });
                      tabOps.updateTabState(tabId, { conditionalOverrides: newOverrides });
                    }}
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
            });
          })()}
        </div>
      )}

      {/* Main content */}
      <div style={{ marginTop: activeCount > 0 ? '8px' : '0' }}>
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
                const isActive = node.id in caseOverrides;
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
                      {node.label || node.id}
                    </div>
                  <select
                      value={caseOverrides[node.id] || ''}
                      onMouseDown={() => {
                        console.log(`[${ts()}] [WhatIfControl] dropdown onMouseDown - suspending layout for 3s`);
                        window.dispatchEvent(new CustomEvent('dagnet:suspendLayout', { 
                          detail: { ms: 3000 }
                        }));
                      }}
                      onFocus={() => {
                        console.log(`[${ts()}] [WhatIfControl] dropdown onFocus - suspending layout for 3s`);
                        window.dispatchEvent(new CustomEvent('dagnet:suspendLayout', { 
                          detail: { ms: 3000 }
                        }));
                      }}
                      onChange={(e) => {
                        performance.mark('dropdown-onChange-start');
                        console.log(`[${ts()}] [WhatIfControl] dropdown onChange fired`);
                        const variantName = e.target.value;
                        performance.mark('dropdown-before-setCaseOverride');
                        if (variantName) {
                          setCaseOverride(node.id, variantName);
                        } else {
                          setCaseOverride(node.id, null);
                        }
                        performance.mark('dropdown-after-setCaseOverride');
                        performance.measure('⚡ dropdown-onChange-TOTAL', 'dropdown-onChange-start', 'dropdown-after-setCaseOverride');
                        performance.measure('⚡ dropdown-setCaseOverride-call', 'dropdown-before-setCaseOverride', 'dropdown-after-setCaseOverride');
                        console.log(`[${ts()}] [WhatIfControl] dropdown onChange completed`);
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
                const anyActive = group.edges.some(e => e.id in conditionalOverrides);
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
                        // Find first active edge in group to determine dropdown value
                        const activeEdge = group.edges.find(e => e.id in conditionalOverrides);
                        if (!activeEdge) return '';
                        
                        const override = conditionalOverrides[activeEdge.id];
                        if (!override) return '';
                        
                        // The override is a Set<string> of forced visited nodes
                        // Convert to sorted array for comparison
                        const overrideIds = Array.from(override).sort().join(',');
                        
                        // Find matching conditional_p option
                        const matchingCond = activeEdge.conditional_p?.find(cond => {
                          const condIds = cond.condition.visited.map(ref => {
                            const node = graph?.nodes.find(n => n.uuid === ref || n.id === ref);
                            if (node) return node.uuid;
                            return ref;
                          }).sort().join(',');
                          return condIds === overrideIds;
                        });
                        
                        return matchingCond ? matchingCond.condition.visited.join(',') : '';
                      })()}
                      onMouseDown={() => {
                        console.log(`[${ts()}] [WhatIfControl] conditional dropdown onMouseDown - suspending layout for 3s`);
                        window.dispatchEvent(new CustomEvent('dagnet:suspendLayout', { 
                          detail: { ms: 3000 }
                        }));
                      }}
                      onFocus={() => {
                        console.log(`[${ts()}] [WhatIfControl] conditional dropdown onFocus - suspending layout for 3s`);
                        window.dispatchEvent(new CustomEvent('dagnet:suspendLayout', { 
                          detail: { ms: 3000 }
                        }));
                      }}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (!tabId) return;
                        
                        // Update ALL edges in the group at once (not one by one)
                        const newOverrides = { ...conditionalOverrides };
                        
                        if (!value) {
                          // Clear all edges in group
                          group.edges.forEach(edge => {
                            delete newOverrides[edge.id];
                          });
                        } else {
                          // Set override for all edges in group
                          const nodeRefs = value.split(',');
                          // Resolve all references (could be UUIDs or IDs) to actual UUIDs
                          const resolvedIds = nodeRefs.map(ref => {
                            // Try to find by UUID or ID
                            const node = graph?.nodes.find(n => n.uuid === ref || n.id === ref);
                            if (node) return node.uuid;
                            // Return as-is if not found
                            return ref;
                          });
                          
                          const visitedSet = new Set(resolvedIds);
                          group.edges.forEach(edge => {
                            newOverrides[edge.id] = visitedSet;
                          });
                        }
                        
                        // Single update with all changes
                        tabOps.updateTabState(tabId, { conditionalOverrides: newOverrides });
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
                          const n = graph?.nodes.find(node => node.uuid === nid || node.id === nid);
                          return n?.label || n?.id || nid;
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
    </div>
  );
}

