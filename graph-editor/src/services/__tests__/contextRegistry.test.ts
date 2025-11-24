import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContextRegistry } from '../contextRegistry';
import type { ContextDefinition } from '../contextRegistry';

describe('ContextRegistry', () => {
  let registry: ContextRegistry;
  
  beforeEach(() => {
    registry = new ContextRegistry();
    registry.clearCache();
  });
  
  describe('detectMECEPartition', () => {
    it('should detect complete MECE partition (otherPolicy: null)', async () => {
      // Mock context with otherPolicy: null (values are MECE as-is)
      const mockContext: ContextDefinition = {
        id: 'browser_type',
        name: 'Browser Type',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'null',
        values: [
          { id: 'chrome', label: 'Chrome' },
          { id: 'safari', label: 'Safari' },
          { id: 'firefox', label: 'Firefox' }
        ],
        metadata: {
          created_at: '2025-01-01T00:00:00Z',
          version: '1.0.0',
          status: 'active'
        }
      };
      
      vi.spyOn(registry, 'getContext').mockResolvedValue(mockContext);
      
      const windows = [
        { sliceDSL: 'context(browser_type:chrome)' },
        { sliceDSL: 'context(browser_type:safari)' },
        { sliceDSL: 'context(browser_type:firefox)' }
      ];
      
      const result = await registry.detectMECEPartition(windows, 'browser_type');
      
      expect(result.isMECE).toBe(true);
      expect(result.isComplete).toBe(true);
      expect(result.canAggregate).toBe(true);
      expect(result.missingValues).toEqual([]);
      expect(result.policy).toBe('null');
    });
    
    it('should detect incomplete partition (otherPolicy: null, missing value)', async () => {
      const mockContext: ContextDefinition = {
        id: 'browser_type',
        name: 'Browser Type',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'null',
        values: [
          { id: 'chrome', label: 'Chrome' },
          { id: 'safari', label: 'Safari' },
          { id: 'firefox', label: 'Firefox' }
        ],
        metadata: {
          created_at: '2025-01-01T00:00:00Z',
          version: '1.0.0',
          status: 'active'
        }
      };
      
      vi.spyOn(registry, 'getContext').mockResolvedValue(mockContext);
      
      const windows = [
        { sliceDSL: 'context(browser_type:chrome)' },
        { sliceDSL: 'context(browser_type:safari)' }
        // Missing firefox
      ];
      
      const result = await registry.detectMECEPartition(windows, 'browser_type');
      
      expect(result.isMECE).toBe(true);
      expect(result.isComplete).toBe(false);
      expect(result.canAggregate).toBe(false); // Incomplete → can't aggregate
      expect(result.missingValues).toEqual(['firefox']);
    });
    
    it('should handle otherPolicy: computed (includes "other")', async () => {
      const mockContext: ContextDefinition = {
        id: 'channel',
        name: 'Channel',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'computed',
        values: [
          { id: 'google', label: 'Google' },
          { id: 'meta', label: 'Meta' },
          { id: 'other', label: 'Other' }
        ],
        metadata: {
          created_at: '2025-01-01T00:00:00Z',
          version: '1.0.0',
          status: 'active'
        }
      };
      
      vi.spyOn(registry, 'getContext').mockResolvedValue(mockContext);
      
      const windows = [
        { sliceDSL: 'context(channel:google)' },
        { sliceDSL: 'context(channel:meta)' },
        { sliceDSL: 'context(channel:other)' }
      ];
      
      const result = await registry.detectMECEPartition(windows, 'channel');
      
      expect(result.isMECE).toBe(true);
      expect(result.isComplete).toBe(true);
      expect(result.canAggregate).toBe(true);
      expect(result.missingValues).toEqual([]);
      expect(result.policy).toBe('computed');
    });
    
    it('should mark incomplete when missing "other" (otherPolicy: computed)', async () => {
      const mockContext: ContextDefinition = {
        id: 'channel',
        name: 'Channel',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'computed',
        values: [
          { id: 'google', label: 'Google' },
          { id: 'meta', label: 'Meta' },
          { id: 'other', label: 'Other' }
        ],
        metadata: {
          created_at: '2025-01-01T00:00:00Z',
          version: '1.0.0',
          status: 'active'
        }
      };
      
      vi.spyOn(registry, 'getContext').mockResolvedValue(mockContext);
      
      const windows = [
        { sliceDSL: 'context(channel:google)' },
        { sliceDSL: 'context(channel:meta)' }
        // Missing "other"
      ];
      
      const result = await registry.detectMECEPartition(windows, 'channel');
      
      expect(result.isMECE).toBe(true);
      expect(result.isComplete).toBe(false);
      expect(result.canAggregate).toBe(false);
      expect(result.missingValues).toContain('other');
    });
    
    it('should never allow aggregation with otherPolicy: undefined', async () => {
      const mockContext: ContextDefinition = {
        id: 'source',
        name: 'Source',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'undefined', // NOT MECE
        values: [
          { id: 'google', label: 'Google' },
          { id: 'facebook', label: 'Facebook' }
        ],
        metadata: {
          created_at: '2025-01-01T00:00:00Z',
          version: '1.0.0',
          status: 'active'
        }
      };
      
      vi.spyOn(registry, 'getContext').mockResolvedValue(mockContext);
      
      const windows = [
        { sliceDSL: 'context(source:google)' },
        { sliceDSL: 'context(source:facebook)' }
      ];
      
      const result = await registry.detectMECEPartition(windows, 'source');
      
      expect(result.isMECE).toBe(true);
      expect(result.isComplete).toBe(true); // Has all listed values
      expect(result.canAggregate).toBe(false); // But NEVER safe (not MECE)
      expect(result.policy).toBe('undefined');
    });
    
    it('should detect duplicate values (non-MECE)', async () => {
      const mockContext: ContextDefinition = {
        id: 'channel',
        name: 'Channel',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'null',
        values: [
          { id: 'google', label: 'Google' },
          { id: 'meta', label: 'Meta' }
        ],
        metadata: {
          created_at: '2025-01-01T00:00:00Z',
          version: '1.0.0',
          status: 'active'
        }
      };
      
      vi.spyOn(registry, 'getContext').mockResolvedValue(mockContext);
      
      const windows = [
        { sliceDSL: 'context(channel:google)' },
        { sliceDSL: 'context(channel:google)' }, // Duplicate!
        { sliceDSL: 'context(channel:meta)' }
      ];
      
      const result = await registry.detectMECEPartition(windows, 'channel');
      
      expect(result.isMECE).toBe(false); // Duplicates → not mutually exclusive
      expect(result.canAggregate).toBe(false);
    });
  });
  
  describe('getValuesForContext', () => {
    it('should exclude "other" for otherPolicy: null', async () => {
      const mockContext: ContextDefinition = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'null',
        values: [
          { id: 'val1', label: 'Value 1' },
          { id: 'other', label: 'Other' }
        ],
        metadata: {
          created_at: '2025-01-01T00:00:00Z',
          version: '1.0.0',
          status: 'active'
        }
      };
      
      vi.spyOn(registry, 'getContext').mockResolvedValue(mockContext);
      
      const values = await registry.getValuesForContext('test');
      
      expect(values).toHaveLength(1);
      expect(values[0].id).toBe('val1');
    });
    
    it('should include "other" for otherPolicy: computed', async () => {
      const mockContext: ContextDefinition = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'computed',
        values: [
          { id: 'val1', label: 'Value 1' },
          { id: 'other', label: 'Other' }
        ],
        metadata: {
          created_at: '2025-01-01T00:00:00Z',
          version: '1.0.0',
          status: 'active'
        }
      };
      
      vi.spyOn(registry, 'getContext').mockResolvedValue(mockContext);
      
      const values = await registry.getValuesForContext('test');
      
      expect(values).toHaveLength(2);
      expect(values.map(v => v.id)).toContain('other');
    });
  });
});

