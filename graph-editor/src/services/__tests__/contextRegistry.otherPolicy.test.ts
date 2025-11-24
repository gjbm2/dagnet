import { describe, it, expect, vi } from 'vitest';
import { ContextRegistry } from '../contextRegistry';
import type { ContextDefinition } from '../contextRegistry';

describe('ContextRegistry - otherPolicy Behavior', () => {
  let registry: ContextRegistry;
  
  beforeEach(() => {
    registry = new ContextRegistry();
    registry.clearCache();
  });
  
  describe('otherPolicy: null', () => {
    it('should exclude "other" value even if present in values array', async () => {
      const mockContext: ContextDefinition = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'null',
        values: [
          { id: 'val1', label: 'Value 1' },
          { id: 'other', label: 'Other' }  // Present but should be excluded
        ],
        metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
      };
      
      vi.spyOn(registry, 'getContext').mockResolvedValue(mockContext);
      
      const values = await registry.getValuesForContext('test');
      
      expect(values).toHaveLength(1);
      expect(values[0].id).toBe('val1');
      expect(values.find(v => v.id === 'other')).toBeUndefined();
    });
  });
  
  describe('otherPolicy: computed', () => {
    it('should include "other" if present in values array', async () => {
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
        metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
      };
      
      vi.spyOn(registry, 'getContext').mockResolvedValue(mockContext);
      
      const values = await registry.getValuesForContext('channel');
      
      expect(values).toHaveLength(3);
      expect(values.find(v => v.id === 'other')).toBeDefined();
    });
    
    it('should auto-create "other" value if missing', async () => {
      const mockContext: ContextDefinition = {
        id: 'source',
        name: 'Source',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'computed',
        values: [
          { id: 'google', label: 'Google' },
          { id: 'facebook', label: 'Facebook' }
          // No "other" value
        ],
        metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
      };
      
      vi.spyOn(registry, 'getContext').mockResolvedValue(mockContext);
      
      const values = await registry.getValuesForContext('source');
      
      expect(values).toHaveLength(3);  // google, facebook, + auto-created "other"
      const other = values.find(v => v.id === 'other');
      expect(other).toBeDefined();
      expect(other?.label).toBe('Other');
      expect(other?.description).toContain('not explicitly listed');
    });
  });
  
  describe('otherPolicy: explicit', () => {
    it('should include "other" if present with explicit filter', async () => {
      const mockContext: ContextDefinition = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'explicit',
        values: [
          { id: 'val1', label: 'Value 1' },
          { id: 'other', label: 'Other', sources: { amplitude: { filter: 'explicit filter' } } }
        ],
        metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
      };
      
      vi.spyOn(registry, 'getContext').mockResolvedValue(mockContext);
      
      const values = await registry.getValuesForContext('test');
      
      expect(values).toHaveLength(2);
      expect(values.find(v => v.id === 'other')).toBeDefined();
    });
    
    it('should log error if "other" missing for explicit policy', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      const mockContext: ContextDefinition = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'explicit',
        values: [
          { id: 'val1', label: 'Value 1' }
          // Missing "other" - invalid for explicit policy
        ],
        metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
      };
      
      vi.spyOn(registry, 'getContext').mockResolvedValue(mockContext);
      
      await registry.getValuesForContext('test');
      
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("otherPolicy='explicit' but no 'other' value")
      );
      
      consoleErrorSpy.mockRestore();
    });
  });
  
  describe('otherPolicy: undefined', () => {
    it('should exclude "other" value (not MECE)', async () => {
      const mockContext: ContextDefinition = {
        id: 'test',
        name: 'Test',
        description: 'Test',
        type: 'categorical',
        otherPolicy: 'undefined',
        values: [
          { id: 'val1', label: 'Value 1' },
          { id: 'other', label: 'Other' }
        ],
        metadata: { created_at: '2025-01-01T00:00:00Z', version: '1.0.0', status: 'active' }
      };
      
      vi.spyOn(registry, 'getContext').mockResolvedValue(mockContext);
      
      const values = await registry.getValuesForContext('test');
      
      expect(values).toHaveLength(1);
      expect(values[0].id).toBe('val1');
    });
  });
});

