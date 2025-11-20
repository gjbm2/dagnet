/**
 * Tests for ColourAssigner
 * 
 * Tests colour assignment to scenarios
 * 
 * @group unit
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { assignColours } from '../ColourAssigner';

describe('ColourAssigner', () => {
  describe('assignColours', () => {
    it('assigns grey for single visible scenario', () => {
      const visibleIds = ['scenario-1'];
      const activationOrder = ['scenario-1'];
      
      const colours = assignColours(visibleIds, activationOrder);
      
      expect(colours.get('scenario-1')).toBe('#808080'); // Grey
    });
    
    it('assigns complementary colours for two scenarios', () => {
      const visibleIds = ['scenario-1', 'scenario-2'];
      const activationOrder = ['scenario-1', 'scenario-2'];
      
      const colours = assignColours(visibleIds, activationOrder);
      
      expect(colours.get('scenario-1')).toBe('#4A90E2'); // Blue
      expect(colours.get('scenario-2')).toBe('#E24A90'); // Pink
    });
    
    it('assigns distributed hues for N scenarios', () => {
      const visibleIds = ['scenario-1', 'scenario-2', 'scenario-3'];
      const activationOrder = ['scenario-1', 'scenario-2', 'scenario-3'];
      
      const colours = assignColours(visibleIds, activationOrder);
      
      expect(colours.size).toBe(3);
      expect(colours.get('scenario-1')).toBeDefined();
      expect(colours.get('scenario-2')).toBeDefined();
      expect(colours.get('scenario-3')).toBeDefined();
      
      // Colours should be different
      expect(colours.get('scenario-1')).not.toBe(colours.get('scenario-2'));
      expect(colours.get('scenario-2')).not.toBe(colours.get('scenario-3'));
      expect(colours.get('scenario-1')).not.toBe(colours.get('scenario-3'));
    });
    
    it('respects activation order, not visibility order', () => {
      const visibleIds = ['scenario-2', 'scenario-1']; // Different order
      const activationOrder = ['scenario-1', 'scenario-2']; // Original order
      
      const colours = assignColours(visibleIds, activationOrder);
      
      // Should follow activation order
      expect(colours.get('scenario-1')).toBe('#4A90E2'); // First in activation
      expect(colours.get('scenario-2')).toBe('#E24A90'); // Second in activation
    });
    
    it('only assigns colours to visible scenarios', () => {
      const visibleIds = ['scenario-1', 'scenario-2'];
      const activationOrder = ['scenario-1', 'scenario-2', 'scenario-3']; // scenario-3 not visible
      
      const colours = assignColours(visibleIds, activationOrder);
      
      expect(colours.size).toBe(2);
      expect(colours.get('scenario-1')).toBeDefined();
      expect(colours.get('scenario-2')).toBeDefined();
      expect(colours.get('scenario-3')).toBeUndefined(); // Not visible
    });
    
    it('handles empty visible list', () => {
      const visibleIds: string[] = [];
      const activationOrder: string[] = [];
      
      const colours = assignColours(visibleIds, activationOrder);
      
      expect(colours.size).toBe(0);
    });
  });
});




