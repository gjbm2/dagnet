import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { useTabContext } from '../contexts/TabContext';
import { useWhatIfContext } from '../contexts/WhatIfContext';
import toast from 'react-hot-toast';
import { getConditionalColor, getConditionSignature } from '@/lib/conditionalColors';
import { 
  normalizeConstraintString, 
  evaluateConstraint, 
  parseConstraints,
  generateCaseDSL,
  augmentDSLWithConstraint,
  removeConstraintFromDSL
} from '@/lib/queryDSL';
import { convertOverridesToDSL, parseWhatIfDSL } from '@/lib/whatIf';
import { QueryExpressionEditor } from './QueryExpressionEditor';

export default function WhatIfAnalysisControl({ tabId }: { tabId?: string }) {
  const { graph } = useGraphStore();
  const { tabs, operations: tabOps } = useTabContext();
  const whatIfCtx = useWhatIfContext();
  const ts = () => new Date().toISOString();
  const myTab = tabs.find(t => t.id === tabId);
  const [searchTerm, setSearchTerm] = useState('');
  
  // NEW: Use whatIfDSL as primary source of truth
  // Convert old format to DSL on mount if needed (backward compatibility)
  const whatIfDSL = useMemo(() => {
    // First check if DSL is already set
    if (myTab?.editorState?.whatIfDSL !== undefined) {
      return myTab.editorState.whatIfDSL;
    }
    
    // Otherwise, convert old format to DSL
    const oldCaseOverrides = whatIfCtx?.caseOverrides ?? myTab?.editorState?.caseOverrides ?? {};
    const oldConditionalOverrides = myTab?.editorState?.conditionalOverrides ?? {};
    
    // Only convert if there are actual overrides
    if (Object.keys(oldCaseOverrides).length > 0 || Object.keys(oldConditionalOverrides).length > 0) {
      const convertedDSL = convertOverridesToDSL(oldCaseOverrides, oldConditionalOverrides, graph);
      // Auto-migrate: save DSL and clear old format
      if (tabId && convertedDSL) {
        tabOps.updateTabState(tabId, { 
          whatIfDSL: convertedDSL,
          caseOverrides: {},
          conditionalOverrides: {}
        });
      }
      return convertedDSL;
    }
    
    return null;
  }, [myTab?.editorState?.whatIfDSL, myTab?.editorState?.caseOverrides, myTab?.editorState?.conditionalOverrides, graph, tabId, whatIfCtx?.caseOverrides]);
  
  // Parse DSL to get overrides (for backward compatibility with whatIf.ts)
  const parsedOverrides = useMemo(() => {
    return parseWhatIfDSL(whatIfDSL, graph);
  }, [whatIfDSL, graph]);
  
  // Legacy support: still expose caseOverrides and conditionalOverrides for whatIf.ts
  const caseOverrides = parsedOverrides.caseOverrides || {};
  const conditionalOverrides = parsedOverrides.conditionalOverrides || {};
  
  // Legacy whatIfAnalysis support
  const whatIfAnalysis = (whatIfCtx?.whatIfAnalysis !== undefined ? whatIfCtx?.whatIfAnalysis : myTab?.editorState?.whatIfAnalysis);
  
  // Helper to update what-if DSL
  const setWhatIfDSL = useCallback((dsl: string | null) => {
    if (!tabId) return;
    
    // Mark start of a What-If update for latency measurement
    window.dispatchEvent(new CustomEvent('dagnet:whatif-start', { detail: { t0: performance.now(), tabId } }));
    
    // Auto-unhide Current layer if What-If is being activated and Current is hidden
    if (dsl && dsl.trim() !== '') {
      const scenarioState = tabOps.getScenarioState(tabId);
      const visibleScenarioIds = scenarioState?.visibleScenarioIds || [];
      
      if (!visibleScenarioIds.includes('current')) {
        // Current is hidden - auto-unhide it
        tabOps.setVisibleScenarios(tabId, [...visibleScenarioIds, 'current']);
        
        // Show toast notification
        toast.success('Current layer auto-shown (What-If requires Current to be visible)', {
          duration: 3000,
          icon: '👁️'
        });
      }
    }
    
    tabOps.updateTabState(tabId, { whatIfDSL: dsl });
    
    // Also update context for immediate visual feedback (convert DSL to old format temporarily)
    if (whatIfCtx) {
      const parsed = parseWhatIfDSL(dsl || null, graph);
      if (whatIfCtx.setCaseOverride) {
        // Clear all first
        Object.keys(whatIfCtx.caseOverrides || {}).forEach(nodeId => {
          whatIfCtx.setCaseOverride!(nodeId, null);
        });
        // Then set new ones
        Object.entries(parsed.caseOverrides || {}).forEach(([nodeId, variant]) => {
          whatIfCtx.setCaseOverride!(nodeId, variant);
        });
      }
      if (whatIfCtx.setConditionalOverride) {
        // Clear all first
        Object.keys(whatIfCtx.conditionalOverrides || {}).forEach(edgeId => {
          whatIfCtx.setConditionalOverride!(edgeId, null);
        });
        // Then set new ones (convert string to Set for context)
        Object.entries(parsed.conditionalOverrides || {}).forEach(([edgeId, condition]) => {
          if (typeof condition === 'string') {
            const parsedCond = parseConstraints(condition);
            whatIfCtx.setConditionalOverride!(edgeId, new Set(parsedCond.visited));
          }
        });
      }
    }
  }, [tabId, graph, whatIfCtx, tabOps]);
  
  // Helper to add case override to DSL
  const addCaseOverride = useCallback((nodeId: string, variantName: string) => {
    if (!graph) return;
    const caseNode = graph.nodes.find((n: any) => n.type === 'case' && (n.uuid === nodeId || n.id === nodeId));
    if (!caseNode) return;
    
    const caseId = caseNode.case?.id || caseNode.uuid || caseNode.id;
    const caseDSL = generateCaseDSL(caseId, variantName, !!caseNode.case?.id);
    const newDSL = augmentDSLWithConstraint(whatIfDSL, caseDSL);
    setWhatIfDSL(newDSL);
  }, [graph, whatIfDSL, setWhatIfDSL]);
  
  // Helper to remove case override from DSL
  const removeCaseOverride = useCallback((nodeId: string, variantName: string) => {
    if (!graph) return;
    const caseNode = graph.nodes.find((n: any) => n.type === 'case' && (n.uuid === nodeId || n.id === nodeId));
    if (!caseNode) return;
    
    const caseId = caseNode.case?.id || caseNode.uuid || caseNode.id;
    const caseDSL = generateCaseDSL(caseId, variantName, !!caseNode.case?.id);
    const newDSL = removeConstraintFromDSL(whatIfDSL, caseDSL);
    setWhatIfDSL(newDSL || null);
  }, [graph, whatIfDSL, setWhatIfDSL]);
  
  // Helper to add conditional override to DSL
  const addConditionalOverride = useCallback((condition: string) => {
    const newDSL = augmentDSLWithConstraint(whatIfDSL, condition);
    setWhatIfDSL(newDSL);
  }, [whatIfDSL, setWhatIfDSL]);
  
  // Helper to remove conditional override from DSL
  const removeConditionalOverride = useCallback((condition: string) => {
    const newDSL = removeConstraintFromDSL(whatIfDSL, condition);
    setWhatIfDSL(newDSL || null);
  }, [whatIfDSL, setWhatIfDSL]);
  
  const clearAllOverrides = useCallback(() => {
    setWhatIfDSL(null);
  }, [setWhatIfDSL]);

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
      // Create display name from first edge's conditions
      displayName: edges[0]?.conditional_p?.[0]?.condition
        ? (typeof edges[0].conditional_p[0].condition === 'string'
            ? edges[0].conditional_p[0].condition
            : 'Empty condition')
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

  // Count active overrides
  const activeCount = whatIfDSL ? 1 : 0;

  return (
    <div>
      {/* DSL Editor - NEW: Use QueryExpressionEditor for display/editing */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontWeight: '600', fontSize: '13px', marginBottom: '8px', color: '#333' }}>
          What-If Scenario
        </div>
        <QueryExpressionEditor
          value={whatIfDSL || ''}
          onChange={(newDSL) => {
            setWhatIfDSL(newDSL || null);
          }}
          graph={graph}
          placeholder="case(case_id:treatment).visited(nodea)"
          height="80px"
          readonly={false}
        />
        {whatIfDSL && (
          <button
            onClick={clearAllOverrides}
            style={{
              marginTop: '8px',
              padding: '6px 12px',
              background: '#ef4444',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px'
            }}
          >
            Clear All
          </button>
        )}
      </div>

      {/* Main content */}
      <div style={{ marginTop: '8px' }}>
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
                // Check if this case node has an override in the DSL
                const parsed = parseConstraints(whatIfDSL || '');
                const caseOverride = parsed.cases.find(c => {
                  const caseNode = graph?.nodes.find((n: any) => 
                    n.type === 'case' && (
                      n.case?.id === c.key || 
                      n.uuid === c.key || 
                      n.id === c.key ||
                      (n.uuid === node.uuid || n.id === node.id)
                    )
                  );
                  return caseNode && (caseNode.uuid === node.uuid || caseNode.id === node.id);
                });
                const isActive = !!caseOverride;
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
                      value={(() => {
                        // Check if this case node has an override in the DSL
                        const parsed = parseConstraints(whatIfDSL || '');
                        const caseOverride = parsed.cases.find(c => {
                          // Match by case.id or node UUID/ID
                          const caseNode = graph?.nodes.find((n: any) => 
                            n.type === 'case' && (
                              n.case?.id === c.key || 
                              n.uuid === c.key || 
                              n.id === c.key ||
                              (n.uuid === node.uuid || n.id === node.id)
                            )
                          );
                          return caseNode && (caseNode.uuid === node.uuid || caseNode.id === node.id);
                        });
                        return caseOverride?.value || '';
                      })()}
                      onChange={(e) => {
                        const variantName = e.target.value;
                        if (variantName) {
                          addCaseOverride(node.id || node.uuid, variantName);
                        } else {
                          // Find current override and remove it
                          const parsed = parseConstraints(whatIfDSL || '');
                          const caseOverride = parsed.cases.find(c => {
                            const caseNode = graph?.nodes.find((n: any) => 
                              n.type === 'case' && (
                                n.case?.id === c.key || 
                                n.uuid === c.key || 
                                n.id === c.key ||
                                (n.uuid === node.uuid || n.id === node.id)
                              )
                            );
                            return caseNode && (caseNode.uuid === node.uuid || caseNode.id === node.id);
                          });
                          if (caseOverride) {
                            removeCaseOverride(node.id || node.uuid, caseOverride.value);
                          }
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
                // Check if any edge in this group has an active override in the DSL
                const parsed = parseConstraints(whatIfDSL || '');
                const anyActive = group.edges[0]?.conditional_p?.some(cond => {
                  if (typeof cond.condition !== 'string') return false;
                  const normalizedCond = normalizeConstraintString(cond.condition);
                  const dslHasVisited = parsed.visited.length > 0 && 
                    cond.condition.includes('visited(') &&
                    parsed.visited.some(v => cond.condition.includes(v));
                  const dslHasExclude = parsed.exclude.length > 0 &&
                    cond.condition.includes('exclude(') &&
                    parsed.exclude.some(e => cond.condition.includes(e));
                  return dslHasVisited || dslHasExclude || normalizeConstraintString(whatIfDSL || '') === normalizedCond;
                }) || false;
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
                        // Check if any edge in this group has an active override in the DSL
                        const parsed = parseConstraints(whatIfDSL || '');
                        // Find matching condition from DSL
                        for (const cond of group.edges[0]?.conditional_p || []) {
                          if (typeof cond.condition !== 'string') continue;
                          const normalizedCond = normalizeConstraintString(cond.condition);
                          // Check if DSL contains this condition (or a superset)
                          const dslHasVisited = parsed.visited.length > 0 && 
                            cond.condition.includes('visited(') &&
                            parsed.visited.some(v => cond.condition.includes(v));
                          const dslHasExclude = parsed.exclude.length > 0 &&
                            cond.condition.includes('exclude(') &&
                            parsed.exclude.some(e => cond.condition.includes(e));
                          
                          if (dslHasVisited || dslHasExclude || normalizeConstraintString(whatIfDSL || '') === normalizedCond) {
                            return normalizedCond;
                          }
                        }
                        return '';
                      })()}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (!value) {
                          // Remove condition from DSL
                          // Find which condition was active
                          const parsed = parseConstraints(whatIfDSL || '');
                          // Remove visited/exclude that match this group's conditions
                          for (const cond of group.edges[0]?.conditional_p || []) {
                            if (typeof cond.condition !== 'string') continue;
                            const normalizedCond = normalizeConstraintString(cond.condition);
                            const condParsed = parseConstraints(normalizedCond);
                            // Remove matching visited/exclude nodes
                            const newDSL = removeConstraintFromDSL(whatIfDSL, normalizedCond);
                            if (newDSL !== whatIfDSL) {
                              setWhatIfDSL(newDSL || null);
                              break;
                            }
                          }
                        } else {
                          // Add condition to DSL
                          addConditionalOverride(value);
                        }
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
                        // Skip old format conditions
                        if (typeof cond.condition !== 'string') {
                          return null;
                        }
                        
                        const conditionSig = normalizeConstraintString(cond.condition);
                        const displayLabel = cond.condition;
                        
                        return (
                          <option key={idx} value={conditionSig}>
                            What if: {displayLabel}?
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

