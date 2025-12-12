/**
 * All Slices Modal
 * 
 * Modal for fetching data across all pinned slices.
 * Uses dslExplosion to enumerate slices from graph.dataInterestsDSL,
 * then runs 'Get all from sources (versioned)' for each selected slice.
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { explodeDSL } from '../../lib/dslExplosion';
import { dataOperationsService, setBatchMode } from '../../services/dataOperationsService';
import { sessionLogService } from '../../services/sessionLogService';
import { LogFileService } from '../../services/logFileService';
import { useTabContext } from '../../contexts/TabContext';
import toast from 'react-hot-toast';
import type { GraphData } from '../../types';
import './Modal.css';

interface AllSlicesModalProps {
  isOpen: boolean;
  onClose: () => void;
  graph: GraphData | null;
  setGraph: (graph: GraphData | null) => void;
}

interface SliceItem {
  id: string;
  dsl: string;
  selected: boolean;
}

/**
 * All Slices Modal
 * 
 * Allows users to:
 * - View all slices derived from graph.dataInterestsDSL
 * - Select which slices to fetch
 * - Execute batch fetches across all selected slices with progress tracking
 */
export function AllSlicesModal({
  isOpen,
  onClose,
  graph,
  setGraph
}: AllSlicesModalProps) {
  const { operations: tabOperations } = useTabContext();
  const [slices, setSlices] = useState<SliceItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState({ currentSlice: 0, totalSlices: 0, currentItem: 0, totalItems: 0 });
  const [bustCache, setBustCache] = useState(false);
  const [simulateToLog, setSimulateToLog] = useState(false);
  
  // CRITICAL: Use ref for log content so it's synchronously available at end of batch
  // React state setters are async, so logContent state would be empty when we check it
  const logContentRef = useRef<string>('');
  
  // CRITICAL: Use ref to track latest graph state during batch operations
  // Without this, rebalancing doesn't work because each iteration uses stale graph
  const graphRef = useRef(graph);
  
  // Abort ref for cancelling in-progress operations
  const abortRef = useRef(false);
  const [currentSliceName, setCurrentSliceName] = useState('');

  // Load slices when modal opens
  useEffect(() => {
    const loadSlices = async () => {
      if (!isOpen || !graph?.dataInterestsDSL) {
        setSlices([]);
        return;
      }
      
      setIsLoading(true);
      try {
        const dslSlices = await explodeDSL(graph.dataInterestsDSL);
        setSlices(dslSlices.map((dsl, idx) => ({
          id: `slice-${idx}`,
          dsl,
          selected: true // All selected by default
        })));
      } catch (error) {
        console.error('[AllSlicesModal] Failed to explode DSL:', error);
        toast.error('Failed to parse data interests DSL');
        setSlices([]);
      } finally {
        setIsLoading(false);
      }
    };
    
    loadSlices();
  }, [isOpen, graph?.dataInterestsDSL]);

  // Keep graphRef in sync with graph prop (for initial value and external changes)
  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setIsProcessing(false);
      setProgress({ currentSlice: 0, totalSlices: 0, currentItem: 0, totalItems: 0 });
      setCurrentSliceName('');
    }
  }, [isOpen]);

  const handleToggleSlice = (id: string) => {
    setSlices(prev => prev.map(slice => 
      slice.id === id ? { ...slice, selected: !slice.selected } : slice
    ));
  };

  const handleSelectAll = () => {
    setSlices(prev => prev.map(slice => ({ ...slice, selected: true })));
  };

  const handleDeselectAll = () => {
    setSlices(prev => prev.map(slice => ({ ...slice, selected: false })));
  };

  const selectedSlices = useMemo(() => slices.filter(s => s.selected), [slices]);

  const executeAllSlicesFetch = async () => {
    if (!graph || selectedSlices.length === 0) return;

    // Simulation mode: do NOT hit external providers. Produce a detailed report log only.
    if (simulateToLog) {
      setIsProcessing(true);
      try {
        const report = await dataOperationsService.simulateRetrieveAllSlicesToMarkdown({
          graph: graph as any,
          slices: selectedSlices.map(s => s.dsl),
          bustCache,
        });
        
        await LogFileService.createLogFile(
          report,
          tabOperations,
          `Retrieve All Slices (Simulated) (${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })})`
        );
        
        toast.success('Simulation complete (no external requests made)');
      } catch (error) {
        console.error('[AllSlicesModal] Simulation failed:', error);
        toast.error(`Simulation failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setIsProcessing(false);
        onClose();
      }
      return;
    }

    setIsProcessing(true);
    const totalSlices = selectedSlices.length;
    setProgress({ currentSlice: 0, totalSlices, currentItem: 0, totalItems: 0 });
    
    // Enable batch mode to suppress individual toasts
    setBatchMode(true);
    
    // Initialize log content with header (legacy "Create log file" path removed)
    const startTime = new Date();
    logContentRef.current = '';

    // Start session log operation
    const logOpId = sessionLogService.startOperation(
      'info',
      'data-fetch',
      'BATCH_ALL_SLICES',
      `Retrieve All Slices: ${totalSlices} slice(s)`,
      {
        filesAffected: selectedSlices.map(s => s.dsl)
      }
    );

    // Show progress toast
    const progressToastId = toast.loading(
      `Processing slice 0/${totalSlices}...`,
      { duration: Infinity }
    );

    let totalSuccess = 0;
    let totalErrors = 0;
    
    // Reset abort flag at start
    abortRef.current = false;
    
    // CRITICAL: Wrap setGraph to also update graphRef
    // This ensures rebalancing works correctly across iterations
    const setGraphWithRef = (newGraph: GraphData | null) => {
      graphRef.current = newGraph;
      setGraph(newGraph);
    };

    try {
      for (let sliceIdx = 0; sliceIdx < selectedSlices.length; sliceIdx++) {
        // Check for abort request
        if (abortRef.current) {
          toast.dismiss(progressToastId);
          toast('Operation cancelled', { icon: '⏹️' });
          break;
        }
        
        const slice = selectedSlices[sliceIdx];
        setProgress(prev => ({ ...prev, currentSlice: sliceIdx + 1 }));
        setCurrentSliceName(slice.dsl);

        toast.loading(
          `Processing slice ${sliceIdx + 1}/${totalSlices}: ${slice.dsl}`,
          { id: progressToastId, duration: Infinity }
        );

        try {
          // CRITICAL: Use graphRef.current for latest state (not stale closure)
          const currentGraph = graphRef.current;
          if (!currentGraph) continue;
          
          // Collect batch items for this slice (similar to BatchOperationsModal)
          const batchItems = collectBatchItems(currentGraph);
          setProgress(prev => ({ ...prev, currentItem: 0, totalItems: batchItems.length }));

          let sliceSuccess = 0;
          let sliceErrors = 0;
          
          // NOTE: Rate limiting is now handled centrally by rateLimiter service in dataOperationsService
          // No need for throttling here - the service layer handles it

          // Process each parameter/case for this slice
          for (let itemIdx = 0; itemIdx < batchItems.length; itemIdx++) {
            // Check for abort request
            if (abortRef.current) break;
            
            const item = batchItems[itemIdx];
            setProgress(prev => ({ ...prev, currentItem: itemIdx + 1 }));

            try {
              // Run get-from-sources (versioned) with the specific slice DSL
              // CRITICAL: Pass graphRef.current (latest) and setGraphWithRef (updates ref)
              if (item.type === 'parameter') {
                await dataOperationsService.getFromSource({
                  objectType: 'parameter',
                  objectId: item.objectId,
                  targetId: item.targetId,
                  graph: graphRef.current,
                  setGraph: setGraphWithRef,
                  paramSlot: item.paramSlot,
                  bustCache, // Pass through bust cache setting
                  currentDSL: slice.dsl, // Use the slice's DSL for window/context
                  targetSlice: slice.dsl
                });
                
                sliceSuccess++;
              } else if (item.type === 'case') {
                await dataOperationsService.getFromSource({
                  objectType: 'case',
                  objectId: item.objectId,
                  targetId: item.targetId,
                  graph: graphRef.current,
                  setGraph: setGraphWithRef,
                  bustCache, // Pass through bust cache setting
                  currentDSL: slice.dsl, // Use the slice's DSL for window/context
                });
                
                sliceSuccess++;
              }
              // NOTE: Rate limiting is handled by rateLimiter service in dataOperationsService
            } catch (err) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              sessionLogService.addChild(
                logOpId,
                'error',
                'ITEM_ERROR',
                `[${slice.dsl}] ${item.name} failed`,
                errorMessage
              );
              sliceErrors++;
              // NOTE: Rate limit backoff is handled by rateLimiter service in dataOperationsService
            }
          }

          totalSuccess += sliceSuccess;
          totalErrors += sliceErrors;

          // Log slice completion
          sessionLogService.addChild(
            logOpId,
            sliceErrors > 0 ? 'warning' : 'success',
            'SLICE_COMPLETE',
            `Slice "${slice.dsl}": ${sliceSuccess} succeeded, ${sliceErrors} failed`,
            undefined,
            {
              added: sliceSuccess,
              errors: sliceErrors
            }
          );

        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          sessionLogService.addChild(
            logOpId,
            'error',
            'SLICE_ERROR',
            `Slice "${slice.dsl}" failed: ${errorMessage}`,
            undefined,
            { errors: 1 }
          );
          totalErrors++;
        }
      }

      // End main operation log
      sessionLogService.endOperation(
        logOpId,
        totalErrors > 0 ? 'warning' : 'success',
        `All Slices complete: ${totalSuccess} operations succeeded, ${totalErrors} failed across ${totalSlices} slices`,
        {
          added: totalSuccess,
          errors: totalErrors
        }
      );

      // Dismiss progress toast and show summary with appropriate icon
      toast.dismiss(progressToastId);
      if (totalErrors > 0 && totalSuccess === 0) {
        toast.error(`All ${totalErrors} operations failed`);
      } else if (totalErrors > 0) {
        toast(`Completed: ${totalSuccess} succeeded, ${totalErrors} failed`, { icon: '⚠️', duration: 4000 });
      } else {
        toast.success(`All ${totalSuccess} operations completed successfully`);
      }
      
      // Legacy "Create log file" path removed in favour of simulation report.

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      sessionLogService.endOperation(
        logOpId,
        'error',
        `All Slices failed: ${errorMessage}`,
        { errors: totalErrors + 1 }
      );
      toast.dismiss(progressToastId);
      toast.error(`Error: ${errorMessage}`);
    } finally {
      // Reset batch mode to re-enable toasts
      setBatchMode(false);
      setIsProcessing(false);
      onClose();
    }
  };

  if (!isOpen) return null;

  const modalContent = (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
        <div className="modal-header">
          <h2 className="modal-title">Retrieve All Slices</h2>
          <button className="modal-close-btn" onClick={() => {
            if (isProcessing) {
              abortRef.current = true;
            } else {
              onClose();
            }
          }}>×</button>
        </div>

        <div className="modal-body">
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: '#666' }}>
              Loading slices...
            </div>
          ) : isProcessing ? (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <div style={{ fontSize: '16px', marginBottom: '12px' }}>
                Processing slice {progress.currentSlice} of {progress.totalSlices}
              </div>
              <div style={{ fontSize: '13px', color: '#666', marginBottom: '20px', fontFamily: 'monospace' }}>
                {currentSliceName}
              </div>
              <div style={{ width: '100%', height: '8px', backgroundColor: '#e0e0e0', borderRadius: '4px', overflow: 'hidden', marginBottom: '8px' }}>
                <div
                  style={{
                    width: `${(progress.currentSlice / progress.totalSlices) * 100}%`,
                    height: '100%',
                    backgroundColor: '#0066cc',
                    transition: 'width 0.3s ease'
                  }}
                />
              </div>
              {progress.totalItems > 0 && (
                <div style={{ fontSize: '12px', color: '#888' }}>
                  Item {progress.currentItem} of {progress.totalItems}
                </div>
              )}
            </div>
          ) : (
            <>
              <p style={{ marginBottom: '16px', fontSize: '13px', color: '#6B7280', lineHeight: '1.5' }}>
                This will run <strong>Get from Sources (versioned)</strong> for all parameters and cases
                in the graph, once for each selected slice. This simulates what a nightly data fetch would do.
              </p>

              {/* Summary */}
              <div style={{ marginBottom: '20px', padding: '12px', backgroundColor: '#f5f5f5', borderRadius: '6px' }}>
                <div style={{ fontSize: '14px', fontWeight: '500', marginBottom: '4px' }}>
                  Found {slices.length} slice{slices.length !== 1 ? 's' : ''} from pinned query
                </div>
                <div style={{ fontSize: '13px', color: '#666' }}>
                  {selectedSlices.length} selected
                </div>
                {slices.length > 50 && (
                  <div style={{ marginTop: '8px', padding: '8px', background: '#FEF3C7', borderRadius: '4px', fontSize: '12px', color: '#854D0E' }}>
                    ⚠️ {slices.length} slices is a large number and may take considerable time
                  </div>
                )}
              </div>

              {/* Slices list */}
              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <label className="modal-label">Select slices to fetch</label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      type="button"
                      onClick={handleSelectAll}
                      style={{
                        fontSize: '12px',
                        padding: '4px 8px',
                        border: '1px solid #ddd',
                        borderRadius: '4px',
                        background: 'white',
                        cursor: 'pointer'
                      }}
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      onClick={handleDeselectAll}
                      style={{
                        fontSize: '12px',
                        padding: '4px 8px',
                        border: '1px solid #ddd',
                        borderRadius: '4px',
                        background: 'white',
                        cursor: 'pointer'
                      }}
                    >
                      Deselect All
                    </button>
                  </div>
                </div>

                <div style={{
                  border: '1px solid #e0e0e0',
                  borderRadius: '6px',
                  maxHeight: '300px',
                  overflowY: 'auto'
                }}>
                  {slices.length === 0 ? (
                    <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
                      No slices found. Check your pinned data interests DSL.
                    </div>
                  ) : (
                    slices.map(slice => (
                      <div
                        key={slice.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          padding: '8px 12px',
                          borderBottom: '1px solid #f0f0f0',
                          cursor: 'pointer',
                          backgroundColor: slice.selected ? '#f0f7ff' : 'transparent'
                        }}
                        onClick={() => handleToggleSlice(slice.id)}
                      >
                        <input
                          type="checkbox"
                          checked={slice.selected}
                          onChange={() => handleToggleSlice(slice.id)}
                          onClick={(e) => e.stopPropagation()}
                          style={{ marginRight: '12px', cursor: 'pointer' }}
                        />
                        <code style={{ fontSize: '12px', fontFamily: 'Monaco, monospace', color: '#374151' }}>
                          {slice.dsl}
                        </code>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Options */}
              <div style={{ marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={simulateToLog}
                    onChange={(e) => setSimulateToLog(e.target.checked)}
                    style={{ marginRight: '8px' }}
                  />
                  <span style={{ fontSize: '14px' }}>Simulate to log (no external calls)</span>
                </label>
                
                <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={bustCache}
                    onChange={(e) => setBustCache(e.target.checked)}
                    style={{ marginRight: '8px' }}
                  />
                  <span style={{ fontSize: '14px' }}>
                    Bust cache (re-fetch all dates, ignore existing data)
                  </span>
                </label>
              </div>

              <div style={{ padding: '12px', backgroundColor: '#E0F2FE', borderRadius: '6px', fontSize: '12px', color: '#0369A1' }}>
                <strong>Note:</strong> This uses incremental fetching - if you ran this yesterday with a 30-day window,
                today's run will only fetch the 1 new day of data. Enable "Bust cache" to re-fetch everything.
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button
            className="modal-btn modal-btn-secondary"
            onClick={() => {
              if (isProcessing) {
                abortRef.current = true;
              } else {
                onClose();
              }
            }}
          >
            {isProcessing ? 'Stop' : 'Cancel'}
          </button>
          <button
            className="modal-btn modal-btn-primary"
            onClick={executeAllSlicesFetch}
            disabled={isProcessing || isLoading || selectedSlices.length === 0}
          >
            {isProcessing ? 'Processing...' : `Fetch ${selectedSlices.length} Slice${selectedSlices.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}

/**
 * Collect batch items from graph (parameters and cases)
 * Similar to BatchOperationsModal but simplified
 */
function collectBatchItems(graph: GraphData): Array<{
  type: 'parameter' | 'case';
  objectId: string;
  targetId: string;
  name: string;
  paramSlot?: 'p' | 'cost_gbp' | 'labour_cost';
}> {
  const items: Array<{
    type: 'parameter' | 'case';
    objectId: string;
    targetId: string;
    name: string;
    paramSlot?: 'p' | 'cost_gbp' | 'labour_cost';
  }> = [];

  // Collect parameters from edges
  if (graph.edges) {
    for (const edge of graph.edges) {
      const edgeId = edge.uuid || edge.id || '';

      // Probability parameter
      if (edge.p?.id && typeof edge.p.id === 'string') {
        items.push({
          type: 'parameter',
          objectId: edge.p.id,
          targetId: edgeId,
          name: `p: ${edge.p.id}`,
          paramSlot: 'p'
        });
      }

      // Cost GBP parameter
      if (edge.cost_gbp?.id && typeof edge.cost_gbp.id === 'string') {
        items.push({
          type: 'parameter',
          objectId: edge.cost_gbp.id,
          targetId: edgeId,
          name: `cost_gbp: ${edge.cost_gbp.id}`,
          paramSlot: 'cost_gbp'
        });
      }

      // Cost Time parameter
      if (edge.labour_cost?.id && typeof edge.labour_cost.id === 'string') {
        items.push({
          type: 'parameter',
          objectId: edge.labour_cost.id,
          targetId: edgeId,
          name: `labour_cost: ${edge.labour_cost.id}`,
          paramSlot: 'labour_cost'
        });
      }
    }
  }

  // Collect cases from nodes
  if (graph.nodes) {
    for (const node of graph.nodes as any[]) {
      const nodeId = node.uuid || node.id || '';

      if (node.case?.id && typeof node.case.id === 'string') {
        items.push({
          type: 'case',
          objectId: node.case.id,
          targetId: nodeId,
          name: `case: ${node.case.id}`
        });
      }
    }
  }

  return items;
}

