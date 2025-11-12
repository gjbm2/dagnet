# Query Selector Component Design

**Purpose:** Generalized component for expression/query construction with Monaco editing + chip visualization  
**Status:** Prototype complete in `QueryExpressionEditor.tsx`  
**Date:** 2025-11-04

---

## Overview

The **QuerySelector** is a dual-mode input component that combines:
1. **Monaco editor** for powerful IDE-like editing with autocomplete
2. **Chip visualization** for readable, visual representation after editing
3. **Custom grammar support** for different query languages

This complements the existing `EnhancedSelector` (connect/selector) by providing a more powerful expression builder.

---

## Component Architecture

### **Comparison: EnhancedSelector vs. QuerySelector**

| Feature | EnhancedSelector | QuerySelector |
|---------|------------------|---------------|
| **Use Case** | Single ID selection | Complex expression construction |
| **Input Method** | Dropdown + typeahead | Monaco editor with autocomplete |
| **Output** | Single ID string | Structured query expression |
| **Visual State** | Text input with icon | Chips (view) / Monaco (edit) |
| **Grammar** | N/A | Custom language definition |
| **Examples** | `parameter-id`, `node-id` | `from(a).to(b).exclude(c)` |

### **Core Features**

1. **Dual-Mode Rendering**
   - **View Mode:** Color-coded chips with hover affordances
   - **Edit Mode:** Monaco editor with syntax highlighting + autocomplete
   - Click chips or empty space → enter edit mode
   - Blur → return to chip view

2. **Monaco Integration**
   - Custom language registration (one-time, no pollution)
   - Syntax highlighting with theme colors
   - Context-aware autocomplete from registries + graph
   - Sans-serif font for readability

3. **Chip System**
   - Parsed from expression using regex/grammar
   - Color-coded by type (from/to, exclude, visited, case, etc.)
   - Delete on hover (X button)
   - Icon per chip type (from Lucide)

4. **Registry Integration**
   - Loads from both graph (current state) and registries (canonical)
   - Union of both sources (graph takes precedence)
   - Async loading with graceful fallback

---

## Generalization Strategy

### **Phase 1: Extract Base Component (Current)**

```typescript
// Current: QueryExpressionEditor.tsx
// Specific to: Data connection query expressions

interface QueryExpressionEditorProps {
  value: string;
  onChange: (value: string) => void;
  graph: any;
  // ... specific props
}
```

### **Phase 2: Create Generic QuerySelector**

```typescript
// New: QuerySelector.tsx
// Generic query/expression builder

interface QuerySelectorProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  
  // Grammar configuration
  grammar: QueryGrammar;
  
  // Data sources for autocomplete
  dataSources: QueryDataSource[];
  
  // Styling
  chipConfig?: ChipConfig;
  placeholder?: string;
  height?: string;
  readonly?: boolean;
}

interface QueryGrammar {
  languageId: string;
  syntax: MonarchSyntax;
  theme: MonacoTheme;
  parser: (query: string) => ParsedChip[];  // Parse string → chips
  autocomplete: AutocompleteProvider;
}

interface QueryDataSource {
  type: string;  // 'node', 'case', 'parameter', etc.
  provider: () => Promise<any[]>;  // Async data loader
  filter?: (item: any, context: string) => boolean;
}
```

### **Phase 3: Specialized Variants**

Create specific wrappers for common use cases:

```typescript
// 1. QueryExpressionSelector (current use case)
<QueryExpressionSelector
  value={query}
  onChange={setQuery}
  graph={graph}
/>

// 2. ConditionalProbabilitySelector
<ConditionalProbabilitySelector
  value={condition}
  onChange={setCondition}
  graph={graph}
  availableNodes={nodes}
/>

// 3. ParameterPackSelector (for snapshots)
<ParameterPackSelector
  value={packExpression}
  onChange={setPackExpression}
  parameters={allParameters}
/>

// 4. EdgeNameConstructor
<EdgeNameConstructor
  value={edgeName}
  onChange={setEdgeName}
  fromNode={sourceNode}
  toNode={targetNode}
/>
```

---

## Use Cases

### **1. Data Connection Queries (Current)**

```typescript
// Query: from(checkout).to(purchase).exclude(abandoned-cart)
<QueryExpressionSelector
  value={query}
  onChange={setQuery}
  graph={graph}
/>
```

**Chips:**
```
[ ○ from: checkout ] → [ ○ to: purchase ] [ × exclude: abandoned-cart ]
```

### **2. Conditional Probabilities**

```typescript
// Query: visited(product-page,add-to-cart).case(experiment-1:treatment)
<ConditionalProbabilitySelector
  value={condition}
  onChange={setCondition}
  graph={graph}
/>
```

**Chips:**
```
[ ✓ visited: product-page ] [ ✓ visited: add-to-cart ] [ ⎇ case: experiment-1:treatment ]
```

### **3. Parameter Pack Expressions**

```typescript
// Query: params[checkout-*.probability].where(status=active)
<ParameterPackSelector
  value={packExpr}
  onChange={setPackExpr}
  parameters={allParams}
/>
```

**Chips:**
```
[ 📦 params: checkout-*.probability ] [ ⚡ where: status=active ]
```

### **4. Edge Name Constructor**

```typescript
// Query: from(landing).via(signup).to(checkout)
<EdgeNameConstructor
  value={edgeName}
  onChange={setEdgeName}
  fromNode={landing}
  toNode={checkout}
/>
```

**Chips:**
```
[ 🔵 from: landing ] → [ 🟢 via: signup ] → [ 🔵 to: checkout ]
```

---

## Grammar Configurations

### **Example: Data Connection Grammar**

```typescript
const dataConnectionGrammar: QueryGrammar = {
  languageId: 'dagnet-query',
  
  syntax: {
    keywords: ['from', 'to', 'exclude', 'visited', 'case'],
    tokenizer: {
      root: [
        [/\b(from|to|exclude|visited|case)\b/, 'keyword'],
        [/[a-z0-9_-]+/, 'identifier'],
        [/[().,:]/, 'delimiter']
      ]
    }
  },
  
  theme: {
    keyword: '#3B82F6',
    identifier: '#1F2937',
    delimiter: '#6B7280'
  },
  
  parser: parseDataConnectionQuery,
  
  autocomplete: {
    triggers: ['.', '(', ',', ':'],
    provider: dataConnectionAutocompleteProvider
  }
};
```

### **Example: Conditional Probability Grammar**

```typescript
const conditionalProbGrammar: QueryGrammar = {
  languageId: 'dagnet-conditional',
  
  syntax: {
    keywords: ['visited', 'case', 'context'],
    // ...
  },
  
  parser: parseConditionalExpression,
  autocomplete: conditionalAutocompleteProvider
};
```

---

## Implementation Plan

### **Phase 1: Stabilize Current Implementation** ✅
- [x] Fix Monaco namespace pollution
- [x] Add delete affordances to chips
- [x] Click empty space → edit mode
- [x] Hover states

### **Phase 2: Extract Generic Component** (Next)
- [ ] Create `QuerySelector.tsx` base component
- [ ] Extract grammar configuration interface
- [ ] Extract chip configuration interface
- [ ] Create `QueryGrammarRegistry` for language definitions
- [ ] Add modal autocomplete (like EnhancedSelector)

### **Phase 3: Create Specialized Variants**
- [ ] `QueryExpressionSelector` (wrap current implementation)
- [ ] `ConditionalProbabilitySelector` (for edge conditions)
- [ ] `ParameterPackSelector` (for snapshot tool)

### **Phase 4: Advanced Features**
- [ ] Grouped/filtered autocomplete dropdown
- [ ] Modal popup for complex selections
- [ ] Drag-to-reorder chips
- [ ] Validation with inline error messages
- [ ] Query builder UI (alternative to text editing)

---

## Modal Autocomplete Design

Similar to `EnhancedSelector`, add a modal view for better node/case selection:

```typescript
interface ModalAutocompleteConfig {
  enabled: boolean;
  trigger: 'click' | 'ctrl+space';
  content: (context: AutocompleteContext) => ReactNode;
}

// Example: When user types "from(" → show modal with:
// - Tree view of nodes (grouped by type)
// - Search/filter
// - Recent items
// - Registry vs. graph indicator
```

**Benefits:**
- Better discoverability
- Filtering/grouping
- Rich metadata display
- Consistent with existing patterns

---

## Styling System

### **Chip Configuration**

```typescript
interface ChipConfig {
  [chipType: string]: {
    color: string;       // Border/icon color
    bgColor: string;     // Background color
    textColor: string;   // Text color
    icon: LucideIcon;    // Icon component
    label: string;       // Display label
  };
}

// Example: Data connection chips
const dataConnectionChips: ChipConfig = {
  from: { color: '#3B82F6', bgColor: '#EFF6FF', textColor: '#1E40AF', icon: Circle, label: 'from' },
  to: { color: '#3B82F6', bgColor: '#EFF6FF', textColor: '#1E40AF', icon: Circle, label: 'to' },
  exclude: { color: '#EF4444', bgColor: '#FEF2F2', textColor: '#991B1B', icon: X, label: 'exclude' },
  // ...
};
```

### **Theme Colors (Global)**

Use app's existing theme system:
- Primary: `#3B82F6` (blue)
- Success: `#10B981` (green)
- Warning: `#F59E0B` (orange)
- Danger: `#EF4444` (red)
- Neutral: `#6B7280` (gray)

---

## Testing Strategy

### **Unit Tests**

```typescript
describe('QuerySelector', () => {
  test('parses query into chips', () => {
    const query = 'from(a).to(b).exclude(c)';
    const chips = parseQuery(query);
    expect(chips).toEqual([
      { type: 'from', values: ['a'], rawText: 'from(a)' },
      { type: 'to', values: ['b'], rawText: 'to(b)' },
      { type: 'exclude', values: ['c'], rawText: 'exclude(c)' }
    ]);
  });
  
  test('renders chips with correct colors', () => {
    const { container } = render(<QuerySelector value="from(a).to(b)" />);
    const chips = container.querySelectorAll('[data-chip]');
    expect(chips[0]).toHaveStyle({ backgroundColor: '#EFF6FF' });
  });
  
  test('deletes chip on click', () => {
    const onChange = jest.fn();
    const { getByTitle } = render(
      <QuerySelector value="from(a).to(b).exclude(c)" onChange={onChange} />
    );
    
    fireEvent.click(getByTitle('Remove'));
    expect(onChange).toHaveBeenCalledWith('from(a).to(b)');
  });
});
```

### **Integration Tests**

```typescript
describe('QuerySelector Integration', () => {
  test('autocomplete shows registry + graph nodes', async () => {
    const { getByRole } = render(<QueryExpressionSelector graph={testGraph} />);
    
    // Focus editor
    fireEvent.click(getByRole('textbox'));
    
    // Type "from("
    userEvent.type(getByRole('textbox'), 'from(');
    
    // Wait for autocomplete
    await waitFor(() => {
      expect(screen.getByText('checkout (graph)')).toBeInTheDocument();
      expect(screen.getByText('signup (registry)')).toBeInTheDocument();
    });
  });
});
```

---

## Documentation

### **For Developers**

```typescript
/**
 * QuerySelector - Generic expression builder with Monaco + chips
 * 
 * @example
 * // Data connection query
 * <QueryExpressionSelector
 *   value="from(a).to(b)"
 *   onChange={setQuery}
 *   graph={graph}
 * />
 * 
 * @example
 * // Conditional probability
 * <ConditionalProbabilitySelector
 *   value="visited(product-page)"
 *   onChange={setCondition}
 *   graph={graph}
 * />
 */
```

### **For Users**

**Editing:**
1. Click the field to enter edit mode
2. Monaco editor appears with autocomplete
3. Type `.` to see available functions
4. Type `(` after a function to see available items
5. Click away or press Escape to save

**Viewing:**
1. Expression renders as color-coded chips
2. Hover over a chip to see delete button
3. Click X to remove that part of the query
4. Click empty space to edit entire expression

---

## Future Enhancements

### **Query Builder UI** (Alternative to text)

```typescript
// Visual builder alternative to Monaco
<QueryBuilder
  value={query}
  onChange={setQuery}
  mode="visual"  // vs. "text"
>
  <QueryBuilder.FromNode nodes={allNodes} />
  <QueryBuilder.ToNode nodes={allNodes} />
  <QueryBuilder.Constraints>
    <QueryBuilder.Exclude nodes={allNodes} />
    <QueryBuilder.Visited nodes={allNodes} />
  </QueryBuilder.Constraints>
</QueryBuilder>
```

### **AI-Assisted Query Construction**

```typescript
// Natural language → query
<QuerySelector
  value={query}
  onChange={setQuery}
  aiAssist={{
    enabled: true,
    prompt: "Get data from checkout to purchase, excluding abandoned carts"
  }}
/>
// → Generates: from(checkout).to(purchase).exclude(abandoned-cart)
```

### **Query Templates**

```typescript
// Pre-built common patterns
<QuerySelector
  value={query}
  onChange={setQuery}
  templates={[
    { name: 'Direct Path', template: 'from({}).to({})' },
    { name: 'Exclude Detours', template: 'from({}).to({}).exclude({})' },
    { name: 'Funnel Analysis', template: 'from({}).visited({}).to({})' }
  ]}
/>
```

---

## Related Documents

- [DATA_CONNECTIONS.md](./DATA_CONNECTIONS.md) — Main data connections spec
- [QUERY_EXPRESSION_SYSTEM.md](./QUERY_EXPRESSION_SYSTEM.md) — Query DSL, MSMDC algorithm
- [DATA_CONNECTIONS_SCHEMA_VALIDATION.md](./DATA_CONNECTIONS_SCHEMA_VALIDATION.md) — Schema design

---

## Document History

| Date | Version | Changes |
|------|---------|---------|
| 2025-11-04 | 0.1 | Initial design document for QuerySelector generalization |

---

**End of Document**

