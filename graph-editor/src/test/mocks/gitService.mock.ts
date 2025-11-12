/**
 * Git Service Mocks
 * 
 * Mock implementations of Git operations for integration tests
 */

import { vi } from 'vitest';
import { sampleGraph, emptyGraph } from '../fixtures/graphs/sample-graph';
import { conversionRateParam, costParam } from '../fixtures/parameters/sample-parameters';

/**
 * Mock graph Git service
 */
export const mockGraphGitService = {
  getGraph: vi.fn((graphId: string) => {
    // Return different graphs based on ID
    if (graphId === 'empty-graph') {
      return Promise.resolve(emptyGraph);
    }
    return Promise.resolve(sampleGraph);
  }),

  saveGraph: vi.fn((graphId: string, graph: any, branch: string = 'main') => {
    return Promise.resolve({
      success: true,
      sha: 'mock-commit-sha-' + Math.random().toString(36).substring(7),
      message: `Updated graph: ${graphId}`,
    });
  }),

  getFileContent: vi.fn((path: string) => {
    return Promise.resolve(JSON.stringify(sampleGraph, null, 2));
  }),

  commitFiles: vi.fn((files: any[], message: string) => {
    return Promise.resolve({
      sha: 'mock-commit-sha-' + Math.random().toString(36).substring(7),
      url: 'https://github.com/mock/repo/commit/abc123',
    });
  }),

  listGraphs: vi.fn(() => {
    return Promise.resolve([
      { id: 'sample-graph', name: 'Sample Conversion Funnel', path: 'graphs/sample-graph.json' },
      { id: 'empty-graph', name: 'Empty Graph', path: 'graphs/empty-graph.json' },
    ]);
  }),
};

/**
 * Mock parameter Git service
 */
export const mockParamGitService = {
  getParameter: vi.fn((paramId: string) => {
    if (paramId === 'cost-param') {
      return Promise.resolve(costParam);
    }
    return Promise.resolve(conversionRateParam);
  }),

  saveParameter: vi.fn((paramId: string, param: any) => {
    return Promise.resolve({
      success: true,
      sha: 'mock-param-sha-' + Math.random().toString(36).substring(7),
    });
  }),

  listParameters: vi.fn(() => {
    return Promise.resolve([
      { id: 'conversion-rate', name: 'Landing to Signup Conversion', type: 'probability' },
      { id: 'acquisition-cost', name: 'Customer Acquisition Cost', type: 'cost_gbp' },
      { id: 'processing-time', name: 'Order Processing Time', type: 'cost_time' },
    ]);
  }),
};

/**
 * Mock registry service
 */
export const mockRegistryService = {
  getParameters: vi.fn(() => {
    return Promise.resolve([
      { id: 'conversion-rate', name: 'Landing to Signup Conversion', type: 'probability' },
      { id: 'acquisition-cost', name: 'Customer Acquisition Cost', type: 'cost_gbp' },
    ]);
  }),

  getNodes: vi.fn(() => {
    return Promise.resolve([
      { id: 'landing', name: 'Landing Page' },
      { id: 'signup', name: 'Sign Up' },
    ]);
  }),

  getCases: vi.fn(() => {
    return Promise.resolve([
      { id: 'control', name: 'Control Group' },
      { id: 'treatment', name: 'Treatment Group' },
    ]);
  }),

  getContexts: vi.fn(() => {
    return Promise.resolve([
      { id: 'mobile', name: 'Mobile Device' },
      { id: 'desktop', name: 'Desktop Device' },
    ]);
  }),

  getEvents: vi.fn(() => {
    return Promise.resolve([
      { id: 'page-view', name: 'Page View' },
      { id: 'signup', name: 'Sign Up Event' },
    ]);
  }),
};

/**
 * Setup function to mock all Git services
 */
export function setupGitServiceMocks() {
  vi.mock('../../services/gitService', () => ({
    graphGitService: mockGraphGitService,
    paramGitService: mockParamGitService,
  }));

  vi.mock('../../services/registryService', () => ({
    registryService: mockRegistryService,
  }));
}

/**
 * Reset all mock call counts
 */
export function resetGitServiceMocks() {
  Object.values(mockGraphGitService).forEach(mock => {
    if (typeof mock === 'function' && 'mockClear' in mock) {
      mock.mockClear();
    }
  });

  Object.values(mockParamGitService).forEach(mock => {
    if (typeof mock === 'function' && 'mockClear' in mock) {
      mock.mockClear();
    }
  });

  Object.values(mockRegistryService).forEach(mock => {
    if (typeof mock === 'function' && 'mockClear' in mock) {
      mock.mockClear();
    }
  });
}

