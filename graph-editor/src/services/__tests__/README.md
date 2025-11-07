# Data Operations Test Suite

This directory contains comprehensive integration and unit tests for the data operations layer, specifically testing the roundtrip flows between graph entities and file registry.

## Overview

These tests were created to catch the types of bugs that manual testing revealed during Phase 1B development, including:

- **Bouncing selectors** (values reverting after being set)
- **Connection ID loss** (`p.id`, `node.id`, `case.id` being stripped)
- **Array append issues** (literal `values[]` keys, duplicate writes)
- **Timestamp resolution** (`values[latest]` using array order instead of timestamps)
- **Provenance tracking** (missing `data_source`, stale `n`/`k` evidence)

## Test Files

### `dataOperations.integration.test.ts`
**Full roundtrip integration tests**

Tests complete Get → Put → Get cycles for all entity types:
- Probability parameters
- Cost parameters (GBP & Time)
- Multi-parameter edges
- Nodes
- Cases

**Key scenarios:**
- Data survives roundtrips without corruption
- IDs are preserved through operations
- Multi-parameter edges don't cross-contaminate
- `values[latest]` retrieves correct data after manual edits
- Error handling for missing files/entities

### `arrayAppend.test.ts`
**Array append operations** (`values[]`, `schedules[]`)

Tests that the `values[]` syntax works correctly:
- Does not create literal `values[]` keys
- Correctly pushes to arrays
- Handles nested paths (`case.schedules[]`)
- `validateOnly` mode prevents duplicate writes

### `idPreservation.test.ts`
**Connection ID preservation**

Tests that connection IDs survive file operations:
- `p.id` preserved after File→Graph updates
- `cost_gbp.id` and `cost_time.id` preserved separately
- `node.id` preserved through multiple updates
- `node.case.id` preserved alongside `node.id`
- IDs survive even when objects are replaced

### `provenance.test.ts`
**Provenance tracking**

Tests that manual edits are properly tagged:
- `data_source: { type: 'manual', edited_at: ... }` added
- Stale evidence (`n`, `k`, `window_to`) NOT included
- `window_from` timestamp added for all manual edits
- Only actually-set fields are written
- Case schedules include `source: 'manual'`

### `valuesLatest.test.ts`
**`values[latest]` timestamp resolution**

Tests that "latest" is determined by `window_from`, not array order:
- Out-of-order timestamps handled correctly
- Missing/invalid timestamps treated as epoch
- After `put`, new entry becomes latest
- Multiple puts create correct history
- Cost parameters use same logic
- Case `schedules[latest]` resolution

## Running Tests

```bash
# Run all data operations tests
npm test -- src/services/__tests__

# Run a specific test file
npm test -- src/services/__tests__/dataOperations.integration.test.ts

# Run in watch mode
npm test -- --watch src/services/__tests__

# Run with coverage
npm test -- --coverage src/services/__tests__
```

## Test Helpers

### `helpers/testFixtures.ts`
Factory functions for creating test data:

```typescript
// Create test entities
const edge = createTestEdge({ p: { mean: 0.45 } });
const node = createTestNode({ id: 'test-node' });
const paramFile = createTestParameterFile({ id: 'my-param' });
const caseFile = createTestCaseFile({ case: { id: 'my-case' } });

// Create test graphs
const graph = createTestGraph({
  nodes: [...],
  edges: [...]
});

// Create history
const paramWithHistory = createParameterFileWithHistory('param-id', [
  { mean: 0.42, window_from: '2025-01-01T00:00:00Z' },
  { mean: 0.45, window_from: '2025-02-01T00:00:00Z' }
]);
```

## Test Strategy

### What These Tests Cover

1. **Roundtrip Integrity**: Data survives Graph→File→Graph without loss
2. **Connection Preservation**: IDs stay attached through operations
3. **Provenance Correctness**: Manual edits tagged, evidence not leaked
4. **Timestamp Logic**: `values[latest]` resolves by time, not position
5. **Error Handling**: Missing files/entities handled gracefully
6. **Type Safety**: Probability, cost_gbp, cost_time kept separate

### What These Tests Don't Cover

- **UI interactions** (PropertiesPanel, EnhancedSelector) - UI component tests
- **ReactFlow sync** (transform.ts, GraphCanvas) - separate test file
- **FileRegistry IndexedDB** - separate persistence tests
- **UpdateManager mapping configuration** - covered by existing UpdateManager tests
- **Concurrent operations** (race conditions, lock contention)

## Common Test Patterns

### Testing Roundtrips

```typescript
test('roundtrip preserves data', async () => {
  // Setup
  const edge = createTestEdge({ p: { mean: 0.45 } });
  const file = createTestParameterFile({ id: 'test' });
  const graph = createTestGraph({ edges: [edge] });
  const setGraph = jest.fn();
  
  // Put to file
  await dataOperationsService.putParameterToFile({
    paramId: 'test',
    edgeId: edge.uuid,
    graph,
    setGraph
  });
  
  // Verify file was updated
  const updatedFile = fileRegistry.getFile('parameter-test');
  expect(updatedFile.data.values[latest].mean).toBe(0.45);
  
  // Get back from file
  edge.p.id = 'test';
  await dataOperationsService.getParameterFromFile({
    paramId: 'test',
    edgeId: edge.uuid,
    graph: createTestGraph({ edges: [edge] }),
    setGraph
  });
  
  // Verify graph was updated
  const updatedGraph = setGraph.mock.calls[setGraph.mock.calls.length - 1][0];
  const updatedEdge = updatedGraph.edges.find(e => e.uuid === edge.uuid);
  expect(updatedEdge.p.mean).toBe(0.45);
  expect(updatedEdge.p.id).toBe('test');  // ID preserved!
});
```

### Testing ID Preservation

```typescript
test('ID preserved after update', async () => {
  const edge = createTestEdge({
    p: { id: 'my-param', mean: 0.40 }
  });
  const file = createTestParameterFile({
    id: 'my-param',
    values: [{ mean: 0.45 }]
  });
  
  const result = await updateManager.handleFileToGraph(
    file, edge, 'UPDATE', 'parameter'
  );
  
  const updated = structuredClone(edge);
  applyChanges(updated, result.changes);
  
  // Preservation step (as in dataOperationsService)
  if (!updated.p.id) updated.p.id = 'my-param';
  
  expect(updated.p.id).toBe('my-param');
  expect(updated.p.mean).toBe(0.45);
});
```

### Testing Provenance

```typescript
test('manual edit includes provenance', async () => {
  const edge = createTestEdge({ p: { mean: 0.45 } });
  const file = createTestParameterFile({ values: [] });
  
  const result = await updateManager.handleGraphToFile(
    edge, file, 'APPEND', 'parameter', { validateOnly: true }
  );
  
  expect(result.changes[0].newValue).toMatchObject({
    mean: 0.45,
    window_from: expect.any(String),
    data_source: {
      type: 'manual',
      edited_at: expect.any(String)
    }
  });
  
  // Stale evidence NOT included
  expect(result.changes[0].newValue).not.toHaveProperty('n');
  expect(result.changes[0].newValue).not.toHaveProperty('k');
});
```

## Debugging Failed Tests

### Common Issues

1. **"Expected 0.45, received 0.42"**
   - Check if `values[latest]` is resolving correctly
   - Verify timestamps are in descending order after sort
   - Ensure test delays exist for timestamp differences

2. **"p.id is undefined"**
   - Check if preservation step is included in test
   - Verify `applyChanges` is called before checking ID
   - Ensure ID was set before calling get/put

3. **"values[] key exists in file"**
   - `applyChanges` not handling `[]` syntax correctly
   - UpdateManager `validateOnly` not being used
   - Duplicate application of changes

4. **"Expected manual, received undefined"**
   - Check UpdateManager APPEND mapping for `data_source`
   - Verify `validateOnly: true` is passed
   - Ensure timestamp transform is included

## Maintenance

When adding new entity types or operations:

1. Add factory to `testFixtures.ts`
2. Create integration test in `dataOperations.integration.test.ts`
3. Add ID preservation test if applicable
4. Add provenance test for PUT operations
5. Update this README

When fixing bugs:

1. Write a failing test that reproduces the bug
2. Fix the bug
3. Verify test passes
4. Add similar test variants if needed


