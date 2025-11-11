/**
 * WindowSelector Component
 * 
 * Graph-level date range picker for data fetching window selection.
 * Allows users to select a date range that will be used when fetching
 * data from external sources or aggregating from cached daily data.
 */

import React, { useMemo, useState } from 'react';
import { useGraphStore } from '../contexts/GraphStoreContext';
import type { DateRange } from '../types';
import { dataOperationsService } from '../services/dataOperationsService';
import toast from 'react-hot-toast';
import './WindowSelector.css';

export function WindowSelector() {
  const { graph, window, setWindow, setGraph } = useGraphStore();
  
  // Show if graph has any edges with parameter files (for windowed aggregation)
  // This includes both external connections and file-based parameters
  const hasParameterFiles = useMemo(() => {
    return graph?.edges?.some(e => e.p?.id || e.cost_gbp?.id || e.cost_time?.id) || false;
  }, [graph]);
  
  // Always show - window selector is useful for any parameter-based aggregation
  
  // Default to last 7 days if no window set
  const defaultEnd = new Date();
  const defaultStart = new Date();
  defaultStart.setDate(defaultEnd.getDate() - 7);
  
  const startDate = window?.start || defaultStart.toISOString().split('T')[0];
  const endDate = window?.end || defaultEnd.toISOString().split('T')[0];
  
  // Check if current window differs from what's applied to graph edges
  const hasWindowChange = useMemo(() => {
    if (!graph?.edges) return false;
    
    // Normalize dates for comparison (YYYY-MM-DD format)
    const normalizeDate = (dateStr: string | undefined) => {
      if (!dateStr) return null;
      // Handle ISO 8601 or YYYY-MM-DD
      return dateStr.split('T')[0];
    };
    
    const currentStart = normalizeDate(startDate);
    const currentEnd = normalizeDate(endDate);
    
    // Check if any edge has evidence with different window
    const edgesWithEvidence = graph.edges.filter((edge: any) => {
      const evidence = edge.p?.evidence || edge.cost_gbp?.evidence || edge.cost_time?.evidence;
      return evidence?.window_from || evidence?.window_to;
    });
    
    if (edgesWithEvidence.length === 0) {
      // No evidence on graph yet - window change is meaningful
      return true;
    }
    
    // Check if any edge has different window
    return edgesWithEvidence.some((edge: any) => {
      const evidence = edge.p?.evidence || edge.cost_gbp?.evidence || edge.cost_time?.evidence;
      const evidenceStart = normalizeDate(evidence?.window_from);
      const evidenceEnd = normalizeDate(evidence?.window_to);
      
      return evidenceStart !== currentStart || evidenceEnd !== currentEnd;
    });
  }, [graph, startDate, endDate]);
  
  const handleStartChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newStart = e.target.value;
    if (newStart && endDate && newStart <= endDate) {
      setWindow({ start: newStart, end: endDate });
    }
  };
  
  const handleEndChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newEnd = e.target.value;
    if (newEnd && startDate && newEnd >= startDate) {
      setWindow({ start: startDate, end: newEnd });
    }
  };
  
  const handlePreset = (days: number | 'today') => {
    const end = new Date();
    const start = new Date();
    
    if (days === 'today') {
      // Today only (start and end are same day)
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
    } else {
      // Last N days (including today)
      start.setDate(end.getDate() - (days - 1));
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
    }
    
    setWindow({
      start: start.toISOString().split('T')[0],
      end: end.toISOString().split('T')[0],
    });
  };
  
  const [isApplying, setIsApplying] = useState(false);
  
  const handleShow = async () => {
    if (!graph) {
      toast.error('No graph loaded');
      return;
    }
    
    const currentWindow: DateRange = {
      start: startDate,
      end: endDate,
    };
    
    setIsApplying(true);
    
    try {
      // Import fileRegistry
      const { fileRegistry } = await import('../contexts/TabContext');
      
      // Find all edges with parameter connections that have daily data
      const edgesWithDailyData = graph.edges?.filter((edge: any) => {
        const paramId = edge.p?.id || edge.cost_gbp?.id || edge.cost_time?.id;
        if (!paramId) return false;
        
        // Check if parameter file has daily data
        const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
        if (!paramFile?.data?.values) return false;
        
        return paramFile.data.values.some((v: any) => v.n_daily && v.k_daily && v.dates);
      }) || [];
      
      if (edgesWithDailyData.length === 0) {
        toast('No edges with daily data found. Use "Get from Source" with daily mode to fetch time-series data.', {
          icon: 'ℹ️',
          duration: 4000,
        });
        return;
      }
      
      // Aggregate window for each edge
      let successCount = 0;
      for (const edge of edgesWithDailyData) {
        const paramId = edge.p?.id || edge.cost_gbp?.id || edge.cost_time?.id;
        if (!paramId) continue;
        
        try {
          await dataOperationsService.getParameterFromFile({
            paramId,
            edgeId: edge.uuid,
            graph,
            setGraph: (g: any) => setGraph(g), // Wrap to handle null
            window: currentWindow,
          });
          successCount++;
        } catch (error) {
          console.error(`[WindowSelector] Failed to aggregate for edge ${edge.uuid}:`, error);
        }
      }
      
      if (successCount > 0) {
        toast.success(`✓ Aggregated window for ${successCount} edge(s)`, { duration: 2000 });
      }
    } catch (error) {
      console.error('[WindowSelector] Show failed:', error);
      toast.error('Failed to apply window');
    } finally {
      setIsApplying(false);
    }
  };
  
  return (
    <div className="window-selector">
      <div className="window-selector-content">
        <label htmlFor="window-start" className="window-selector-label">
          Window:
        </label>
        <div className="window-selector-presets">
          <button
            type="button"
            onClick={() => handlePreset('today')}
            className="window-selector-preset"
            title="Today only"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => handlePreset(7)}
            className="window-selector-preset"
            title="Last 7 days"
          >
            7d
          </button>
          <button
            type="button"
            onClick={() => handlePreset(30)}
            className="window-selector-preset"
            title="Last 30 days"
          >
            30d
          </button>
          <button
            type="button"
            onClick={() => handlePreset(90)}
            className="window-selector-preset"
            title="Last 90 days"
          >
            90d
          </button>
        </div>
        <input
          id="window-start"
          type="date"
          value={startDate}
          onChange={handleStartChange}
          className="window-selector-input"
          max={endDate}
        />
        <span className="window-selector-separator">to</span>
        <input
          id="window-end"
          type="date"
          value={endDate}
          onChange={handleEndChange}
          className="window-selector-input"
          min={startDate}
          max={new Date().toISOString().split('T')[0]}
        />
        <button
          onClick={handleShow}
          disabled={isApplying || !hasWindowChange}
          className="window-selector-button"
          title={
            !hasWindowChange 
              ? "Window matches current graph view" 
              : "Apply window to aggregate data from cached daily values"
          }
        >
          {isApplying ? 'Applying...' : 'Show'}
        </button>
      </div>
    </div>
  );
}

