# Test Infrastructure

## Overview

This directory contains shared test utilities, fixtures, and mocks.

## Structure

```
test/
├── setup.ts                 # Global Vitest setup (runs before all tests)
├── fixtures/                # Mock test data
│   ├── graphs/             # Graph fixtures
│   ├── parameters/         # Parameter fixtures
│   ├── nodes/              # Node fixtures
│   ├── cases/              # Case fixtures
│   └── index.ts            # Export all fixtures
├── mocks/                  # Service mocks
│   ├── gitService.mock.ts  # Git operations mock
│   └── index.ts            # Export all mocks
└── README.md               # This file
```

## Usage

### Using Fixtures in Tests

```typescript
import { sampleGraph, conversionRateParam } from '../../test/fixtures';

it('should load graph data', () => {
  const graph = sampleGraph;
  expect(graph.nodes.length).toBe(3);
});
```

### Using Mocks in Tests

```typescript
import { mockGraphGitService, resetGitServiceMocks } from '../../test/mocks';

// Mock at module level
vi.mock('../../services/gitService', () => ({
  graphGitService: mockGraphGitService,
}));

describe('My Test Suite', () => {
  beforeEach(() => {
    resetGitServiceMocks(); // Clear call history
  });

  it('should call Git service', async () => {
    await loadGraph('sample-graph');
    expect(mockGraphGitService.getGraph).toHaveBeenCalledWith('sample-graph');
  });
});
```

## Best Practices

1. **Fixtures are read-only** - Don't mutate fixtures in tests; clone them if needed
2. **Reset mocks** - Always reset mocks in `beforeEach` to avoid test pollution
3. **Realistic data** - Fixtures should match real data structure and values
4. **Version control** - All fixtures are committed to Git for reproducibility

## Adding New Fixtures

1. Create file in appropriate subdirectory (e.g., `fixtures/graphs/my-graph.ts`)
2. Export data as named export
3. Add to `fixtures/index.ts` if commonly used
4. Document any special properties or use cases

## Adding New Mocks

1. Create mock in `mocks/` directory
2. Follow naming convention: `serviceName.mock.ts`
3. Export mock functions with `vi.fn()`
4. Add reset function for cleanup
5. Export from `mocks/index.ts`

