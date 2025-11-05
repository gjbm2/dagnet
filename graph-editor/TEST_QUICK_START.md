# Testing Quick Start

## Run Tests

```bash
# Watch mode (recommended for development)
npm test

# Run once (CI mode)
npm run test:run

# With UI (browser-based)
npm run test:ui

# With coverage
npm run test:coverage
```

## Write a Test

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

describe('MyComponent', () => {
  it('should do something', () => {
    const result = myFunction(input);
    expect(result).toBe(expected);
  });
});
```

## Test File Location

Place test files next to the code they test:
```
src/
  services/
    UpdateManager.ts
    UpdateManager.test.ts  ← Test file here
```

## Common Assertions

```typescript
// Equality
expect(value).toBe(5);
expect(value).toEqual({ a: 1 });

// Truthiness
expect(value).toBeTruthy();
expect(value).toBeFalsy();

// Arrays/Objects
expect(array).toHaveLength(3);
expect(obj).toHaveProperty('key');

// Async
await expect(promise).resolves.toBe(value);
await expect(promise).rejects.toThrow();
```

## Mocking

```typescript
import { vi } from 'vitest';

// Mock function
const mockFn = vi.fn().mockReturnValue(42);

// Mock module
vi.mock('./module', () => ({
  export: vi.fn()
}));
```

## CI/CD

Tests run automatically on push to:
- `main`
- `develop`
- `project-data`

Check GitHub Actions tab for results.

---

See [TESTING.md](./TESTING.md) for complete guide.

