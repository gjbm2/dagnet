# Integration Testing Guide

## What Are Integration Tests?

**Component Integration Tests** (also called **UI Integration Tests**) are tests that:

1. ✅ **Run in a virtual DOM** (jsdom) - no browser needed
2. ✅ **Render real React components** - full component tree
3. ✅ **Simulate real user interactions** - clicks, drags, typing
4. ✅ **Test component interactions** - how components work together
5. ✅ **Detect infinite loops** - by monitoring render counts
6. ✅ **Verify state management** - ensure state flows correctly

## Tools You Already Have

Your project is already set up with all the necessary tools:

| Tool | Purpose | Status |
|------|---------|--------|
| `@testing-library/react` | Renders components in virtual DOM | ✅ Installed |
| `@testing-library/user-event` | Simulates user interactions | ✅ Installed |
| `jsdom` | Virtual DOM environment | ✅ Configured |
| `vitest` | Test runner | ✅ Configured |

## Example Test File

See `src/components/__tests__/GraphCanvas.integration.test.tsx` for a complete example.

## Test Patterns

### 1. Basic Component Rendering

```typescript
it('should render without errors', () => {
  render(<MyComponent />);
  expect(screen.getByTestId('my-component')).toBeInTheDocument();
});
```

### 2. User Interactions

```typescript
it('should handle user clicks', async () => {
  const user = userEvent.setup();
  render(<Button onClick={handleClick}>Click me</Button>);
  
  await user.click(screen.getByText('Click me'));
  expect(handleClick).toHaveBeenCalled();
});
```

### 3. Detecting Infinite Loops

```typescript
it('should not cause infinite re-renders', async () => {
  const renderCount = vi.fn();
  render(<MyComponent onRender={renderCount} />);
  
  // Perform action that might cause loops
  await user.click(screen.getByText('Update'));
  
  // Wait a bit
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Verify reasonable render count (not hundreds)
  expect(renderCount.mock.calls.length).toBeLessThan(10);
});
```

### 4. Testing Component Interactions

```typescript
it('should sync state between components', async () => {
  render(
    <Provider>
      <ComponentA />
      <ComponentB />
    </Provider>
  );
  
  // Action in ComponentA
  await user.click(screen.getByTestId('component-a-button'));
  
  // Verify ComponentB updated
  await waitFor(() => {
    expect(screen.getByTestId('component-b-value')).toHaveTextContent('updated');
  });
});
```

### 5. Testing Graph Operations

```typescript
it('should add nodes without errors', async () => {
  render(<GraphCanvas />);
  
  // Wait for component to expose function via ref
  await waitFor(() => {
    expect(addNodeRef.current).toBeDefined();
  });
  
  // Call the function
  addNodeRef.current();
  
  // Verify graph updated
  await waitFor(() => {
    expect(graphStore.setGraph).toHaveBeenCalled();
    const newGraph = graphStore.setGraph.mock.calls[0][0];
    expect(newGraph.nodes.length).toBeGreaterThan(0);
  });
});
```

## What to Test

### ✅ DO Test:

- **User interaction flows** - clicking, dragging, typing
- **Component communication** - props, callbacks, context
- **State synchronization** - between components
- **Edge cases** - empty states, rapid operations
- **Error handling** - graceful failures
- **Render performance** - no infinite loops

### ❌ DON'T Test:

- **Implementation details** - internal state, private methods
- **Third-party libraries** - ReactFlow, Monaco, etc. (mock them)
- **Visual appearance** - use visual regression tests instead
- **Network requests** - mock external APIs

## Running Integration Tests

```bash
# Run all integration tests
npm test -- **/*.integration.test.tsx

# Run specific test file
npm test -- src/components/__tests__/GraphCanvas.integration.test.tsx

# Run in watch mode
npm test -- --watch **/*.integration.test.tsx

# Run with coverage
npm test -- --coverage **/*.integration.test.tsx
```

## Common Patterns

### Mocking Complex Dependencies

```typescript
// Mock ReactFlow (requires canvas/DOM)
vi.mock('reactflow', () => ({
  ReactFlow: ({ children, ...props }) => (
    <div data-testid="reactflow">{children}</div>
  ),
  // ... other mocks
}));
```

### Testing Async Operations

```typescript
it('should handle async updates', async () => {
  render(<AsyncComponent />);
  
  // Trigger async action
  await user.click(screen.getByText('Load'));
  
  // Wait for async update
  await waitFor(() => {
    expect(screen.getByText('Loaded')).toBeInTheDocument();
  });
});
```

### Testing Context Providers

```typescript
const TestWrapper = ({ children }) => (
  <GraphStoreProvider value={mockStore}>
    <TabContextProvider value={mockTabs}>
      {children}
    </TabContextProvider>
  </GraphStoreProvider>
);

it('should use context values', () => {
  render(
    <TestWrapper>
      <MyComponent />
    </TestWrapper>
  );
  // Test component that uses context
});
```

## Best Practices

1. **Use `data-testid`** for stable selectors
2. **Wait for async updates** with `waitFor()`
3. **Clean up after tests** (handled by `afterEach` in setup.ts)
4. **Mock external dependencies** (ReactFlow, Monaco, etc.)
5. **Test user behavior**, not implementation
6. **Keep tests focused** - one interaction per test
7. **Use `userEvent`** instead of `fireEvent` for realistic interactions

## Example: Full Graph Workflow Test

```typescript
it('should complete full graph creation workflow', async () => {
  const user = userEvent.setup();
  
  render(
    <TestWrapper>
      <GraphCanvas />
      <PropertiesPanel />
    </TestWrapper>
  );
  
  // 1. Add a node
  await waitFor(() => expect(addNodeRef.current).toBeDefined());
  addNodeRef.current();
  
  // 2. Wait for node to appear
  await waitFor(() => {
    expect(screen.getByTestId(/^node-/)).toBeInTheDocument();
  });
  
  // 3. Select the node
  const node = screen.getByTestId(/^node-/);
  await user.click(node);
  
  // 4. Verify PropertiesPanel updated
  await waitFor(() => {
    expect(screen.getByTestId('properties-panel')).toHaveTextContent('Node');
  });
  
  // 5. Add another node
  addNodeRef.current();
  
  // 6. Create edge between nodes
  // (simulate drag from node1 to node2)
  
  // 7. Verify edge created
  await waitFor(() => {
    expect(graphStore.setGraph).toHaveBeenCalled();
    const graph = graphStore.setGraph.mock.calls[graphStore.setGraph.mock.calls.length - 1][0];
    expect(graph.edges.length).toBe(1);
  });
});
```

## Debugging Integration Tests

### View Rendered Output

```typescript
import { screen, debug } from '@testing-library/react';

it('should render correctly', () => {
  render(<MyComponent />);
  debug(); // Prints entire DOM to console
  debug(screen.getByTestId('my-component')); // Prints specific element
});
```

### Check Render Counts

```typescript
const renderCount = vi.fn();
const Component = () => {
  renderCount();
  return <div>Test</div>;
};

it('should not re-render excessively', () => {
  render(<Component />);
  expect(renderCount).toHaveBeenCalledTimes(1);
});
```

### Monitor State Changes

```typescript
const stateChanges: any[] = [];
const Component = () => {
  const [state, setState] = useState(0);
  useEffect(() => {
    stateChanges.push(state);
  }, [state]);
  // ...
};
```

## Next Steps

1. **Start with simple tests** - render a component, verify it appears
2. **Add user interactions** - click buttons, fill forms
3. **Test component communication** - verify callbacks fire
4. **Add edge cases** - empty states, rapid clicks
5. **Monitor for infinite loops** - check render counts

## Resources

- [React Testing Library Docs](https://testing-library.com/react)
- [user-event Docs](https://testing-library.com/docs/user-event/intro)
- [Vitest Docs](https://vitest.dev/)
- Your existing test: `src/components/__tests__/GraphCanvas.integration.test.tsx`

