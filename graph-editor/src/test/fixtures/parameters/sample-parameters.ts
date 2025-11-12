/**
 * Sample Parameter Fixtures
 * 
 * Realistic parameter data for integration tests
 */

export const conversionRateParam = {
  id: 'conversion-rate',
  name: 'Landing to Signup Conversion',
  type: 'probability',
  description: 'Probability of users signing up from landing page',
  query: 'from(landing).to(signup)',
  query_overridden: false,
  values: [
    {
      mean: 0.75,
      stdev: 0.05,
      n: 1000,
      k: 750,
      window_from: '2025-01-01T00:00:00Z',
      window_to: '2025-01-31T00:00:00Z',
      source: 'analytics',
    },
  ],
  metadata: {
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-31T00:00:00Z',
    author: 'test-user',
    version: '1.0.0',
    status: 'active',
  },
};

export const costParam = {
  id: 'acquisition-cost',
  name: 'Customer Acquisition Cost',
  type: 'cost_gbp',
  description: 'Average cost to acquire one customer',
  values: [
    {
      mean: 25.50,
      stdev: 5.00,
      distribution: 'lognormal',
      currency: 'GBP',
      source: 'marketing',
    },
  ],
  metadata: {
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-31T00:00:00Z',
    author: 'test-user',
    version: '1.0.0',
    status: 'active',
  },
};

export const timeParam = {
  id: 'processing-time',
  name: 'Order Processing Time',
  type: 'cost_time',
  description: 'Average time to process an order',
  values: [
    {
      mean: 2.5,
      stdev: 0.5,
      distribution: 'gamma',
      units: 'hours',
      source: 'operations',
    },
  ],
  metadata: {
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-31T00:00:00Z',
    author: 'test-user',
    version: '1.0.0',
    status: 'active',
  },
};

export const emptyParam = {
  id: 'empty-param',
  name: 'Empty Parameter',
  type: 'probability',
  description: '',
  values: [{ mean: 1.0 }],
  metadata: {
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    author: 'test-user',
    version: '1.0.0',
    status: 'draft',
  },
};

