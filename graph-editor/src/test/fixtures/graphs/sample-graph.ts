/**
 * Sample Graph Fixture
 * 
 * Realistic graph data for integration tests
 */

export const sampleGraph = {
  nodes: [
    {
      id: 'landing',
      label: 'Landing Page',
      position: { x: 100, y: 100 },
      color: '#3B82F6',
      description: 'Initial landing page for users',
    },
    {
      id: 'signup',
      label: 'Sign Up',
      position: { x: 400, y: 100 },
      color: '#10B981',
      description: 'User registration page',
    },
    {
      id: 'activation',
      label: 'Email Activation',
      position: { x: 700, y: 100 },
      color: '#F59E0B',
      description: 'Email verification step',
    },
  ],
  edges: [
    {
      id: 'edge-1',
      from: 'landing',
      to: 'signup',
      p: { mean: 0.75, stdev: 0.05 },
      label: 'Conversion',
      parameter: 'conversion-rate',
    },
    {
      id: 'edge-2',
      from: 'signup',
      to: 'activation',
      p: { mean: 0.90, stdev: 0.03 },
      label: 'Activation',
      parameter: 'activation-rate',
    },
  ],
  metadata: {
    name: 'Sample Conversion Funnel',
    description: 'Basic user conversion flow',
    version: '1.0.0',
    created: '2025-01-01T00:00:00Z',
    updated: '2025-01-15T00:00:00Z',
  },
};

export const emptyGraph = {
  nodes: [],
  edges: [],
  metadata: {
    name: 'Empty Graph',
    version: '1.0.0',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  },
};

export const complexGraph = {
  nodes: [
    { id: 'start', label: 'Start', position: { x: 0, y: 200 } },
    { id: 'step1', label: 'Step 1', position: { x: 200, y: 100 } },
    { id: 'step2', label: 'Step 2', position: { x: 200, y: 300 } },
    { id: 'step3', label: 'Step 3', position: { x: 400, y: 200 } },
    { id: 'end', label: 'End', position: { x: 600, y: 200 } },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'step1', p: { mean: 0.6 } },
    { id: 'e2', from: 'start', to: 'step2', p: { mean: 0.4 } },
    { id: 'e3', from: 'step1', to: 'step3', p: { mean: 0.8 } },
    { id: 'e4', from: 'step2', to: 'step3', p: { mean: 0.7 } },
    { id: 'e5', from: 'step3', to: 'end', p: { mean: 0.9 } },
  ],
  metadata: {
    name: 'Complex Multi-Path Graph',
    version: '1.0.0',
    created: '2025-01-01T00:00:00Z',
    updated: '2025-01-15T00:00:00Z',
  },
};

