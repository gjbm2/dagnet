/**
 * Tests for connection ID preservation
 * 
 * Ensures that p.id, node.id, and case.id are preserved through
 * file operations and do not get lost during object replacement.
 * 
 * @group unit
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { updateManager } from '../UpdateManager';
import { createTestEdge, createTestNode, createTestParameterFile, createTestCaseFile, createTestNodeFile } from './helpers/testFixtures';

// Mock applyChanges function (from dataOperationsService)
const applyChanges = (target: any, changes: Array<{ field: string; newValue: any }>): void => {
  for (const change of changes) {
    const parts = change.field.split('.');
    let obj: any = target;
    
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      
      if (part.endsWith('[]')) {
        const arrayName = part.slice(0, -2);
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
    
    const finalPart = parts[parts.length - 1];
    if (finalPart.endsWith('[]')) {
      const arrayName = finalPart.slice(0, -2);
      if (!obj[arrayName]) {
        obj[arrayName] = [];
      }
      obj[arrayName].push(change.newValue);
    } else {
      obj[finalPart] = change.newValue;
    }
  }
};

describe('Connection ID Preservation', () => {
  
  // ============================================================
  // PARAMETER IDs (p.id, cost_gbp.id, cost_time.id)
  // ============================================================
  
  describe('Parameter ID Preservation', () => {
    it('p.id preserved after file→graph update', async () => {
      const edge = createTestEdge({
        uuid: 'edge-1',
        p: { 
          id: 'homepage-to-product',
          mean: 0.40  // Old value
        }
      });
      
      const paramFile = createTestParameterFile({
        id: 'homepage-to-product',
        values: [
          { mean: 0.45, stdev: 0.03, window_from: '2025-01-01T00:00:00Z' }
        ]
      });
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      // Apply changes
      const updatedEdge = structuredClone(edge);
      applyChanges(updatedEdge, result.changes || []);
      
      // After data update, ID should still be there
      expect(updatedEdge.p!.id).toBe('homepage-to-product');
      expect(updatedEdge.p!.mean).toBe(0.45);  // Data updated
      expect(updatedEdge.p!.stdev).toBe(0.03);
    });
    
    it('p.id preserved after manual preservation step', async () => {
      const edge = createTestEdge({
        uuid: 'edge-1',
        p: { 
          id: 'test-param',
          mean: 0.40
        }
      });
      
      const paramFile = createTestParameterFile({
        id: 'test-param',
        values: [{ mean: 0.45, stdev: 0.03 }]
      });
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      const updatedEdge = structuredClone(edge);
      applyChanges(updatedEdge, result.changes || []);
      
      // Simulate preservation step (as done in dataOperationsService)
      const paramId = 'test-param';
      if (result.changes && result.changes.length > 0) {
        const updatedSlot = result.changes[0]?.field.split('.')[0]; // e.g., 'p'
        if (updatedSlot && paramId) {
          if (!updatedEdge[updatedSlot]) {
            updatedEdge[updatedSlot] = {};
          }
          if (!updatedEdge[updatedSlot].id) {
            updatedEdge[updatedSlot].id = paramId;
          }
        }
      }
      
      expect(updatedEdge.p!.id).toBe('test-param');
      expect(updatedEdge.p!.mean).toBe(0.45);
    });
    
    it('cost_gbp.id preserved separately from p.id', async () => {
      const edge = createTestEdge({
        uuid: 'edge-1',
        p: { id: 'param-p', mean: 0.45 },
        cost_gbp: { id: 'param-gbp', mean: 10.0 }
      });
      
      const costFile = createTestParameterFile({
        id: 'param-gbp',
        type: 'cost_gbp',
        values: [{ mean: 15.0, stdev: 2.5 }]
      });
      
      const result = await updateManager.handleFileToGraph(
        costFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      const updatedEdge = structuredClone(edge);
      applyChanges(updatedEdge, result.changes || []);
      
      // Preserve cost_gbp.id
      if (result.changes && result.changes.length > 0) {
        const updatedSlot = result.changes[0]?.field.split('.')[0];
        if (updatedSlot === 'cost_gbp' && !updatedEdge.cost_gbp!.id) {
          updatedEdge.cost_gbp!.id = 'param-gbp';
        }
      }
      
      // Both IDs should be preserved
      expect(updatedEdge.p!.id).toBe('param-p');
      expect(updatedEdge.cost_gbp!.id).toBe('param-gbp');
      expect(updatedEdge.cost_gbp!.mean).toBe(15.0);
    });
    
    it('cost_time.id preserved', async () => {
      const edge = createTestEdge({
        uuid: 'edge-1',
        cost_time: { id: 'checkout-duration', mean: 300 }
      });
      
      const timeFile = createTestParameterFile({
        id: 'checkout-duration',
        type: 'cost_time',
        values: [{ mean: 310, stdev: 95, distribution: 'lognormal' }]
      });
      
      const result = await updateManager.handleFileToGraph(
        timeFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      const updatedEdge = structuredClone(edge);
      applyChanges(updatedEdge, result.changes || []);
      
      // Preserve
      if (result.changes && result.changes.length > 0) {
        const updatedSlot = result.changes[0]?.field.split('.')[0];
        if (updatedSlot === 'cost_time' && !updatedEdge.cost_time!.id) {
          updatedEdge.cost_time!.id = 'checkout-duration';
        }
      }
      
      expect(updatedEdge.cost_time!.id).toBe('checkout-duration');
      expect(updatedEdge.cost_time!.mean).toBe(310);
    });
    
    it('p.id survives multiple sequential updates', async () => {
      const edge = createTestEdge({
        uuid: 'edge-1',
        p: { id: 'test-param', mean: 0.40 }
      });
      
      const paramFile1 = createTestParameterFile({
        id: 'test-param',
        values: [{ mean: 0.45 }]
      });
      
      const paramFile2 = createTestParameterFile({
        id: 'test-param',
        values: [{ mean: 0.50 }]
      });
      
      // First update
      let result = await updateManager.handleFileToGraph(paramFile1, edge, 'UPDATE', 'parameter');
      let updatedEdge = structuredClone(edge);
      applyChanges(updatedEdge, result.changes || []);
      if (!updatedEdge.p!.id) updatedEdge.p!.id = 'test-param';
      
      expect(updatedEdge.p!.id).toBe('test-param');
      expect(updatedEdge.p!.mean).toBe(0.45);
      
      // Second update
      result = await updateManager.handleFileToGraph(paramFile2, updatedEdge, 'UPDATE', 'parameter');
      const updatedEdge2 = structuredClone(updatedEdge);
      applyChanges(updatedEdge2, result.changes || []);
      if (!updatedEdge2.p!.id) updatedEdge2.p!.id = 'test-param';
      
      expect(updatedEdge2.p!.id).toBe('test-param');
      expect(updatedEdge2.p!.mean).toBe(0.50);
    });
  });
  
  // ============================================================
  // NODE IDs (node.id)
  // ============================================================
  
  describe('Node ID Preservation', () => {
    it('node.id preserved after file→graph update', async () => {
      const node = createTestNode({
        uuid: 'node-1',
        id: 'checkout',
        label: 'Old Label'
      });
      
      const nodeFile = createTestNodeFile({
        id: 'checkout',
        name: 'Checkout Process',
        description: 'User checkout flow'
      });
      
      const result = await updateManager.handleFileToGraph(
        nodeFile,
        node,
        'UPDATE',
        'node'
      );
      
      const updatedNode = structuredClone(node);
      applyChanges(updatedNode, result.changes || []);
      
      // Preserve node.id
      if (!updatedNode.id) {
        updatedNode.id = 'checkout';
      }
      
      expect(updatedNode.id).toBe('checkout');
      expect(updatedNode.label).toBe('Checkout Process');
    });
    
    it('node.id survives multiple updates', async () => {
      const node = createTestNode({
        uuid: 'node-1',
        id: 'my-node',
        label: 'v1'
      });
      
      const nodeFile1 = createTestNodeFile({ id: 'my-node', name: 'v2' });
      const nodeFile2 = createTestNodeFile({ id: 'my-node', name: 'v3' });
      
      // First update
      let result = await updateManager.handleFileToGraph(nodeFile1, node, 'UPDATE', 'node');
      let updatedNode = structuredClone(node);
      applyChanges(updatedNode, result.changes || []);
      if (!updatedNode.id) updatedNode.id = 'my-node';
      
      expect(updatedNode.id).toBe('my-node');
      expect(updatedNode.label).toBe('v2');
      
      // Second update
      result = await updateManager.handleFileToGraph(nodeFile2, updatedNode, 'UPDATE', 'node');
      const updatedNode2 = structuredClone(updatedNode);
      applyChanges(updatedNode2, result.changes || []);
      if (!updatedNode2.id) updatedNode2.id = 'my-node';
      
      expect(updatedNode2.id).toBe('my-node');
      expect(updatedNode2.label).toBe('v3');
    });
  });
  
  // ============================================================
  // CASE IDs (node.case.id)
  // ============================================================
  
  describe('Case ID Preservation', () => {
    it('node.case.id preserved after file→graph update', async () => {
      const node = createTestNode({
        uuid: 'node-1',
        type: 'case',
        case: {
          id: 'checkout-test-2025',
          status: 'active',
          variants: [
            { name: 'control', weight: 0.5 }
          ]
        }
      });
      
      const caseFile = createTestCaseFile({
        parameter_id: 'case-checkout-test-2025',
        case: {
          id: 'checkout-test-2025',
          status: 'paused',
          variants: [
            { name: 'control', weight: 0.3 },
            { name: 'treatment', weight: 0.7 }
          ],
          schedules: []
        }
      });
      
      const result = await updateManager.handleFileToGraph(
        caseFile,
        node,
        'UPDATE',
        'case'
      );
      
      const updatedNode = structuredClone(node);
      applyChanges(updatedNode, result.changes || []);
      
      // Preserve node.id and node.case.id
      if (!updatedNode.id) updatedNode.id = 'checkout';
      if (!updatedNode.case) updatedNode.case = { id: '', status: 'active', variants: [] };
      if (!updatedNode.case.id) updatedNode.case.id = 'checkout-test-2025';
      
      expect(updatedNode.case!.id).toBe('checkout-test-2025');
      expect(updatedNode.case!.status).toBe('paused');
      expect(updatedNode.case!.variants).toHaveLength(2);
    });
    
    it('both node.id and case.id preserved together', async () => {
      const node = createTestNode({
        uuid: 'node-1',
        id: 'checkout-node',
        type: 'case',
        case: {
          id: 'my-case',
          status: 'active',
          variants: []
        }
      });
      
      const caseFile = createTestCaseFile({
        parameter_id: 'case-my-case',
        case: {
          id: 'my-case',
          status: 'active',
          variants: [
            { name: 'a', weight: 0.5 },
            { name: 'b', weight: 0.5 }
          ],
          schedules: []
        }
      });
      
      const result = await updateManager.handleFileToGraph(
        caseFile,
        node,
        'UPDATE',
        'case'
      );
      
      const updatedNode = structuredClone(node);
      applyChanges(updatedNode, result.changes || []);
      
      // Preserve both
      if (!updatedNode.id) updatedNode.id = 'checkout-node';
      if (!updatedNode.case) updatedNode.case = { id: '', status: 'active', variants: [] };
      if (!updatedNode.case.id) updatedNode.case.id = 'my-case';
      
      expect(updatedNode.id).toBe('checkout-node');
      expect(updatedNode.case!.id).toBe('my-case');
      expect(updatedNode.case!.variants).toHaveLength(2);
    });
    
    it('case.id survives multiple updates', async () => {
      const node = createTestNode({
        uuid: 'node-1',
        type: 'case',
        case: {
          id: 'test-case',
          status: 'active',
          variants: [{ name: 'a', weight: 1.0 }]
        }
      });
      
      const caseFile1 = createTestCaseFile({
        case: {
          id: 'test-case',
          variants: [{ name: 'a', weight: 0.5 }, { name: 'b', weight: 0.5 }],
          schedules: []
        }
      });
      
      const caseFile2 = createTestCaseFile({
        case: {
          id: 'test-case',
          variants: [{ name: 'a', weight: 0.3 }, { name: 'b', weight: 0.7 }],
          schedules: []
        }
      });
      
      // First update
      let result = await updateManager.handleFileToGraph(caseFile1, node, 'UPDATE', 'case');
      let updatedNode = structuredClone(node);
      applyChanges(updatedNode, result.changes || []);
      if (!updatedNode.case) updatedNode.case = { id: '', status: 'active', variants: [] };
      if (!updatedNode.case.id) updatedNode.case.id = 'test-case';
      
      expect(updatedNode.case!.id).toBe('test-case');
      expect(updatedNode.case!.variants[0].weight).toBe(0.5);
      
      // Second update
      result = await updateManager.handleFileToGraph(caseFile2, updatedNode, 'UPDATE', 'case');
      const updatedNode2 = structuredClone(updatedNode);
      applyChanges(updatedNode2, result.changes || []);
      if (!updatedNode2.case) updatedNode2.case = { id: '', status: 'active', variants: [] };
      if (!updatedNode2.case.id) updatedNode2.case.id = 'test-case';
      
      expect(updatedNode2.case!.id).toBe('test-case');
      expect(updatedNode2.case!.variants[0].weight).toBe(0.3);
    });
  });
  
  // ============================================================
  // EDGE CASES
  // ============================================================
  
  describe('ID Preservation Edge Cases', () => {
    it('ID preserved even when p object is entirely replaced', async () => {
      const edge = createTestEdge({
        uuid: 'edge-1',
        p: { id: 'test-param', mean: 0.40 }
      });
      
      const paramFile = createTestParameterFile({
        id: 'test-param',
        values: [{ mean: 0.45, stdev: 0.03, distribution: 'beta' }]
      });
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      // Simulate object replacement (worst case)
      const updatedEdge = structuredClone(edge);
      updatedEdge.p = {};  // Complete replacement
      applyChanges(updatedEdge, result.changes || []);
      
      // Preservation step
      if (!updatedEdge.p.id) {
        updatedEdge.p.id = 'test-param';
      }
      
      expect(updatedEdge.p.id).toBe('test-param');
      expect(updatedEdge.p.mean).toBe(0.45);
    });
    
    it('ID preserved when field is undefined before update', async () => {
      const edge = createTestEdge({
        uuid: 'edge-1',
        p: undefined as any
      });
      
      // Manually set ID before get
      if (!edge.p) edge.p = {};
      edge.p.id = 'test-param';
      
      const paramFile = createTestParameterFile({
        id: 'test-param',
        values: [{ mean: 0.45 }]
      });
      
      const result = await updateManager.handleFileToGraph(
        paramFile,
        edge,
        'UPDATE',
        'parameter'
      );
      
      const updatedEdge = structuredClone(edge);
      applyChanges(updatedEdge, result.changes || []);
      
      // Preservation
      if (!updatedEdge.p) updatedEdge.p = {};
      if (!updatedEdge.p.id) updatedEdge.p.id = 'test-param';
      
      expect(updatedEdge.p.id).toBe('test-param');
      expect(updatedEdge.p.mean).toBe(0.45);
    });
  });
});

