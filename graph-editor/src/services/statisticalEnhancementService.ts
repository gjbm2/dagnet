/**
 * Statistical Enhancement Service
 * 
 * Plugin point for future statistical enhancement methods (Bayesian, trend-aware, etc.).
 * Currently implements a NoOp pass-through enhancer.
 * 
 * Architecture:
 *   RawAggregation → StatisticalEnhancementService → EnhancedAggregation
 */

import type { RawAggregation } from './windowAggregationService';

export interface EnhancedAggregation {
  method: string;
  n: number;
  k: number;
  mean: number;
  stdev: number;
  confidence_interval?: [number, number] | null;
  trend?: {
    direction: 'increasing' | 'decreasing' | 'stable';
    slope: number;
    significance: number;
  } | null;
  metadata: {
    raw_method: string;
    enhancement_method: string;
    data_points: number;
  };
}

export interface StatisticalEnhancer {
  enhance(raw: RawAggregation): EnhancedAggregation;
}

/**
 * No-op enhancer - passes through raw aggregation unchanged
 */
export class NoOpEnhancer implements StatisticalEnhancer {
  enhance(raw: RawAggregation): EnhancedAggregation {
    return {
      method: raw.method,
      n: raw.n,
      k: raw.k,
      mean: raw.mean,
      stdev: raw.stdev,
      confidence_interval: null,
      trend: null,
      metadata: {
        raw_method: raw.method,
        enhancement_method: 'none',
        data_points: raw.days_included,
      },
    };
  }
}

/**
 * Statistical Enhancement Service
 * 
 * Provides a plugin architecture for statistical enhancement methods.
 * Currently only supports 'none' (NoOp), but can be extended with:
 * - 'bayesian': Bayesian inference with priors
 * - 'trend-aware': Trend detection and adjustment
 * - 'robust': Robust statistics (outlier-resistant)
 */
export class StatisticalEnhancementService {
  private enhancers: Map<string, StatisticalEnhancer> = new Map();

  constructor() {
    // Register default NoOp enhancer
    this.registerEnhancer('none', new NoOpEnhancer());
  }

  /**
   * Register a new enhancement method
   */
  registerEnhancer(name: string, enhancer: StatisticalEnhancer): void {
    this.enhancers.set(name, enhancer);
  }

  /**
   * Enhance raw aggregation with statistical method
   * 
   * @param raw Raw aggregation result
   * @param method Enhancement method ('none', 'bayesian', 'trend-aware', 'robust')
   * @returns Enhanced aggregation
   */
  enhance(raw: RawAggregation, method: string = 'none'): EnhancedAggregation {
    const enhancer = this.enhancers.get(method);
    
    if (!enhancer) {
      console.warn(`Unknown enhancement method: ${method}, falling back to 'none'`);
      const noOpEnhancer = this.enhancers.get('none')!;
      return noOpEnhancer.enhance(raw);
    }

    return enhancer.enhance(raw);
  }
}

// Singleton instance
export const statisticalEnhancementService = new StatisticalEnhancementService();

