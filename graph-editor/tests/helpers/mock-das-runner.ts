/**
 * Mock DAS Runner
 * 
 * Simulates DAS execution for testing without hitting real APIs.
 * Records all queries for assertion.
 */

export interface MockDASConfig {
  provider?: string;
  responses?: Record<string, any>;
  shouldFail?: boolean;
  failureMessage?: string;
  mode?: 'daily' | 'aggregate';
}

export interface DASExecutionRecord {
  connectionName: string;
  dsl: any;
  options: any;
  timestamp: string;
  result: any;
}

export class MockDASRunner {
  private executions: DASExecutionRecord[] = [];
  private config: MockDASConfig;

  constructor(config: MockDASConfig = {}) {
    this.config = config;
  }

  /**
   * Execute a query (mocked)
   */
  async execute(connectionName: string, dsl: any, options: any = {}): Promise<any> {
    const execution: DASExecutionRecord = {
      connectionName,
      dsl,
      options,
      timestamp: new Date().toISOString(),
      result: null
    };

    // Check if should fail
    if (this.config.shouldFail) {
      execution.result = {
        success: false,
        error: this.config.failureMessage || 'Mock failure',
        phase: 'execute'
      };
      this.executions.push(execution);
      return execution.result;
    }

    // Determine mode
    const mode = options.context?.mode || dsl.mode || this.config.mode || 'aggregate';

    // Generate mock response
    const mockResult = this.generateMockResponse(dsl, mode);
    
    execution.result = {
      success: true,
      raw: mockResult,
      updates: []
    };

    this.executions.push(execution);
    return execution.result;
  }

  /**
   * Get all executions (for assertions)
   */
  getExecutions(): DASExecutionRecord[] {
    return [...this.executions];
  }

  /**
   * Get last execution
   */
  getLastExecution(): DASExecutionRecord | undefined {
    return this.executions[this.executions.length - 1];
  }

  /**
   * Assert execution count
   */
  assertExecutionCount(expected: number): void {
    if (this.executions.length !== expected) {
      throw new Error(`Expected ${expected} executions, got ${this.executions.length}`);
    }
  }

  /**
   * Assert query was executed
   */
  assertQueryExecuted(queryPattern: string | RegExp): void {
    const found = this.executions.some(exec => {
      const query = this.dslToString(exec.dsl);
      return typeof queryPattern === 'string'
        ? query.includes(queryPattern)
        : queryPattern.test(query);
    });

    if (!found) {
      throw new Error(`Expected query matching ${queryPattern} to be executed`);
    }
  }

  /**
   * Assert mode was used
   */
  assertModeUsed(mode: 'daily' | 'aggregate'): void {
    const lastExec = this.getLastExecution();
    if (!lastExec) {
      throw new Error('No executions recorded');
    }

    const actualMode = lastExec.options.context?.mode || lastExec.dsl.mode;
    if (actualMode !== mode) {
      throw new Error(`Expected mode ${mode}, got ${actualMode}`);
    }
  }

  /**
   * Clear executions (reset between tests)
   */
  clear(): void {
    this.executions = [];
  }

  // Private helpers

  private generateMockResponse(dsl: any, mode: string): any {
    // Check for custom response
    const key = this.dslToString(dsl);
    if (this.config.responses && this.config.responses[key]) {
      return this.config.responses[key];
    }

    // Generate realistic mock data
    const from_count = 1000 + Math.floor(Math.random() * 1000);
    const conversion_rate = 0.3 + Math.random() * 0.4;
    const to_count = Math.floor(from_count * conversion_rate);
    const p_mean = to_count / from_count;

    if (mode === 'daily') {
      // Generate daily time series
      const days = 7;
      const time_series = [];
      
      for (let i = 0; i < days; i++) {
        const date = new Date(2025, 0, 13 + i).toISOString().split('T')[0];
        const daily_n = Math.floor(from_count / days);
        const daily_k = Math.floor(to_count / days);
        
        time_series.push({
          date,
          n: daily_n,
          k: daily_k,
          p: daily_k / daily_n
        });
      }

      return {
        from_count,
        to_count,
        p_mean,
        time_series,
        mode: 'daily'
      };
    } else {
      // Aggregate mode
      return {
        from_count,
        to_count,
        p_mean,
        mode: 'aggregate'
      };
    }
  }

  private dslToString(dsl: any): string {
    let query = `from(${dsl.from}).to(${dsl.to})`;
    
    if (dsl.visited && dsl.visited.length > 0) {
      query += `.visited(${dsl.visited.join(',')})`;
    }
    
    if (dsl.exclude && dsl.exclude.length > 0) {
      query += `.exclude(${dsl.exclude.join(',')})`;
    }

    return query;
  }
}

/**
 * Create a mock DAS runner with preset responses
 */
export function createMockDASRunner(config?: MockDASConfig): MockDASRunner {
  return new MockDASRunner(config);
}

/**
 * Create a mock Amplitude response
 */
export function createMockAmplitudeResponse(config: {
  from_count?: number;
  to_count?: number;
  daily?: boolean;
  days?: number;
}): any {
  const from_count = config.from_count ?? 2000;
  const to_count = config.to_count ?? 800;
  const p_mean = to_count / from_count;

  if (config.daily) {
    const days = config.days ?? 7;
    const time_series = [];
    
    for (let i = 0; i < days; i++) {
      const date = new Date(2025, 0, 13 + i).toISOString().split('T')[0];
      time_series.push({
        date,
        n: Math.floor(from_count / days),
        k: Math.floor(to_count / days),
        p: p_mean
      });
    }

    return {
      from_count,
      to_count,
      p_mean,
      time_series,
      day_funnels: {
        series: time_series
      }
    };
  }

  return {
    from_count,
    to_count,
    p_mean
  };
}

