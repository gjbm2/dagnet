# Selector Modal Design

## Overview
Extend `EnhancedSelector` with a modal view that provides advanced search, filter, sort, and group capabilities matching the Navigator interface.

## Architecture

### 1. Shared Filtering/Sorting Hook
**File:** `graph-editor/src/hooks/useItemFiltering.ts`

Extract filtering and sorting logic from Navigator into reusable hook:

```typescript
interface FilterOptions {
  searchQuery: string;
  showLocalOnly: boolean;
  showDirtyOnly: boolean;
  showOpenOnly: boolean;
  viewMode: 'all' | 'files-only';
}

interface SortOptions {
  sortBy: 'name' | 'modified' | 'opened' | 'status' | 'type';
}

interface GroupOptions {
  groupBy: 'type' | 'tags' | 'status' | 'none';
}

export function useItemFiltering<T extends ItemBase>(
  items: T[],
  filters: FilterOptions,
  sort: SortOptions,
  group: GroupOptions
) {
  // Returns: { filteredItems, groupedItems, ...stats }
}
```

**Benefits:**
- DRY principle - single source of truth
- Consistent behavior across Navigator and Selector Modal
- Easier to test and maintain
- Performance optimization via memoization

### 2. Selector Modal Component
**File:** `graph-editor/src/components/SelectorModal.tsx`

**Scoping:** Modal is rendered within the graph window (GraphEditor component tree), not app-level.
This ensures:
- Modal is contained within the current tab's viewport
- Each graph tab has independent modal state
- Modal overlays only the graph editor area, not entire app
- Consistent with tab-scoped state management

```typescript
interface SelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  type: 'parameter' | 'context' | 'case' | 'node';
  items: any[];
  currentValue: string;
  onSelect: (value: string) => void;
  parameterType?: string;
  showCurrentGraphGroup?: boolean;
}

export function SelectorModal({ ... }: SelectorModalProps) {
  // State for filters, sort, group
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [sortBy, setSortBy] = useState<SortMode>('name');
  const [groupBy, setGroupBy] = useState<GroupMode>('type');
  
  // Use shared filtering hook
  const { filteredItems, groupedItems } = useItemFiltering(
    items,
    { searchQuery, showLocalOnly, ... },
    { sortBy },
    { groupBy }
  );
  
  return (
    <div className="selector-modal-overlay"> {/* Scoped to graph window, not body */}
      <div className="selector-modal-container">
        <div className="selector-modal-header">
          <h3>Select {type}</h3>
          <button onClick={onClose}>×</button>
        </div>
        <div className="selector-modal-controls">
          <SearchInput />
          <NavigatorControls /> {/* Reuse existing component */}
        </div>
        <div className="selector-modal-body">
          {/* Render grouped items similar to Navigator */}
          {groupedItems.map(group => (
            <ObjectTypeSection ... />
          ))}
        </div>
      </div>
    </div>
  );
}
```

### 3. EnhancedSelector Integration
**File:** `graph-editor/src/components/EnhancedSelector.tsx`

Add modal button to dropdown header:

```typescript
// In dropdown render
<div className="enhanced-selector-dropdown-header">
  <button 
    onClick={() => setShowModal(true)}
    className="open-modal-btn"
    title="Open advanced selector"
  >
    <Maximize2 size={14} />
    Advanced...
  </button>
</div>

{/* Modal */}
{showModal && (
  <SelectorModal
    isOpen={showModal}
    onClose={() => setShowModal(false)}
    type={type}
    items={allItems}
    currentValue={inputValue}
    onSelect={(value) => {
      onChange(value);
      setShowModal(false);
    }}
    parameterType={parameterType}
    showCurrentGraphGroup={showCurrentGraphGroup}
  />
)}
```

## Rendering Strategy

### Modal Placement
The modal is rendered **within the GraphEditor component tree**, not as a global portal:

```
GraphEditor
  └─ PropertiesPanel
      └─ EnhancedSelector
          ├─ Dropdown (existing)
          └─ SelectorModal (new, rendered conditionally)
              └─ Overlay (position: absolute, relative to GraphEditor)
```

**CSS Positioning:**
```css
.selector-modal-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 1000;
  /* Scoped to graph editor container, not viewport */
}
```

**Benefits:**
- Each tab has independent modal state
- Modal doesn't interfere with Navigator or other UI
- No global state pollution
- Follows existing tab-scoped architecture

## UI Design

### Dropdown Enhancement
```
┌─────────────────────────────────┐
│ [⛶ Advanced...]        [Create] │ ← Header with modal button
├─────────────────────────────────┤
│ Current Graph                   │
│  □ node-a                       │
│  □ node-b                       │
├─────────────────────────────────┤
│ Node Registry                   │
│  □ registry-node-1              │
│  □ registry-node-2              │
└─────────────────────────────────┘
```

### Modal View
```
┌─────────────────────────────────────────────┐
│ Select Node                            [×]  │
├─────────────────────────────────────────────┤
│ [🔍 Search...]                              │
│ [Filter ▾] [Sort ▾] [Group ▾]             │
├─────────────────────────────────────────────┤
│                                             │
│ ▼ Current Graph (3)                        │
│   □ node-a          Label A      [Open]   │
│   □ node-b          Label B      [Open]   │
│   □ node-c          Label C      [Open]   │
│                                             │
│ ▼ Node Registry (12)                       │
│   □ registry-node-1  Desc 1      [Open]   │
│   □ registry-node-2  Desc 2      [Open]   │
│   ...                                       │
│                                             │
├─────────────────────────────────────────────┤
│              [Cancel]  [Select]             │
└─────────────────────────────────────────────┘
```

## Implementation Steps

1. ✅ **Create useItemFiltering hook**
   - Extract from NavigatorContent
   - Add tests
   - Generic interface

2. **Refactor Navigator to use hook**
   - Replace inline logic
   - Verify no regressions

3. **Create SelectorModal component**
   - Modal wrapper with overlay
   - Search input
   - Reuse NavigatorControls
   - Item list with grouping

4. **Update EnhancedSelector**
   - Add "Advanced" button to dropdown
   - Wire up modal state
   - Pass items and callbacks

5. **Styling**
   - Modal CSS
   - Responsive design
   - Dark mode support

6. **Testing**
   - Test with all item types
   - Test filtering/sorting
   - Test selection flow

## Benefits

1. **Better UX for large registries**
   - Easy to search through 100+ items
   - Advanced filtering (local only, dirty only, etc.)
   - Multiple sorting options

2. **Consistency**
   - Same controls as Navigator
   - Familiar UI patterns
   - Shared logic = consistent behavior

3. **Maintainability**
   - Single source of filtering logic
   - Easier to add new filter/sort options
   - Testable in isolation

4. **Performance**
   - Memoized filtering/sorting
   - Virtual scrolling (future enhancement)
   - Lazy loading (future enhancement)

---

## Implementation Summary

**Status**: ✅ Complete (2025-11-03)

### What Was Built

1. **Reusable Filtering Hook** (`useItemFiltering.ts`)
   - Extracted filtering, sorting, and grouping logic
   - Shared between Navigator and SelectorModal
   - Fully typed with ItemBase interface

2. **SelectorModal Component** (`SelectorModal.tsx` + `.css`)
   - Full-window modal overlay on graph editor tab (max-width: 1200px)
   - **Table view** with sortable columns:
     - Slug (monospace, ID)
     - Label (item name)
     - Type (conversion, entry, exit, etc.)
     - Stored (chips: graph, file, registry, dirty, open)
     - Description
   - Click column headers to toggle sort direction (asc/desc)
   - Search, filter, sort, and group controls (from NavigatorControls)
   - Row actions: click to select, external link icon to open file
   - Selected row highlighted with blue background
   - Keyboard navigation (Escape to close)

3. **Integration with GraphEditor**
   - Modal state managed at GraphEditor level
   - Accessible via SelectionContext
   - `openSelectorModal()` callback passed through context
   - Modal overlays entire graph window (not just sidebar)

4. **EnhancedSelector Enhancement**
   - Added compact "Expand" icon button (Maximize2) in dropdown header
   - Positioned next to close X button (right-aligned, space-efficient)
   - Clicking opens modal scoped to graph tab
   - Removed local modal state
   - Uses context to trigger modal

### Key Design Decisions

- **Scoping**: Modal is scoped to graph tab, not application-wide
- **Positioning**: Overlays entire graph editor window for maximum width
- **State Management**: Centralized in GraphEditor, accessed via context
- **Reusability**: `useItemFiltering` hook ensures consistency across interfaces

