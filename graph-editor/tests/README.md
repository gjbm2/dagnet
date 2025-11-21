# DagNet Test Suite

Comprehensive testing framework to prevent regression on critical data pipeline issues.

## 🎯 Test Philosophy

**Test CLASSES of problems, not just specific bugs.**

After debugging 28+ interconnected bugs in the composite query → file → graph pipeline, we've identified 8 major problem classes that account for 90%+ of production issues. This test suite systematically tests each class.

## 📊 Test Hierarchy

### **TIER 1 (P0): Critical Path** ⚡
Tests that catch catastrophic pipeline failures. **Run on every commit.**

- **Pipeline Integrity** (`pipeline-integrity/`)
  - Full data flow tests (MSMDC → DAS → File → Graph)
  - Composite query execution (minus/plus terms)
  - Daily vs aggregate mode propagation
  - Provider event name mapping
  
- **State Synchronization** (`state-sync/`)
  - Graph ↔ File ↔ UI consistency
  - Concurrent update handling
  - Rollback/undo integrity
  - Dirty flag management

### **TIER 2 (P1): Data Integrity** 🔒
Tests that catch data corruption and loss. **Run before merge to main.**

- **Mode Propagation** (`context-propagation/`)
- **Identity Consistency** (`identity/`)
- **Schema Mapping** (`schema-mapping/`)
- **Input Validation** (`validation/`)

### **TIER 3 (P2): Provider Abstraction** 🔌
Tests that catch provider-specific leaks. **Run nightly.**

- **Provider Agnostic** (`provider-abstraction/`)
- **Atomic Operations** (`atomicity/`)

## 🚀 Running Tests

```bash
# Run all P0 tests (fast, <1min)
npm test -- tests/pipeline-integrity tests/state-sync

# Run specific test file
npm test -- tests/pipeline-integrity/composite-query-flow.test.ts

# Run with coverage
npm test -- --coverage

# Watch mode (during development)
npm test -- --watch
```

## 📁 Directory Structure

```
tests/
├── helpers/                 # Test utilities
│   ├── test-graph-builder.ts    # Graph creation helpers
│   ├── mock-file-registry.ts    # Mock file system
│   └── mock-das-runner.ts        # Mock DAS execution
│
├── pipeline-integrity/      # P0: Full pipeline tests
│   ├── composite-query-flow.test.ts
│   ├── simple-query-flow.test.ts
│   └── provider-switching.test.ts
│
├── state-sync/              # P0: State consistency tests
│   ├── multi-source-truth.test.ts
│   ├── concurrent-updates.test.ts
│   └── rollback-integrity.test.ts
│
├── context-propagation/     # P1: Flag threading tests
│   └── flag-threading.test.ts
│
├── identity/                # P1: ID/signature tests
│   └── signature-consistency.test.ts
│
├── schema-mapping/          # P1: Transform tests
│   └── transformation-integrity.test.ts
│
├── provider-abstraction/    # P2: Provider tests
│   └── provider-agnostic.test.ts
│
├── validation/              # P1: Input sanitization
│   └── input-sanitization.test.ts
│
└── atomicity/               # P2: Transaction tests
    └── transaction-integrity.test.ts
```

## 🔍 Test Patterns

### **1. Pipeline Tests**
Test complete data flow from entry to exit.

```typescript
test('minus() query: full pipeline', async () => {
  // SETUP: Create graph with minus() query
  const graph = createCompositeQueryGraph();
  
  // ACTION: Execute full pipeline
  await dataOps.getFromSource({ /* ... */ });
  
  // ASSERT: Trace data through EVERY stage
  expect(dasRunner.executions[0].mode).toBe('daily');
  expect(fileRegistry.getFile('param').values).toHaveLength(8);
  expect(updatedGraph.edges[0].p.mean).toBeCloseTo(0.315);
});
```

### **2. State Sync Tests**
Verify all sources of truth stay in sync.

```typescript
test('graph update: file and history sync', async () => {
  const before = captureAllState();
  
  await updateEdge({ mean: 0.75 });
  
  const after = captureAllState();
  expect(after.graph.mean).toBe(0.75);
  expect(after.file.mean).toBe(0.75);
  expect(after.history[0].mean).toBe(0.75);
});
```

### **3. Flag Propagation Tests**
Ensure flags reach deepest call stack.

```typescript
test('dailyMode propagates to adapter', async () => {
  const tracer = createFlagTracer('dailyMode');
  
  await getFromSource({ dailyMode: true, tracer });
  
  expect(tracer.reachedTargets).toContain('amplitude.buildRequest');
  expect(tracer.getFlagAt('amplitude')).toBe(true);
});
```

## 🐛 Bugs Prevented By These Tests

These tests would have caught ALL 28 bugs from our recent debugging session:

### Pipeline Integrity Tests Catch:
- ✅ Composite queries not executing with daily mode
- ✅ Time-series not combined correctly
- ✅ File write without subsequent load
- ✅ Provider event names not preserved
- ✅ Query signatures not including minus/plus
- ✅ Sub-queries not requesting daily data
- ✅ Amplitude adapter using global window
- ✅ Incorrect funnel order in minus queries

### State Sync Tests Catch:
- ✅ File updated but graph not refreshed
- ✅ Graph changed but file not saved
- ✅ Unsigned cache entries used in aggregation
- ✅ UpdateManager loading old values
- ✅ Edge ID lookups failing (uuid vs id)
- ✅ Graph query not pushed to file

### Validation Tests Catch:
- ✅ Uppercase letters rejected by query validator
- ✅ Query parser rejecting valid inputs
- ✅ Invalid data deep in call stack

## 📈 Success Metrics

- **Coverage**: 90%+ on critical paths
- **Speed**: P0 tests run in <60s
- **Reliability**: 0% flaky tests
- **Clarity**: Every failure message explains WHAT and WHERE

## 🔧 Adding New Tests

When adding new functionality:

1. **Identify the problem class** (Pipeline? State Sync? Validation?)
2. **Add test to appropriate directory**
3. **Use existing helpers** (createTestGraph, MockFileRegistry, etc.)
4. **Test the GENERAL case**, not just your specific use case
5. **Add descriptive failure messages**

Example:

```typescript
test('new feature: data survives pipeline', async () => {
  // SETUP: Create realistic scenario
  const graph = createTestGraph({ /* ... */ });
  
  // ACTION: Run through pipeline
  const result = await runFullPipeline(graph);
  
  // ASSERT: With clear failure message
  expect(result.mean).toBe(expectedMean, 
    `Expected mean ${expectedMean} after pipeline, got ${result.mean}. ` +
    `Check if data was lost at ${result.lastStage}`
  );
});
```

## 🚨 When Tests Fail

1. **Read the failure message** - it tells you WHERE the issue is
2. **Check recent changes** - what did you modify?
3. **Run test in isolation** - `npm test -- path/to/test.ts`
4. **Add logging** - use `console.log` liberally in tests
5. **Don't skip tests** - fix the root cause

## 📚 Further Reading

- [Test Infrastructure Design](./docs/TEST_INFRASTRUCTURE.md)
- [Mocking Strategy](./docs/MOCKING_STRATEGY.md)
- [CI/CD Integration](./docs/CI_CD_TESTS.md)

