/**
 * Tests for ColorAssigner
 * 
 * Tests color assignment to scenarios
 * 
 * @group unit
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { assignColors } from '../ColorAssigner';

describe('ColorAssigner', () => {
  describe('assignColors', () => {
    it('assigns grey for single visible scenario', () => {
      const visibleIds = ['scenario-1'];
      const activationOrder = ['scenario-1'];
      
      const colors = assignColors(visibleIds, activationOrder);
      
      expect(colors.get('scenario-1')).toBe('#808080'); // Grey
    });
    
    it('assigns complementary colors for two scenarios', () => {
      const visibleIds = ['scenario-1', 'scenario-2'];
      const activationOrder = ['scenario-1', 'scenario-2'];
      
      const colors = assignColors(visibleIds, activationOrder);
      
      expect(colors.get('scenario-1')).toBe('#4A90E2'); // Blue
      expect(colors.get('scenario-2')).toBe('#E24A90'); // Pink
    });
    
    it('assigns distributed hues for N scenarios', () => {
      const visibleIds = ['scenario-1', 'scenario-2', 'scenario-3'];
      const activationOrder = ['scenario-1', 'scenario-2', 'scenario-3'];
      
      const colors = assignColors(visibleIds, activationOrder);
      
      expect(colors.size).toBe(3);
      expect(colors.get('scenario-1')).toBeDefined();
      expect(colors.get('scenario-2')).toBeDefined();
      expect(colors.get('scenario-3')).toBeDefined();
      
      // Colors should be different
      expect(colors.get('scenario-1')).not.toBe(colors.get('scenario-2'));
      expect(colors.get('scenario-2')).not.toBe(colors.get('scenario-3'));
      expect(colors.get('scenario-1')).not.toBe(colors.get('scenario-3'));
    });
    
    it('respects activation order, not visibility order', () => {
      const visibleIds = ['scenario-2', 'scenario-1']; // Different order
      const activationOrder = ['scenario-1', 'scenario-2']; // Original order
      
      const colors = assignColors(visibleIds, activationOrder);
      
      // Should follow activation order
      expect(colors.get('scenario-1')).toBe('#4A90E2'); // First in activation
      expect(colors.get('scenario-2')).toBe('#E24A90'); // Second in activation
    });
    
    it('only assigns colors to visible scenarios', () => {
      const visibleIds = ['scenario-1', 'scenario-2'];
      const activationOrder = ['scenario-1', 'scenario-2', 'scenario-3']; // scenario-3 not visible
      
      const colors = assignColors(visibleIds, activationOrder);
      
      expect(colors.size).toBe(2);
      expect(colors.get('scenario-1')).toBeDefined();
      expect(colors.get('scenario-2')).toBeDefined();
      expect(colors.get('scenario-3')).toBeUndefined(); // Not visible
    });
    
    it('handles empty visible list', () => {
      const visibleIds: string[] = [];
      const activationOrder: string[] = [];
      
      const colors = assignColors(visibleIds, activationOrder);
      
      expect(colors.size).toBe(0);
    });
  });
});

