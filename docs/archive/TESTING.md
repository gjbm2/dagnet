# Testing Guide

## Overview

This project uses **Vitest** as the test runner, with React Testing Library for component tests.

## Quick Start

```bash
# Run all tests (watch mode)
npm test

# Run tests once (CI mode)
npm run test:run

# Run with UI (browser-based test viewer)
npm run test:ui

# Run with coverage report
npm run test:coverage

# Watch mode (automatically reruns on file changes)
npm run test:watch
```

## Test Structure

```
graph-editor/
├── src/
│   ├── services/
│   │   ├── UpdateManager.ts
│   │   └── UpdateManager.test.ts          # Unit tests for services
│   ├── components/
│   │   ├── GraphCanvas.tsx
│   │   └── GraphCanvas.test.tsx           # Component tests
│   ├── lib/
│   │   ├── runner.ts
│   │   └── runner.test.ts                 # Logic tests
│   └── test/
│       ├── setup.ts                       # Global test setup
│       ├── fixtures/                      # Test data
│       └── utils/                         # Test utilities
├── vitest.config.ts                       # Vitest configuration
└── TESTING.md                             # This file
```

## Test Types

### 1. Unit Tests
Test individual functions/classes in isolation.

**Example:** `UpdateManager.test.ts`
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { UpdateManager } from './UpdateManager';

describe('UpdateManager', () => {
  let manager: UpdateManager;
  
  beforeEach(() => {
    manager = new UpdateManager();
  });
  
  it('should respect override flags', async () => {
    const result = await manager.handleFileToGraph(...);
    expect(result.conflicts).toHaveLength(1);
  });
});
```

### 2. Integration Tests
Test multiple components working together.

**Example:** Complete data flow tests
```typescript
it('should sync parameter file to graph edge', async () => {
  const paramFile = loadFixture('parameter-example.yaml');
  const graphEdge = { /* ... */ };
  
  const result = await updateManager.handleFileToGraph(
    paramFile,
    graphEdge,
    'UPDATE',
    'parameter'
  );
  
  expect(result.success).toBe(true);
  expect(graphEdge.p.mean).toBe(paramFile.values[0].mean);
});
```

### 3. Component Tests
Test React components with user interactions.

```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { PropertiesPanel } from './PropertiesPanel';

describe('PropertiesPanel', () => {
  it('should show override indicators', () => {
    render(<PropertiesPanel node={nodeWithOverrides} />);
    
    expect(screen.getByTestId('override-icon')).toBeInTheDocument();
  });
});
```

## Configuration

### vitest.config.ts
- **Environment:** jsdom (for DOM APIs)
- **Globals:** true (no need to import `describe`, `it`, etc.)
- **Setup:** Runs `src/test/setup.ts` before each test file
- **Coverage:** V8 provider with text/json/html/lcov reporters

### src/test/setup.ts
Global mocks for:
- `window.matchMedia`
- `ResizeObserver`
- `IntersectionObserver`

## Best Practices

### 1. Test File Naming
- Unit tests: `*.test.ts` or `*.test.tsx`
- Integration tests: `*.integration.test.ts`
- E2E tests: `*.e2e.test.ts`

### 2. Test Organization
```typescript
describe('ComponentName', () => {
  describe('Feature Group', () => {
    it('should do specific thing', () => {
      // Arrange
      const input = ...;
      
      // Act
      const result = doSomething(input);
      
      // Assert
      expect(result).toBe(expected);
    });
  });
});
```

### 3. What to Test

**✅ DO Test:**
- Business logic (UpdateManager, data transformations)
- Edge cases and error handling
- User interactions (button clicks, form submissions)
- Data flow (file → graph, external → file)
- Override flag behavior
- Validation logic

**❌ DON'T Test:**
- Third-party libraries (trust they work)
- Simple getters/setters
- Type definitions
- CSS/styling (use visual regression instead)

### 4. Mocking

**Mock external dependencies:**
```typescript
import { vi } from 'vitest';

vi.mock('./paramRegistryService', () => ({
  loadParameter: vi.fn().mockResolvedValue({ ... })
}));
```

**Mock timers:**
```typescript
vi.useFakeTimers();
vi.setSystemTime(new Date('2025-01-01'));
// ... test code ...
vi.useRealTimers();
```

### 5. Async Testing
```typescript
it('should handle async operations', async () => {
  const promise = asyncFunction();
  
  // Wait for promise to resolve
  await expect(promise).resolves.toBe(value);
  
  // Or wait for specific conditions
  await waitFor(() => {
    expect(screen.getByText('Success')).toBeInTheDocument();
  });
});
```

## Coverage Goals

- **Unit tests:** 80%+ coverage for core logic
- **Integration tests:** All critical user flows
- **E2E tests:** (Phase 2) Key scenarios

**Current Status (Phase 0.3):**
- UpdateManager: 13/22 tests passing (59%)
- Target: 100% by end of Phase 0

## CI/CD Integration

### GitHub Actions
Tests run automatically on:
- Push to `main`, `develop`, `project-data` branches
- Pull requests to `main` or `develop`

**Workflow:** `.github/workflows/test.yml`
- Matrix testing: Node 18.x and 20.x
- TypeScript type checking
- Test suite execution
- Coverage report generation
- (Optional) Codecov integration

### Pre-commit Hooks (Optional)
Install husky for pre-commit testing:
```bash
npm install --save-dev husky lint-staged
npx husky install
```

Add to `package.json`:
```json
{
  "lint-staged": {
    "*.{ts,tsx}": ["npm run test:run --related"]
  }
}
```

## Debugging Tests

### VS Code
Add to `.vscode/launch.json`:
```json
{
  "type": "node",
  "request": "launch",
  "name": "Debug Current Test",
  "runtimeExecutable": "npm",
  "runtimeArgs": ["run", "test:run", "--", "${relativeFile}"],
  "console": "integratedTerminal"
}
```

### Vitest UI
```bash
npm run test:ui
```
Opens browser with interactive test viewer.

### Console Logging
```typescript
it('debug test', () => {
  console.log('Debug:', value);  // Shows in terminal
  expect(value).toBe(expected);
});
```

## Troubleshooting

### "Cannot find module" errors
- Check `vitest.config.ts` alias configuration
- Ensure imports use correct paths

### "ReferenceError: X is not defined"
- Add global mock to `src/test/setup.ts`
- Or import from 'vitest': `import { vi } from 'vitest'`

### Tests hang indefinitely
- Check for unclosed promises
- Use `--reporter=verbose` to see which test is stuck
- Add timeout: `it('test', { timeout: 5000 }, () => { ... })`

### Coverage not generated
- Install coverage provider: `npm install --save-dev @vitest/coverage-v8`
- Check `vitest.config.ts` coverage settings

## Resources

- [Vitest Docs](https://vitest.dev/)
- [Testing Library](https://testing-library.com/)
- [React Testing Library](https://testing-library.com/react)
- [Vitest UI](https://vitest.dev/guide/ui.html)

---

**Updated:** 2025-11-05  
**Phase:** 0.3 - Testing Infrastructure Complete

