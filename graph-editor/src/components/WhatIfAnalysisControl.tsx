import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { useTabContext } from '../contexts/TabContext';
import { useWhatIfContext } from '../contexts/WhatIfContext';
import toast from 'react-hot-toast';
import { getConditionalColour, getConditionSignature, getConditionalProbabilityColour } from '@/lib/conditionalColours';
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
import CollapsibleSection from './CollapsibleSection';
import { Search, X } from 'lucide-react';
import './PropertiesPanel.css';

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
    
    // First, remove any existing case override for this case node from the DSL
    let cleanedDSL = whatIfDSL;
    const parsed = parseConstraints(whatIfDSL || '');
    const existingOverride = parsed.cases.find(c => {
      const matchedNode = graph.nodes.find((n: any) => 
        n.type === 'case' && (
          n.case?.id === c.key || 
          n.uuid === c.key || 
          n.id === c.key
        )
      );
      return matchedNode && (matchedNode.uuid === caseNode.uuid || matchedNode.id === caseNode.id);
    });
    
    if (existingOverride) {
      // Remove the old override first
      const oldCaseDSL = generateCaseDSL(existingOverride.key, existingOverride.value, !!caseNode.case?.id);
      cleanedDSL = removeConstraintFromDSL(cleanedDSL, oldCaseDSL);
    }
    
    // Then add the new override
    const caseDSL = generateCaseDSL(caseId, variantName, !!caseNode.case?.id);
    const newDSL = augmentDSLWithConstraint(cleanedDSL, caseDSL);
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
    return Array.from(groups.entries()).map(([signature, edges]) => {
      // Get colour from first condition in first edge
      const firstCondition = edges[0]?.conditional_p?.[0];
      const colour = firstCondition 
        ? getConditionalProbabilityColour(firstCondition)
        : getConditionalColour(edges[0]) || '#4ade80';
      
      return {
        signature,
        edges,
        colour,
        // Create display name from first edge's conditions
        displayName: edges[0]?.conditional_p?.[0]?.condition
          ? (typeof edges[0].conditional_p[0].condition === 'string'
              ? edges[0].conditional_p[0].condition
              : 'Empty condition')
          : 'Empty condition'
      };
    });
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
      <div className="property-section">
        <label className="property-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>What-If Scenario</span>
          {whatIfDSL && (
            <button
              onClick={clearAllOverrides}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#6B7280',
                fontSize: '11px',
                cursor: 'pointer',
                padding: '2px 6px',
                borderRadius: '3px',
                fontWeight: 'normal',
                textDecoration: 'underline',
                opacity: 0.7
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = '1';
                e.currentTarget.style.color = '#EF4444';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = '0.7';
                e.currentTarget.style.color = '#6B7280';
              }}
            >
              clear
            </button>
          )}
        </label>
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
      </div>

      {/* Main content */}
      <div className="property-section">
          {/* Search */}
          <div style={{ position: 'relative', marginBottom: '12px' }}>
            <Search 
              className="search-icon" 
              size={16} 
              strokeWidth={2}
              style={{
                position: 'absolute',
                left: '8px',
                top: '50%',
                transform: 'translateY(-50%)',
                color: '#999',
                pointerEvents: 'none',
                zIndex: 1
              }}
            />
            <input
              type="text"
              className="property-input"
              placeholder="Search cases or conditional edges..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                paddingLeft: '32px',
                paddingRight: searchTerm ? '32px' : '10px',
                fontFamily: 'inherit',
                background: 'white'
              }}
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm('')}
                style={{
                  position: 'absolute',
                  right: '6px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  color: '#666',
                  cursor: 'pointer',
                  padding: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '50%',
                  transition: 'background-color 0.15s ease',
                  zIndex: 2
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#e9ecef';
                  e.currentTarget.style.color = '#333';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                  e.currentTarget.style.color = '#666';
                }}
                title="Clear search"
              >
                <X size={14} strokeWidth={2} />
              </button>
            )}
          </div>

          {/* Case Nodes Section */}
          {filteredCaseNodes.length > 0 && (
            <CollapsibleSection title="Case Nodes" defaultOpen={true}>
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
                const nodeColour = node.layout?.colour || '#e5e7eb';
                
                  return (
                    <div key={node.id} style={{ marginBottom: '8px' }}>
                      <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', marginBottom: '8px', color: '#333' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div className="property-color-swatch" style={{
                            background: nodeColour
                          }} />
                          {node.case?.id || node.label || node.id}
                        </div>
                      </label>
                      <select
                        className="property-input"
                        style={{
                          zIndex: 10,
                          position: 'relative'
                        }}
                        value={(() => {
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
            </CollapsibleSection>
          )}

          {/* Condition Groups Section */}
          {filteredConditionGroups.length > 0 && (
            <CollapsibleSection title="Conditional Probabilities" defaultOpen={true}>
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
                const groupColour = group.colour || '#4ade80';
                
                  return (
                    <div key={group.signature} style={{ marginBottom: '8px' }}>
                      <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', marginBottom: '8px', color: '#333' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <div className="property-color-swatch" style={{
                            background: groupColour
                          }}></div>
                          <span>
                            {group.displayName}
                          </span>
                        </div>
                      </label>
                      <div className="property-helper-text" style={{ marginBottom: '6px', fontSize: '11px', color: '#666' }}>
                        Affects {group.edges.length} edge{group.edges.length > 1 ? 's' : ''}
                      </div>
                      <select
                        className="property-input"
                        style={{
                          zIndex: 10,
                          position: 'relative'
                        }}
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
                            const parsed = parseConstraints(whatIfDSL || '');
                            // Remove visited/exclude that match this group's conditions
                            for (const cond of group.edges[0]?.conditional_p || []) {
                              if (typeof cond.condition !== 'string') continue;
                              const normalizedCond = normalizeConstraintString(cond.condition);
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
            </CollapsibleSection>
          )}

          {filteredCaseNodes.length === 0 && conditionalEdges.length === 0 && (
            <div className="property-helper-text" style={{ textAlign: 'center', padding: '20px' }}>
              {searchTerm ? 'No matching cases or conditional edges' : 'No cases or conditional edges in this graph'}
            </div>
          )}
      </div>
    </div>
  );
}

