/**
 * Mock for external API integrations (Amplitude, Mixpanel, custom APIs, etc.)
 * Used by DAS runner tests
 */

import { vi } from 'vitest';

/**
 * Mock Amplitude API response
 */
export const mockAmplitudeResponse = {
  data: {
    series: [
      [100, 120, 150, 180, 200],
    ],
    xValues: ['2025-01-01', '2025-01-02', '2025-01-03', '2025-01-04', '2025-01-05'],
  },
  meta: {
    total_events: 750,
  },
};

/**
 * Mock Mixpanel API response
 */
export const mockMixpanelResponse = {
  results: {
    'conversion_rate': {
      values: {
        '2025-01-01': 0.25,
        '2025-01-02': 0.27,
        '2025-01-03': 0.26,
      },
    },
  },
};

/**
 * Mock custom REST API response
 */
export const mockCustomAPIResponse = {
  status: 'success',
  data: {
    metric_name: 'bounce_rate',
    value: 0.35,
    timestamp: '2025-01-15T12:00:00Z',
    metadata: {
      source: 'analytics_db',
      confidence: 0.95,
    },
  },
};

/**
 * Mock fetch for Amplitude API
 */
export function mockAmplitudeFetch() {
  return vi.fn((url: string, options?: any) => {
    if (url.includes('amplitude.com')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockAmplitudeResponse),
        text: () => Promise.resolve(JSON.stringify(mockAmplitudeResponse)),
      });
    }
    
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });
}

/**
 * Mock fetch for Mixpanel API
 */
export function mockMixpanelFetch() {
  return vi.fn((url: string, options?: any) => {
    if (url.includes('mixpanel.com')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockMixpanelResponse),
        text: () => Promise.resolve(JSON.stringify(mockMixpanelResponse)),
      });
    }
    
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });
}

/**
 * Mock fetch for custom REST API
 */
export function mockCustomAPIFetch(customResponse?: any) {
  return vi.fn((url: string, options?: any) => {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(customResponse || mockCustomAPIResponse),
      text: () => Promise.resolve(JSON.stringify(customResponse || mockCustomAPIResponse)),
    });
  });
}

/**
 * Mock fetch for failed API call (401 unauthorized)
 */
export function mockAPIAuthFailure() {
  return vi.fn((url: string, options?: any) => {
    return Promise.resolve({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
      text: () => Promise.resolve('{"error":"Unauthorized"}'),
    });
  });
}

/**
 * Mock fetch for failed API call (404 not found)
 */
export function mockAPINotFound() {
  return vi.fn((url: string, options?: any) => {
    return Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'Resource not found' }),
      text: () => Promise.resolve('{"error":"Resource not found"}'),
    });
  });
}

/**
 * Mock fetch for failed API call (500 server error)
 */
export function mockAPIServerError() {
  return vi.fn((url: string, options?: any) => {
    return Promise.resolve({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Internal server error' }),
      text: () => Promise.resolve('{"error":"Internal server error"}'),
    });
  });
}

/**
 * Mock fetch for rate-limited API (429)
 */
export function mockAPIRateLimited() {
  return vi.fn((url: string, options?: any) => {
    return Promise.resolve({
      ok: false,
      status: 429,
      headers: new Headers({
        'Retry-After': '60',
      }),
      json: () => Promise.resolve({ error: 'Rate limit exceeded' }),
      text: () => Promise.resolve('{"error":"Rate limit exceeded"}'),
    });
  });
}

/**
 * Mock fetch that simulates network timeout
 */
export function mockAPITimeout() {
  return vi.fn((url: string, options?: any) => {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(new Error('Network timeout'));
      }, 100);
    });
  });
}

/**
 * Mock fetch for all external APIs with router
 */
export function mockAllExternalAPIs(customResponses?: {
  amplitude?: any;
  mixpanel?: any;
  custom?: any;
}) {
  return vi.fn((url: string, options?: any) => {
    if (url.includes('amplitude.com')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(customResponses?.amplitude || mockAmplitudeResponse),
      });
    }
    
    if (url.includes('mixpanel.com')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(customResponses?.mixpanel || mockMixpanelResponse),
      });
    }
    
    // Default custom API response
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(customResponses?.custom || mockCustomAPIResponse),
    });
  });
}

/**
 * Create a complete mock environment for external API tests
 */
export function setupExternalAPIMocks(customResponses?: any) {
  const originalFetch = global.fetch;
  
  global.fetch = mockAllExternalAPIs(customResponses) as any;
  
  return {
    restore: () => {
      global.fetch = originalFetch;
    },
    mockFetch: global.fetch as any,
  };
}

