/**
 * Rate Limiter Service
 * 
 * Centralized rate limiting for external API calls (Amplitude, etc.)
 * 
 * Amplitude uses a cost-based rate limit:
 * - Each query has a "cost" (typically 200-500 for funnel queries)
 * - Budget: ~360-1000 cost per minute depending on plan
 * - When exceeded: 429 "Too Many Requests" with query cost in message
 * 
 * This service provides:
 * - Global rate limiting across all call sites
 * - Automatic backoff on 429 errors
 * - Per-provider configuration
 */

export interface RateLimiterConfig {
  /** Minimum delay between requests (ms) */
  minDelayMs: number;
  /** Initial backoff delay on 429 error (ms) */
  backoffInitialMs: number;
  /** Maximum backoff delay (ms) */
  backoffMaxMs: number;
  /** Backoff multiplier on each consecutive 429 */
  backoffMultiplier: number;
}

interface RateLimiterState {
  lastRequestTime: number;
  currentBackoff: number;
  consecutiveErrors: number;
}

// Provider-specific configurations
const PROVIDER_CONFIGS: Record<string, RateLimiterConfig> = {
  // Amplitude has cost-based rate limiting (~360-1000 cost/min)
  // Each funnel query costs ~200-500, so we can do ~2-5 queries/min safely
  // 3 seconds = 20 queries/min is aggressive but usually works
  'amplitude': {
    minDelayMs: 3000,           // 3 seconds between requests
    backoffInitialMs: 10000,    // 10 seconds on first 429
    backoffMaxMs: 120000,       // 2 minutes max backoff
    backoffMultiplier: 2,       // Double backoff each time
  },
  // Default for unknown providers - conservative
  'default': {
    minDelayMs: 1000,           // 1 second between requests
    backoffInitialMs: 5000,     // 5 seconds on first 429
    backoffMaxMs: 60000,        // 1 minute max backoff
    backoffMultiplier: 2,
  },
};

class RateLimiter {
  // Per-provider state
  private providerState: Map<string, RateLimiterState> = new Map();
  
  /**
   * Get configuration for a provider
   */
  private getConfig(provider: string): RateLimiterConfig {
    // Normalize provider name (e.g., 'amplitude-prod' → 'amplitude')
    const normalizedProvider = provider.toLowerCase().split('-')[0];
    return PROVIDER_CONFIGS[normalizedProvider] || PROVIDER_CONFIGS['default'];
  }
  
  /**
   * Get or create state for a provider
   */
  private getState(provider: string): RateLimiterState {
    const normalizedProvider = provider.toLowerCase().split('-')[0];
    if (!this.providerState.has(normalizedProvider)) {
      this.providerState.set(normalizedProvider, {
        lastRequestTime: 0,
        currentBackoff: 0,
        consecutiveErrors: 0,
      });
    }
    return this.providerState.get(normalizedProvider)!;
  }
  
  /**
   * Wait for rate limit before making a request
   * Call this BEFORE making an API request
   * 
   * @param provider - Provider name (e.g., 'amplitude-prod', 'amplitude')
   * @returns Promise that resolves when it's safe to make the request
   */
  async waitForRateLimit(provider: string): Promise<void> {
    const config = this.getConfig(provider);
    const state = this.getState(provider);
    
    const now = Date.now();
    const timeSinceLastRequest = now - state.lastRequestTime;
    
    // Calculate required wait time
    let waitTime = 0;
    
    // If we're in backoff mode, wait for backoff to expire
    if (state.currentBackoff > 0) {
      waitTime = Math.max(waitTime, state.currentBackoff);
      console.log(`[RateLimiter] ${provider}: In backoff mode, waiting ${state.currentBackoff}ms`);
    }
    
    // Ensure minimum delay between requests
    const remainingDelay = config.minDelayMs - timeSinceLastRequest;
    if (remainingDelay > 0) {
      waitTime = Math.max(waitTime, remainingDelay);
    }
    
    if (waitTime > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // Update last request time
    state.lastRequestTime = Date.now();
  }
  
  /**
   * Report a successful request
   * Resets backoff state
   * 
   * @param provider - Provider name
   */
  reportSuccess(provider: string): void {
    const state = this.getState(provider);
    state.currentBackoff = 0;
    state.consecutiveErrors = 0;
  }
  
  /**
   * Report a rate limit error (429)
   * Increases backoff for next request
   * 
   * @param provider - Provider name
   * @param errorMessage - Optional error message (may contain Retry-After info)
   */
  reportRateLimitError(provider: string, errorMessage?: string): void {
    const config = this.getConfig(provider);
    const state = this.getState(provider);
    
    state.consecutiveErrors++;
    
    // Calculate new backoff
    if (state.currentBackoff === 0) {
      state.currentBackoff = config.backoffInitialMs;
    } else {
      state.currentBackoff = Math.min(
        state.currentBackoff * config.backoffMultiplier,
        config.backoffMaxMs
      );
    }
    
    console.log(
      `[RateLimiter] ${provider}: Rate limit hit (${state.consecutiveErrors}x), ` +
      `next backoff: ${state.currentBackoff}ms`
    );
    
    // Try to parse Retry-After from error message if available
    if (errorMessage) {
      const retryAfterMatch = errorMessage.match(/retry.?after[:\s]+(\d+)/i);
      if (retryAfterMatch) {
        const retryAfterSeconds = parseInt(retryAfterMatch[1], 10);
        if (!isNaN(retryAfterSeconds)) {
          state.currentBackoff = Math.max(state.currentBackoff, retryAfterSeconds * 1000);
          console.log(`[RateLimiter] ${provider}: Using Retry-After: ${retryAfterSeconds}s`);
        }
      }
    }
  }
  
  /**
   * Check if an error is a rate limit error
   * 
   * @param error - Error object or message
   * @returns true if this is a 429 / rate limit error
   */
  isRateLimitError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('429') ||
      message.includes('Too Many Requests') ||
      message.includes('rate limit') ||
      message.includes('Exceeded concurrent limit') ||
      message.includes('Exceeded rate limit')
    );
  }
  
  /**
   * Get current state for debugging/monitoring
   */
  getStats(): Record<string, RateLimiterState> {
    const stats: Record<string, RateLimiterState> = {};
    for (const [provider, state] of this.providerState.entries()) {
      stats[provider] = { ...state };
    }
    return stats;
  }
  
  /**
   * Reset all rate limiter state (for testing)
   */
  reset(): void {
    this.providerState.clear();
  }
}

// Singleton instance
export const rateLimiter = new RateLimiter();






