# Current Layer What-If Chip Design

## Overview

Add a "+ What if" chip to the Current layer row in the Scenarios panel. The chip automatically shows the What-If control panel when any What-If analysis is active. The chip visually transforms into a folder tab that extends down to connect with the panel, creating a cohesive visual unit. This design helps users understand that What-If modifications are part of the Current layer's state.

## Goals

1. **Clarify the relationship** between What-If and Current layer
2. **Improve discoverability** of What-If controls
3. **Maintain existing patterns** - keep the window bar What-If button as well
4. **Provide intuitive UX** - chip becomes folder tab, panel auto-shows when What-If is active
5. **Visual coherence** - chip and panel share same background color, appearing as one unit

## Visual Design

### Key Visual Concept: Chip Transforms Into Folder Tab

The chip is **always present** in the Current row. When clicked, it **transforms into** a folder tab that extends down to connect with the panel below. It's the same element in two different visual states.

```
Collapsed State (Chip):
┌──────────────────────────────────────────┐
│ [●] Current    [+ What if]  [✏️] [👁️]   │ ← Chip (rounded pill)
└──────────────────────────────────────────┘

Expanded State (Tab):
┌──────────────────────────────────────────┐
│ [●] Current    [+ What if x] [✏️] [👁️]  │ ← Same element, now a tab
│                 │           │             │
│                 └───────────┘             │ ← Tab extends down
│                ┌─────────────────────┐    │
│                │  What-If Panel      │    │
│                │  (matching color)   │    │
│                └─────────────────────┘    │
└──────────────────────────────────────────┘
```

**Key:** 
- Same button element, different styling based on state
- Chip form: Rounded pill (`border-radius: 12px`)
- Tab form: Top-rounded, flat bottom (`border-radius: 6px 6px 0 0`), extends down
- Transforms via CSS transition

---

### Current Layer Row (Collapsed - Panel Hidden)

```
┌─────────────────────────────────────────────────────┐
│ [ ] [●] Current          [+ What if]  [✏️] [👁️]     │
└─────────────────────────────────────────────────────┘
      Reads as: "Current [+ What if]"  ←── Visual unity
```

**Elements:**
- Drag placeholder (empty space `[ ]`)
- Color swatch (●)
- "Current" label
- **"+ What if" chip** - always visible, clickable to open panel
  - Same font size as "Current" label
  - Reads as extension/qualifier of "Current"
  - Can be subtle (lighter colors) to integrate with title
- Edit button (✏️)
- Visibility toggle (👁️)

**Chip Styling (Collapsed):**
- Inline with Current row elements, reads as part of "Current" title
- Small rounded button style
- Font size: **Same as "Current" label** (seamless visual integration)
- Background: light grey `#E5E7EB` (can be made more subtle/less pronounced)
- Border: `1px solid #D1D5DB` (can be lightened for collapsed state)
- Text: `+ What if`
- Cursor: pointer
- Visual goal: User reads as "Current [+ What if]" - chip as extension of title

### Current Layer Row (Expanded - Panel Visible)

```
┌─────────────────────────────────────────────────────┐
│ [ ] [●] Current          [+ What if x]  [✏️] [👁️]   │ ← Tab STAYS inline
│                          │           │               │
│                          └───────────┘               │ ← Tab extends down
│                          ┌───────────────────────┐   │
│                          │  What-If Panel        │   │
│                          │                       │   │
│                          │  DSL Editor:          │   │
│                          │  [query input]        │   │
│                          │                       │   │
│                          │  Constraints...       │   │
│                          │  [Clear All]          │   │
│                          │                       │   │
│                          └───────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

**Visual Design:**
- The chip **stays inline** horizontally with Current row elements
- The chip **extends down** vertically to meet the panel, forming a folder tab shape
- Tab and panel share the same background color (light grey: `#E5E7EB`)
- The tab's bottom border is removed where it connects to the panel
- Creates a continuous visual unit - tab is the "label" of the "folder"

**Chip/Tab Styling (Expanded):**
- Position: Stays inline in Current row, extends downward
- Shape: Rectangle with rounded top corners, flat bottom where it connects
- `border-radius: 6px 6px 0 0` (rounded top, flat bottom)
- Background: `#E5E7EB` (light grey, matches panel)
- Border: `1px solid #D1D5DB`, no bottom border (connects to panel)
- Text: `+ What if x` in 12px size
- Padding: `4px 10px` (horizontal), extends down to panel
- Cursor: pointer (clicking clears What-If)

**Panel Styling:**
- Background: `#E5E7EB` (light grey, same as tab)
- Border: `1px solid #D1D5DB`
- Border-radius: `0 6px 6px 6px` (top-left square where tab connects)
- Padding: `12px`
- Positioned directly below the tab
- Max-height: `400px`
- Overflow-y: `auto`

**Show/Hide Behavior:**
- Click chip to **open panel** (works even if no What-If DSL yet - lets user create one)
- Panel allows user to create/edit What-If DSL
- Click "x" to **close panel**
- If What-If DSL exists when panel closes, it's preserved
- If user clears DSL in panel, panel can optionally auto-close 

## Interaction Behavior

### Opening the Panel

**Scenario A: User clicks the "+ What if" chip**
1. User clicks the "+ What if" chip
2. Chip visually transforms into folder tab
   - Border-radius changes from pill to tab shape
   - Text changes to "+ What if x"
   - Bottom border disappears, extends down to panel
3. Panel slides down below the tab with smooth animation (200ms ease-out)
4. Panel contains full `WhatIfAnalysisControl` component
5. User can now create/edit What-If DSL

**Works even when no What-If DSL exists** - this is how users access What-If to create one.

**Scenario B: What-If DSL applied from elsewhere**
1. What-If DSL is applied from elsewhere (e.g., window bar)
2. Panel automatically expands to show the active What-If
3. Chip transforms to folder tab style

**Trigger:** `whatIfDSL` becomes non-null/non-empty while panel is closed

### Clearing What-If (and Closing Panel)

**User clicks "x" on the tab:**
1. All What-If DSL is cleared (set to null/empty)
2. Panel automatically closes (slides up and fades out, 200ms)
3. Tab visually transforms back to chip
   - Border-radius changes from tab to pill shape
   - Text changes back to "+ What if"
   - Bottom border reappears

**OR user clicks "Clear All" button within the panel:**
1. Same effect - What-If DSL cleared
2. Panel automatically closes
3. Tab transforms back to chip

**Key:** Clearing What-If **causes** the panel to close. They're not separate actions.

**Logic:** When `whatIfDSL` becomes null/empty AND panel is open → close panel and transform tab back to chip.

### Other Interactions

**Edit button (✏️):**
- Opening the Current modal does NOT affect the What-If panel
- User can have both open simultaneously
- Independent views of Current layer

**Navigation:**
- Panel expanded state is **transient** (doesn't persist across sessions)
- On page reload: panel starts collapsed, regardless of What-If DSL state
- User can re-open panel by clicking chip if What-If exists

## Component Structure

```
ScenariosPanel
├─ CurrentLayerRow
│  ├─ Color swatch
│  ├─ "Current" label
│  ├─ WhatIfChip/Tab (NEW - always visible, transforms based on state)
│  ├─ Edit button
│  └─ Visibility toggle
│
└─ {panelExpanded && (
   └─ CurrentLayerWhatIfPanel (NEW)
      └─ WhatIfAnalysisControl tabId={tabId}
   )}
```

### Transient Expanded State + Clear Logic

The panel needs a **transient expanded state** that allows opening before DSL exists, but clears when DSL is removed:

**In ScenariosPanel:**
```tsx
// Get What-If DSL from context
const whatIfCtx = useWhatIfContext();
const whatIfDSL = whatIfCtx?.whatIfDSL;

// Transient state: is panel currently expanded?
const [panelExpanded, setPanelExpanded] = useState(false);

// Auto-expand when What-If becomes active from elsewhere
useEffect(() => {
  if (whatIfDSL && whatIfDSL.trim().length > 0 && !panelExpanded) {
    setPanelExpanded(true); // Auto-open panel when What-If applied
  }
}, [whatIfDSL]);

// Auto-close when What-If is cleared
useEffect(() => {
  if ((!whatIfDSL || whatIfDSL.trim().length === 0) && panelExpanded) {
    setPanelExpanded(false); // Auto-close panel when What-If cleared
  }
}, [whatIfDSL, panelExpanded]);

// Open panel (even if no DSL yet)
const openPanel = () => {
  setPanelExpanded(true);
};

// Clear What-If (which automatically closes panel via useEffect)
const handleClearWhatIf = () => {
  whatIfCtx?.setWhatIfDSL(null);
  // Panel closes automatically via useEffect above
};
```

### Chip/Tab Button JSX

```tsx
<button
  className={`current-layer-whatif-button ${panelExpanded ? 'tab' : 'chip'}`}
  onClick={panelExpanded ? handleClearWhatIf : openPanel}
  title={panelExpanded ? "Clear What-If analysis" : "Open What-If panel"}
>
  + What if {panelExpanded && 'x'}
</button>
```

### Panel JSX

```tsx
{panelExpanded && (
  <div className="current-layer-whatif-panel">
    <WhatIfAnalysisControl tabId={tabId} />
  </div>
)}
```

**Key insights:** 
- Same button element, different click handlers based on state
- Chip state: Clicking opens panel
- Tab state: Clicking clears What-If (which auto-closes panel)
- Panel auto-closes when What-If DSL becomes empty

## Implementation Approach

### Phase 1: Basic Structure
1. Add `useWhatIfContext()` to ScenariosPanel to access What-If DSL
2. Add local state: `const [panelExpanded, setPanelExpanded] = useState(false)`
3. Add chip/tab button to Current layer row (always rendered)
4. Add conditional panel render based on `panelExpanded`
5. Wire up toggle handler on chip click
6. Add basic CSS for chip/tab and panel

### Phase 2: Folder Tab Visual
1. Implement folder tab CSS (chip extends down, no bottom border)
2. Add inline positioning to keep tab in Current row
3. Ensure tab and panel share same background color
4. Perfect the visual connection (panel top-left corner square)
5. Test that it looks like a cohesive folder

### Phase 3: What-If Integration
1. Render `WhatIfAnalysisControl` inside the panel
2. Add auto-expand when What-If DSL becomes active from elsewhere
3. Verify What-If controls work correctly when embedded
4. Test synchronization with window bar What-If button
5. Ensure both locations can edit the same What-If state

### Phase 4: Polish
1. Add smooth transitions (slide down/up for panel: 200ms ease-out)
2. Add chip text transition ("+ What if" ↔ "+ What if x")
3. Keyboard accessibility (Tab navigation, Escape to close)
4. Ensure proper focus management
5. Test with various What-If scenarios
6. Responsive behavior if panel is narrow

## Styling Details

### CSS Classes

```css
/* Base button - always present in Current row */
.current-layer-whatif-button {
  padding: 4px 10px;
  background: #E5E7EB; /* Light grey */
  border: 1px solid #D1D5DB; /* Grey border */
  font-size: inherit; /* Match "Current" label font size - reads as part of title */
  font-weight: 500;
  color: #374151; /* Dark grey text */
  cursor: pointer;
  transition: all 200ms ease;
  white-space: nowrap;
  position: relative;
}

/* Chip state - collapsed, no panel */
.current-layer-whatif-button.chip {
  border-radius: 12px; /* Fully rounded pill */
  /* Note: Can make background/border more subtle in collapsed state */
  /* e.g., background: #F3F4F6, border: #E5E7EB for less prominence */
}

.current-layer-whatif-button.chip:hover {
  background: #D1D5DB; /* Slightly darker grey on hover */
}

/* Tab state - expanded, connected to panel */
.current-layer-whatif-button.tab {
  border-radius: 6px 6px 0 0; /* Rounded top, flat bottom (folder tab) */
  border-bottom: none; /* No bottom border - connects to panel */
  margin-bottom: -1px; /* Pull down to overlap with panel border */
}

.current-layer-whatif-button.tab:hover {
  background: #D1D5DB; /* Slightly darker grey on hover */
}

/* What-If panel - connects to tab */
.current-layer-whatif-panel {
  margin-top: 0; /* No gap - connects directly to tab */
  margin-left: 0; /* Align with tab */
  background: #E5E7EB; /* Same light grey as tab */
  border-radius: 0 6px 6px 6px; /* Top-left square (where tab connects), others rounded */
  border: 1px solid #D1D5DB; /* Same border as tab */
  padding: 12px;
  overflow: hidden;
  animation: slideDown 200ms ease-out;
  max-height: 400px;
  overflow-y: auto;
}

@keyframes slideDown {
  from {
    opacity: 0;
    max-height: 0;
    padding-top: 0;
    padding-bottom: 0;
    margin-top: -10px;
  }
  to {
    opacity: 1;
    max-height: 400px;
    padding-top: 12px;
    padding-bottom: 12px;
    margin-top: 0;
  }
}

/* Adjust WhatIfAnalysisControl when embedded */
.current-layer-whatif-panel .what-if-analysis-control {
  /* Remove any outer margins */
  margin: 0;
}

/* Container for button + panel to keep them visually connected */
.current-layer-whatif-container {
  display: flex;
  flex-direction: column;
  margin-top: 8px;
  margin-left: 24px; /* Indent from Current row */
}
```

### CSS Transition

The button smoothly transitions between chip and tab states:
- Border-radius morphs from `12px` (pill) to `6px 6px 0 0` (tab)
- Bottom border disappears when becoming tab
- All changes animate via `transition: all 200ms ease`

### Color Palette

**Tab/Panel (Expanded State):**
- **Background:** `#E5E7EB` (gray-200 - slightly darker than panel)
- **Border:** `#D1D5DB` (gray-300 - subtle definition)
- **Text:** `#374151` (gray-700 - good contrast)
- **Hover background:** `#D1D5DB` (gray-300 - slightly darker)

**Chip (Collapsed State - Optional More Subtle Variant):**
- **Background:** `#F3F4F6` (gray-100 - lighter, less pronounced)
- **Border:** `#E5E7EB` (gray-200 - softer)
- **Text:** `#374151` (gray-700 - same)
- Can iterate on prominence - goal is to read as part of "Current" title

This creates a cohesive "folder tab" effect where the chip extends down into the panel seamlessly, while matching the color temperature of other Scenarios panel elements. The collapsed state can be more subtle to integrate with the "Current" title.

## Integration Points

### With Existing What-If Button (Window Bar)

The window bar What-If button remains **fully independent**. Both locations show What-If controls:

1. **Window bar button** - Dropdown overlay, temporary, dismissible
2. **Current layer folder tab** - Embedded panel, auto-shows when active, part of scenarios UI

**Synchronization:**
- Changes made in either location affect the same underlying `whatIfDSL` state
- Both render the same `WhatIfAnalysisControl` component
- DSL changes reflect immediately in both places
- When DSL is set from window bar, Current layer panel automatically appears
- When DSL is cleared from Current layer tab, window bar reflects the change
- No conflict - they're two synchronized views into the same data

### With Scenarios Context

- Uses existing `useScenariosContext` for accessing Current layer state
- Uses existing `useWhatIfContext` to read `whatIfDSL` and control visibility
- No new context needed
- No expansion state to persist - panel visibility is purely derived from What-If DSL

### With Current Modal Editor

- Opening Current in modal editor does NOT auto-collapse the What-If panel
- Users can have both open simultaneously
- Modal shows full parameter YAML; embedded What-If panel shows DSL-based overrides
- Independent but complementary views of Current layer

## Accessibility

- **Keyboard navigation:**
  - Tab key moves to chip button
  - Enter/Space toggles panel open/closed
  - Escape closes expanded panel (when focus is within panel)
  - Tab navigation within panel content when expanded
- **Screen readers:**
  - Chip (collapsed): "Show What-If controls, button, collapsed"
  - Chip (expanded): "Hide What-If controls, button, expanded"
  - Panel announced as "What-If Analysis region"
- **Focus management:**
  - When expanding, focus moves to DSL query editor
  - When collapsing via Escape, focus returns to chip button
  - When collapsing via chip click, focus remains on chip

## Future Enhancements

1. **Constraint count in tab:**
   - Show count of active constraints in the tab
   - e.g., "+ What if (3) x" when 3 constraints are active
   - Helps user see at a glance how complex their What-If is

2. **Drag-to-resize:**
   - Allow user to adjust height of panel area
   - Drag handle at bottom of panel

3. **Collapsible sections within panel:**
   - Allow collapsing DSL editor if user only wants to see constraint summary
   - More compact view for complex What-If scenarios

4. **Quick actions:**
   - Add common What-If templates as quick-pick options
   - "Recent" What-If queries dropdown

5. **Visual feedback on affected elements:**
   - When hovering over tab, highlight affected edges/nodes in graph
   - Helps user see What-If impact at a glance

6. **Split-button behavior:**
   - Main tab area opens/focuses panel (if minimized)
   - Only "x" clears What-If
   - Provides both navigation and clear actions

## Open Questions

1. **Should the folder tab be slightly indented or flush with Current row?**
   - Recommendation: Slight indent from left edge to show it's "inside" Current layer context.

2. **Animation duration?**
   - Recommendation: 200ms for both button transformation and panel slide.

3. **Max height for panel?**
   - Recommendation: 400px with scroll. Ensures it doesn't dominate the scenarios panel.

4. **Should the "x" in "+ What if x" be styled differently?**
   - Recommendation: Plain text is clear. Could use a subtle × character if preferred. *** THE X SHOULD BE A CLOSE NORMAL X CLOSE ICON FOR USE ON A TAB, NOT THE LETTER X ***

5. **Light grey color choice?**
   - Decision: Light grey (`#E5E7EB`) matches the Scenarios panel color temperature and provides subtle distinction while being slightly darker than the panel background.

6. **Should button transformation be instant or animated?**
   - Recommendation: Animated with CSS transition (200ms) for smooth, polished feel.

7. **How subtle should collapsed chip be?**
   - Goal: Chip should read as part of "Current" title, not as separate control
   - Recommendation: Can use lighter background/border in collapsed state (e.g., `#F3F4F6` / `#E5E7EB`) to be less pronounced
   - Can iterate on prominence during implementation

8. **Font size for chip?**
   - Decision: **Same as "Current" label** - ensures visual cohesion and reads as "Current [+ What if]"

## Mockup ASCII Art Summary

### State 1: Panel Collapsed (Button in Chip Form)
```
┌─ Scenarios Panel ─────────────────┐
│                                    │
│  [●] Current [+ What if] [✏️] [👁️]│ ← Reads as "Current [+ What if]"
│                                    │   Same font size, subtle colors
│  ─────────────────────────────     │
│  [+] Create Snapshot               │
│  ─────────────────────────────     │
│  [●] Scenario 1       [✏️] [👁️]   │
│  [●] Scenario 2       [✏️] [👁️]   │
│  ─────────────────────────────     │
│  [●] Base (Original)  [✏️] [👁️]   │
│                                    │
└────────────────────────────────────┘
```
**Click action:** Opens panel

### State 2: Panel Expanded (Button in Tab Form)
```
┌─ Scenarios Panel ─────────────────┐
│                                    │
│  [●] Current [+ What if x] [✏️] [👁️] ← Same button (tab form)
│               │          │          │
│               └──────────┘          │   Extends down ↓
│              ┌────────────────────┐ │
│              │ What-If Panel      │ │ ← Connected to tab
│              │                    │ │
│              │ DSL Editor:        │ │
│              │ ┌────────────────┐ │ │
│              │ │ case().visit() │ │ │
│              │ └────────────────┘ │ │
│              │                    │ │
│              │ Constraints:       │ │
│              │ • treatment        │ │
│              │ • nodea            │ │
│              │                    │ │
│              │ [Clear All]        │ │
│              └────────────────────┘ │
│                                    │
│  ─────────────────────────────     │
│  [+] Create Snapshot               │
│  ─────────────────────────────     │
│  [●] Scenario 1       [✏️] [👁️]   │
│  [●] Scenario 2       [✏️] [👁️]   │
│                                    │
└────────────────────────────────────┘
```
**Click action:** Clears What-If → Panel auto-closes → Button reverts to chip

**Visual Notes:**
- **One button, two forms:** Chip (rounded pill) ↔ Tab (folder tab)
- Button transforms via CSS transition between forms
- Tab and panel share same light grey background (`#E5E7EB`)
- Tab has no bottom border - visually merges with panel
- Panel has square top-left corner where tab connects
- Clicking "x" clears What-If, which automatically closes panel and transforms button back to chip

## Success Metrics

1. **Visual clarity** - Users understand What-If is part of Current layer (folder tab makes this obvious)
2. **State awareness** - Users see when What-If is active via tab presence
3. **No confusion** - Window bar and Current layer What-If work together harmoniously
4. **Smooth UX** - Animations are fluid and purposeful (200ms, not jarring)
5. **Accessibility** - Fully keyboard navigable and screen reader friendly
6. **Reduced clicks** - Panel auto-shows when What-If applied, reducing manual toggling
7. **Clear mental model** - "Clear What-If = panel disappears" is intuitive

---

## Design Summary

### Core Concept
A **folder tab chip** in the Current layer row that provides access to the What-If control panel. The chip is always visible and reads as part of the "Current" title (using the same font size), creating the visual impression: **"Current [+ What if]"**. Clicking it opens/closes the panel. The tab and panel share a light grey background, creating a cohesive visual unit with the folder tab metaphor while matching the Scenarios panel aesthetic.

### Key Design Decisions

1. **Single transforming button**
   - One button element that transforms between chip and tab states
   - Always visible in Current row (provides access to What-If)
   - Chip state: Rounded pill, clicking opens panel
   - Tab state: Folder tab, clicking clears What-If
   - Smooth CSS transition between states (200ms)

2. **Inline folder tab visual**
   - Button stays horizontally inline with Current row elements
   - When expanded, morphs into folder tab that extends down to panel
   - Border-radius changes: `12px` (chip) → `6px 6px 0 0` (tab)
   - Bottom border disappears on tab to connect with panel
   - Matching backgrounds create unified appearance

3. **Light grey color scheme**
   - Background: `#E5E7EB` (gray-200)
   - Border: `#D1D5DB` (gray-300)
   - Text: `#374151` (gray-700)
   - Matches color temperature of Scenarios panel elements
   - Slightly darker than panel background for subtle distinction

4. **Clear What-If = Close Panel**
   - Clicking "x" on tab **clears What-If DSL**
   - Clearing What-If **automatically closes panel**
   - Panel auto-closes via useEffect when DSL becomes empty
   - Tab transforms back to chip when panel closes
   - Simple, predictable: remove What-If → panel disappears

5. **Dual access**
   - Window bar What-If button still available
   - Current layer button provides persistent, visible access
   - Both synchronized to same underlying `whatIfDSL` state
   - Applying What-If from window bar auto-expands panel in Current layer

### Benefits

- **Visual clarity:** Folder tab makes What-If's relationship to Current layer obvious
- **Always discoverable:** Button always visible, not hidden when inactive
- **Reads as part of title:** Same font size as "Current" - user reads as "Current [+ What if]"
- **Simple mental model:** One button, two states - chip (open) or tab (clear)
- **Intuitive interaction:** Clear What-If = panel disappears (direct cause and effect)
- **Cohesive design:** Tab and panel form unified visual element via matching colors
- **Smooth transformation:** Button morphs between states with CSS transition
- **Subtle when collapsed:** Can be less pronounced in collapsed state to blend with title

---

**Status:** Design approved for implementation  
**Author:** Assistant  
**Date:** 2025-11-20  
**Next Steps:** Proceed to implementation (Phase 1-3)

