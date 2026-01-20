/**
 * Integration tests for cohort horizon evaluation (NO start-bounding)
 *
 * These tests verify that:
 * - path_t95 is computed/propagated correctly
 * - cohort horizon evaluation uses path_t95 as the effective horizon input
 * - but the requested window is preserved (start-truncation is disallowed)
 *
 * Design reference: fetch-planning-first-principles.md (start-truncation disallowed)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeCohortRetrievalHorizon } from '../cohortRetrievalHorizon';
import { computePathT95, getActiveEdges, type GraphForPath } from '../statisticalEnhancementService';
import { computeAndApplyPathT95 } from '../fetchDataService';
import type { Graph } from '../../types';

describe('cohort horizon integration', () => {
  const referenceDate = new Date('2025-12-09T12:00:00Z');
  
  describe('end-to-end path_t95 to bounded cohort window', () => {
    it('should compute path_t95 and use it for horizon evaluation (without bounding)', () => {
      // 1. Create a graph with latency edges
      const graph: GraphForPath = {
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'mid' },
          { id: 'end' },
        ],
        edges: [
          { id: 'e1', uuid: 'e1', from: 'start', to: 'mid', p: { mean: 0.5, latency: { latency_parameter: true, t95: 15 } } },
          { id: 'e2', uuid: 'e2', from: 'mid', to: 'end', p: { mean: 0.5, latency: { latency_parameter: true, t95: 10 } } },
        ],
      };
      
      // 2. Compute path_t95
      const activeEdges = getActiveEdges(graph);
      const pathT95Map = computePathT95(graph, activeEdges);
      
      // Verify path_t95 computation
      expect(pathT95Map.get('e1')).toBe(15);  // 0 + 15
      expect(pathT95Map.get('e2')).toBe(25);  // 15 + 10
      
      // 3. Use path_t95 for horizon evaluation for the downstream edge
      const requestedWindow = {
        start: '9-Sep-25',  // 91 days before reference
        end: '9-Dec-25',    // reference date
      };
      
      // For edge e2, use its computed path_t95
      const horizonResult = computeCohortRetrievalHorizon({
        requestedWindow,
        pathT95: pathT95Map.get('e2'),  // 25 days cumulative
        referenceDate,
      });
      
      // Start-truncation is disallowed: window should be preserved
      expect(horizonResult.wasBounded).toBe(false);
      expect(horizonResult.effectiveT95).toBe(25);
      expect(horizonResult.t95Source).toBe('path_t95');
      expect(horizonResult.daysTrimmed).toBe(0);
      expect(horizonResult.boundedWindow.start).toBe(requestedWindow.start);
      expect(horizonResult.boundedWindow.end).toBe(requestedWindow.end);
    });
    
    it('should produce different effective horizons for different edges on same path (without bounding)', () => {
      // Graph: start → A → B → C with increasing cumulative latency
      const graph: GraphForPath = {
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'A' },
          { id: 'B' },
          { id: 'C' },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'A', p: { mean: 0.5, latency: { latency_parameter: true, t95: 7 } } },
          { id: 'e2', from: 'A', to: 'B', p: { mean: 0.5, latency: { latency_parameter: true, t95: 14 } } },
          { id: 'e3', from: 'B', to: 'C', p: { mean: 0.5, latency: { latency_parameter: true, t95: 21 } } },
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      const pathT95Map = computePathT95(graph, activeEdges);
      
      // Verify cumulative path_t95
      expect(pathT95Map.get('e1')).toBe(7);
      expect(pathT95Map.get('e2')).toBe(21);  // 7 + 14
      expect(pathT95Map.get('e3')).toBe(42);  // 7 + 14 + 21
      
      // Same requested window for all edges
      const requestedWindow = {
        start: '9-Sep-25',  // ~91 days
        end: '9-Dec-25',
      };
      
      // Edge 1: short horizon (7 days)
      const horizon1 = computeCohortRetrievalHorizon({
        requestedWindow,
        pathT95: pathT95Map.get('e1'),
        referenceDate,
      });
      
      // Edge 3: long horizon (42 days)
      const horizon3 = computeCohortRetrievalHorizon({
        requestedWindow,
        pathT95: pathT95Map.get('e3'),
        referenceDate,
      });
      
      // Different edges should yield different effective horizon inputs
      expect(horizon1.effectiveT95).toBe(7);
      expect(horizon3.effectiveT95).toBe(42);
      // But neither should bound (start-truncation disallowed)
      expect(horizon1.wasBounded).toBe(false);
      expect(horizon3.wasBounded).toBe(false);
      expect(horizon1.daysTrimmed).toBe(0);
      expect(horizon3.daysTrimmed).toBe(0);
    });
  });
  
  describe('full graph → bounded window flow', () => {
    it('should apply path_t95 to graph and use for horizon evaluation (without bounding)', () => {
      // Create a full Graph type (not just GraphForPath)
      const graph: Graph = {
        nodes: [
          { id: 'start', uuid: 'start', type: 'start', label: 'Start' },
          { id: 'end', uuid: 'end', label: 'End' },
        ],
        edges: [
          { 
            id: 'e1', 
            uuid: 'e1', 
            from: 'start', 
            to: 'end', 
            p: { 
              mean: 0.5, 
              latency: { 
                latency_parameter: true,
                t95: 20, 
              } 
            } 
          },
        ],
      } as any;
      
      // Track graph updates
      let updatedGraph: Graph | null = null;
      const setGraph = (g: Graph | null) => { updatedGraph = g; };
      
      // Apply path_t95 to graph
      computeAndApplyPathT95(graph, setGraph);
      
      expect(updatedGraph).not.toBeNull();
      
      // Get the edge from updated graph
      const edge = updatedGraph!.edges.find(e => e.id === 'e1');
      expect(edge?.p?.latency?.path_t95).toBe(20);  // 0 + 20 from start
      
      // Now use that path_t95 for horizon evaluation
      const horizonResult = computeCohortRetrievalHorizon({
        requestedWindow: {
          start: '9-Sep-25',  // ~91 days
          end: '9-Dec-25',
        },
        pathT95: edge?.p?.latency?.path_t95,
        edgeT95: edge?.p?.latency?.t95,
        referenceDate,
      });
      
      expect(horizonResult.effectiveT95).toBe(20);
      expect(horizonResult.t95Source).toBe('path_t95');
      expect(horizonResult.wasBounded).toBe(false);
      expect(horizonResult.daysTrimmed).toBe(0);
    });
  });
  
  describe('edge cases from implementation plan §8.2', () => {
    it('mixed latency paths: non-latency upstream, latency downstream', () => {
      const graph: GraphForPath = {
        nodes: [
          { id: 'a', type: 'start' },
          { id: 'b' },
          { id: 'c' },
        ],
        edges: [
          // Non-latency edge (no t95)
          { id: 'ab', from: 'a', to: 'b', p: { mean: 0.8 } },
          // Latency edge
          { id: 'bc', from: 'b', to: 'c', p: { mean: 0.5, latency: { latency_parameter: true, t95: 14 } } },
        ],
      };
      
      const activeEdges = getActiveEdges(graph);
      const pathT95Map = computePathT95(graph, activeEdges);
      
      // Non-latency edge: path_t95 = 0
      expect(pathT95Map.get('ab')).toBe(0);
      // Latency edge: path_t95 = 0 + 14 = 14
      expect(pathT95Map.get('bc')).toBe(14);
      
      // Cohort horizon for the latency edge should use 14
      const horizon = computeCohortRetrievalHorizon({
        requestedWindow: { start: '9-Sep-25', end: '9-Dec-25' },
        pathT95: pathT95Map.get('bc'),
        referenceDate,
      });
      
      expect(horizon.effectiveT95).toBe(14);
    });
    
    it('prior coverage stops just before new query window', () => {
      // Files contain cohort(-100d:-10d), new query is cohort(-9d:)
      // The new window is entirely within the horizon, so no bounding
      const requestedWindow = {
        start: '30-Nov-25',  // 9 days before reference
        end: '9-Dec-25',
      };
      
      const horizonResult = computeCohortRetrievalHorizon({
        requestedWindow,
        pathT95: 30,  // 30 day horizon
        referenceDate,
        existingCoverage: {
          dates: [],  // No dates in the new window
        },
      });
      
      // Window is entirely within horizon (9 days < 30 days)
      expect(horizonResult.wasBounded).toBe(false);
      expect(horizonResult.boundedWindow.start).toBe(requestedWindow.start);
      expect(horizonResult.boundedWindow.end).toBe(requestedWindow.end);
    });
  });
});





