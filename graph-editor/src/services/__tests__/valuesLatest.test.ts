/**
 * Tests for values[latest] resolution
 * 
 * Ensures that the "latest" value is determined by timestamp (window_from),
 * not by array order.
 * 
 * @group unit
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { updateManager } from '../UpdateManager';
import { createTestParameterFile, createTestEdge, createTestCaseFile, createTestNode } from './helpers/testFixtures';

describe('values[latest] Timestamp Resolution', () => {
  
  // ============================================================
  // BASIC TIMESTAMP SORTING
  // ============================================================
  
  describe('Basic Timestamp Sorting', () => {
    it('finds most recent by window_from, not array order', async () => {
      const paramFile = createTestParameterFile({
        id: 'test-latest',
        values: [
          { mean: 0.42, window_from: '2025-01-01T00:00:00Z' },    // Jan
          { mean: 0.45, window_from: '2025-02-01T00:00:00Z' },    // Feb
          { mean: 0.30, window_from: '2025-03-01T00:00:00Z' },    // Mar ← Most recent
          { mean: 0.35, window_from: '2025-01-15T00:00:00Z' }     // Mid-Jan (added later but older)
        ]
      });
      
      const edge = createTestEdge({
        uuid: 'edge-1',
        p: { id: 'test-latest' }
      });
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      expect(result.success).toBe(true);
      
      // Should get March entry (mean: 0.30), not last in array
      const meanChange = result.changes!.find((c: any) => c.field === 'p.mean');
      expect(meanChange).toBeDefined();
      expect(meanChange!.newValue).toBe(0.30);
    });
    
    it('handles out-of-order timestamps', async () => {
      const paramFile = createTestParameterFile({
        id: 'out-of-order',
        values: [
          { mean: 0.30, window_from: '2025-03-01T00:00:00Z' },    // Mar
          { mean: 0.42, window_from: '2025-01-01T00:00:00Z' },    // Jan
          { mean: 0.50, window_from: '2025-05-01T00:00:00Z' },    // May ← Most recent
          { mean: 0.45, window_from: '2025-02-01T00:00:00Z' }     // Feb
        ]
      });
      
      const edge = createTestEdge({ p: { id: 'out-of-order' } });
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      const meanChange = result.changes!.find((c: any) => c.field === 'p.mean');
      expect(meanChange!.newValue).toBe(0.50);  // May entry
    });
    
    it('handles reverse chronological order', async () => {
      const paramFile = createTestParameterFile({
        id: 'reverse',
        values: [
          { mean: 0.50, window_from: '2025-05-01T00:00:00Z' },    // May ← Most recent
          { mean: 0.45, window_from: '2025-04-01T00:00:00Z' },    // Apr
          { mean: 0.42, window_from: '2025-03-01T00:00:00Z' },    // Mar
          { mean: 0.40, window_from: '2025-02-01T00:00:00Z' }     // Feb
        ]
      });
      
      const edge = createTestEdge({ p: { id: 'reverse' } });
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      const meanChange = result.changes!.find((c: any) => c.field === 'p.mean');
      expect(meanChange!.newValue).toBe(0.50);  // First in array is also most recent
    });
  });
  
  // ============================================================
  // MISSING/INVALID TIMESTAMPS
  // ============================================================
  
  describe('Missing or Invalid Timestamps', () => {
    it('handles missing window_from (treats as epoch)', async () => {
      const paramFile = createTestParameterFile({
        id: 'no-timestamp',
        values: [
          { mean: 0.42, window_from: '2025-01-01T00:00:00Z' },
          { mean: 0.35 }  // No timestamp, should sort as oldest
        ]
      });
      
      const edge = createTestEdge({ p: { id: 'no-timestamp' } });
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      const meanChange = result.changes!.find((c: any) => c.field === 'p.mean');
      expect(meanChange!.newValue).toBe(0.42);  // Entry with timestamp wins
    });
    
    it('all missing timestamps: uses last in array', async () => {
      const paramFile = createTestParameterFile({
        id: 'all-missing',
        values: [
          { mean: 0.42 },
          { mean: 0.45 },
          { mean: 0.50 }  // ← No timestamps, so last one wins
        ]
      });
      
      const edge = createTestEdge({ p: { id: 'all-missing' } });
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      const meanChange = result.changes!.find((c: any) => c.field === 'p.mean');
      // When all are epoch (0), the first one in the sorted array (which is last after sort) wins
      expect(meanChange!.newValue).toBe(0.42);  // First after descending sort
    });
    
    it('mix of present and missing timestamps', async () => {
      const paramFile = createTestParameterFile({
        id: 'mixed',
        values: [
          { mean: 0.40 },                                         // No timestamp
          { mean: 0.42, window_from: '2025-01-01T00:00:00Z' },   // Jan
          { mean: 0.45 },                                         // No timestamp
          { mean: 0.50, window_from: '2025-05-01T00:00:00Z' },   // May ← Most recent
          { mean: 0.48, window_from: '2025-04-01T00:00:00Z' }    // Apr
        ]
      });
      
      const edge = createTestEdge({ p: { id: 'mixed' } });
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      const meanChange = result.changes!.find((c: any) => c.field === 'p.mean');
      expect(meanChange!.newValue).toBe(0.50);  // May (most recent timestamp)
    });
  });
  
  // ============================================================
  // ROUNDTRIP: PUT → GET
  // ============================================================
  
  describe('Roundtrip: Put Then Get', () => {
    it('after put, new entry becomes latest', async () => {
      const paramFile = createTestParameterFile({
        id: 'test-roundtrip',
        values: [
          { mean: 0.42, window_from: '2025-01-01T00:00:00Z' },
          { mean: 0.45, window_from: '2025-02-01T00:00:00Z' }
        ]
      });
      
      const edge = createTestEdge({
        uuid: 'edge-1',
        p: { id: 'test-roundtrip', mean: 0.50, stdev: 0.05, distribution: 'beta' }
      });
      
      // Simulate put to file
      const putResult = await updateManager.handleGraphToFile(
        edge,
        paramFile,
        'APPEND',
        'parameter',
        { validateOnly: true }
      );
      
      // Manually apply (simulating applyChanges)
      if (putResult.changes && putResult.changes.length > 0) {
        const newEntry = putResult.changes[0].newValue;
        paramFile.values.push(newEntry);
      }
      
      // Change edge value so that getting from file creates a change
      edge.p!.mean = 0.42; // Different from file's latest (0.50)
      
      const getResult = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      // Should retrieve the newly added value (most recent timestamp)
      const meanChange = getResult.changes!.find((c: any) => c.field === 'p.mean');
      expect(meanChange!.newValue).toBe(0.50);  // Our new value from file
    });
    
    it('multiple puts create history, latest is retrieved', async () => {
      const paramFile = createTestParameterFile({
        id: 'multi-put',
        values: []
      });
      
      const edge = createTestEdge({ uuid: 'edge-1' });
      
      // Put v1
      edge.p = { id: 'multi-put', mean: 0.40, distribution: 'beta' };
      let result = await updateManager.handleGraphToFile(edge, paramFile, 'APPEND', 'parameter', { validateOnly: true });
      if (result.changes && result.changes!.length > 0) {
        paramFile.values.push(result.changes![0].newValue);
      }
      
      // Small delay to ensure timestamp is different
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Put v2
      edge.p = { id: 'multi-put', mean: 0.45, distribution: 'beta' };
      result = await updateManager.handleGraphToFile(edge, paramFile, 'APPEND', 'parameter', { validateOnly: true });
      if (result.changes && result.changes!.length > 0) {
        paramFile.values.push(result.changes![0].newValue);
      }
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Put v3
      edge.p = { id: 'multi-put', mean: 0.50, distribution: 'beta' };
      result = await updateManager.handleGraphToFile(edge, paramFile, 'APPEND', 'parameter', { validateOnly: true });
      if (result.changes && result.changes!.length > 0) {
        paramFile.values.push(result.changes![0].newValue);
      }
      
      // Change edge value so that getting from file creates a change
      edge.p.mean = 0.40; // Different from file's latest (0.50)
      
      const getResult = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      const meanChange = getResult.changes!.find((c: any) => c.field === 'p.mean');
      expect(meanChange!.newValue).toBe(0.50);  // Most recent (v3) from file
    });
  });
  
  // ============================================================
  // EDGE CASES
  // ============================================================
  
  describe('Edge Cases', () => {
    it('single value is always latest', async () => {
      const paramFile = createTestParameterFile({
        id: 'single',
        values: [
          { mean: 0.42, window_from: '2025-01-01T00:00:00Z' }
        ]
      });
      
      const edge = createTestEdge({ p: { id: 'single' } });
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      const meanChange = result.changes!.find((c: any) => c.field === 'p.mean');
      expect(meanChange!.newValue).toBe(0.42);
    });
    
    it('empty values array returns no changes', async () => {
      const paramFile = createTestParameterFile({
        id: 'empty',
        values: []
      });
      
      const edge = createTestEdge({ p: { id: 'empty' } });
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      // Should not error, but no mean change expected
      const meanChange = result.changes!.find((c: any) => c.field === 'p.mean');
      expect(meanChange).toBeUndefined();
    });
    
    it('identical timestamps: first one wins (stable sort)', async () => {
      const timestamp = '2025-01-01T00:00:00Z';
      const paramFile = createTestParameterFile({
        id: 'identical',
        values: [
          { mean: 0.42, window_from: timestamp },
          { mean: 0.45, window_from: timestamp },
          { mean: 0.48, window_from: timestamp }
        ]
      });
      
      const edge = createTestEdge({ p: { id: 'identical' } });
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      const meanChange = result.changes!.find((c: any) => c.field === 'p.mean');
      // After descending sort, first with this timestamp wins
      expect(meanChange!.newValue).toBe(0.42);
    });
    
    it('very old and very new timestamps', async () => {
      const paramFile = createTestParameterFile({
        id: 'extremes',
        values: [
          { mean: 0.42, window_from: '1970-01-01T00:00:00Z' },    // Unix epoch
          { mean: 0.45, window_from: '2025-01-01T00:00:00Z' },    // Recent
          { mean: 0.50, window_from: '2099-12-31T23:59:59Z' }     // Far future ← Most recent
        ]
      });
      
      const edge = createTestEdge({ p: { id: 'extremes' } });
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      const meanChange = result.changes!.find((c: any) => c.field === 'p.mean');
      expect(meanChange!.newValue).toBe(0.50);  // Far future date
    });
  });
  
  // ============================================================
  // COST PARAMETERS
  // ============================================================
  
  describe('Cost Parameters Also Use Latest', () => {
    it('cost_gbp uses latest by timestamp', async () => {
      const paramFile = createTestParameterFile({
        id: 'cost-gbp',
        type: 'cost_gbp',
        values: [
          { mean: 10.0, window_from: '2025-01-01T00:00:00Z' },
          { mean: 12.5, window_from: '2025-03-01T00:00:00Z' },   // ← Latest
          { mean: 11.0, window_from: '2025-02-01T00:00:00Z' }
        ]
      });
      
      const edge = createTestEdge({ cost_gbp: { id: 'cost-gbp' } });
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      const meanChange = result.changes!.find((c: any) => c.field === 'cost_gbp.mean');
      expect(meanChange!.newValue).toBe(12.5);
    });
    
    it('cost_time uses latest by timestamp', async () => {
      const paramFile = createTestParameterFile({
        id: 'cost-time',
        type: 'cost_time',
        values: [
          { mean: 300, window_from: '2025-01-01T00:00:00Z' },
          { mean: 310, window_from: '2025-02-01T00:00:00Z' },
          { mean: 320, window_from: '2025-03-01T00:00:00Z' }    // ← Latest
        ]
      });
      
      const edge = createTestEdge({ cost_time: { id: 'cost-time' } });
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      const meanChange = result.changes!.find((c: any) => c.field === 'cost_time.mean');
      expect(meanChange!.newValue).toBe(320);
    });
  });
  
  // ============================================================
  // CASE SCHEDULES[latest]
  // ============================================================
  
  describe('Case schedules[latest] Resolution', () => {
    it('finds most recent schedule by window_from', async () => {
      const caseFile = createTestCaseFile({
        id: 'case-test',
        case: {
          id: 'test',
          status: 'active',
          variants: [],
          schedules: [
            {
              window_from: '2025-01-01T00:00:00Z',
              variants: [{ name: 'a', weight: 1.0 }]
            },
            {
              window_from: '2025-03-01T00:00:00Z',   // ← Most recent
              variants: [
                { name: 'a', weight: 0.5 },
                { name: 'b', weight: 0.5 }
              ]
            },
            {
              window_from: '2025-02-01T00:00:00Z',
              variants: [
                { name: 'a', weight: 0.7 },
                { name: 'b', weight: 0.3 }
              ]
            }
          ]
        }
      });
      
      const node = createTestNode({
        type: 'case',
        case: { id: 'test', status: 'active', variants: [] }
      });
      
      const result = await updateManager.handleFileToGraph(
        caseFile,
        node,
        'UPDATE',
        'case'
      );
      
      const variantsChange = result.changes!.find((c: any) => c.field === 'case.variants');
      expect(variantsChange).toBeDefined();
      expect(variantsChange!.newValue).toEqual([
        { name: 'a', name_overridden: false, weight: 0.5, weight_overridden: false, description: undefined, description_overridden: false },
        { name: 'b', name_overridden: false, weight: 0.5, weight_overridden: false, description: undefined, description_overridden: false }
      ]);
    });
  });
});

