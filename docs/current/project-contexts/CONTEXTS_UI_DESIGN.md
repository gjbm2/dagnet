# Contexts UI Design — Final Proposal

**Part of**: Contexts v1 implementation  
**Status**: Final design specification  
**Date**: 23-Nov-2025  
**Last Updated**: 24-Nov-2025

**See also**:
- `README.md` — Overview and navigation for all contexts documentation
- `CONTEXTS_ARCHITECTURE.md` — Data model, terminology (sliceDSL, currentQueryDSL, dataInterestsDSL)
- `CONTEXTS_REGISTRY.md` — otherPolicy impact on UI dropdowns and value lists
- `CONTEXTS_AGGREGATION.md` — AggregationResult status mapping to UI behavior
- `CONTEXTS_TESTING_ROLLOUT.md` — Phase 3: UI components implementation and testing

---

## Design Summary

**Single-line toolbar** with enhanced Monaco chips:

1. **Context chips inline** (using QueryExpressionEditor): `[ channel: google ▾ ✕ ][ browser: chrome ▾ ✕ ]`
2. **Per-chip `▾` dropdown**: Click to swap/multi-select values for that specific key (Apply/Cancel)
3. **`[+ Context ▾]` or `[+ ▾]` button**: 
   - Full label when empty, compact when contexts exist
   - Opens accordion dropdown with all key:value pairs from pinned query
   - **Auto-uncheck** behavior: Selecting from one key clears other keys (nudges away from Cartesian products)
   - Allows explicit combos via "Specific" section
4. **Text editing**: Click between chips → Monaco edit mode (advanced users can force any combo)
5. **`[⤵]` unroll**: Expands to show full DSL as chips + `[Pinned query]` button (with tooltip)

**Key principle**: Extend existing QueryExpressionEditor with per-chip dropdowns; shared `ContextValueSelector` component for all dropdowns (per-chip and Add Context).

**Progressive disclosure**:
- Level 1: See chips at a glance
- Level 2: Click `▾` on chip → quick value swap via checkboxes
- Level 3: Click `[+▾]` → add new keys
- Level 4: Click into text → Monaco edit mode
- Level 5: Click `[⤵]` → full DSL editor + graph config access

---

## WindowSelector Toolbar (Single Line)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ [Today][7d][30d][90d] │ [Jan 1-Mar 31] │ [channel:google ▾✕][browser:chrome ▾✕] [+▾] [⤵] [Fetch] │
└───────────────────────────────────────────────────────────────────────────────┘
  Date presets            Date picker         Context chips (dynamic width)      Add  Unroll Fetch
                                             Each chip has ▾ for value swap
```

**All on one line**, no wrapping (or wraps to 2 lines gracefully if many contexts).

**Note**: What-if has been moved to the Scenarios panel (where it belongs logically). WindowSelector now focuses purely on **query/data selection** (dates + contexts).

---

## Visual Comparison

### Current WindowSelector (Actual Implementation)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [Context] | [Today][7d][30d][90d] [Jan 1-Mar 31] [Fetch] | [What-if…3]           │
└──────────────────────────────────────────────────────────────────────────────────┘
  Placeholder   Date presets        Date picker    Fetch        What-if
```

**Current state**:
- Context button exists but shows "Coming soon" dropdown
- Date presets: Today, 7d, 30d, 90d
- What-if button (will be removed)

### Proposed: With Contexts Implemented

**Empty state** (no contexts):

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ [Today][7d][30d][90d] [Jan 1-Mar 31] [+ Context ▾] [⤵] [Fetch]              │
└─────────────────────────────────────────────────────────────────────────────┘
  Date presets          Date picker     Add context  Unroll
```

**With 1 Context**:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [Today][7d][30d][90d] [Jan 1-Mar 31] [channel:google ▾✕] [+ ▾] [⤵] [Fetch]  │
└──────────────────────────────────────────────────────────────────────────────┘
                                       ~140px Monaco       Compact button now
```

**With 2 Contexts**:

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ [Today][7d][30d][90d] [Jan 1-Mar 31] [channel:google ▾✕][browser:chrome ▾✕] [+ ▾] [⤵] [Fetch] │
└───────────────────────────────────────────────────────────────────────────────────────┘
                                       ~260px Monaco                  Compact button
```

**With Multiple Values (contextAny)**:

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [Today][7d][30d][90d] [Jan 1-Mar 31] [channel:google,meta ▾✕][browser:chrome ▾✕] [+ ▾] [⤵] [Fetch] │
└──────────────────────────────────────────────────────────────────────────────────────┘
                                       ~280px Monaco
```

**With Many Contexts** (grows up to max, then clamps):

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ [Today][7d][30d][90d] [Jan 1-Mar 31] [ch:google,meta ▾✕][br:chrome ▾✕][src:fb ▾✕] [+ ▾] [⤵] [Fetch] │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
                                       ~400-450px Monaco (max width, then wraps or overflows)
```

**Changes from current**:
- ✗ Remove placeholder "Context" button
- ✗ Remove What-if button (moved to Scenarios panel)
- ✓ Add Monaco DSL component (dynamic width, empty when no contexts)
- ✓ Add `[+ Context ▾]` button (changes to `[+ ▾]` when contexts exist)
- ✓ Add `[⤵]` Unroll button
- ✓ Cross-key combinations naturally handled via `[Fetch]` button appearance (no special warnings)

**Smooth growth**: Monaco component width transitions smoothly (0.2s ease-out) as chips added/removed.

---

## Components Breakdown

### 1. Context Chips (Enhanced Monaco with Dynamic Width)

**Component**: Extended **`QueryExpressionEditor`** with enhanced context chip rendering

**Position**: Between date picker and Add/Unroll buttons (right side of toolbar)

**Each context chip shows**:

```
[ channel: google  ▾  ✕ ]
         ↑         ↑  ↑
      value     swap remove
```

**Chip interactions**:
- **Click `▾` on chip** → Opens **value dropdown** for that specific key (see below)
- **Click `✕` on chip** → Removes that entire context constraint
- **Click chip body** (text area) → Enters Monaco edit mode (advanced users can type)

**Dynamic width behavior**:

The Monaco DSL component **grows smoothly** as contexts are added:

- **Empty state** (no contexts): 
  - Width: ~60px (minimal)
  - Shows subtle placeholder: `[add context…]` in light grey
  - Clicking opens Add Context dropdown
  
- **1 context**: 
  - Width: ~140px
  - `[ channel: google ▾ ✕ ]`
  
- **2 contexts**: 
  - Width: ~260px
  - `[ channel: google ▾ ✕ ][ browser: chrome ▾ ✕ ]`
  
- **3 contexts or contextAny with multiple values**:
  - Width: ~350-400px
  - `[ channel: google,meta ▾ ✕ ][ browser: chrome ▾ ✕ ][ source: facebook ▾ ✕ ]`
  
- **Max width**: ~450px (clamped to avoid dominating toolbar)
  - After max, **either**:
    - Allow toolbar to wrap to 2 lines (WindowSelector height becomes 60-70px), OR
    - Show first 2-3 chips + `[+2 more ▾]` overflow indicator

**Implementation**:

```css
.context-dsl-display {
  display: inline-flex;
  align-items: center;
  min-width: 60px;
  max-width: min(450px, 40vw);  /* Never more than 40% of viewport width */
  flex-grow: 0;
  flex-shrink: 1;  /* Can shrink if toolbar is tight */
  transition: width 0.2s ease-out;
}

/* Parent toolbar allows wrapping if needed */
.window-selector-main {
  display: flex;
  flex-wrap: wrap;  /* Allow 2-line layout if necessary */
  gap: 8px;
}
```

**Responsive strategy**:
- **Wide screens** (>1400px): Chips inline, grows to ~450px max
- **Medium screens** (900-1400px): Chips inline, max-width adapts via `40vw`
- **Narrow screens** (<900px): Toolbar wraps; context chips get full second line if needed
- **Very narrow** (<600px): Fallback to compact button `[ Contexts: 3 ▾ ]` (collapse to count only)

**Why this works**:
- Most users will have 1-3 contexts at a time (typical use case)
- WindowSelector component can gracefully expand height if needed
- Smooth transitions make resizing feel natural, not jarring

**Binding**: Bound to **context portion** of `currentQueryDSL` only (not including `window(...)`)

---

### 2. Per-Chip Value Dropdown

**Trigger**: Clicking `▾` on any context chip

**Anchored to**: That specific chip

**Content**:

```
┌─────────────────────┐
│ Channel             │
├─────────────────────┤
│ ☑ google            │  ← Currently selected
│ ☐ meta              │
│ ☐ other             │
│ ☐ direct            │
│                     │
│ [Apply]  [Cancel]   │
└─────────────────────┘
```

**Behavior**:
- Shows all values for that key (from context registry via `dataInterestsDSL`)
- Current value(s) checked on open
- User checks/unchecks values (multi-select always enabled)
- **Changes are draft** until Apply clicked
- **Chip doesn't change** while dropdown is open

**Commit logic**:
- Click **[Apply]**:
  - Close dropdown
  - Update chip based on selection:
    - **0 values checked** → Remove chip (no constraint)
    - **1 value** → `context(channel:meta)`
    - **2+ values** → `contextAny(channel:google,meta)`
    - **All values checked** → Remove chip (equivalent to no filter) + brief tooltip: "All values selected = no filter"
  - Update `currentQueryDSL`
  - **Check data coverage** for new context + date combination:
    - If data cached → Aggregate and display instantly
    - If data NOT cached → Show `[Fetch]` button (user must explicitly click to fetch)
  
- Click **[Cancel]**:
  - Close dropdown
  - Abandon changes (revert to state when dropdown opened)
  - Chip stays as-is
  
- Click **outside dropdown**:
  - Same as Cancel (abandon changes)
  - Explicit Apply required to commit

**Smart behavior**:
- If chip already represents `contextAny(channel:google,meta)`, dropdown opens with both checked
- User can check more or uncheck some; Apply commits the change

---

### 3. Add Context Dropdown

**Component**: Generalized context value selector (same class as per-chip dropdown, extended for multi-key)

**Trigger button**:
- **Position**: Immediately after the last context chip (or after Monaco component if no chips)
- **Label**:
  - When no contexts selected: `[+ Context ▾]` (full label)
  - When contexts exist: `[+ ▾]` (compact)

**Behavior**:
- Click → Opens dropdown showing **all available key:value pairs** from `dataInterestsDSL`
- Organized by key with **accordion sections** (collapsible)
- Includes a "Specific Combinations" section for explicit multi-key combos from pinned query
- User checks values; Apply commits

**Key principle**: Selecting from one key section **auto-unchecks other key sections**, nudging away from Cartesian products unless explicitly pinned

**Dropdown structure** (example with pinned query: `context(channel);context(browser-type);context(channel:google,browser-type:chrome)`):

```
┌──────────────────────────────────────────────┐
│ Add Context                                  │
├──────────────────────────────────────────────┤
│ ▾ Browser Type                               │
│   ☐ Chrome                                   │
│   ☐ Safari                                   │
│   ☐ Other                                    │
│                                              │
│ ▸ Channel                                    │  ← Collapsed
│                                              │
│ ▸ Specific                                   │  ← Collapsed (only shown if pinned has combos)
│                                              │
│ [Apply]  [Cancel]                            │
└──────────────────────────────────────────────┘
```

**When "Channel" accordion expanded**:

```
│ ▾ Channel                                    │
│   ☐ Google                                   │
│   ☐ Facebook                                 │
│   ☐ Other                                    │
```

**When "Specific" accordion expanded** (only if pinned query has explicit combos):

```
│ ▾ Specific                                   │
│   ☐ Browser: Chrome & Channel: Google       │  ← From context(channel:google,browser-type:chrome)
```

**Accordion sections derived from pinned query**:
- `context(channel)` → "Channel" section
- `context(browser-type)` → "Browser Type" section  
- `context(channel:google,browser-type:chrome)` → "Specific" section **only if such combos exist in pinned query**

**If pinned query is just** `context(channel);context(browser-type)`:
- Dropdown shows only "Browser Type" and "Channel" sections
- NO "Specific" section (none defined)

**Selection behavior (enforces pinned scope via UI)**:

**Core principle**: The checkbox UI **only allows selections that are explicitly in the pinned query**. Arbitrary multi-key combinations outside pinned scope require Monaco DSL editing.

**Within same accordion section**: Multiple selections allowed

- User expands "Browser Type"
- Checks "Chrome" → `☑ Chrome`
- Checks "Safari" → `☑ Chrome ☑ Safari` (both checked)
- Will create `contextAny(browser-type:chrome,safari)` on Apply

**Across different accordion sections**: Mutually exclusive (auto-uncheck and collapse)

- User has `☑ Chrome ☑ Safari` checked under **expanded** "Browser Type" section
- User expands "Channel" section
- **Immediately upon expansion**:
  - "Browser Type" section **collapses** (rolls up)
  - All checkboxes in Browser Type **auto-uncheck** (Chrome and Safari cleared)
- User checks "Facebook" under Channel: `☑ Facebook`
- On Apply: Creates `context(channel:facebook)` chip only
- **No warning/message** — silent mutual exclusion

**"Specific" section behaves identically**:

- User expands "Specific" section
- **All other sections collapse and uncheck** (Channel, Browser Type, etc.)
- User checks `☐ Browser: Chrome & Channel: Google`
- On Apply: Creates `context(channel:google).context(browser-type:chrome)` (both chips)
- This is allowed because it's **explicitly in the pinned query**

**Result**: 
- Checkbox UI constrains user to **exactly the context slices defined in `dataInterestsDSL`**
- No way to create arbitrary multi-key combos via checkboxes
- Forces intentional use of Monaco for off-pinned-path queries
- Simpler UX (one section active at a time); enforces data governance (only fetch pinned slices)

**Apply/Cancel**:
- Click **[Apply]**:
  - Commit all checked values
  - Add appropriate chips based on selection:
    - 1 value in 1 key → `context(key:value)` chip
    - Multiple values in 1 key → `contextAny(key:v1,v2)` chip
    - Specific combo checked → Multiple `context(...)` chips (e.g., `context(channel:google).context(browser-type:chrome)`)
  - Close dropdown
  - Check coverage → show data or `[Fetch]`
  
- Click **[Cancel]** or click outside:
  - Abandon all changes
  - Close dropdown

**Implementation**: 
- **Shared component**: `ContextValueSelector` (NEW)
  - Used for both per-chip dropdown (single key) and Add Context dropdown (multi-key)
  - Props: `mode: 'single-key' | 'multi-key'`, `availableKeys`, `currentSelection`, etc.
  - Accordion rendering when in `multi-key` mode
  - Auto-uncheck logic when in `multi-key` mode
- Renders checkboxes, Apply/Cancel buttons, handles accordion state
- Anchored to trigger button/chip via popover positioning

---


## Unrolled State (Full DSL Editor)

Clicking `[⤵]` at far right of toolbar expands WindowSelector **downward**:

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ [Today][7d][30d][90d] │ [Jan 1-Mar 31] │ [ch:google ▾✕][br:chrome ▾✕] [+ ▾] [▴] [Fetch] │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ Full query: [context:channel:google ✕][context:browser-type:chrome ✕][window:1-Jan-31-Mar ✕]  │  [Pinned query] │
└───────────────────────────────────────────────────────────────────────────────────────┘
              ↑ Query DSL as chips (editable)                                               ↑ Hover shows tooltip
```

**Extended area (one line)**:
- **Left**: "Full query:" label + `currentQueryDSL` displayed as chips (using QueryExpressionEditor or similar)
  - Shows contexts + window combined
  - Fully editable (click to enter Monaco mode, or click chip `✕` to remove)
  - Chips can be individually removed or edited
  
- **Separator**: `│` divider

- **Right**: `[Pinned query]` button
  - **Hover**: Tooltip shows `dataInterestsDSL` string (e.g., "context(channel);context(browser-type).window(-90d:)")
  - **Click**: Opens modal for editing `dataInterestsDSL`
  - Clearly separated from current query (visual and spatial distinction)

**Collapse**: Click `[▴]` (was `[⤵]`) to collapse back to single-line mode

**Benefits of this layout**:
- **Clear distinction**: Current query (editable, left) vs Pinned config (button, right)
- **One line**: Still compact even when unrolled
- **Tooltip discoverability**: Hover shows what pinned query is without opening modal
- **Chip consistency**: Full query uses same chip pattern as toolbar (familiar)

**Alternative (if chips too wide)**: Replace chips with Monaco editor (text view):

```
├───────────────────────────────────────────────────────────────────────────────────────┤
│ Full query: │ context(channel:google).context(browser-type:chrome).window(1-Jan-31-Mar) │  │  [Pinned query] │
└───────────────────────────────────────────────────────────────────────────────────────┘
              ↑ Monaco editor (inline)                                                     ↑ Button
```

Use whichever fits better; chips are more consistent, Monaco is more compact.

---

## User Flows

### Flow 1: Add a context (most common)

1. User clicks `[+ Context ▾]` (full label when no contexts)
2. Dropdown opens with accordion sections:
   - ▾ Browser Type: ☐ Chrome, ☐ Safari, ☐ Other
   - ▸ Channel (collapsed)
   - ▸ Specific (collapsed)
3. User expands "Channel" accordion
4. User checks "Google"
5. User clicks **[Apply]**
6. Dropdown closes
7. New chip appears: `[ channel: google ▾ ✕ ]`
8. Add button changes to `[+ ▾]` (compact)
9. Query updates with `context(channel:google)`
10. System checks coverage → shows data or `[Fetch]` button

### Flow 2: Change a context value

1. User sees `[ channel: google ▾ ✕ ]` chip
2. Clicks the `▾` caret on the chip
3. Dropdown opens: ☑ google, ☐ meta, ☐ other, ☐ direct, [Apply] [Cancel]
4. User unchecks "google", checks "meta"
5. User clicks **[Apply]**
6. Dropdown closes
7. Chip updates to `[ channel: meta ▾ ✕ ]`
8. System checks data coverage:
   - If cached → Shows data instantly
   - If not cached → `[Fetch]` button appears

### Flow 3: Select multiple values (contextAny)

1. User clicks `▾` on `[ channel: google ▾ ✕ ]`
2. Dropdown opens with google checked
3. User checks "meta" as well (both now checked)
4. User clicks **[Apply]**
5. Dropdown closes
6. Chip updates to `[ channel: google,meta ▾ ✕ ]` (or `[ channel: 2 values ▾ ✕ ]` if too long)
7. DSL updates to `contextAny(channel:google,meta)`
8. System checks coverage → shows data or `[Fetch]` button

### Flow 4: Remove a context

1. User clicks `✕` on any chip
2. Chip disappears
3. Query updates (context constraint removed)

### Flow 5: Add multiple values (within same key)

1. User clicks `[+ Context ▾]`
2. Expands "Browser Type" section
3. Checks "Chrome", then also checks "Safari"
4. Both remain checked: `☑ Chrome ☑ Safari`
5. Clicks **[Apply]**
6. Chip appears: `[ browser-type: chrome,safari ▾ ✕ ]`
7. Query: `contextAny(browser-type:chrome,safari)`

### Flow 6: Auto-uncheck prevents accidental Cartesian products

1. User clicks `[+ Context ▾]`
2. Expands "Browser Type", checks "Chrome" and "Safari"
3. Currently: `☑ Chrome ☑ Safari` (in Browser Type section)
4. User expands "Channel" section and checks "Facebook"
5. **Immediately**: All Browser Type checkboxes auto-uncheck
6. Currently: `☑ Facebook` (only Channel section has selections)
7. Clicks **[Apply]**
8. Chip appears: `[ channel: facebook ▾ ✕ ]` (NOT browser-type chips)
9. This nudges user toward single-key selections (as pinned)

### Flow 7: Explicit multi-key combo (from Specific section)

1. User clicks `[+ Context ▾]`
2. Expands "Specific" section
3. Checks `☐ Browser: Chrome & Channel: Google`
4. This does NOT auto-uncheck (it's an explicit combo)
5. Clicks **[Apply]**
6. Two chips appear: `[ channel: google ▾ ✕ ][ browser-type: chrome ▾ ✕ ]`
7. Query: `context(channel:google).context(browser-type:chrome)`

### Flow 8: Advanced text editing (rare)

1. User clicks directly on the text between chips (or in empty space if no chips)
2. Monaco enters **edit mode** (chips → text)
3. User types: `context(channel:google).context(browser-type:chrome)`
4. Autocomplete suggests functions
5. On blur/save → parses back to chips: `[ channel: google ▾ ✕ ][ browser-type: chrome ▾ ✕ ]`
6. Even if this combo wasn't in pinned query, it's allowed (advanced user override)

### Flow 9: View full query (contexts + window)

1. User clicks `[⤵]` (unroll button at far right)
2. WindowSelector expands downward (one additional line)
3. Shows: "Full query: [channel:google ✕][browser:chrome ✕][window:1-Jan-31-Mar ✕]  │  [Pinned query]"
4. User can:
   - Click `✕` on any chip to remove that constraint
   - Click chip text to edit directly (Monaco mode)
   - Hover `[Pinned query]` to see tooltip: "context(channel);context(browser-type).window(-90d:)"
5. Click `[▴]` to collapse

### Flow 10: Edit pinned query (graph configuration)

1. User clicks `[⤵]` to unroll
2. Hovers over `[Pinned query]` button → Tooltip shows: "context(channel);context(browser-type).window(-90d:)"
3. Clicks `[Pinned query]` button
4. Modal opens with Monaco editor for `dataInterestsDSL`
5. User edits: `context(channel);context(browser-type);context(channel:google,browser-type:chrome).window(-90d:)`
6. Preview shows implied slices (all channel values + all browser values + specific combo)
7. Clicks **Save**
8. Modal closes
9. Updates which key:value pairs appear in Add Context dropdown accordions
10. Does NOT change current query view (only affects what gets suggested/cached overnight)

---

## Component Hierarchy

```
WindowSelector (existing, extend)
├─ Date presets (existing)
├─ DateRangePicker (existing)
├─ ContextDSLDisplay (NEW — wraps QueryExpressionEditor)
│  └─ QueryExpressionEditor (existing, EXTEND chip rendering)
│      └─ Enhanced context chips:
│          ├─ Chip body (clickable → edit mode)
│          ├─ [▾] Per-chip value dropdown (opens ContextValueSelector)
│          └─ [✕] Remove chip
├─ AddContextButton `[+ Context ▾]` or `[+ ▾]` (NEW — dynamic label)
├─ UnrollButton [⤵]/[▴] (NEW — toggle)
└─ FetchButton (existing)

When per-chip dropdown open:
└─ ContextValueSelector (NEW — anchored to specific chip)
   ├─ mode: 'single-key'
   ├─ Shows values for that key only
   ├─ Checkboxes (multi-select allowed)
   ├─ [Apply] [Cancel] buttons
   └─ Updates DSL on Apply

When Add Context dropdown open:
└─ ContextValueSelector (SAME component, different mode)
   ├─ mode: 'multi-key'
   ├─ Accordion sections per key + "Specific" section
   ├─ Auto-uncheck across keys (unless Specific section)
   ├─ [Apply] [Cancel] buttons
   └─ Adds chip(s) on Apply

When unrolled:
└─ ExtendedQueryPanel (NEW — one-line layout)
   ├─ "Full query:" label
   ├─ QueryExpressionEditor (shows full currentQueryDSL as chips)
   ├─ Separator │
   ├─ [Pinned query] button (with tooltip)
   └─ Click button → PinnedQueryModal

PinnedQueryModal:
└─ Monaco editor for dataInterestsDSL
   ├─ Preview of implied slices
   └─ [Save] [Cancel]
```

---

## Implementation Notes

### Extension to QueryExpressionEditor

**File**: `graph-editor/src/components/QueryExpressionEditor.tsx`

**Current state**: Renders chips for `from`, `to`, `visited`, `case`, etc. Already has `context` in `outerChipConfig`.

**Needed enhancement**: Per-chip dropdown trigger

```typescript
// Add to chip rendering logic (around line 1200+)
function renderContextChip(chip: ParsedQueryChip) {
  return (
    <div className="query-chip context-chip">
      <span className="chip-label">{chip.key}:</span>
      <span className="chip-value">{chip.value}</span>
      
      {/* NEW: Per-chip dropdown caret */}
      <button 
        className="chip-dropdown-trigger"
        onClick={(e) => {
          e.stopPropagation();
          openValueDropdownForChip(chip);
        }}
      >
        ▾
      </button>
      
      {/* Existing: Remove button */}
      <button 
        className="chip-remove"
        onClick={(e) => {
          e.stopPropagation();
          removeChip(chip);
        }}
      >
        ✕
      </button>
    </div>
  );
}
```

**Per-chip value dropdown**:

```typescript
interface ContextValueDropdownProps {
  chip: ParsedQueryChip;
  contextKey: string;
  availableValues: string[];  // From context registry
  currentValues: string[];    // Currently selected (might be multiple if contextAny)
  onValuesChange: (newValues: string[]) => void;
  anchorEl: HTMLElement;
}

// Simple popover component
function ContextValueDropdown({ chip, contextKey, availableValues, ... }: ContextValueDropdownProps) {
  const [multiSelect, setMultiSelect] = useState(currentValues.length > 1);
  
  const handleToggle = (value: string) => {
    if (multiSelect) {
      // Toggle in array
      const newValues = currentValues.includes(value)
        ? currentValues.filter(v => v !== value)
        : [...currentValues, value];
      onValuesChange(newValues);
    } else {
      // Single select: replace
      onValuesChange([value]);
    }
  };
  
  return (
    <div className="context-value-dropdown" style={positionBelowAnchor(anchorEl)}>
      <div className="dropdown-header">{contextKey}</div>
      {availableValues.map(value => (
        <label key={value}>
          <input 
            type="checkbox" 
            checked={currentValues.includes(value)}
            onChange={() => handleToggle(value)}
          />
          {value}
        </label>
      ))}
      <div className="dropdown-footer">
        <button onClick={() => setMultiSelect(!multiSelect)}>
          {multiSelect ? 'Single select' : 'Select multiple'}
        </button>
      </div>
    </div>
  );
}
```

**DSL update logic**:

```typescript
function updateDSLFromChipValueChange(
  chip: ParsedQueryChip,
  newValues: string[]
): string {
  // Parse current DSL
  const parsed = parseConstraintString(currentContextDSL);
  
  // Remove old constraint for this key
  parsed.contexts = parsed.contexts.filter(c => c.key !== chip.key);
  parsed.contextAnys = parsed.contextAnys.filter(ca => 
    !ca.pairs.some(p => p.key === chip.key)
  );
  
  // Add new constraint
  if (newValues.length === 1) {
    parsed.contexts.push({ key: chip.key, value: newValues[0] });
  } else if (newValues.length > 1) {
    parsed.contextAnys.push({
      pairs: newValues.map(v => ({ key: chip.key, value: v }))
    });
  }
  
  // Rebuild DSL
  return buildConstraintString(parsed);
}
```

---

### Add Context Button

```typescript
// In WindowSelector.tsx, after context chips

{/* Add Context button */}
<button 
  className="window-selector-preset add-context-button"
  onClick={() => setShowAddContextDropdown(true)}
  ref={addContextButtonRef}
>
  +▾
</button>

{showAddContextDropdown && (
  <div className="context-add-dropdown" style={positionBelowAnchor(addContextButtonRef.current)}>
    {availableKeysToAdd.map(key => (
      <button 
        key={key.id}
        onClick={() => addContextKey(key.id)}
      >
        {key.name}
      </button>
    ))}
  </div>
)}
```

**Available keys logic**:

```typescript
function getAvailableKeysToAdd(
  dataInterestsDSL: string,
  currentContextDSL: string,
  contextRegistry: ContextRegistry
): ContextDefinition[] {
  
  // Get keys implied by pinned query
  const pinnedKeys = extractContextKeysFromDSL(dataInterestsDSL);
  
  // Get keys already in current query
  const currentKeys = extractContextKeysFromDSL(currentContextDSL);
  
  // Return keys that are pinned but not yet in current query
  return pinnedKeys.filter(key => !currentKeys.includes(key));
}
```

---

### Unroll State

```typescript
const [isUnrolled, setIsUnrolled] = useState(false);

// Unroll toggle button (far right of toolbar)
<button 
  className="window-selector-preset"
  onClick={() => setIsUnrolled(!isUnrolled)}
  title="Show full query DSL"
>
  {isUnrolled ? '▴' : '⤵'}
</button>

// Extended panel (when unrolled) - ONE LINE
{isUnrolled && (
  <div className="window-selector-extended">
    <div className="extended-row">
      {/* Left: Full query as chips */}
      <div className="full-query-display">
        <span className="label">Full query:</span>
        <QueryExpressionEditor
          value={currentQueryDSL}
          onChange={setCurrentQueryDSL}
          graph={graph}
          height="32px"
          // Shows contexts + window as chips, fully editable
        />
      </div>
      
      {/* Separator */}
      <div className="separator">│</div>
      
      {/* Right: Pinned query button with tooltip */}
      <button
        className="pinned-query-button"
        onClick={() => setShowPinnedQueryModal(true)}
        title={graph.dataInterestsDSL || 'No pinned query set'}  // Tooltip shows DSL string
      >
        Pinned query
      </button>
    </div>
  </div>
)}

// Styling for one-line layout
.window-selector-extended {
  border-top: 1px solid #e0e0e0;
  padding: 8px 12px;
}

.extended-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.full-query-display {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}

.separator {
  color: #ccc;
  font-size: 18px;
}

.pinned-query-button {
  padding: 4px 12px;
  background: #f5f5f5;
  border: 1px solid #d0d0d0;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}

.pinned-query-button:hover {
  background: #e8e8e8;
}
```

---

### Pinned Query Modal

```typescript
// Modal for editing graph-level dataInterestsDSL
{showPinnedQueryModal && (
  <Modal onClose={() => setShowPinnedQueryModal(false)}>
    <div className="pinned-query-editor">
      <h3>Pinned Data Interests (Graph Configuration)</h3>
      <p>
        Controls which context slices are fetched automatically overnight
        and suggested in the Context dropdown. Does not affect current view.
      </p>
      
      <Editor
        height="120px"
        language="dagnet-query"
        value={graph.dataInterestsDSL || ''}
        onChange={(newValue) => setDraftPinnedDSL(newValue)}
      />
      
      <div className="preview">
        <strong>Implied slices:</strong>
        {/* Show enumerated key:value combos from parsed DSL */}
        <ul>
          {previewImpliedSlices(draftPinnedDSL).map(slice => (
            <li key={slice}>{slice}</li>
          ))}
        </ul>
      </div>
      
      <div className="modal-actions">
        <button onClick={savePinnedQuery}>Save</button>
        <button onClick={() => setShowPinnedQueryModal(false)}>Cancel</button>
      </div>
    </div>
  </Modal>
)}
```

---

## Summary

**Single-line toolbar. Enhanced Monaco chips. Shared dropdown component.**

**What makes this design work**:

1. **Compact & dynamic**: Chips grow from ~60px (empty) to ~450px max; smooth transitions
2. **Discoverable**: Per-chip `▾` + `[+ Context ▾]` button make interactions obvious
3. **Smart nudging**: 
   - Auto-uncheck across keys in Add Context dropdown (nudges toward single-key selections)
   - Explicit combos available via "Specific" section (for pinned multi-key slices)
   - No annoying warnings; `[Fetch]` appears naturally when needed
4. **Consistent**: Extends existing QueryExpressionEditor chip pattern
5. **Shared components**: `ContextValueSelector` used for both per-chip and Add Context dropdowns
6. **Apply/Cancel**: Draft mode prevents jarring chip resizes during interaction

**Key decisions**:

✓ **What-if removed from WindowSelector** — Now in Scenarios panel (clearer separation)  
✓ **Dynamic button label** — `[+ Context ▾]` → `[+ ▾]` after first chip added  
✓ **One-click context addition** — Add dropdown shows key:value pairs directly, not just keys  
✓ **Auto-uncheck nudging** — Selecting from new key clears previous key (silent, not blocking)  
✓ **All-values-checked = auto-remove** — Chip disappears when all values selected (semantic correctness)  
✓ **Unrolled state on one line** — Full query chips + separator + Pinned query button with tooltip  
✓ **No cross-key warnings** — Natural feedback via `[Fetch]` button only  

**Code reuse**:
- QueryExpressionEditor: Extend chip rendering with embedded `▾` button
- ContextValueSelector (NEW): Shared component for all context dropdowns (single-key, multi-key modes)
- WindowSelector dropdown pattern: Anchored popovers (established pattern)
- Monaco language: Register `contextAny` and `window` functions for autocomplete

**Future enhancement (post-v1)**: 
- Apply same chip + `▾` pattern to `window(...)` selection
- `[ window: 1-Jan-31-Mar ▾ ✕ ]` chip for non-preset ranges
- Dropdown with DateRangePicker + relative options (-7d, -30d, -90d)
- Makes entire query DSL consistently chip-based

**Progressive disclosure**:
1. View → See chips
2. Swap → `▾` on chip → checkboxes
3. Add → `[+ ▾]` → accordion dropdown
4. Remove → `✕` on chip
5. Edit → Click text → Monaco
6. Full + Config → `[⤵]` → chips + pinned query access

Everything on one line (or gracefully wraps if many contexts), maximum familiarity, minimal new code.

---

## Implementation Notes

**For implementation details**, see:
- Data model and terminology: `CONTEXTS_ARCHITECTURE.md`
- Context registry and otherPolicy: `CONTEXTS_REGISTRY.md`  
- Aggregation logic: `CONTEXTS_AGGREGATION.md`
- Implementation plan: `IMPLEMENTATION_PLAN.md`
