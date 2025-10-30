# Navigator Filter/Sort/Group Controls Design

## Overview
Add a compact control bar below the search bar in the Navigator to provide quick access to common filtering, sorting, and grouping options.

## Visual Design

```
┌─────────────────────────────────────────┐
│  🔍 Search...                      [×]  │ ← Existing search bar
├─────────────────────────────────────────┤
│  [🎯 All ▾] [↕ Name ▾] [📁 Type ▾]     │ ← New controls bar
└─────────────────────────────────────────┘
│                                         │
│  ▼ 📊 Graphs (10)                      │
│    graph-1                              │
│    graph-2                              │
│  ...                                    │
```

## Controls Bar Layout

### 1. Filter Button (Left)
**Label:** Filter status (e.g., "All", "Dirty", "Open", "Local")
**Icon:** 🎯 or filter icon
**Dropdown options:**
- ☑ All files (default)
- ○ Dirty only
- ○ Open only  
- ○ Local only
- ○ Files with changes

### 2. Sort Button (Middle)
**Label:** Current sort (e.g., "Name", "Modified", "Opened")
**Icon:** ↕ or sort icon
**Dropdown options:**
- Name (A→Z)
- Modified (Recent first) ← Fix to ensure this is truly recent-first
- Opened (Recent first)
- Status (Dirty → Clean)
- Type (A→Z)

### 3. Group Button (Right)
**Label:** Current grouping (e.g., "Type", "Tags", "None")
**Icon:** 📁 or group icon
**Dropdown options:**
- ☑ By Type (default - Parameters, Contexts, Cases, Nodes)
- ○ By Tags
- ○ Flat list (no grouping)
- ○ By Status (Dirty, Open, Clean)

## Implementation Details

### UI Components

```typescript
interface NavigatorControlsState {
  filter: 'all' | 'dirty' | 'open' | 'local';
  sortBy: 'name' | 'modified' | 'opened' | 'status' | 'type';
  sortDirection: 'asc' | 'desc';
  groupBy: 'type' | 'tags' | 'status' | 'none';
}
```

### CSS Styling

```css
.navigator-controls {
  display: flex;
  gap: 6px;
  padding: 6px 8px;
  background: #f5f5f5;
  border-bottom: 1px solid #e0e0e0;
  flex-shrink: 0;
}

.control-button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  background: white;
  border: 1px solid #d0d0d0;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
  min-width: 0; /* Allow flex shrinking */
}

.control-button:hover {
  background: #f8f9fa;
  border-color: #0066cc;
}

.control-button-label {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.control-button-icon {
  font-size: 10px;
  color: #666;
}

/* Dropdown menu */
.control-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 2px;
  background: white;
  border: 1px solid #d0d0d0;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  z-index: 1000;
  min-width: 160px;
}

.control-dropdown-item {
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
}

.control-dropdown-item:hover {
  background: #f0f0f0;
}

.control-dropdown-item.active {
  background: #e3f2fd;
  color: #0066cc;
}
```

### Component Structure

```tsx
// NavigatorControls.tsx
export function NavigatorControls({
  filter,
  sortBy,
  groupBy,
  onFilterChange,
  onSortChange,
  onGroupChange
}: NavigatorControlsProps) {
  return (
    <div className="navigator-controls">
      <ControlDropdown
        icon="🎯"
        label={getFilterLabel(filter)}
        value={filter}
        options={FILTER_OPTIONS}
        onChange={onFilterChange}
      />
      
      <ControlDropdown
        icon="↕"
        label={getSortLabel(sortBy)}
        value={sortBy}
        options={SORT_OPTIONS}
        onChange={onSortChange}
      />
      
      <ControlDropdown
        icon="📁"
        label={getGroupLabel(groupBy)}
        value={groupBy}
        options={GROUP_OPTIONS}
        onChange={onGroupChange}
      />
    </div>
  );
}
```

## Behavior Details

### Filter Interactions
- **All (default):** Show all files
- **Dirty:** Show only files with unsaved changes
- **Open:** Show only files with open tabs
- **Local:** Show only local-only files (not committed)
- Filter state persists in localStorage

### Sort Interactions
- **Name:** Alphabetical A→Z
- **Modified:** Most recently modified first (FIXED: ensure descending)
- **Opened:** Most recently opened first
- **Status:** Dirty files first, then open, then clean
- **Type:** Alphabetical by type name
- Sort state persists in localStorage
- Clicking same sort option toggles direction (asc/desc)

### Group Interactions
- **By Type (default):** Sections for Graphs, Parameters, Contexts, Cases, Nodes
- **By Tags:** Group items by their tags
- **Flat list:** No grouping, just a flat sorted list
- **By Status:** Group by Dirty, Open, Clean
- Group state persists in localStorage

## Responsive Behavior

### Narrow Navigator (< 200px)
- Show only icons, hide labels
- Tooltips show full labels on hover

### Normal Navigator (200-300px)
- Show short labels: "All", "Name", "Type"

### Wide Navigator (> 300px)
- Show full labels: "All files", "Sort: Name", "Group: Type"

## Accessibility
- All controls keyboard accessible (Tab, Enter, Arrow keys)
- ARIA labels for screen readers
- Focus indicators
- Keyboard shortcuts:
  - `F`: Toggle filter menu
  - `S`: Toggle sort menu
  - `G`: Toggle group menu

## Future Enhancements
- Saved filter/sort presets
- Custom sort orders
- Multi-tag filtering
- Search within filtered results


