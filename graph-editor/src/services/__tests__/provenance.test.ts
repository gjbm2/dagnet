/**
 * Tests for provenance tracking
 * 
 * Ensures that manual edits are properly tagged with data_source metadata
 * and that stale evidence data (n, k) is NOT included.
 * 
 * @group unit
 */

import { describe, it, expect } from 'vitest';
import { updateManager } from '../UpdateManager';
import { createTestEdge, createTestNode, createTestParameterFile, createTestCaseFile } from './helpers/testFixtures';

describe('Provenance Tracking', () => {
  
  // ============================================================
  // PARAMETER PROVENANCE
  // ============================================================
  
  describe('Parameter Provenance', () => {
    it('manual probability edit includes data_source', async () => {
      const edge = createTestEdge({
        p: { mean: 0.45, stdev: 0.03, distribution: 'beta' }
      });
      
      const fileData = createTestParameterFile({ values: [] });
      
      const result = await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { interactive: true, validateOnly: true }
      );
      
      expect(result.success).toBe(true);
      expect(result.changes).toHaveLength(1);
      expect(result.changes![0].newValue).toMatchObject({
        mean: 0.45,
        stdev: 0.03,
        distribution: 'beta',
        window_from: expect.stringMatching(/\d{4}-\d{2}-\d{2}T/),
        data_source: {
          type: 'manual',
          edited_at: expect.stringMatching(/\d{4}-\d{2}-\d{2}T/)
        }
      });
    });
    
    it('does not include n/k from stale evidence', async () => {
      const edge = createTestEdge({
        p: {
          mean: 0.45,
          stdev: 0.03,
          distribution: 'beta',
          // Stale evidence from previous "get"
          evidence: {
            n: 6000,
            k: 2700,
            window_from: '2025-01-01T00:00:00Z',
            window_to: '2025-01-31T23:59:59Z'
          }
        }
      });
      
      const fileData = createTestParameterFile({ values: [] });
      
      const result = await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { interactive: true, validateOnly: true }
      );
      
      const newValue = result.changes![0].newValue;
      
      expect(newValue).not.toHaveProperty('n');
      expect(newValue).not.toHaveProperty('k');
      expect(newValue).not.toHaveProperty('window_to');
      expect(newValue.mean).toBe(0.45);
    });
    
    it('cost_gbp manual edit includes data_source', async () => {
      const edge = createTestEdge({
        cost_gbp: { mean: 14.8, stdev: 2.9, distribution: 'lognormal' }
      });
      
      const fileData = createTestParameterFile({ type: 'cost_gbp', values: [] });
      
      const result = await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { interactive: true, validateOnly: true }
      );
      
      expect(result.changes![0].newValue).toMatchObject({
        mean: 14.8,
        stdev: 2.9,
        distribution: 'lognormal',
        data_source: {
          type: 'manual',
          edited_at: expect.any(String)
        }
      });
    });
    
    it('cost_time manual edit includes data_source', async () => {
      const edge = createTestEdge({
        cost_time: { mean: 310, stdev: 95, distribution: 'lognormal' }
      });
      
      const fileData = createTestParameterFile({ type: 'cost_time', values: [] });
      
      const result = await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { interactive: true, validateOnly: true }
      );
      
      expect(result.changes![0].newValue).toMatchObject({
        mean: 310,
        stdev: 95,
        distribution: 'lognormal',
        data_source: {
          type: 'manual',
          edited_at: expect.any(String)
        }
      });
    });
    
    it('only includes fields that are actually set', async () => {
      const edge = createTestEdge({
        p: { mean: 0.45 }  // No stdev or distribution
      });
      
      const fileData = createTestParameterFile({ values: [] });
      
      const result = await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { interactive: true, validateOnly: true }
      );
      
      const newValue = result.changes![0].newValue;
      
      expect(newValue.mean).toBe(0.45);
      expect(newValue).toHaveProperty('window_from');
      expect(newValue).toHaveProperty('data_source');
      
      // These were not set, so should not be included
      expect(newValue).not.toHaveProperty('stdev');
      expect(newValue).not.toHaveProperty('locked');
    });
    
    it('includes stdev when explicitly set', async () => {
      const edge = createTestEdge({
        p: { mean: 0.45, stdev: 0.03 }
      });
      
      const fileData = createTestParameterFile({ values: [] });
      
      const result = await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { interactive: true, validateOnly: true }
      );
      
      expect(result.changes![0].newValue).toHaveProperty('stdev', 0.03);
    });
    
    it('includes distribution when set', async () => {
      const edge = createTestEdge({
        p: { mean: 0.45, stdev: 0.03, distribution: 'beta' }
      });
      
      const fileData = createTestParameterFile({ values: [] });
      
      const result = await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { interactive: true, validateOnly: true }
      );
      
      expect(result.changes![0].newValue).toHaveProperty('distribution', 'beta');
    });
  });
  
  // ============================================================
  // CASE PROVENANCE
  // ============================================================
  
  describe('Case Provenance', () => {
    it('case schedule includes source: manual', async () => {
      const node = createTestNode({
        type: 'case',
        case: {
          id: 'test-case',
          status: 'active',
          variants: [
            { name: 'control', weight: 0.3 },
            { name: 'treatment', weight: 0.7 }
          ]
        }
      });
      
      const fileData = createTestCaseFile({ case: { schedules: [] } });
      
      const result = await updateManager.handleGraphToFile(
        node,
        fileData,
        'APPEND',
        'case',
        { interactive: true, validateOnly: true }
      );
      
      expect(result.success).toBe(true);
      expect(result.changes).toHaveLength(1);
      expect(result.changes![0].newValue).toMatchObject({
        variants: [
          { name: 'control', weight: 0.3 },
          { name: 'treatment', weight: 0.7 }
        ],
        window_from: expect.stringMatching(/\d{4}-\d{2}-\d{2}T/),
        source: 'manual',
        edited_at: expect.stringMatching(/\d{4}-\d{2}-\d{2}T/)
      });
    });
    
    it('case schedule includes all variants', async () => {
      const node = createTestNode({
        type: 'case',
        case: {
          id: 'multi-variant',
          status: 'active',
          variants: [
            { name: 'control', weight: 0.25 },
            { name: 'treatment-a', weight: 0.25 },
            { name: 'treatment-b', weight: 0.25 },
            { name: 'treatment-c', weight: 0.25 }
          ]
        }
      });
      
      const fileData = createTestCaseFile({ case: { schedules: [] } });
      
      const result = await updateManager.handleGraphToFile(
        node,
        fileData,
        'APPEND',
        'case',
        { interactive: true, validateOnly: true }
      );
      
      const schedule = result.changes![0].newValue;
      
      expect(schedule.variants).toHaveLength(4);
      expect(schedule.variants).toEqual([
        { name: 'control', weight: 0.25 },
        { name: 'treatment-a', weight: 0.25 },
        { name: 'treatment-b', weight: 0.25 },
        { name: 'treatment-c', weight: 0.25 }
      ]);
    });
    
    it('case schedule only includes name and weight for variants', async () => {
      const node = createTestNode({
        type: 'case',
        case: {
          id: 'test-case',
          status: 'active',
          variants: [
            { 
              name: 'control', 
              weight: 0.5,
              // These fields should NOT be in the schedule
              extra_field: 'should not appear',
              another_field: 123
            } as any,
            { name: 'treatment', weight: 0.5 }
          ]
        }
      });
      
      const fileData = createTestCaseFile({ case: { schedules: [] } });
      
      const result = await updateManager.handleGraphToFile(
        node,
        fileData,
        'APPEND',
        'case',
        { interactive: true, validateOnly: true }
      );
      
      const schedule = result.changes![0].newValue;
      
      expect(schedule.variants[0]).toEqual({ name: 'control', weight: 0.5 });
      expect(schedule.variants[0]).not.toHaveProperty('extra_field');
      expect(schedule.variants[0]).not.toHaveProperty('another_field');
    });
  });
  
  // ============================================================
  // TIMESTAMP CORRECTNESS
  // ============================================================
  
  describe('Timestamp Correctness', () => {
    it('window_from is a valid ISO timestamp', async () => {
      const edge = createTestEdge({ p: { mean: 0.45 } });
      const fileData = createTestParameterFile({ values: [] });
      
      const result = await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { validateOnly: true }
      );
      
      const timestamp = result.changes![0].newValue.window_from;
      
      expect(timestamp).toBeTruthy();
      expect(typeof timestamp).toBe('string');
      expect(new Date(timestamp).toISOString()).toBe(timestamp);
    });
    
    it('edited_at is a valid ISO timestamp', async () => {
      const edge = createTestEdge({ p: { mean: 0.45 } });
      const fileData = createTestParameterFile({ values: [] });
      
      const result = await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { validateOnly: true }
      );
      
      const timestamp = result.changes![0].newValue.data_source.edited_at;
      
      expect(timestamp).toBeTruthy();
      expect(typeof timestamp).toBe('string');
      expect(new Date(timestamp).toISOString()).toBe(timestamp);
    });
    
    it('window_from and edited_at are close to current time', async () => {
      const beforeTest = new Date().getTime();
      
      const edge = createTestEdge({ p: { mean: 0.45 } });
      const fileData = createTestParameterFile({ values: [] });
      
      const result = await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { validateOnly: true }
      );
      
      const afterTest = new Date().getTime();
      
      const windowFrom = new Date(result.changes![0].newValue.window_from).getTime();
      const editedAt = new Date(result.changes![0].newValue.data_source.edited_at).getTime();
      
      // Should be within test execution time (allow 1 second buffer)
      expect(windowFrom).toBeGreaterThanOrEqual(beforeTest - 1000);
      expect(windowFrom).toBeLessThanOrEqual(afterTest + 1000);
      expect(editedAt).toBeGreaterThanOrEqual(beforeTest - 1000);
      expect(editedAt).toBeLessThanOrEqual(afterTest + 1000);
    });
  });
  
  // ============================================================
  // DATA_SOURCE TYPE
  // ============================================================
  
  describe('data_source Type Field', () => {
    it('manual edits have type: "manual"', async () => {
      const edge = createTestEdge({ p: { mean: 0.45 } });
      const fileData = createTestParameterFile({ values: [] });
      
      const result = await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { interactive: true, validateOnly: true }
      );
      
      expect(result.changes![0].newValue.data_source.type).toBe('manual');
    });
    
    it('non-interactive mode still marks as manual', async () => {
      const edge = createTestEdge({ p: { mean: 0.45 } });
      const fileData = createTestParameterFile({ values: [] });
      
      const result = await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { interactive: false, validateOnly: true }
      );
      
      expect(result.changes![0].newValue.data_source.type).toBe('manual');
    });
  });
  
  // ============================================================
  // CONTRAST WITH FILE→GRAPH (which includes evidence)
  // ============================================================
  
  describe('Contrast: File→Graph DOES include evidence', () => {
    it('getting from file includes n/k evidence', async () => {
      const paramFile = createTestParameterFile({
        id: 'test-param',
        values: [
          {
            mean: 0.42,
            stdev: 0.03,
            n: 5000,
            k: 2100,
            distribution: 'beta',
            window_from: '2025-01-01T00:00:00Z',
            window_to: '2025-01-31T23:59:59Z'
          }
        ]
      });
      
      const edge = createTestEdge({ p: { id: 'test-param' } });
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      expect(result.success).toBe(true);
      
      // File→Graph SHOULD include evidence (it's coming from the file)
      const changes = result.changes;
      const meanChange = changes.find((c: any) => c.field === 'p.mean');
      
      expect(meanChange).toBeDefined();
      expect(meanChange!.newValue).toBe(0.42);
    });
    
    it('putting back to file strips evidence', async () => {
      // Simulate: get from file (includes evidence) → user edits → put back
      const edge = createTestEdge({
        p: {
          mean: 0.50,  // User changed this
          stdev: 0.03,
          distribution: 'beta',
          // Evidence from previous get
          evidence: {
            n: 5000,
            k: 2100,
            window_from: '2025-01-01T00:00:00Z'
          }
        }
      });
      
      const fileData = createTestParameterFile({ values: [] });
      
      const result = await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { validateOnly: true }
      );
      
      const newValue = result.changes![0].newValue;
      
      // User's edit goes in
      expect(newValue.mean).toBe(0.50);
      
      // Evidence does NOT
      expect(newValue).not.toHaveProperty('n');
      expect(newValue).not.toHaveProperty('k');
      
      // But provenance metadata IS added
      expect(newValue).toHaveProperty('data_source');
      expect(newValue.data_source.type).toBe('manual');
    });
  });
});

