/**
 * All Slices Modal
 *
 * Configuration form for fetching data across all pinned slices.
 * Uses dslExplosion to enumerate slices from graph.dataInterestsDSL,
 * then commissions a retrieve-all job via executeRetrieveAllSlicesWithProgressToast.
 * Progress is shown in the OperationsToast, not in this modal.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { explodeDSL } from '../../lib/dslExplosion';
import { executeRetrieveAllSlicesWithProgressToast } from '../../services/retrieveAllSlicesService';
import { useTabContext, fileRegistry } from '../../contexts/TabContext';
import toast from 'react-hot-toast';
import type { GraphData } from '../../types';
import { requestPutToBase } from '../../hooks/usePutToBaseRequestListener';
import { useTheme } from '../../contexts/ThemeContext';
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
 * Configuration form — gathers user options (slices, cache, simulate, etc.)
 * then closes and delegates execution to the shared retrieve-all service.
 */
export function AllSlicesModal({
  isOpen,
  onClose,
  graph,
  setGraph,
  currentDSL
}: AllSlicesModalProps) {
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const { activeTabId, tabs, operations: tabOperations } = useTabContext();
  const [slices, setSlices] = useState<SliceItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [bustCache, setBustCache] = useState(false);
  const [simulateToLog, setSimulateToLog] = useState(false);
  const [putToBaseAfter, setPutToBaseAfter] = useState(true);
  const [checkDbCoverage, setCheckDbCoverage] = useState(false);

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

  const executeAllSlicesFetch = () => {
    if (!graph || selectedSlices.length === 0) return;

    // Derive workspace identity from the active graph file for DB coverage preflight.
    const activeTab = activeTabId ? tabs.find(t => t.id === activeTabId) : undefined;
    const graphFileSource = activeTab?.fileId ? fileRegistry.getFile(activeTab.fileId)?.source : undefined;
    const wsForCoverage = (checkDbCoverage && graphFileSource?.repository && graphFileSource?.branch)
      ? { repository: graphFileSource.repository, branch: graphFileSource.branch }
      : undefined;

    // Capture values needed by callbacks (modal is about to close).
    const capturedActiveTabId = activeTabId;
    const capturedTabs = tabs;
    const capturedTabOperations = tabOperations;
    const targetFileId = activeTab?.fileId;
    const wantPutToBase = putToBaseAfter && !simulateToLog;

    // Build onBeforeRun: evidence-mode override (skip for simulation).
    const onBeforeRun = simulateToLog ? undefined : async () => {
      const affectedTabIds = targetFileId
        ? capturedTabs.filter(t => t.fileId === targetFileId).map(t => t.id)
        : [];
      const prevModes = new Map<string, 'f+e' | 'f' | 'e'>();

      for (const tabId of affectedTabIds) {
        const prev = capturedTabOperations.getScenarioVisibilityMode(tabId, 'current');
        prevModes.set(tabId, prev);
        await capturedTabOperations.setScenarioVisibilityMode(tabId, 'current', 'e');
      }

      // Return cleanup function to restore modes.
      return async () => {
        for (const tabId of affectedTabIds) {
          const prev = prevModes.get(tabId);
          if (!prev) continue;
          try {
            await capturedTabOperations.setScenarioVisibilityMode(tabId, 'current', prev);
          } catch {
            // Best-effort only.
          }
        }
      };
    };

    // Build onSuccess: conditional put-to-base.
    const onSuccess = (wantPutToBase && capturedActiveTabId)
      ? () => { requestPutToBase(capturedActiveTabId); }
      : undefined;

    // Close modal immediately — progress is shown in OperationsToast.
    onClose();

    // Simulation: snapshot the graph (no mutation during dry-run).
    const graphSnapshot = graph;
    const getGraph = simulateToLog ? () => graphSnapshot : () => graph;
    const setGraphFn = simulateToLog ? () => {} : setGraph;

    // Fire and forget — the wrapper handles progress, errors, and completion.
    void executeRetrieveAllSlicesWithProgressToast({
      getGraph,
      setGraph: setGraphFn,
      slices: selectedSlices.map(s => s.dsl),
      bustCache,
      simulate: simulateToLog,
      isAutomated: false,
      checkDbCoverageFirst: checkDbCoverage,
      workspace: wsForCoverage,
      postRunRefreshDsl: simulateToLog ? undefined : currentDSL,
      toastId: `manual:${Date.now()}`,
      toastLabel: 'Retrieve All Slices',
      onBeforeRun,
      onSuccess,
    });
  };

  if (!isOpen) return null;

  const modalContent = (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
        <div className="modal-header">
          <h2 className="modal-title">Retrieve All Slices</h2>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: '#666' }}>
              Loading slices...
            </div>
          ) : (
            <>
              <p style={{ marginBottom: '16px', fontSize: '13px', color: '#6B7280', lineHeight: '1.5' }}>
                This will run <strong>Get from Sources (versioned)</strong> for all parameters and cases
                in the graph, once for each selected slice. This simulates what a nightly data fetch would do.
              </p>

              {/* Summary */}
              <div style={{ marginBottom: '20px', padding: '12px', backgroundColor: dark ? '#252525' : '#f5f5f5', borderRadius: '6px' }}>
                <div style={{ fontSize: '14px', fontWeight: '500', marginBottom: '4px' }}>
                  Found {slices.length} slice{slices.length !== 1 ? 's' : ''} from pinned query
                </div>
                <div style={{ fontSize: '13px', color: '#666' }}>
                  {selectedSlices.length} selected
                </div>
                {slices.length > 50 && (
                  <div style={{ marginTop: '8px', padding: '8px', background: dark ? '#3b2f0e' : '#FEF3C7', borderRadius: '4px', fontSize: '12px', color: dark ? '#fbbf24' : '#854D0E' }}>
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
                        border: `1px solid ${dark ? '#555' : '#ddd'}`,
                        borderRadius: '4px',
                        background: dark ? '#2d2d2d' : 'white',
                        color: 'inherit',
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
                        border: `1px solid ${dark ? '#555' : '#ddd'}`,
                        borderRadius: '4px',
                        background: dark ? '#2d2d2d' : 'white',
                        color: 'inherit',
                        cursor: 'pointer'
                      }}
                    >
                      Deselect All
                    </button>
                  </div>
                </div>

                <div style={{
                  border: `1px solid ${dark ? '#404040' : '#e0e0e0'}`,
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
                          borderBottom: `1px solid ${dark ? '#333' : '#f0f0f0'}`,
                          cursor: 'pointer',
                          backgroundColor: slice.selected ? (dark ? '#1a2a40' : '#f0f7ff') : 'transparent'
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

                <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={checkDbCoverage}
                    onChange={(e) => setCheckDbCoverage(e.target.checked)}
                    style={{ marginRight: '8px' }}
                  />
                  <span style={{ fontSize: '14px' }}>
                    Check snapshot DB coverage first (fills historic gaps)
                  </span>
                </label>
              </div>

              <div style={{ padding: '12px', backgroundColor: dark ? '#0c2a3d' : '#E0F2FE', borderRadius: '6px', fontSize: '12px', color: dark ? '#38bdf8' : '#0369A1' }}>
                <strong>Note:</strong> This uses incremental fetching - if you ran this yesterday with a 30-day window,
                today's run will only fetch the 1 new day of data. Enable "Bust cache" to re-fetch everything.
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button
            className="modal-btn modal-btn-secondary"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="modal-btn modal-btn-primary"
            onClick={executeAllSlicesFetch}
            disabled={isLoading || selectedSlices.length === 0}
          >
            {`Fetch ${selectedSlices.length} Slice${selectedSlices.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
