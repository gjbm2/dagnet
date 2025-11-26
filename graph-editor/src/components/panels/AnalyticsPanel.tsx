/**
 * AnalyticsPanel
 * 
 * Basic analytics panel for Phase 1 implementation.
 * 
 * Features:
 * - Shows DSL query string using QueryExpressionEditor (Monaco chip editor)
 * - AutomatableField wrapper for override state (ZapOff icon)
 * - Lists available analysis types
 * - Displays JSON results
 * - Persists override state to TabContext
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useGraphStore } from '../../contexts/GraphStoreContext';
import { graphComputeClient, AnalysisResponse, AvailableAnalysis } from '../../lib/graphComputeClient';
import { constructQueryDSL } from '../../lib/dslConstruction';
import { AutomatableField } from '../AutomatableField';
import { QueryExpressionEditor } from '../QueryExpressionEditor';
import { BarChart3, RefreshCw, ChevronDown, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import './AnalyticsPanel.css';

interface AnalyticsPanelProps {
  tabId?: string;
  hideHeader?: boolean;
}

export default function AnalyticsPanel({ tabId, hideHeader = false }: AnalyticsPanelProps) {
  // Get store state directly using the hook (same pattern as PropertiesPanel)
  const { graph } = useGraphStore();
  
  // Extract nodes and edges from graph (for DSL construction)
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  
  // State - DSL is NOT persisted, always derived from selection
  // (Override state is session-only, not saved across reloads)
  const [queryDSL, setQueryDSL] = useState<string>('');
  const [isQueryOverridden, setIsQueryOverridden] = useState(false);
  const [availableAnalyses, setAvailableAnalyses] = useState<AvailableAnalysis[]>([]);
  const [selectedAnalysisId, setSelectedAnalysisId] = useState<string | null>(null);
  const [results, setResults] = useState<AnalysisResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showSpinner, setShowSpinner] = useState(false); // Delayed spinner
  const [error, setError] = useState<string | null>(null);
  
  // Refs for debouncing and request tracking
  const analysisRequestRef = useRef<number>(0);
  const spinnerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Use a ref for graph to avoid recreating callbacks on every graph change
  const graphRef = useRef(graph);
  graphRef.current = graph;
  
  // Track selected nodes from React Flow (via custom event)
  // These are human-readable IDs, not UUIDs
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  
  // Query React Flow's selection state and convert UUIDs to human-readable IDs
  // Uses graphRef to avoid dependency on graph changing
  const querySelection = useCallback(() => {
    const detail = {
      selectedNodeUuids: [] as string[],
      selectedEdgeUuids: [] as string[]
    };
    // Dispatch synchronous event - GraphCanvas listener will populate detail with UUIDs
    window.dispatchEvent(new CustomEvent('dagnet:querySelection', { detail }));
    
    const selectionUuids = detail.selectedNodeUuids;
    if (selectionUuids.length === 0) return [];
    
    // Access graph from ref to get current value without dependency
    const currentNodes = graphRef.current?.nodes;
    if (!currentNodes || currentNodes.length === 0) {
      // Graph not loaded yet - return null to signal "not ready"
      return null;
    }
    
    // Convert UUIDs to human-readable IDs
    const humanReadableIds: string[] = [];
    for (const uuid of selectionUuids) {
      // Match by uuid (primary) or id (fallback for edge cases)
      const node = currentNodes.find((n: any) => n.uuid === uuid || n.id === uuid);
      if (node) {
        humanReadableIds.push(node.id);
      }
      // Silently skip unresolved nodes (don't spam console)
    }
    
    return humanReadableIds;
  }, []); // No dependencies - uses refs
  
  // Poll for selection changes (since there's no direct callback from React Flow)
  useEffect(() => {
    let mounted = true;
    
    // Helper to check and update selection
    const handleSelectionChange = () => {
      if (!mounted) return;
      
      const newIds = querySelection();
      // Skip if graph not ready (null return)
      if (newIds === null) return;
      
      setSelectedNodeIds(prev => {
        // Only update if actually changed
        const prevStr = prev.slice().sort().join(',');
        const newStr = newIds.slice().sort().join(',');
        if (prevStr !== newStr) {
          return newIds;
        }
        return prev;
      });
    };
    
    // Initial query
    handleSelectionChange();
    
    // Poll periodically (500ms - don't need to be super fast)
    const pollInterval = setInterval(handleSelectionChange, 500);
    
    // Also listen for any clicks that might change selection
    window.addEventListener('mouseup', handleSelectionChange);
    window.addEventListener('keyup', handleSelectionChange);
    
    return () => {
      mounted = false;
      clearInterval(pollInterval);
      window.removeEventListener('mouseup', handleSelectionChange);
      window.removeEventListener('keyup', handleSelectionChange);
    };
  }, [querySelection]);
  
  // Compute auto-generated DSL
  const autoGeneratedDSL = useMemo(() => {
    if (selectedNodeIds.length === 0) return '';
    return constructQueryDSL(selectedNodeIds, nodes as any[], edges as any[]);
  }, [selectedNodeIds, nodes, edges]);
  
  // Auto-construct DSL when selection changes (only if not overridden)
  useEffect(() => {
    if (!isQueryOverridden) {
      setQueryDSL(autoGeneratedDSL);
    }
  }, [autoGeneratedDSL, isQueryOverridden]);
  
  // No persistence - DSL is session-only, derived from selection
  
  // Handle DSL change from QueryExpressionEditor
  const handleDSLChange = useCallback((newValue: string) => {
    setQueryDSL(newValue);
  }, []);
  
  // Handle blur - commit the override if value differs from auto-generated
  const handleDSLBlur = useCallback((currentValue: string) => {
    if (currentValue !== autoGeneratedDSL) {
      setIsQueryOverridden(true);
    }
  }, [autoGeneratedDSL]);
  
  // Clear override - reset to auto-generated
  const clearOverride = useCallback(() => {
    setQueryDSL(autoGeneratedDSL);
    setIsQueryOverridden(false);
  }, [autoGeneratedDSL]);
  
  // Fetch available analyses when DSL changes (DSL is source of truth for analysis matching)
  useEffect(() => {
    if (!graph) {
      setAvailableAnalyses([]);
      setSelectedAnalysisId(null);
      return;
    }
    
    const fetchAvailable = async () => {
      try {
        console.log('[AnalyticsPanel] Fetching analyses for DSL:', JSON.stringify(queryDSL));
        const response = await graphComputeClient.getAvailableAnalyses(
          graph,
          queryDSL || undefined,
          1 // Single scenario for now
        );
        console.log('[AnalyticsPanel] Got analyses:', response.analyses.map(a => a.id));
        setAvailableAnalyses(response.analyses);
        
        // Auto-select primary analysis
        const primary = response.analyses.find(a => a.is_primary);
        if (primary) {
          setSelectedAnalysisId(primary.id);
        }
      } catch (err) {
        console.warn('Failed to fetch available analyses:', err);
        setAvailableAnalyses([]);
      }
    };
    
    fetchAvailable();
  }, [graph, queryDSL]);
  
  // Run analysis - called automatically on state changes
  const runAnalysis = useCallback(async () => {
    if (!graph) {
      setResults(null);
      setError(null);
      return;
    }
    
    // Need either selection or DSL (or an analysis type that doesn't require them)
    const hasInput = selectedNodeIds.length > 0 || queryDSL.trim();
    if (!hasInput && !selectedAnalysisId) {
      setResults(null);
      setError(null);
      return;
    }
    
    // Track this request to avoid race conditions
    const requestId = ++analysisRequestRef.current;
    
    setIsLoading(true);
    setError(null);
    
    // Show spinner after 500ms delay
    if (spinnerTimeoutRef.current) {
      clearTimeout(spinnerTimeoutRef.current);
    }
    spinnerTimeoutRef.current = setTimeout(() => {
      if (analysisRequestRef.current === requestId) {
        setShowSpinner(true);
      }
    }, 500);
    
    try {
      const response = await graphComputeClient.analyzeSelection(
        graph,
        queryDSL || undefined,
        'base',
        selectedAnalysisId || undefined
      );
      
      // Only update if this is still the latest request
      if (analysisRequestRef.current === requestId) {
        setResults(response);
        
        if (!response.success && response.error) {
          setError(response.error.message);
        }
      }
    } catch (err) {
      if (analysisRequestRef.current === requestId) {
        setError(err instanceof Error ? err.message : 'Analysis failed');
        setResults(null);
      }
    } finally {
      if (analysisRequestRef.current === requestId) {
        setIsLoading(false);
        setShowSpinner(false);
        if (spinnerTimeoutRef.current) {
          clearTimeout(spinnerTimeoutRef.current);
          spinnerTimeoutRef.current = null;
        }
      }
    }
  }, [graph, selectedNodeIds, queryDSL, selectedAnalysisId]);
  
  // Track previous analysis ID for detecting dropdown changes
  const prevAnalysisIdRef = useRef<string | null>(null);
  
  // Effect 1: Run immediately when analysis type dropdown changes
  useEffect(() => {
    // Skip initial render and when value is being auto-set
    if (prevAnalysisIdRef.current !== null && 
        selectedAnalysisId !== null && 
        prevAnalysisIdRef.current !== selectedAnalysisId) {
      runAnalysis();
    }
    prevAnalysisIdRef.current = selectedAnalysisId;
  }, [selectedAnalysisId, runAnalysis]);
  
  // Effect 2: Debounced auto-run for DSL/selection/graph changes
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      runAnalysis();
    }, 300);
    
    return () => clearTimeout(timeoutId);
  }, [graph, selectedNodeIds, queryDSL, runAnalysis]);
  
  // Cleanup spinner timeout on unmount
  useEffect(() => {
    return () => {
      if (spinnerTimeoutRef.current) {
        clearTimeout(spinnerTimeoutRef.current);
      }
    };
  }, []);
  
  // Get formatted result data
  const formattedResults = useMemo(() => {
    if (!results?.results?.[0]?.data) return null;
    return JSON.stringify(results.results[0].data, null, 2);
  }, [results]);
  
  return (
    <div className="analytics-panel">
      {/* Header */}
      {!hideHeader && (
        <div className="analytics-header">
          <BarChart3 size={14} strokeWidth={2} style={{ flexShrink: 0 }} />
          <h3 className="analytics-title">Analytics</h3>
        </div>
      )}
      
      {/* Main content area - responsive layout */}
      <div className="analytics-content">
        {/* Controls column */}
        <div className="analytics-controls">
          {/* Selection info */}
          <div className="analytics-section">
            <div className="analytics-section-label">Selection</div>
            <div className="analytics-selection-info">
              {selectedNodeIds.length === 0 ? (
                <span className="analytics-muted">No nodes selected</span>
              ) : (
                <>
                  <span>{selectedNodeIds.length} node{selectedNodeIds.length !== 1 ? 's' : ''}: </span>
                  <span className="analytics-node-ids" title={selectedNodeIds.join(', ')}>
                    {selectedNodeIds.slice(0, 3).join(', ')}
                    {selectedNodeIds.length > 3 && `, +${selectedNodeIds.length - 3} more`}
                  </span>
                </>
              )}
            </div>
          </div>
          
          {/* DSL Query - using AutomatableField + QueryExpressionEditor */}
          <div className="analytics-section">
            <AutomatableField
              label="Query DSL"
              layout="label-above"
              value={queryDSL}
              overridden={isQueryOverridden}
              onClearOverride={clearOverride}
              tooltip="DSL query derived from selection. Edit to override auto-generation."
            >
              <QueryExpressionEditor
                value={queryDSL}
                onChange={handleDSLChange}
                onBlur={handleDSLBlur}
                graph={graph}
                placeholder="from(node).to(node)"
                height="40px"
              />
            </AutomatableField>
          </div>
          
          {/* Analysis Type Selector */}
          <div className="analytics-section">
            <div className="analytics-section-label">Analysis Type</div>
            <div className="analytics-type-selector">
              <select
                className="analytics-select"
                value={selectedAnalysisId || ''}
                onChange={(e) => setSelectedAnalysisId(e.target.value)}
                disabled={availableAnalyses.length === 0}
              >
                {availableAnalyses.length === 0 ? (
                  <option value="">No analyses available</option>
                ) : (
                  availableAnalyses.map(analysis => (
                    <option key={analysis.id} value={analysis.id}>
                      {analysis.name}{analysis.is_primary ? ' (recommended)' : ''}
                    </option>
                  ))
                )}
              </select>
              <ChevronDown size={14} className="analytics-select-icon" />
            </div>
            {selectedAnalysisId && (
              <div className="analytics-type-description">
                {availableAnalyses.find(a => a.id === selectedAnalysisId)?.description}
              </div>
            )}
          </div>
        </div>
        
        {/* Results column */}
        <div className="analytics-output">
          {/* Loading Spinner (delayed) */}
          {showSpinner && (
            <div className="analytics-loading">
              <Loader2 size={16} className="analytics-spinner" />
              <span>Analyzing...</span>
            </div>
          )}
          
          {/* Error */}
          {error && (
            <div className="analytics-error">
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}
          
          {/* Results */}
          {results && results.success && (
            <div className="analytics-section analytics-results">
              <div className="analytics-section-label">
                <CheckCircle2 size={14} className="analytics-success-icon" />
                Results: {results.results?.[0]?.analysis_name}
              </div>
              <pre className="analytics-json">
                {formattedResults}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
