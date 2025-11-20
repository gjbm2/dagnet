# Sidebar Selector UX: Nudging Without Mandating

## The Design Challenge

**Goal**: Encourage users to select from registry (parameters/contexts/cases/nodes) when appropriate, BUT don't mandate it - allow free-form text entry too.

**Why this matters**:
- Registry provides validation, autocomplete, reuse
- But sometimes users need to experiment, prototype, or work outside the registry
- Heavy-handed validation kills creativity and flow
- Need to find the balance: **guide, don't gate**

---

## Current Behavior Analysis

Looking at `PropertiesPanel.tsx` line 816-913, the current case node UI shows TWO modes:

```typescript
// Case node has two modes:
{caseMode === 'registry' ? (
  <select value={caseData.parameter_id} ...>
    <option value="">Select a parameter...</option>
    <option value="param1">Parameter 1</option>
  </select>
) : (
  <div>
    {/* Manual variant editing */}
  </div>
)}
```

**Problem with current approach**:
- Hard toggle between "registry" and "manual"
- Can't easily see registry options while in manual mode
- Can't easily enter custom value while in registry mode

---

## Proposed UX Pattern: Hybrid Input with Suggestions

### Pattern 1: Combobox (Recommended)

A **combobox** (combo of dropdown + text input) lets users:
- Type freely (manual mode)
- See suggestions from registry (guided mode)
- Pick from list OR type custom value

```
┌─────────────────────────────────────────┐
│ Parameter ID                             │
├─────────────────────────────────────────┤
│ [checkout-completion________]      ▼   │  ← Text input + dropdown button
│                                         │
│ User types "check" →                    │
│   ┌───────────────────────────────┐    │
│   │ Suggestions from registry:    │    │
│   │ ✓ checkout-completion     📄  │    │  ← Has file, active
│   │ ✓ checkout-initiated      📄  │    │
│   │ ⚠ checkout-abandoned      ⭘  │    │  ← In registry, no file
│   │ ────────────────────────────  │    │
│   │ ℹ️ Type to use custom value   │    │  ← Can also type anything!
│   └───────────────────────────────┘    │
└─────────────────────────────────────────┘
```

**Visual Indicators**:
- ✓ + 📄 = In registry, has file (best option)
- ⚠ + ⭘ = In registry, no file (should create file)
- No icon = Custom value (not in registry)

**Behavior**:
- As user types, filter suggestions in real-time
- Clicking dropdown shows ALL registry items
- Pressing Enter commits current text (even if not in registry)
- Tab key cycles through suggestions
- Escape closes suggestions

### Pattern 2: Input with Inline Badge

Shows validation status inline, doesn't block input:

```
┌─────────────────────────────────────────┐
│ Parameter ID                             │
├─────────────────────────────────────────┤
│ [checkout-completion________] ✓ Active  │  ← Known good value
│ [my-custom-param____________] ⚠ Unknown │  ← Not in registry
│ [checkout-abandon___________] ⚠ No file │  ← Registry, needs file
└─────────────────────────────────────────┘
```

**Badges**:
- ✓ Active = In registry, has file
- ⚠ Unknown = Not in registry (still valid!)
- ⚠ No file = In registry but no detail file
- ℹ️ Planned = In registry, marked as planned

### Pattern 3: Input with Helper Dropdown (Current but Enhanced)

Keep text input simple, add small dropdown button for "browse registry":

```
┌─────────────────────────────────────────────────┐
│ Parameter ID                                    │
├─────────────────────────────────────────────────┤
│ [____________________________]  [📋 Browse...]  │
│                                                 │
│ Click Browse → Modal with:                      │
│   - Search/filter                               │
│   - Full list with descriptions                 │
│   - "Create new..." option                      │
└─────────────────────────────────────────────────┘
```

---

## Recommended Approach: Progressive Disclosure

Use **Pattern 1 (Combobox)** with progressive disclosure of validation:

### Level 1: Typing (No Interruption)
```
[checkout-complet_______]

- User can type anything
- No validation shown yet
- Feels free-form
```

### Level 2: Pause (Show Suggestions)
```
[checkout-completion____]  ▼
  ┌─────────────────────────────┐
  │ checkout-completion     ✓   │
  │ checkout-abandoned      ⚠   │
  └─────────────────────────────┘

- After 300ms pause, show suggestions
- Non-intrusive
- Can ignore and keep typing
```

### Level 3: Blur (Show Validation)
```
[my-custom-param________]  ⚠ Not in registry

- When leaving field, show validation badge
- Doesn't prevent saving
- Just informational
```

### Level 4: Save (Offer Help)
```
Graph saved successfully!

ℹ️ Note: "my-custom-param" is not in the registry.
   [Add to registry] [Keep as-is]

- After save, gentle suggestion
- Optional action
- Doesn't block workflow
```

---

## Component API Design

### ParameterSelector Component

```typescript
interface ParameterSelectorProps {
  // Core props
  type: 'parameter' | 'context' | 'case' | 'node';
  value: string;
  onChange: (value: string) => void;
  
  // Validation mode
  validationMode?: 'strict' | 'warning' | 'none';
  // - strict: Must be in registry (shows error, disables save)
  // - warning: Prefer registry (shows warning badge)
  // - none: Free-form (no validation, no suggestions)
  
  // UI preferences
  showSuggestions?: boolean;     // Show autocomplete dropdown
  showValidationBadge?: boolean; // Show inline status badge
  showBrowseButton?: boolean;    // Add "Browse..." button
  
  // Customization
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  
  // Callbacks
  onSelect?: (item: RegistryEntry) => void;  // Called when picking from registry
  onCreate?: () => void;                      // Called when "Create new..." clicked
}

// Usage in PropertiesPanel:
<ParameterSelector
  type="parameter"
  value={edge.p?.parameter_id || ''}
  onChange={(id) => updateEdge('p.parameter_id', id)}
  validationMode="warning"  // ← Key choice!
  showSuggestions={true}
  showValidationBadge={true}
  placeholder="e.g. checkout-completion or custom"
/>
```

### Validation Modes Compared

| Mode | Enforces Registry | Shows Warnings | Allows Custom | Best For |
|------|-------------------|----------------|---------------|----------|
| `strict` | ✅ Yes | ✅ Error | ❌ No | Production graphs with strict governance |
| `warning` | ❌ No | ✅ Warning | ✅ Yes | **Default - balance of guidance + freedom** |
| `none` | ❌ No | ❌ No | ✅ Yes | Experimental/prototype graphs |

---

## Contextual Nudging

Different fields have different needs:

### Edge Probability Parameter
```typescript
<ParameterSelector
  type="parameter"
  value={edge.p?.parameter_id}
  onChange={(id) => updateEdge('p.parameter_id', id)}
  validationMode="warning"      // ← Suggest but don't enforce
  showSuggestions={true}
  placeholder="Select parameter or enter custom"
/>
```

**Rationale**: Users often prototype with literal values, later parameterize

### Case Node ID
```typescript
<ParameterSelector
  type="case"
  value={node.case?.id}
  onChange={(id) => updateNode('case.id', id)}
  validationMode="warning"      // ← Warn if not in registry
  showSuggestions={true}
  placeholder="Select case from registry"
/>
```

**Rationale**: Cases are usually managed centrally, but allow ad-hoc for testing

### Node ID (Future)
```typescript
<ParameterSelector
  type="node"
  value={node.id}
  onChange={(id) => updateNode('id', id)}
  validationMode="none"         // ← Totally free-form!
  showSuggestions={true}        // ← But still suggest from registry
  placeholder="Enter node ID"
/>
```

**Rationale**: Node IDs are part of graph structure, must be flexible

---

## Visual Language

### Consistent Icon System

| Icon | Meaning | Colour | Usage |
|------|---------|-------|-------|
| ✓ | Valid, has file | Green | Item exists in registry with detail file |
| ⚠ | Warning | Orange | Item in registry but no file, or custom value |
| ℹ️ | Info | Blue | Helpful tip, planned item |
| ❌ | Error | Red | Invalid (only in strict mode) |
| 📄 | Has file | Gray | Detail file exists |
| ⭘ | No file | Gray | No detail file yet |
| 📋 | Browse | Gray | Opens registry browser |

### Subtle Visual Hierarchy

```
High confidence (in registry, has file):
┌────────────────────────────────┐
│ [checkout-completion_] ✓       │  ← Green checkmark, calm
└────────────────────────────────┘

Medium confidence (in registry, no file):
┌────────────────────────────────┐
│ [checkout-abandoned__] ⚠ No file│ ← Orange, but not alarming
└────────────────────────────────┘

Low confidence (custom value):
┌────────────────────────────────┐
│ [my-custom-value_____] ⚠ Custom│ ← Orange, informational
└────────────────────────────────┘

Invalid (strict mode only):
┌────────────────────────────────┐
│ [invalid-value_______] ❌ Error│ ← Red border, red text
└────────────────────────────────┘
```

---

## Interaction Patterns

### Pattern: Type-to-Filter
```
User types: "ch"
  ↓
[ch_______________________]  ▼
  ┌─────────────────────────────┐
  │ checkout-completion     ✓   │
  │ checkout-initiated      ✓   │
  │ checkout-abandoned      ⚠   │
  │ channel-attribution     ✓   │ ← Also matches!
  └─────────────────────────────┘
  
Filter by:
- ID starts with "ch"
- OR tags contain "ch"
- OR description contains "ch"
```

### Pattern: Click-to-Browse
```
User clicks dropdown button:
  ↓
[checkout-completion_____]  [▼]
  ┌───────────────────────────────────────┐
  │ 🔍 [Search...]                        │
  ├───────────────────────────────────────┤
  │ Parameters (12)                       │
  │   ✓ checkout-completion           📄 │
  │   ✓ checkout-initiated            📄 │
  │   ⚠ checkout-abandoned            ⭘ │
  │   ✓ conversion-rate-baseline      📄 │
  │   ...                                 │
  ├───────────────────────────────────────┤
  │ ➕ Create new parameter...            │
  └───────────────────────────────────────┘
  
Shows:
- All items of this type
- Search box for filtering
- Status indicators
- "Create new..." at bottom
```

### Pattern: Smart Paste
```
User pastes: "checkout-completion"
  ↓
System checks registry
  ↓
[checkout-completion_____] ✓ Active

Auto-validates on paste
```

---

## Accessibility Considerations

### Keyboard Navigation
- `Tab` / `Shift+Tab`: Move between fields
- `Down Arrow`: Open suggestions (if closed)
- `Up/Down Arrow`: Navigate suggestions
- `Enter`: Select highlighted suggestion
- `Escape`: Close suggestions, keep current value
- `Ctrl+Space`: Force open suggestions

### Screen Reader Support
```html
<div role="combobox" aria-expanded="true" aria-haspopup="listbox">
  <input
    type="text"
    aria-autocomplete="list"
    aria-controls="parameter-suggestions"
    aria-activedescendant="option-checkout-completion"
  />
  <ul id="parameter-suggestions" role="listbox">
    <li id="option-checkout-completion" role="option" aria-selected="true">
      checkout-completion
      <span aria-label="Status: Active with file">✓ 📄</span>
    </li>
  </ul>
</div>
```

### Visual Indicators Must Be Paired With Text
```
❌ Bad:  [checkout_] ✓
✅ Good: [checkout_] ✓ Active

❌ Bad:  [custom___] ⚠
✅ Good: [custom___] ⚠ Not in registry
```

---

## Implementation Strategy

### Phase 1: Basic Combobox (No Validation)
```typescript
<input
  type="text"
  value={value}
  onChange={(e) => onChange(e.target.value)}
  list="parameter-suggestions"
/>
<datalist id="parameter-suggestions">
  {registryItems.map(item => (
    <option key={item.id} value={item.id} />
  ))}
</datalist>
```

**Pros**: Native HTML, accessible out of the box  
**Cons**: Limited styling, no rich UI

### Phase 2: Custom Combobox (With Validation)
```typescript
<Combobox
  options={registryItems}
  value={value}
  onChange={onChange}
  renderOption={(item) => (
    <div>
      {item.id}
      <StatusBadge status={item.status} hasFile={!!item.file_path} />
    </div>
  )}
  filterOption={(item, query) =>
    item.id.includes(query) || item.tags?.some(t => t.includes(query))
  }
/>
```

**Pros**: Full control, rich UI, validation  
**Cons**: More code, accessibility requires work

### Phase 3: Radix UI (Recommended)
Use `@radix-ui/react-select` or `@radix-ui/react-combobox`:

```typescript
import { Combobox } from '@radix-ui/react-combobox';

<Combobox.Root value={value} onValueChange={onChange}>
  <Combobox.Trigger>
    <Combobox.Input />
    <Combobox.Icon />
  </Combobox.Trigger>
  
  <Combobox.Content>
    <Combobox.Viewport>
      {filteredItems.map(item => (
        <Combobox.Item key={item.id} value={item.id}>
          {item.id}
          <StatusBadge status={item.status} />
        </Combobox.Item>
      ))}
    </Combobox.Viewport>
  </Combobox.Content>
</Combobox.Root>
```

**Pros**: Accessible, composable, well-tested  
**Cons**: Radix overhead, learning curve

---

## Validation Mode Selector

### Location: Edit Menu

Add validation mode selector to Edit menu for easy access:

```
Edit
├─ Undo                    Ctrl+Z
├─ Redo                    Ctrl+Y
├─ ───────────────────────
├─ Cut                     Ctrl+X
├─ Copy                    Ctrl+C
├─ Paste                   Ctrl+V
├─ ───────────────────────
├─ Validation Mode         ▶
│  ├─ ● Warning (Default)      - Suggest registry, allow custom
│  ├─ ○ Strict                 - Require registry IDs
│  └─ ○ None                   - Free-form, no suggestions
└─ ───────────────────────
```

### Implementation in EditMenu.tsx

```typescript
// Add to EditMenu state
const [validationMode, setValidationMode] = useState<'warning' | 'strict' | 'none'>('warning');

// Store in localStorage for persistence
useEffect(() => {
  const saved = localStorage.getItem('dagnet:validationMode');
  if (saved) setValidationMode(saved as any);
}, []);

useEffect(() => {
  localStorage.setItem('dagnet:validationMode', validationMode);
}, [validationMode]);

// Menu items
<MenubarSub>
  <MenubarSubTrigger>Validation Mode</MenubarSubTrigger>
  <MenubarSubContent>
    <MenubarRadioGroup value={validationMode} onValueChange={setValidationMode}>
      <MenubarRadioItem value="warning">
        Warning (Default)
        <span style={{ fontSize: '12px', color: '#666', marginLeft: '8px' }}>
          Suggest registry, allow custom
        </span>
      </MenubarRadioItem>
      <MenubarRadioItem value="strict">
        Strict
        <span style={{ fontSize: '12px', color: '#666', marginLeft: '8px' }}>
          Require registry IDs
        </span>
      </MenubarRadioItem>
      <MenubarRadioItem value="none">
        None
        <span style={{ fontSize: '12px', color: '#666', marginLeft: '8px' }}>
          Free-form, no suggestions
        </span>
      </MenubarRadioItem>
    </MenubarRadioGroup>
  </MenubarSubContent>
</MenubarSub>
```

### Context Provider for Global Access

Create ValidationContext to make mode available app-wide:

```typescript
// contexts/ValidationContext.tsx
interface ValidationContextValue {
  mode: 'warning' | 'strict' | 'none';
  setMode: (mode: 'warning' | 'strict' | 'none') => void;
}

const ValidationContext = createContext<ValidationContextValue | null>(null);

export function ValidationProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<'warning' | 'strict' | 'none'>(() => {
    const saved = localStorage.getItem('dagnet:validationMode');
    return (saved as any) || 'warning';
  });

  useEffect(() => {
    localStorage.setItem('dagnet:validationMode', mode);
  }, [mode]);

  return (
    <ValidationContext.Provider value={{ mode, setMode }}>
      {children}
    </ValidationContext.Provider>
  );
}

export function useValidationMode() {
  const context = useContext(ValidationContext);
  if (!context) throw new Error('useValidationMode must be used within ValidationProvider');
  return context;
}
```

### Usage in PropertiesPanel

```typescript
import { useValidationMode } from '../../contexts/ValidationContext';

function PropertiesPanel() {
  const { mode: validationMode } = useValidationMode();
  
  return (
    <ParameterSelector
      type="parameter"
      value={edge.p?.parameter_id || ''}
      onChange={(id) => updateEdge('p.parameter_id', id)}
      validationMode={validationMode}  // ← Uses global setting
      showSuggestions={true}
      placeholder="Select parameter or enter custom"
    />
  );
}
```

---

## Summary: The "Nudging" Philosophy

### ✅ DO:
- Show suggestions when user pauses typing
- Display validation badges after blur/save
- Make registry items easy to discover
- Provide clear visual hierarchy (in registry vs. custom)
- Allow free-form text entry
- Offer quick "Create new..." from dropdown

### ❌ DON'T:
- Block saving with validation errors (unless strict mode)
- Force users to pick from registry
- Show intrusive modals mid-typing
- Hijack user input (autocomplete without consent)
- Make custom values feel "wrong"

### 🎯 GOAL:
**"Make the right thing easy, not the only thing possible"**

---

**Key Insight**: The validation mode should default to `warning`, not `strict`. This gives users:
1. **Freedom** to experiment and prototype
2. **Guidance** via suggestions and badges
3. **Path to formalization** when ready (create registry entry)

The sidebar becomes a **collaborative guide**, not a **gatekeeper**.

