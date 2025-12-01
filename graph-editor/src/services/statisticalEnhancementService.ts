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
import { graphComputeClient } from '../lib/graphComputeClient';
import type { StatsEnhanceResponse } from '../lib/graphComputeClient';

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
 * Python stats service client interface
 * For heavy computations (MCMC, complex Bayesian inference, etc.)
 */
interface PythonStatsService {
  enhance(raw: RawAggregation, method: string): Promise<EnhancedAggregation>;
}

/**
 * Python stats service client implementation using GraphComputeClient
 */
class PythonStatsServiceClient implements PythonStatsService {
  async enhance(raw: RawAggregation, method: string): Promise<EnhancedAggregation> {
    // Call Python API via GraphComputeClient
    const response: StatsEnhanceResponse = await graphComputeClient.enhanceStats(
      {
        method: raw.method,
        n: raw.n,
        k: raw.k,
        mean: raw.mean,
        stdev: raw.stdev,
        raw_data: raw.raw_data,
        window: raw.window,
        days_included: raw.days_included,
        days_missing: raw.days_missing,
      },
      method
    );

    // Convert response to EnhancedAggregation format
    return {
      method: response.method,
      n: response.n,
      k: response.k,
      mean: response.mean,
      stdev: response.stdev,
      confidence_interval: response.confidence_interval ?? null,
      trend: response.trend ?? null,
      metadata: response.metadata,
    };
  }
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
 * Inverse-variance weighting enhancer
 * 
 * Recalculates mean using inverse-variance weighting from daily data.
 * This gives more weight to days with larger sample sizes and accounts for variance.
 * 
 * Formula: p = Σ(w_i × p_i) / Σ(w_i) where w_i = n_i / (p_i × (1 - p_i))
 */
export class InverseVarianceEnhancer implements StatisticalEnhancer {
  enhance(raw: RawAggregation): EnhancedAggregation {
    // If no daily data, fall back to naive result
    if (!raw.raw_data || raw.raw_data.length === 0) {
      return {
        method: 'inverse-variance',
        n: raw.n,
        k: raw.k,
        mean: raw.mean,
        stdev: raw.stdev,
        confidence_interval: null,
        trend: null,
        metadata: {
          raw_method: raw.method,
          enhancement_method: 'inverse-variance',
          data_points: raw.days_included,
        },
      };
    }

    // CRITICAL: Use simple mean (k/n) as the primary calculation.
    // 
    // Inverse-variance weighting was causing issues because:
    // 1. Days with p=0 (e.g., weekends, data lag) aren't "estimates of 0%" - they're outliers
    // 2. These days get massive weight: n/0.01 = 100×n when p=0
    // 3. This distorts the weighted mean (e.g., 56% actual → 16% weighted)
    //
    // The simple mean (k/n) is the CORRECT observed conversion rate over the period.
    // For funnel data, each day's data is not an independent "estimate" to combine -
    // it's actual observed data, and the aggregate is simply total_k / total_n.
    
    // Use simple mean: this is the actual observed conversion rate
    const simpleMean = raw.n > 0 ? raw.k / raw.n : 0;
    const finalMean = Math.round(simpleMean * 1000) / 1000; // Round to 3 decimal places
    
    // CRITICAL: k is the actual observed success count - it's EVIDENCE, not an estimate.
    // We preserve raw.k (the sum of all k_daily values).
    // Users need to see actual observed k, not a derived value.
    
    // Recalculate stdev using simple mean
    const finalStdev = raw.n > 0 
      ? Math.sqrt((finalMean * (1 - finalMean)) / raw.n)
      : 0;

    return {
      method: 'inverse-variance',
      n: raw.n,
      k: raw.k,  // PRESERVE actual observed k
      mean: finalMean,  // Use simple mean (k/n) - the actual observed conversion rate
      stdev: finalStdev,
      confidence_interval: null,
      trend: null,
      metadata: {
        raw_method: raw.method,
        enhancement_method: 'inverse-variance',
        data_points: raw.days_included,
      },
    };
  }
}

/**
 * Statistical Enhancement Service
 * 
 * Provides a plugin architecture for statistical enhancement methods.
 * Routes simple operations to TypeScript enhancers (fast, synchronous)
 * and complex operations to Python service (heavy lifting, async).
 * 
 * Local (TS) methods:
 * - 'none': No-op pass-through
 * - 'inverse-variance': Weighted average by precision
 * 
 * Python methods (offloaded):
 * - 'mcmc': MCMC sampling for Bayesian inference
 * - 'bayesian-complex': Complex Bayesian models with custom priors
 * - 'trend-aware': ML-based trend detection
 * - 'robust': Robust statistics with outlier detection
 */
export class StatisticalEnhancementService {
  private enhancers: Map<string, StatisticalEnhancer> = new Map();
  private pythonService: PythonStatsService;

  constructor(pythonService?: PythonStatsService) {
    // Register default TypeScript enhancers
    this.registerEnhancer('none', new NoOpEnhancer());
    this.registerEnhancer('inverse-variance', new InverseVarianceEnhancer());
    
    // Initialize Python service (stub for now)
    this.pythonService = pythonService || new PythonStatsServiceClient();
  }

  /**
   * Register a new TypeScript enhancement method
   */
  registerEnhancer(name: string, enhancer: StatisticalEnhancer): void {
    this.enhancers.set(name, enhancer);
  }

  /**
   * Determine if a method should be offloaded to Python
   * 
   * Python methods are computationally expensive and benefit from NumPy/SciPy:
   * - MCMC sampling
   * - Complex Bayesian inference
   * - ML-based trend detection
   * - Large matrix operations
   */
  private shouldOffloadToPython(method: string): boolean {
    const pythonMethods = [
      'mcmc',
      'bayesian-complex',
      'trend-aware',
      'robust',
      'bayesian', // Alias for bayesian-complex
    ];
    
    return pythonMethods.includes(method.toLowerCase());
  }

  /**
   * Enhance raw aggregation with statistical method
   * 
   * Routes to TypeScript enhancers for simple operations (synchronous)
   * or Python service for complex operations (async).
   * 
   * @param raw Raw aggregation result
   * @param method Enhancement method
   * @returns Enhanced aggregation (Promise for Python methods, sync for TS methods)
   */
  enhance(raw: RawAggregation, method: string = 'inverse-variance'): EnhancedAggregation | Promise<EnhancedAggregation> {
    // Check if method should be offloaded to Python
    if (this.shouldOffloadToPython(method)) {
      return this.pythonService.enhance(raw, method);
    }

    // Use local TypeScript enhancer
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

