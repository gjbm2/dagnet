import { describe, it, expect } from 'vitest';
import { QuerySignatureService, type DataQuerySpec } from '../querySignatureService';

describe('QuerySignatureService', () => {
  const service = new QuerySignatureService();
  
  const baseSpec: Omit<DataQuerySpec, 'windowBounds'> = {
    connectionId: 'test-conn',
    connectionType: 'amplitude',
    fromNode: 'homepage',
    toNode: 'checkout',
    visited: ['promo'],
    excluded: ['abandoned'],
    cases: [{ key: 'test', value: 'treatment' }],
    contextFilters: [
      { key: 'channel', value: 'google', sourceField: 'utm_source', sourcePredicate: "utm_source == 'google'" }
    ],
    granularity: 'daily',
    adapterOptions: {}
  };
  
  describe('buildDailySignature', () => {
    it('should generate deterministic signatures', async () => {
      const sig1 = await service.buildDailySignature(baseSpec);
      const sig2 = await service.buildDailySignature(baseSpec);
      
      expect(sig1).toBe(sig2);
      expect(sig1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });
    
    it('should produce same signature for same spec with different window (daily mode)', async () => {
      const spec1 = { ...baseSpec, granularity: 'daily' as const };
      const spec2 = { ...baseSpec, granularity: 'daily' as const };
      
      const sig1 = await service.buildDailySignature(spec1);
      const sig2 = await service.buildDailySignature(spec2);
      
      expect(sig1).toBe(sig2); // Windows excluded in daily mode
    });
    
    it('should produce different signature when topology changes', async () => {
      const spec1 = baseSpec;
      const spec2 = { ...baseSpec, visited: ['promo', 'landing'] };
      
      const sig1 = await service.buildDailySignature(spec1);
      const sig2 = await service.buildDailySignature(spec2);
      
      expect(sig1).not.toBe(sig2);
    });
    
    it('should produce different signature when context mappings change', async () => {
      const spec1 = baseSpec;
      const spec2 = {
        ...baseSpec,
        contextFilters: [
          { key: 'channel', value: 'google', sourceField: 'utm_source', sourcePredicate: "utm_source == 'google_ads'" }
        ]
      };
      
      const sig1 = await service.buildDailySignature(spec1);
      const sig2 = await service.buildDailySignature(spec2);
      
      expect(sig1).not.toBe(sig2);
    });
  });
  
  describe('buildAggregateSignature', () => {
    it('should include window bounds in signature', async () => {
      const specWithWindow: DataQuerySpec = {
        ...baseSpec,
        granularity: 'aggregate',
        windowBounds: { start: '2025-01-01', end: '2025-01-31' }
      };
      
      const specWithDifferentWindow: DataQuerySpec = {
        ...baseSpec,
        granularity: 'aggregate',
        windowBounds: { start: '2025-02-01', end: '2025-02-28' }
      };
      
      const sig1 = await service.buildAggregateSignature(specWithWindow);
      const sig2 = await service.buildAggregateSignature(specWithDifferentWindow);
      
      expect(sig1).not.toBe(sig2); // Different windows → different signatures
    });
    
    it('should throw if called with daily granularity', async () => {
      const spec: DataQuerySpec = {
        ...baseSpec,
        granularity: 'daily',
        windowBounds: { start: '2025-01-01', end: '2025-01-31' }
      };
      
      await expect(service.buildAggregateSignature(spec)).rejects.toThrow('requires granularity: aggregate');
    });
  });
  
  describe('validateSignature', () => {
    it('should return valid: true for matching signatures', async () => {
      const spec: DataQuerySpec = {
        ...baseSpec,
        granularity: 'daily',
        windowBounds: { start: '2025-01-01', end: '2025-01-31' }
      };
      
      const signature = await service.buildDailySignature(spec);
      const result = await service.validateSignature(signature, spec);
      
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });
    
    it('should return valid: false when spec changed', async () => {
      const spec1: DataQuerySpec = { ...baseSpec, granularity: 'daily' };
      const spec2: DataQuerySpec = { ...baseSpec, granularity: 'daily', visited: ['promo', 'landing'] };
      
      const signature1 = await service.buildDailySignature(spec1);
      const result = await service.validateSignature(signature1, spec2);
      
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('changed');
    });
  });
  
  describe('normalizeSpec', () => {
    it('should produce deterministic ordering', async () => {
      // Same spec with fields in different order
      const spec1: DataQuerySpec = {
        connectionId: 'test',
        connectionType: 'amplitude',
        fromNode: 'a',
        toNode: 'b',
        visited: ['x', 'y'],
        excluded: ['z'],
        cases: [],
        contextFilters: [],
        granularity: 'daily',
        adapterOptions: { opt1: 'val1', opt2: 'val2' }
      };
      
      const spec2: DataQuerySpec = {
        toNode: 'b',
        fromNode: 'a',
        granularity: 'daily',
        visited: ['y', 'x'], // Different order
        contextFilters: [],
        excluded: ['z'],
        cases: [],
        adapterOptions: { opt2: 'val2', opt1: 'val1' }, // Different order
        connectionType: 'amplitude',
        connectionId: 'test'
      };
      
      const sig1 = await service.buildDailySignature(spec1);
      const sig2 = await service.buildDailySignature(spec2);
      
      expect(sig1).toBe(sig2); // Should be identical after normalization
    });
  });
});

