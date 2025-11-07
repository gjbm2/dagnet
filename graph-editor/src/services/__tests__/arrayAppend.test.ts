/**
 * Tests for array append operations
 * 
 * Ensures that values[] and schedules[] array syntax works correctly
 * and doesn't create literal "values[]" keys.
 * 
 * @group unit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { updateManager } from '../UpdateManager';
import { createTestEdge, createTestNode, createTestParameterFile, createTestCaseFile } from './helpers/testFixtures';

// Mock toast
vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  }
}));

// Mock applyChanges function (from dataOperationsService)
const applyChanges = (target: any, changes: Array<{ field: string; newValue: any }>): void => {
  for (const change of changes) {
    const parts = change.field.split('.');
    let obj: any = target;
    
    // Navigate to the nested object
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      
      // Handle array append syntax: "field[]"
      if (part.endsWith('[]')) {
        const arrayName = part.slice(0, -2); // Remove "[]"
        if (!obj[arrayName]) {
          obj[arrayName] = [];
        }
        obj = obj[arrayName];
      } else {
        if (!obj[part]) {
          obj[part] = {};
        }
        obj = obj[part];
      }
    }
    
    // Set the final value
    const finalPart = parts[parts.length - 1];
    if (finalPart.endsWith('[]')) {
      // Array append: push the new value
      const arrayName = finalPart.slice(0, -2);
      if (!obj[arrayName]) {
        obj[arrayName] = [];
      }
      obj[arrayName].push(change.newValue);
    } else {
      // Regular field set
      obj[finalPart] = change.newValue;
    }
  }
};

describe('Array Append Operations', () => {
  
  describe('applyChanges function', () => {
    it('appends to values array', () => {
      const fileData = {
        values: [
          { mean: 0.42, window_from: '2025-01-01T00:00:00Z' }
        ]
      };
      
      const changes = [{
        field: 'values[]',
        newValue: { mean: 0.45, window_from: '2025-02-01T00:00:00Z' }
      }];
      
      applyChanges(fileData, changes);
      
      expect(fileData.values).toHaveLength(2);
      expect(fileData.values[1].mean).toBe(0.45);
    });
    
    it('does not create literal "values[]" key', () => {
      const fileData = { values: [] };
      const changes = [{ field: 'values[]', newValue: { mean: 0.45 } }];
      
      applyChanges(fileData, changes);
      
      expect(fileData).not.toHaveProperty('values[]');
      expect(fileData.values).toHaveLength(1);
    });
    
    it('creates array if it does not exist', () => {
      const fileData = {};
      const changes = [{ field: 'values[]', newValue: { mean: 0.45 } }];
      
      applyChanges(fileData, changes);
      
      expect(fileData).toHaveProperty('values');
      expect(Array.isArray((fileData as any).values)).toBe(true);
      expect((fileData as any).values).toHaveLength(1);
    });
    
    it('appends multiple items sequentially', () => {
      const fileData: any = { values: [] };
      const changes = [
        { field: 'values[]', newValue: { mean: 0.45 } },
        { field: 'values[]', newValue: { mean: 0.50 } },
        { field: 'values[]', newValue: { mean: 0.55 } }
      ];
      
      for (const change of changes) {
        applyChanges(fileData, [change]);
      }
      
      expect(fileData.values).toHaveLength(3);
      expect(fileData.values[0].mean).toBe(0.45);
      expect(fileData.values[1].mean).toBe(0.50);
      expect(fileData.values[2].mean).toBe(0.55);
    });
    
    it('works with nested array paths', () => {
      const fileData: any = { case: { schedules: [] } };
      const changes = [{
        field: 'case.schedules[]',
        newValue: { window_from: '2025-01-01T00:00:00Z', variants: [] }
      }];
      
      applyChanges(fileData, changes);
      
      expect(fileData.case.schedules).toHaveLength(1);
      expect(fileData.case.schedules[0].window_from).toBe('2025-01-01T00:00:00Z');
    });
  });
  
  describe('UpdateManager APPEND operations', () => {
    it('validateOnly mode does not apply changes', async () => {
      const edge = createTestEdge({ p: { mean: 0.45 } });
      const fileData = createTestParameterFile({ values: [] });
      
      const result = await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { validateOnly: true }
      );
      
      expect(result.success).toBe(true);
      expect(result.changes).toBeDefined();
      expect(result.changes!.length).toBeGreaterThan(0);
      
      // File should NOT be modified
      expect(fileData.values).toHaveLength(0);
    });
    
    it('non-validateOnly mode applies changes directly', async () => {
      const edge = createTestEdge({ p: { mean: 0.45 } });
      const fileData = createTestParameterFile({ values: [] });
      
      const result = await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { validateOnly: false }
      );
      
      expect(result.success).toBe(true);
      
      // File SHOULD be modified
      expect(fileData.values.length).toBeGreaterThan(0);
    });
    
    it('parameter APPEND returns correct change structure', async () => {
      const edge = createTestEdge({
        p: { mean: 0.45, stdev: 0.03, distribution: 'beta' }
      });
      const fileData = createTestParameterFile({ values: [] });
      
      const result = await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { validateOnly: true }
      );
      
      expect(result.changes).toHaveLength(1);
      expect(result.changes![0]).toMatchObject({
        field: 'values[]',
        newValue: {
          mean: 0.45,
          stdev: 0.03,
          distribution: 'beta',
          window_from: expect.any(String),
          data_source: {
            type: 'manual',
            edited_at: expect.any(String)
          }
        }
      });
    });
    
    it('case APPEND returns correct change structure', async () => {
      const node = createTestNode({
        type: 'case',
        case: {
          id: 'test-case',
          status: 'active',
          variants: [
            { name: 'control', weight: 0.5 },
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
        { validateOnly: true }
      );
      
      expect(result.changes).toHaveLength(1);
      expect(result.changes![0]).toMatchObject({
        field: 'case.schedules[]',  // Case files have schedules under case.schedules
        newValue: {
          variants: [
            { name: 'control', weight: 0.5 },
            { name: 'treatment', weight: 0.5 }
          ],
          window_from: expect.any(String),
          source: 'manual',
          edited_at: expect.any(String)
        }
      });
    });
  });
  
  describe('Duplicate Prevention', () => {
    it('calling both UpdateManager and applyChanges does not duplicate', async () => {
      const edge = createTestEdge({ p: { mean: 0.45 } });
      const fileData = createTestParameterFile({ values: [] });
      
      // Step 1: UpdateManager with validateOnly (does NOT apply)
      const result = await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { validateOnly: true }
      );
      
      expect(fileData.values).toHaveLength(0);
      
      // Step 2: Apply changes manually
      applyChanges(fileData, result.changes!);
      
      expect(fileData.values).toHaveLength(1);
      expect(fileData.values[0].mean).toBe(0.45);
    });
    
    it('calling UpdateManager twice without validateOnly creates duplicates (expected)', async () => {
      const edge = createTestEdge({ p: { mean: 0.45 } });
      const fileData = createTestParameterFile({ values: [] });
      
      // First call
      await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { validateOnly: false }
      );
      
      expect(fileData.values).toHaveLength(1);
      
      // Second call (would create duplicate)
      await updateManager.handleGraphToFile(
        edge,
        fileData,
        'APPEND',
        'parameter',
        { validateOnly: false }
      );
      
      // This IS expected behavior - calling APPEND twice should append twice
      expect(fileData.values).toHaveLength(2);
    });
  });
});

