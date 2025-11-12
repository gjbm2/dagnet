# Testing Strategy

## Test Pyramid

```
        /\
       /E2E\        ← Real credentials, real Git, slow (5-10 tests)
      /------\
     /  INT   \     ← Mocked Git, fast (50-100 tests)
    /----------\
   /    UNIT    \   ← Pure functions, very fast (100s of tests)
  /--------------\
```

## Test Types

### 1. Unit Tests
- **What**: Test individual functions/classes in isolation
- **Mocking**: All external dependencies mocked
- **Speed**: Very fast (< 1ms per test)
- **Location**: `*.test.ts` files next to source
- **Example**: `UpdateManager.test.ts`

### 2. Integration Tests
- **What**: Test component interactions, UI workflows
- **Mocking**: Mock external services (Git, IndexedDB, Network)
- **Speed**: Fast (10-100ms per test)
- **Location**: `**/*.integration.test.tsx`
- **Git Strategy**: **MOCK all Git operations**
- **Example**: `GraphCanvas.integration.test.tsx`

### 3. End-to-End Tests
- **What**: Test complete user workflows with real backend
- **Mocking**: NO mocking - use real services
- **Speed**: Slow (1-10s per test)
- **Location**: `**/*.e2e.test.tsx`
- **Git Strategy**: **REAL Git operations with credentials**
- **Example**: `FullWorkflow.e2e.test.tsx`

---

## Git/Repository Testing Strategy

### Integration Tests: MOCK Git Operations

**Why Mock?**
- ✅ Tests run fast (no network calls)
- ✅ Tests are reliable (no network failures)
- ✅ Tests are reproducible (no external state)
- ✅ No credentials needed (security)
- ✅ Can test error scenarios easily
- ✅ CI/CD friendly (runs anywhere)

**How to Mock:**

```typescript
// Mock the Git service
vi.mock('../../services/gitService', () => ({
  graphGitService: {
    getGraph: vi.fn(() => Promise.resolve(mockGraphData)),
    saveGraph: vi.fn(() => Promise.resolve({ success: true })),
    getFileContent: vi.fn(() => Promise.resolve('mock content')),
    commitFiles: vi.fn(() => Promise.resolve({ sha: 'abc123' })),
  },
  paramGitService: {
    getParameter: vi.fn(() => Promise.resolve(mockParamData)),
    saveParameter: vi.fn(() => Promise.resolve({ success: true })),
  },
}));
```

**Test Data Fixtures:**
- Store mock data in `src/test/fixtures/`
- Use realistic data based on actual repo files
- Version control fixtures for reproducibility

```typescript
// src/test/fixtures/graphs/sample-graph.json
export const sampleGraph = {
  nodes: [
    { id: 'landing', label: 'Landing Page', position: { x: 0, y: 0 } },
    { id: 'signup', label: 'Sign Up', position: { x: 200, y: 0 } }
  ],
  edges: [
    { id: 'e1', from: 'landing', to: 'signup', p: { mean: 0.75 } }
  ],
  metadata: {
    name: 'Sample Conversion Funnel',
    version: '1.0.0',
    created: '2025-01-01T00:00:00Z'
  }
};
```

### E2E Tests: REAL Git Operations

**Why Real?**
- ✅ Verifies actual Git integration works
- ✅ Tests authentication flow
- ✅ Catches Git-specific bugs
- ✅ Validates schema compatibility

**Credentials Strategy:**

```typescript
// E2E tests use environment variables
const credentials = {
  token: process.env.GITHUB_TEST_TOKEN,
  owner: process.env.GITHUB_TEST_OWNER || 'your-org',
  repo: process.env.GITHUB_TEST_REPO || 'dagnet-test-data'
};

// Skip E2E tests if no credentials
describe('E2E: Full Workflow', () => {
  beforeAll(() => {
    if (!process.env.GITHUB_TEST_TOKEN) {
      console.warn('Skipping E2E tests: No GITHUB_TEST_TOKEN provided');
      return;
    }
  });
  
  it('should load graph from real repository', async () => {
    if (!process.env.GITHUB_TEST_TOKEN) {
      return; // Skip
    }
    
    const graph = await graphGitService.getGraph('test-graph', 'main', credentials);
    expect(graph).toBeDefined();
    expect(graph.nodes.length).toBeGreaterThan(0);
  });
});
```

**CI/CD Setup:**
```yaml
# .github/workflows/test.yml
env:
  GITHUB_TEST_TOKEN: ${{ secrets.GITHUB_TEST_TOKEN }}
  GITHUB_TEST_OWNER: "your-org"
  GITHUB_TEST_REPO: "dagnet-test-data"
```

---

## Recommended Approach

### For Integration Tests (Current PR)
1. ✅ **Mock all Git operations**
2. ✅ Use fixtures for test data
3. ✅ Fast, reliable, no credentials needed

### For E2E Tests (Separate PR)
1. ⏳ Create dedicated E2E test suite
2. ⏳ Use test repository with sample data
3. ⏳ Configure credentials via environment variables
4. ⏳ Run separately from main test suite

---

## File Structure

```
graph-editor/
├── src/
│   ├── test/
│   │   ├── setup.ts                    # Global test setup
│   │   ├── fixtures/                   # Mock data
│   │   │   ├── graphs/
│   │   │   │   ├── sample-graph.json
│   │   │   │   └── complex-graph.json
│   │   │   ├── parameters/
│   │   │   │   ├── conversion-rate.yaml
│   │   │   │   └── cost-metric.yaml
│   │   │   ├── nodes/
│   │   │   └── cases/
│   │   └── mocks/                      # Service mocks
│   │       ├── gitService.mock.ts
│   │       └── indexedDB.mock.ts
│   ├── components/
│   │   └── __tests__/
│   │       ├── *.test.tsx              # Unit tests
│   │       ├── *.integration.test.tsx  # Integration tests (mocked)
│   │       └── *.e2e.test.tsx          # E2E tests (real services)
│   └── services/
│       └── __tests__/
│           ├── *.test.ts               # Unit tests
│           └── *.integration.test.ts   # Integration tests (mocked)
```

---

## Test Commands

```bash
# Run unit tests only
npm test -- **/*.test.ts

# Run integration tests (fast, mocked)
npm run test:integration

# Run E2E tests (slow, real services)
npm run test:e2e

# Run all tests
npm test
```

---

## Example: Integration Test with Mocked Git

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GraphEditor } from '../GraphEditor';
import { sampleGraph } from '../../test/fixtures/graphs/sample-graph';

// Mock Git service
vi.mock('../../services/gitService', () => ({
  graphGitService: {
    getGraph: vi.fn(() => Promise.resolve(sampleGraph)),
    saveGraph: vi.fn(() => Promise.resolve({ success: true })),
  },
}));

describe('GraphEditor - Load and Save', () => {
  it('should load graph from repository', async () => {
    render(<GraphEditor fileId="sample-graph" />);
    
    await waitFor(() => {
      expect(screen.getByText('Landing Page')).toBeInTheDocument();
      expect(screen.getByText('Sign Up')).toBeInTheDocument();
    });
    
    // Verify mock was called
    expect(graphGitService.getGraph).toHaveBeenCalledWith('sample-graph', 'main');
  });
  
  it('should save graph to repository', async () => {
    const user = userEvent.setup();
    render(<GraphEditor fileId="sample-graph" />);
    
    // Make a change
    await user.click(screen.getByText('Landing Page'));
    await user.type(screen.getByLabelText('Label'), ' Updated');
    
    // Save
    await user.keyboard('{Control>}s{/Control}');
    
    await waitFor(() => {
      expect(graphGitService.saveGraph).toHaveBeenCalled();
    });
  });
});
```

---

## Example: E2E Test with Real Git

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { graphGitService } from '../../services/gitService';

const E2E_ENABLED = !!process.env.GITHUB_TEST_TOKEN;

describe.skipIf(!E2E_ENABLED)('E2E: Repository Operations', () => {
  const credentials = {
    token: process.env.GITHUB_TEST_TOKEN!,
    owner: process.env.GITHUB_TEST_OWNER || 'dagnet-org',
    repo: process.env.GITHUB_TEST_REPO || 'dagnet-test-data',
  };
  
  it('should load real graph from dagnet repository', async () => {
    const graph = await graphGitService.getGraph(
      'graphs/test-graph.json',
      'main',
      credentials
    );
    
    expect(graph).toBeDefined();
    expect(graph.nodes).toBeInstanceOf(Array);
    expect(graph.edges).toBeInstanceOf(Array);
    expect(graph.metadata.name).toBe('Test Graph');
  }, 10000); // 10s timeout for network
  
  it('should load real parameter from dagnet repository', async () => {
    const param = await paramGitService.getParameter(
      'parameters/conversion-rate.yaml',
      'main',
      credentials
    );
    
    expect(param).toBeDefined();
    expect(param.type).toBe('probability');
    expect(param.values).toBeInstanceOf(Array);
  }, 10000);
});
```

---

## Summary

| Aspect | Integration Tests | E2E Tests |
|--------|------------------|-----------|
| **Git Operations** | Mocked | Real |
| **Test Data** | Fixtures | Real repo |
| **Credentials** | Not needed | Required |
| **Speed** | Fast (ms) | Slow (seconds) |
| **Reliability** | High | Medium (network) |
| **When to Run** | Every commit | Before release |
| **Coverage** | Broad (100s) | Critical paths (10s) |

**Current Task**: Focus on integration tests with mocked Git for fast, reliable CI/CD.
**Future Task**: Add E2E tests for pre-release validation with real credentials.

