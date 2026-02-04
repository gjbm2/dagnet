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
import { retrieveAllSlicesService } from '../../services/retrieveAllSlicesService';
import { useTabContext } from '../../contexts/TabContext';
import toast from 'react-hot-toast';
import type { GraphData } from '../../types';
import { requestPutToBase } from '../../hooks/usePutToBaseRequestListener';
import './Modal.css';

interface AllSlicesModalProps {
  isOpen: boolean;
  onClose: () => void;
  graph: GraphData | null;
  setGraph: (graph: GraphData | null) => void;
  /** AUTHORITATIVE DSL from graphStore - the single source of truth for derivations */
  currentDSL: string;
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
  setGraph,
  currentDSL
}: AllSlicesModalProps) {
  const { activeTabId, tabs, operations: tabOperations } = useTabContext();
  const [slices, setSlices] = useState<SliceItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState({ currentSlice: 0, totalSlices: 0, currentItem: 0, totalItems: 0 });
  const [bustCache, setBustCache] = useState(false);
  const [simulateToLog, setSimulateToLog] = useState(false);
  const [putToBaseAfter, setPutToBaseAfter] = useState(true);
  
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

    // Simulation mode: run the REAL Retrieve All codepaths, but:
    // - no external HTTP (dry-run request construction only)
    // - no file writes
    // - no graph mutation
    //
    // The artefact is the session log trace (DRY_RUN_HTTP entries).
    if (simulateToLog) {
      setIsProcessing(true);
      try {
        const graphSnapshot = graphRef.current as GraphData | null;
        if (!graphSnapshot) return;

        await retrieveAllSlicesService.execute({
          getGraph: () => graphSnapshot,
          // No graph mutation in simulation mode.
          setGraph: () => {},
          slices: selectedSlices.map(s => s.dsl),
          bustCache,
          simulate: true,
          shouldAbort: () => abortRef.current,
          onProgress: (p) => {
            setProgress({
              currentSlice: p.currentSlice,
              totalSlices: p.totalSlices,
              currentItem: p.currentItem,
              totalItems: p.totalItems,
            });
            setCurrentSliceName(p.currentSliceDSL || '');
          },
        });

        toast.success('Simulation complete (see session log for dry-run HTTP commands)');
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

    const progressToastId = toast.loading(
      `Processing slice 0/${totalSlices}...`,
      { duration: Infinity }
    );

    abortRef.current = false;

    const setGraphWithRef = (newGraph: GraphData | null) => {
      graphRef.current = newGraph;
      setGraph(newGraph);
    };

    // Apply a temporary evidence-mode override for ALL tabs viewing this graph file.
    const activeTab = activeTabId ? tabs.find(t => t.id === activeTabId) : undefined;
    const targetFileId = activeTab?.fileId;
    const affectedTabIds = targetFileId ? tabs.filter(t => t.fileId === targetFileId).map(t => t.id) : [];
    const prevModes = new Map<string, 'f+e' | 'f' | 'e'>();
    let shouldPutToBase = false;

    try {
      // Force CURRENT layer only to evidence mode in all affected tabs (restore in finally).
      for (const tabId of affectedTabIds) {
        const prev = tabOperations.getScenarioVisibilityMode(tabId, 'current');
        prevModes.set(tabId, prev);
        await tabOperations.setScenarioVisibilityMode(tabId, 'current', 'e');
      }

      const result = await retrieveAllSlicesService.execute({
        getGraph: () => graphRef.current as GraphData | null,
        setGraph: setGraphWithRef,
        slices: selectedSlices.map(s => s.dsl),
        bustCache,
        postRunRefreshDsl: currentDSL,
        shouldAbort: () => abortRef.current,
        onProgress: (p) => {
          setProgress({
            currentSlice: p.currentSlice,
            totalSlices: p.totalSlices,
            currentItem: p.currentItem,
            totalItems: p.totalItems,
          });
          setCurrentSliceName(p.currentSliceDSL || '');
          toast.loading(
            `Processing slice ${p.currentSlice}/${p.totalSlices}: ${p.currentSliceDSL || ''}`,
            { id: progressToastId, duration: Infinity }
          );
        },
      });

      // Finalise: optionally Put To Base after retrieve (refresh live scenarios).
      // Any post-retrieve topo/LAG pass is service-layer behaviour (not UI).
      if (!result.aborted && result.totalSuccess > 0) {
        shouldPutToBase = putToBaseAfter && Boolean(activeTabId);
      }

      toast.dismiss(progressToastId);
      if (result.aborted) {
        toast('Operation cancelled', { icon: '⏹️' });
      } else if (result.totalErrors > 0 && result.totalSuccess === 0) {
        toast.error(`All ${result.totalErrors} operations failed`);
      } else if (result.totalErrors > 0) {
        toast(`Completed: ${result.totalSuccess} succeeded, ${result.totalErrors} failed`, { icon: '⚠️', duration: 4000 });
      } else {
        const durationStr = (result.durationMs / 1000).toFixed(1);
        toast.success(
          `Retrieve All complete (${durationStr}s)\n${result.totalCacheHits} cached, ${result.totalApiFetches} fetched (${result.totalDaysFetched}d new)`
        );
      }
    } catch (error) {
      toast.dismiss(progressToastId);
      toast.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Restore CURRENT layer visibility modes.
      for (const tabId of affectedTabIds) {
        const prev = prevModes.get(tabId);
        if (!prev) continue;
        try {
          await tabOperations.setScenarioVisibilityMode(tabId, 'current', prev);
        } catch {
          // Best-effort only.
        }
      }

      if (shouldPutToBase && activeTabId) {
        requestPutToBase(activeTabId);
      }
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
                <label style={{ display: 'flex', alignItems: 'center', cursor: simulateToLog ? 'not-allowed' : 'pointer', opacity: simulateToLog ? 0.6 : 1 }}>
                  <input
                    type="checkbox"
                    checked={putToBaseAfter}
                    onChange={(e) => setPutToBaseAfter(e.target.checked)}
                    style={{ marginRight: '8px' }}
                    disabled={simulateToLog}
                  />
                  <span style={{ fontSize: '14px' }}>Put to Base after retrieve (refresh live scenarios)</span>
                </label>

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

