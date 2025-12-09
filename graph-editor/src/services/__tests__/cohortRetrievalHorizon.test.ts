/**
 * Tests for Cohort Retrieval Horizon Helper
 * 
 * Design reference: retrieval-date-logic-implementation-plan.md §6, §8.2
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeCohortRetrievalHorizon,
  shouldBoundCohortWindow,
  getEffectiveT95ForCohort,
  type CohortHorizonInput,
} from '../cohortRetrievalHorizon';

describe('cohortRetrievalHorizon', () => {
  // Use a fixed reference date for deterministic tests
  const referenceDate = new Date('2025-12-09T12:00:00Z');
  
  describe('computeCohortRetrievalHorizon', () => {
    describe('basic window bounding', () => {
      it('should bound a wide cohort window to path_t95 horizon', () => {
        const input: CohortHorizonInput = {
          requestedWindow: {
            start: '9-Sep-25',  // 91 days ago
            end: '9-Dec-25',    // today
          },
          pathT95: 30,  // 30 day path maturity
          referenceDate,
        };
        
        const result = computeCohortRetrievalHorizon(input);
        
        expect(result.wasBounded).toBe(true);
        expect(result.effectiveT95).toBe(30);
        expect(result.t95Source).toBe('path_t95');
        // Should trim ~59 days (91 - 30 - 2 buffer)
        expect(result.daysTrimmed).toBeGreaterThan(50);
      });
      
      it('should NOT bound a narrow window already within horizon', () => {
        const input: CohortHorizonInput = {
          requestedWindow: {
            start: '29-Nov-25',  // 10 days ago
            end: '9-Dec-25',     // today
          },
          pathT95: 30,  // 30 day path maturity
          referenceDate,
        };
        
        const result = computeCohortRetrievalHorizon(input);
        
        expect(result.wasBounded).toBe(false);
        expect(result.daysTrimmed).toBe(0);
        expect(result.boundedWindow.start).toBe(result.originalWindow.start);
      });
      
      it('should never widen the requested window', () => {
        const input: CohortHorizonInput = {
          requestedWindow: {
            start: '5-Dec-25',  // 4 days ago
            end: '9-Dec-25',    // today
          },
          pathT95: 90,  // Very long maturity
          referenceDate,
        };
        
        const result = computeCohortRetrievalHorizon(input);
        
        expect(result.wasBounded).toBe(false);
        expect(result.boundedWindow.start).toBe(result.originalWindow.start);
        expect(result.boundedWindow.end).toBe(result.originalWindow.end);
      });
      
      it('should preserve the end date (never truncate recent cohorts)', () => {
        const input: CohortHorizonInput = {
          requestedWindow: {
            start: '9-Jun-25',  // ~180 days ago
            end: '9-Dec-25',    // today
          },
          pathT95: 14,  // Short maturity
          referenceDate,
        };
        
        const result = computeCohortRetrievalHorizon(input);
        
        // End date should always be preserved
        expect(result.boundedWindow.end).toBe(result.originalWindow.end);
      });
    });
    
    describe('t95 fallback chain', () => {
      it('should prefer path_t95 over edge_t95', () => {
        const input: CohortHorizonInput = {
          requestedWindow: { start: '9-Sep-25', end: '9-Dec-25' },
          pathT95: 40,
          edgeT95: 20,
          maturityDays: 10,
          referenceDate,
        };
        
        const result = computeCohortRetrievalHorizon(input);
        
        expect(result.effectiveT95).toBe(40);
        expect(result.t95Source).toBe('path_t95');
      });
      
      it('should fall back to edge_t95 when path_t95 is missing', () => {
        const input: CohortHorizonInput = {
          requestedWindow: { start: '9-Sep-25', end: '9-Dec-25' },
          edgeT95: 25,
          maturityDays: 10,
          referenceDate,
        };
        
        const result = computeCohortRetrievalHorizon(input);
        
        expect(result.effectiveT95).toBe(25);
        expect(result.t95Source).toBe('edge_t95');
      });
      
      it('should fall back to maturity_days when t95 values are missing', () => {
        const input: CohortHorizonInput = {
          requestedWindow: { start: '9-Sep-25', end: '9-Dec-25' },
          maturityDays: 14,
          referenceDate,
        };
        
        const result = computeCohortRetrievalHorizon(input);
        
        expect(result.effectiveT95).toBe(14);
        expect(result.t95Source).toBe('maturity_days');
      });
      
      it('should use default (30 days) when all values are missing', () => {
        const input: CohortHorizonInput = {
          requestedWindow: { start: '9-Sep-25', end: '9-Dec-25' },
          referenceDate,
        };
        
        const result = computeCohortRetrievalHorizon(input);
        
        expect(result.effectiveT95).toBe(30);  // DEFAULT_MATURITY_DAYS
        expect(result.t95Source).toBe('default');
      });
      
      it('should ignore zero/negative t95 values', () => {
        const input: CohortHorizonInput = {
          requestedWindow: { start: '9-Sep-25', end: '9-Dec-25' },
          pathT95: 0,
          edgeT95: -5,
          maturityDays: 20,
          referenceDate,
        };
        
        const result = computeCohortRetrievalHorizon(input);
        
        expect(result.effectiveT95).toBe(20);
        expect(result.t95Source).toBe('maturity_days');
      });
    });
    
    describe('cohort classification', () => {
      it('should classify missing cohorts correctly', () => {
        const input: CohortHorizonInput = {
          requestedWindow: { start: '5-Dec-25', end: '9-Dec-25' },  // 5 days
          pathT95: 30,
          referenceDate,
          existingCoverage: {
            dates: [],  // No existing coverage
          },
        };
        
        const result = computeCohortRetrievalHorizon(input);
        
        expect(result.cohortClassification.missingCount).toBe(5);
        expect(result.cohortClassification.staleCount).toBe(0);
        expect(result.cohortClassification.stableCount).toBe(0);
      });
      
      it('should classify covered cohorts with old retrieval as stable', () => {
        // Using dates well in the past so they were mature when retrieved
        const input: CohortHorizonInput = {
          requestedWindow: { start: '1-Nov-25', end: '5-Nov-25' },  // ~38 days before reference
          pathT95: 30,
          referenceDate,
          existingCoverage: {
            dates: ['1-Nov-25', '2-Nov-25', '3-Nov-25', '4-Nov-25', '5-Nov-25'],
            // Retrieved after the cohorts were mature (30 days after the cohort dates)
            retrievedAt: '2025-12-05T00:00:00Z',
          },
        };
        
        const result = computeCohortRetrievalHorizon(input);
        
        // These cohorts were covered and were mature when retrieved
        expect(result.cohortClassification.stableCount).toBeGreaterThan(0);
        expect(result.cohortClassification.missingCount).toBe(0);
      });
    });
    
    describe('edge cases', () => {
      it('should handle single-day window', () => {
        const input: CohortHorizonInput = {
          requestedWindow: { start: '9-Dec-25', end: '9-Dec-25' },
          pathT95: 30,
          referenceDate,
        };
        
        const result = computeCohortRetrievalHorizon(input);
        
        expect(result.wasBounded).toBe(false);
        expect(result.boundedWindow.start).toBe('9-Dec-25');
        expect(result.boundedWindow.end).toBe('9-Dec-25');
      });
      
      it('should handle very large path_t95', () => {
        const input: CohortHorizonInput = {
          requestedWindow: { start: '9-Sep-25', end: '9-Dec-25' },  // 91 days
          pathT95: 180,  // 6 months maturity
          referenceDate,
        };
        
        const result = computeCohortRetrievalHorizon(input);
        
        // Should not bound because entire window is within horizon
        expect(result.wasBounded).toBe(false);
      });
      
      it('should enforce minimum horizon days', () => {
        const input: CohortHorizonInput = {
          requestedWindow: { start: '9-Sep-25', end: '9-Dec-25' },
          pathT95: 1,  // Very short maturity
          referenceDate,
        };
        
        const result = computeCohortRetrievalHorizon(input);
        
        // Should report actual t95
        expect(result.effectiveT95).toBe(1);
        // Window was bounded
        expect(result.wasBounded).toBe(true);
        // Min horizon is 7 days + 2 buffer = 9 days
        // So from 91 day window, we trim down to ~9 days, meaning daysTrimmed ~82
        expect(result.daysTrimmed).toBeGreaterThan(80);
      });
    });
    
    describe('summary generation', () => {
      it('should generate readable summary for bounded window', () => {
        const input: CohortHorizonInput = {
          requestedWindow: { start: '9-Sep-25', end: '9-Dec-25' },
          pathT95: 30,
          referenceDate,
        };
        
        const result = computeCohortRetrievalHorizon(input);
        
        expect(result.summary).toContain('Bounded');
        expect(result.summary).toContain('path_t95');
        expect(result.summary).toContain('30');
      });
      
      it('should generate readable summary for unbounded window', () => {
        const input: CohortHorizonInput = {
          requestedWindow: { start: '5-Dec-25', end: '9-Dec-25' },
          pathT95: 30,
          referenceDate,
        };
        
        const result = computeCohortRetrievalHorizon(input);
        
        expect(result.summary).toContain('full window');
        expect(result.summary).toContain('within');
      });
    });
  });
  
  describe('shouldBoundCohortWindow', () => {
    it('should return true for windows extending before horizon', () => {
      const result = shouldBoundCohortWindow(
        { start: '9-Sep-25', end: '9-Dec-25' },  // 91 days
        30,  // path_t95
        undefined,
        undefined,
        referenceDate
      );
      
      expect(result).toBe(true);
    });
    
    it('should return false for windows within horizon', () => {
      const result = shouldBoundCohortWindow(
        { start: '29-Nov-25', end: '9-Dec-25' },  // 10 days
        30,  // path_t95
        undefined,
        undefined,
        referenceDate
      );
      
      expect(result).toBe(false);
    });
  });
  
  describe('getEffectiveT95ForCohort', () => {
    it('should extract effective t95 from edge with path_t95', () => {
      const edge = {
        p: {
          latency: {
            t95: 20,
            path_t95: 45,
            maturity_days: 14,
          },
        },
      };
      
      const result = getEffectiveT95ForCohort(edge);
      
      expect(result.effectiveT95).toBe(45);
      expect(result.source).toBe('path_t95');
    });
    
    it('should use computed path_t95 if provided', () => {
      const edge = {
        p: {
          latency: {
            t95: 20,
            maturity_days: 14,
          },
        },
      };
      
      const result = getEffectiveT95ForCohort(edge, 55);
      
      expect(result.effectiveT95).toBe(55);
      expect(result.source).toBe('path_t95');
    });
    
    it('should fall back through the chain', () => {
      const edge = { p: { latency: { maturity_days: 21 } } };
      
      const result = getEffectiveT95ForCohort(edge);
      
      expect(result.effectiveT95).toBe(21);
      expect(result.source).toBe('maturity_days');
    });
  });
});

describe('implementation plan test scenarios (§8.2)', () => {
  const referenceDate = new Date('2025-12-09T12:00:00Z');
  
  describe('cohort(-90d:) where path_t95 is much shorter', () => {
    it('should bound retrieval to path_t95 horizon, not full 90 days', () => {
      const input: CohortHorizonInput = {
        requestedWindow: {
          start: '10-Sep-25',  // ~90 days ago
          end: '9-Dec-25',
        },
        pathT95: 21,  // 3 weeks maturity
        referenceDate,
      };
      
      const result = computeCohortRetrievalHorizon(input);
      
      expect(result.wasBounded).toBe(true);
      expect(result.daysTrimmed).toBeGreaterThan(60);  // Should trim most of the 90 days
      expect(result.effectiveT95).toBe(21);
    });
  });
  
  describe('cohorts where path_t95 is longer than requested range', () => {
    it('should NOT widen the window', () => {
      const input: CohortHorizonInput = {
        requestedWindow: {
          start: '25-Nov-25',  // ~14 days ago
          end: '9-Dec-25',
        },
        pathT95: 60,  // 60 day maturity (longer than window)
        referenceDate,
      };
      
      const result = computeCohortRetrievalHorizon(input);
      
      expect(result.wasBounded).toBe(false);
      expect(result.boundedWindow.start).toBe(result.originalWindow.start);
      expect(result.boundedWindow.end).toBe(result.originalWindow.end);
    });
  });
  
  describe('scenarios where t95 is undefined or zero', () => {
    it('should fall back to maturity_days', () => {
      const input: CohortHorizonInput = {
        requestedWindow: { start: '9-Sep-25', end: '9-Dec-25' },
        pathT95: 0,
        edgeT95: undefined,
        maturityDays: 28,
        referenceDate,
      };
      
      const result = computeCohortRetrievalHorizon(input);
      
      expect(result.effectiveT95).toBe(28);
      expect(result.t95Source).toBe('maturity_days');
    });
    
    it('should use conservative default when all are missing', () => {
      const input: CohortHorizonInput = {
        requestedWindow: { start: '9-Sep-25', end: '9-Dec-25' },
        referenceDate,
      };
      
      const result = computeCohortRetrievalHorizon(input);
      
      expect(result.t95Source).toBe('default');
      expect(result.effectiveT95).toBe(30);  // Default
    });
  });
  
  describe('prior coverage stops just before new query window', () => {
    it('should correctly classify entire window as missing', () => {
      // Files contain cohort(-100d:-10d), new query is cohort(-9d:)
      const input: CohortHorizonInput = {
        requestedWindow: {
          start: '30-Nov-25',  // -9d from reference
          end: '9-Dec-25',
        },
        pathT95: 30,
        referenceDate,
        existingCoverage: {
          // Prior coverage ended at -10d, so -9d to today is all missing
          dates: [],  // No dates in the new window
        },
      };
      
      const result = computeCohortRetrievalHorizon(input);
      
      // Window is entirely within horizon (9 days < 30 day path_t95)
      expect(result.wasBounded).toBe(false);
      // All dates should be missing
      expect(result.cohortClassification.missingCount).toBe(10);  // 30-Nov to 9-Dec
    });
  });
});

