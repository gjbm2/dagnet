# Nodes Registry & Parameter Selector Design Document

## Executive Summary

This document outlines the design for:
1. **Nodes Registry** - A new registry type for tracking node IDs (similar to parameters/contexts/cases)
2. **Registry vs. Navigator** - Clarifying the distinction and relationship
3. **Parameter Selector Component** - Generic UI component for selecting/creating registry items
4. **Integration** - How these systems work together

## Part 1: Registry vs. Navigator - The Distinction

### The Key Insight

**Registry** and **Navigator** serve DIFFERENT but COMPLEMENTARY purposes:

#### Registry (Index Files)
- **Purpose**: Lightweight metadata catalog
- **Location**: `*-index.yaml` files in repository (e.g., `parameters-index.yaml`, `nodes-index.yaml`)
- **Contents**: 
  - ID
  - file_path (may not exist yet)
  - status
  - tags
  - created_at/updated_at
  - usage_count
  - metadata_summary
- **Use Cases**:
  - Quick lookup of available IDs
  - Validation ("does this ID exist?")
  - Autocomplete/search
  - Track items that don't have full files yet
  - Analytics and usage tracking

#### Navigator (File Browser)
- **Purpose**: Browsable file tree
- **Location**: In-memory list built from actual files in repository
- **Contents**:
  - Files that ACTUALLY EXIST in the repo
  - Full file metadata from Git API
  - isLocal flag for uncommitted files
- **Use Cases**:
  - Browsing repository structure
  - Opening files for editing
  - Showing what's available to open
  - Managing local/uncommitted files

### Critical Difference: Registry Can Contain "Planned" Items

**Example Scenario:**
```yaml
# nodes-index.yaml
nodes:
  - id: homepage
    status: active
    type: entry
    usage_count: 5
  
  - id: checkout-flow
    status: active  
    type: flow
    usage_count: 3
  
  - id: abandoned-cart
    status: planned    # <-- Not a file yet!
    type: exit
    usage_count: 0     # Referenced but not implemented
```

In this case:
- **Registry** knows about "abandoned-cart" node (it's in the index)
- **Navigator** does NOT show it (no file exists)
- **Graph editor** can reference it in expressions: `e.my-edge.visited('abandoned-cart').p.mean`
- **Validation** can warn: "Referenced node 'abandoned-cart' exists but has no definition file"

### Why This Matters

1. **Forward References**: You can reference a node in a graph before creating its detailed definition
2. **Lightweight Tracking**: Not every node needs a full YAML file with extensive metadata
3. **ID Management**: Registry is the source of truth for "what IDs exist"
4. **Separation of Concerns**: Registry = "what exists conceptually", Navigator = "what files exist physically"

## Part 2: Nodes Registry Design

### Why Nodes Need a Registry

Currently, nodes are ONLY defined within individual graph files. This creates problems:

**Problem 1: No Global Node ID Tracking**
- Each graph has its own nodes
- No way to reference a node from graph A in graph B
- No way to track "what nodes exist in our system"

**Problem 2: Can't Use Node References in Expressions**
- Want: `e.my-edge.visited('homepage').p.mean`
- Need: A registry of valid node IDs to validate against

**Problem 3: No Cross-Graph Analysis**
- Can't ask: "What graphs contain the 'checkout' node?"
- Can't track: "How many times is 'homepage' used across all graphs?"

**Problem 4: No Metadata for Nodes**
- Nodes in graphs are lightweight (id, slug, label)
- May want richer metadata (description, category, tags, ownership)

### Nodes Registry Structure

#### nodes-index.yaml (Registry File)
```yaml
version: "1.0.0"
created_at: "2025-01-28T10:00:00Z"
updated_at: "2025-01-28T15:30:00Z"

nodes:
  - id: homepage
    slug: homepage
    file_path: "nodes/homepage.yaml"  # Optional - may not exist
    status: active
    type: entry
    category: acquisition
    tags: ["landing", "seo", "paid-traffic"]
    graphs_using: ["conversion-funnel", "user-journey"]
    usage_count: 5
    created_at: "2025-01-15T10:00:00Z"
    updated_at: "2025-01-15T10:00:00Z"
    author: "growth-team"
    version: "1.0.0"

  - id: product-detail-page
    slug: pdp
    file_path: "nodes/product-detail.yaml"
    status: active
    type: conversion
    category: consideration
    tags: ["product", "browsing"]
    graphs_using: ["conversion-funnel"]
    usage_count: 3
    created_at: "2025-01-15T11:00:00Z"
    updated_at: "2025-01-15T11:00:00Z"
    author: "product-team"
    version: "1.0.0"

  - id: checkout-complete
    slug: checkout-success
    file_path: "nodes/checkout-complete.yaml"
    status: active
    type: success
    category: conversion
    outcome_type: success
    tags: ["checkout", "purchase", "conversion"]
    graphs_using: ["conversion-funnel", "checkout-flow"]
    usage_count: 7
    created_at: "2025-01-15T12:00:00Z"
    updated_at: "2025-01-15T12:00:00Z"
    author: "ecommerce-team"
    version: "1.0.0"
  
  - id: abandoned-cart
    slug: cart-abandoned
    file_path: null  # No detailed file yet - just tracking the ID
    status: planned
    type: exit
    category: abandonment
    outcome_type: failure
    tags: ["cart", "abandonment"]
    graphs_using: ["conversion-funnel"]
    usage_count: 2
    created_at: "2025-01-28T09:00:00Z"
    author: "analytics-team"
    version: "1.0.0"
```

#### nodes/homepage.yaml (Optional Detailed File)
```yaml
# Detailed node definition (optional - for nodes that need rich metadata)
id: homepage
slug: homepage
name: "Homepage / Landing Page"
type: entry
category: acquisition

description: |
  The main entry point for users arriving via SEO, paid traffic, or direct navigation.
  This is the primary landing page for new user acquisition.

metadata:
  created_at: "2025-01-15T10:00:00Z"
  updated_at: "2025-01-15T14:30:00Z"
  author: "growth-team"
  version: "1.0.0"
  status: active
  
  # Tags for categorization
  tags: ["landing", "seo", "paid-traffic", "acquisition"]
  
  # Analytics metadata
  analytics:
    tracking_events: ["page_view", "hero_click", "signup_click"]
    conversion_goals: ["sign_up", "add_to_cart"]
    funnel_stage: "awareness"
  
  # Data sources
  data_sources:
    - type: google_analytics
      property_id: "GA-12345"
      view: "homepage_traffic"
    - type: statsig
      experiment_layer: "homepage_variants"
  
  # Cost information
  costs:
    acquisition_cost:
      parameter_id: "homepage-acquisition-cpa"
      description: "Average cost per visitor to homepage"
    
  # Business context
  ownership:
    team: "growth"
    product_manager: "alice@example.com"
    engineer: "bob@example.com"
  
  # Related nodes
  relationships:
    next_steps: ["product-listing", "search", "category-browse"]
    similar_nodes: ["landing-page-a", "landing-page-b"]
    
  # A/B test variants
  variants:
    - id: control
      description: "Original homepage design"
      status: active
    - id: variant_hero
      description: "New hero image treatment"
      status: testing

# Layout defaults (for when added to graphs)
layout:
  default_colour: "#4CAF50"
  default_icon: "home"
  suggested_position: "left"

# Entry behavior (how users arrive)
entry:
  sources: ["organic_search", "paid_ads", "direct", "referral"]
  default_distribution:
    organic_search: 0.45
    paid_ads: 0.30
    direct: 0.15
    referral: 0.10
```

### Schema Comparison

| Feature | Parameters | Contexts | Cases | **Nodes** |
|---------|-----------|----------|-------|-----------|
| **Purpose** | Edge probability/cost values | Contextual dimensions | A/B test variants | Graph nodes/states |
| **Registry File** | `parameters-index.yaml` | `contexts-index.yaml` | `cases-index.yaml` | `nodes-index.yaml` |
| **Detail Files** | `parameters/*.yaml` | `contexts/*.yaml` | `cases/*.yaml` | `nodes/*.yaml` |
| **ID Usage** | `edge.p.parameter_id` | `context.id` | `node.case.id` | `node.id` (implicit) |
| **Required?** | No (can use literal values) | No | No | **Sort of** (nodes exist in graphs, but registry is optional) |
| **Cross-Reference** | Yes (multiple graphs) | Yes (multiple graphs) | Yes (multiple graphs) | **Yes (new!)** |

### Key Differences for Nodes

**Unlike Parameters/Contexts/Cases:**
1. **Nodes ALWAYS exist in graphs** - they're not optional external references
2. **Registry is supplementary** - enriches node definitions, doesn't replace them
3. **Two sources of truth**: 
   - Graph file: "This graph has these nodes"
   - Registry: "These node IDs exist globally"
4. **Validation is bidirectional**:
   - Graph → Registry: "Does this node ID follow conventions?"
   - Registry → Graph: "Is this node ID used correctly?"

## Part 3: Registry Service Architecture

### Current State
```
paramRegistryService.ts
├─ loadRegistry() → parameters-index.yaml
├─ loadParameter(id) → parameters/{id}.yaml
├─ loadContext(id) → contexts/{id}.yaml
├─ loadCase(id) → cases/{id}.yaml
└─ Config: source, gitBranch, gitBasePath, etc.
```

### Proposed: Enhanced Registry Service

```typescript
// Enhanced ParamRegistryService (or rename to RegistryService)
class RegistryService {
  // Existing methods
  async loadParametersIndex(): Promise<ParametersIndex>
  async loadContextsIndex(): Promise<ContextsIndex>
  async loadCasesIndex(): Promise<CasesIndex>
  
  // NEW: Nodes support
  async loadNodesIndex(): Promise<NodesIndex>
  async loadNode(nodeId: string): Promise<NodeDefinition | null>
  
  // NEW: Generic registry access
  async loadIndex(type: 'parameter' | 'context' | 'case' | 'node'): Promise<RegistryIndex>
  async loadItem(type: ObjectType, id: string): Promise<any>
  
  // NEW: Validation helpers
  async isValidId(type: ObjectType, id: string): Promise<boolean>
  async searchRegistry(type: ObjectType, query: string): Promise<RegistryEntry[]>
  
  // NEW: Usage tracking (when saving graphs)
  async updateUsageCount(type: 'node', id: string, graphId: string): Promise<void>
}
```

### Data Flow

```
Application Load
├─ NavigatorContext.loadItems()
│  ├─ Scans directories for FILES
│  └─ Populates navigator tree
│
└─ RegistryService.loadIndexes()
   ├─ Loads parameters-index.yaml → in-memory cache
   ├─ Loads contexts-index.yaml → in-memory cache
   ├─ Loads cases-index.yaml → in-memory cache
   └─ Loads nodes-index.yaml → in-memory cache

User Opens Graph
├─ Graph contains nodes with IDs
├─ PropertiesPanel shows node properties
└─ NodeIdSelector uses RegistryService.searchRegistry('node', query)
   ├─ Shows: All nodes from registry (even if no file)
   └─ Validates: "Is this ID in the registry?"

User Selects Parameter
├─ ParameterSelector uses RegistryService.searchRegistry('parameter', query)
│  ├─ Returns: List of RegistryEntry (lightweight)
│  └─ User selects one
├─ PropertiesPanel updates edge.p.parameter_id
└─ (Optionally) Load full parameter file if needed
```

## Part 4: Navigator Enhancement

### Current Navigator State
```typescript
interface NavigatorState {
  items: RepositoryItem[]        // Files from repo
  localItems: RepositoryItem[]   // Uncommitted files
  // ...
}

interface RepositoryItem {
  id: string
  type: ObjectType
  name: string
  path: string
  description?: string
  isLocal?: boolean
}
```

### Enhanced Navigator State
```typescript
interface NavigatorState {
  items: RepositoryItem[]         // Files from repo (unchanged)
  localItems: RepositoryItem[]    // Uncommitted files (unchanged)
  
  // NEW: Registry data (lightweight metadata)
  registryIndexes: {
    parameters?: ParametersIndex
    contexts?: ContextsIndex
    cases?: CasesIndex
    nodes?: NodesIndex  // NEW!
  }
}

interface RegistryEntry {
  id: string
  file_path?: string   // May be null for planned items
  status: 'active' | 'planned' | 'deprecated' | 'archived'
  type?: string
  tags?: string[]
  usage_count?: number
  // ... other metadata
}
```

### Load Sequence

```typescript
// In NavigatorContext initialization
async function initialize() {
  // 1. Load registry indexes (lightweight, fast)
  const registryIndexes = {
    parameters: await registryService.loadParametersIndex(),
    contexts: await registryService.loadContextsIndex(),
    cases: await registryService.loadCasesIndex(),
    nodes: await registryService.loadNodesIndex(),  // NEW!
  }
  
  // 2. Load actual files from repo (for navigator tree)
  const items = await loadItemsFromRepo()
  
  // 3. Combine: Navigator shows files, but validates against registry
  setState({ registryIndexes, items })
}
```

### Usage Pattern

```typescript
// ParameterSelector component
function ParameterSelector({ type, value, onChange }) {
  const { state } = useNavigatorContext()
  
  // Get registry entries (includes planned items)
  const registryEntries = state.registryIndexes[type + 's']?.[type + 's'] || []
  
  // Get actual files (only committed/local files)
  const fileItems = state.items.filter(item => item.type === type)
  
  // Show entries from registry, mark which have files
  const options = registryEntries.map(entry => ({
    ...entry,
    hasFile: fileItems.some(item => item.id === entry.id),
    isLocal: localItems.some(item => item.id === entry.id)
  }))
  
  return (
    <Dropdown>
      {options.map(opt => (
        <Option key={opt.id}>
          {opt.id}
          {!opt.hasFile && <Badge>No file</Badge>}
          {opt.isLocal && <Badge>Local</Badge>}
        </Option>
      ))}
    </Dropdown>
  )
}
```

## Part 5: Parameter Selector Component Design

### Component Hierarchy
```
ParameterSelector (Generic)
├─ Props:
│  ├─ type: 'parameter' | 'context' | 'case' | 'node'
│  ├─ value: string (current ID)
│  ├─ onChange: (id: string) => void
│  ├─ placeholder?: string
│  ├─ disabled?: boolean
│  ├─ allowCreate?: boolean
│  └─ showCreateIfEmpty?: boolean
│
├─ Uses:
│  ├─ useNavigatorContext() → registryIndexes
│  ├─ RegistryService (validation, search)
│  └─ NewFileModal (for creation) - ENHANCED version
│
└─ Renders:
   ├─ Combobox/Autocomplete input
   ├─ Dropdown with filtered options
   ├─ "Create new..." option
   └─ Visual indicators (exists, local, planned)
```

### Visual Design

```
┌─────────────────────────────────────────┐
│ 🔍 conversion-rate-baseline       ▼    │  ← Combobox input
└─────────────────────────────────────────┘
  │
  └─> ┌───────────────────────────────────┐
      │ 🔍 [Search...]                    │
      ├───────────────────────────────────┤
      │ ✓ conversion-rate-baseline    📄 │ ← Has file
      │ ✓ email-signup-rate          📄 │
      │ ✓ checkout-completion         📄 │
      │ ⚠ abandoned-cart-rate         ⭘ │ ← No file (planned)
      │ ✓ homepage-traffic (local)    📝 │ ← Local uncommitted
      ├───────────────────────────────────┤
      │ ➕ Create new parameter...        │
      └───────────────────────────────────┘
```

### Integration Example

```typescript
// In PropertiesPanel.tsx - Edge Properties
<div>
  <label>Parameter ID</label>
  <ParameterSelector
    type="parameter"
    value={edge.p?.parameter_id || ''}
    onChange={(id) => updateEdge('p.parameter_id', id)}
    placeholder="Select or create parameter..."
    allowCreate={true}
  />
</div>

// In PropertiesPanel.tsx - Case Node
<div>
  <label>Case ID</label>
  <ParameterSelector
    type="case"
    value={node.case?.id || ''}
    onChange={(id) => updateNode('case.id', id)}
    placeholder="Select or create case..."
    allowCreate={true}
  />
</div>

// NEW: In PropertiesPanel.tsx - Node ID validation
<div>
  <label>Node ID</label>
  <ParameterSelector
    type="node"
    value={node.id}
    onChange={(id) => updateNode('id', id)}
    placeholder="Select or create node..."
    allowCreate={true}
    showCreateIfEmpty={true}
  />
  {!isValidNodeId(node.id) && (
    <Warning>This node ID is not in the registry</Warning>
  )}
</div>
```

## Part 5.5: Enhanced NewFileModal Design

### The Problem with Current Modal
The current `NewFileModal` only allows creating files "from scratch" with a new name. But with registries, we have a new use case: **creating a file for an ID that already exists in the registry but has no file**.

### Enhanced Modal: Two Creation Modes

#### Mode 1: Create From Scratch (Existing)
User enters a completely new name, system creates both registry entry (eventually) and file.

#### Mode 2: Create File for Existing Registry ID (NEW!)
User selects an ID from registry that has no file, system creates file with that ID pre-populated.

### Enhanced NewFileModal Props

```typescript
interface NewFileModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, type: ObjectType) => Promise<void>;
  fileType?: ObjectType;        // If provided, type selector is hidden
  defaultName?: string;          // For duplicate functionality
  
  // NEW: Registry-aware props
  mode?: 'create' | 'select-from-registry' | 'both';  // Default: 'create'
  showRegistryOption?: boolean;  // Show toggle between modes
  registryEntries?: RegistryEntry[];  // Registry items without files
}
```

### UI Design: Two Modes Side-by-Side

```
┌─────────────────────────────────────────────────────────┐
│ Create New Parameter                                    │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ How would you like to create this file?                │
│                                                         │
│ ┌─────────────────────────────────────────────────┐   │
│ │ ⚪ Create from scratch                          │   │
│ │    Enter a new name:                            │   │
│ │    [____________________________] .yaml         │   │
│ │                                                 │   │
│ │    Letters, numbers, hyphens, underscores only │   │
│ └─────────────────────────────────────────────────┘   │
│                                                         │
│ ┌─────────────────────────────────────────────────┐   │
│ │ ⚪ Create file for existing registry ID         │   │
│ │    Select from registry:                        │   │
│ │                                                 │   │
│ │    🔍 [Search registry...]              ▼      │   │
│ │    ┌──────────────────────────────────────┐    │   │
│ │    │ ⚠ checkout-completion      Used 3×   │    │   │
│ │    │ ⚠ abandoned-cart-rate      Used 1×   │    │   │
│ │    │ ⚠ email-bounce-rate        Used 0×   │    │   │
│ │    │ ℹ homepage-traffic      (planned)    │    │   │
│ │    └──────────────────────────────────────┘    │   │
│ │                                                 │   │
│ │    These IDs exist in the registry but have    │   │
│ │    no file yet. Creating a file will provide   │   │
│ │    detailed metadata for graphs using this ID. │   │
│ └─────────────────────────────────────────────────┘   │
│                                                         │
│                            [Cancel]  [Create]           │
└─────────────────────────────────────────────────────────┘
```

### Implementation Strategy

#### Option A: Enhance Existing NewFileModal (Recommended)
**Pros:**
- Single component to maintain
- Consistent UX
- Can reuse styling and logic

**Cons:**
- More complex component
- More props to manage

#### Option B: Create Separate RegistryFileModal
**Pros:**
- Cleaner separation of concerns
- Simpler individual components

**Cons:**
- Code duplication
- Two different UX patterns
- More components to maintain

**Decision: Go with Option A** - Enhanced NewFileModal with mode switching.

### Enhanced Component Structure

```typescript
// Enhanced NewFileModal.tsx
export function NewFileModal({
  isOpen,
  onClose,
  onCreate,
  fileType,
  defaultName = '',
  mode = 'create',
  showRegistryOption = false,
  registryEntries = []
}: NewFileModalProps) {
  
  // State
  const [creationMode, setCreationMode] = useState<'scratch' | 'registry'>(
    registryEntries.length > 0 && mode !== 'create' ? 'registry' : 'scratch'
  );
  const [fileName, setFileName] = useState(defaultName);
  const [selectedRegistryId, setSelectedRegistryId] = useState<string>('');
  const [registrySearchQuery, setRegistrySearchQuery] = useState('');
  
  // Filter registry entries by search
  const filteredRegistry = registryEntries.filter(entry => 
    entry.id.toLowerCase().includes(registrySearchQuery.toLowerCase()) ||
    entry.tags?.some(tag => tag.toLowerCase().includes(registrySearchQuery.toLowerCase()))
  );
  
  // Sort by usage (most used first)
  const sortedRegistry = filteredRegistry.sort((a, b) => 
    (b.usage_count || 0) - (a.usage_count || 0)
  );
  
  const handleCreate = async () => {
    const nameToUse = creationMode === 'registry' 
      ? selectedRegistryId 
      : fileName.trim();
    
    if (!nameToUse) {
      setError('Please enter a name or select from registry');
      return;
    }
    
    // ... validation ...
    
    await onCreate(nameToUse, fileType || selectedType);
  };
  
  // ... rest of component
}
```

### Usage Examples

#### Example 1: Standard Creation (No Registry Option)
```typescript
<NewFileModal
  isOpen={isOpen}
  onClose={onClose}
  onCreate={handleCreate}
  fileType="parameter"
  // No registry props - works as before
/>
```

#### Example 2: Registry-Aware Creation
```typescript
const registryWithoutFiles = navState.registryIndexes.parameters?.parameters
  .filter(entry => !entry.file_path || entry.status === 'planned')
  .map(entry => ({
    id: entry.id,
    usage_count: entry.usage_count,
    status: entry.status,
    tags: entry.tags
  })) || [];

<NewFileModal
  isOpen={isOpen}
  onClose={onClose}
  onCreate={handleCreate}
  fileType="parameter"
  mode="both"
  showRegistryOption={true}
  registryEntries={registryWithoutFiles}
/>
```

#### Example 3: Force Registry Selection
```typescript
// When specifically creating files for registry IDs
<NewFileModal
  isOpen={isOpen}
  onClose={onClose}
  onCreate={handleCreate}
  fileType="parameter"
  mode="select-from-registry"
  registryEntries={registryWithoutFiles}
/>
```

### Integration Points

#### In FileMenu.tsx
```typescript
const handleNew = (type: ObjectType) => {
  // Get registry entries without files
  const registryKey = `${type}s` as keyof typeof navState.registryIndexes;
  const registryData = navState.registryIndexes[registryKey];
  const entriesWithoutFiles = registryData?.[registryKey]?.filter(
    (entry: any) => !entry.file_path || entry.status === 'planned'
  ) || [];
  
  setNewFileType(type);
  setNewFileRegistryEntries(entriesWithoutFiles);
  setIsNewFileModalOpen(true);
};

// Render
<NewFileModal
  isOpen={isNewFileModalOpen}
  onClose={() => setIsNewFileModalOpen(false)}
  onCreate={handleCreateFile}
  fileType={newFileType}
  showRegistryOption={newFileRegistryEntries.length > 0}
  registryEntries={newFileRegistryEntries}
/>
```

#### In NavigatorItemContextMenu.tsx
```typescript
// Similar pattern for right-click "New..." in nav panel
```

### Benefits of This Approach

1. **Discoverability**: Users learn about registry IDs that need files
2. **Prevents Duplicates**: Encourages using existing IDs instead of creating new ones
3. **Usage-Driven**: Shows most-used IDs first, helps prioritize what to implement
4. **Validation**: "Create from scratch" can warn if similar registry ID exists
5. **Workflow Efficiency**: Direct path from "planned" registry entry to implemented file

### Example Workflow

```
Step 1: User building graph
  ├─ Needs parameter for "checkout completion rate"
  ├─ Types parameter_id: "checkout-completion"
  └─ Saves (creates reference to registry ID)

Step 2: Registry auto-update (future feature)
  ├─ Detects new ID in graph
  ├─ Adds to registry as "planned"
  └─ Sets usage_count: 1

Step 3: User wants to add metadata
  ├─ File > New > Parameter
  ├─ Modal shows: "checkout-completion (used 1×, no file)"
  ├─ User selects it
  └─ Creates parameter file with ID pre-populated

Step 4: All graphs benefit
  ├─ File now exists
  ├─ All graphs using that ID can load metadata
  └─ Registry marks as "active" with file_path
```

### Validation Enhancements

When user types in "Create from scratch" mode:

```typescript
const handleNameChange = (name: string) => {
  setFileName(name);
  
  // Check if similar ID exists in registry
  const similarInRegistry = registryEntries.find(
    entry => entry.id.toLowerCase() === name.toLowerCase().trim()
  );
  
  if (similarInRegistry) {
    setWarning(
      `"${similarInRegistry.id}" exists in registry ` +
      `(used ${similarInRegistry.usage_count}× times). ` +
      `Consider using that ID instead?`
    );
  }
};
```

### Future Enhancement: Smart Suggestions

```
User types: "checkout"
  ↓
Modal shows:
  ┌────────────────────────────────────────┐
  │ Create from scratch: "checkout"        │
  │                                        │
  │ Did you mean one of these?             │
  │ • checkout-completion (used 3×)        │
  │ • checkout-initiated (used 2×)         │
  │ • checkout-abandoned (planned)         │
  └────────────────────────────────────────┘
```

## Part 6: Implementation Phases

### Phase 1: Registry Enhancement (Foundation)
**Goal**: Add nodes registry support to service layer

1. Create `nodes-index.yaml` schema
2. Create example `nodes-index.yaml` file
3. Enhance `paramRegistryService` (or rename to `registryService`):
   - Add `loadNodesIndex()`
   - Add `loadNode(id)`
   - Add generic `loadIndex(type)` method
4. Add nodes registry to `fileTypeRegistry.ts`
5. Unit tests for registry loading

**Deliverable**: Service layer can load and query nodes registry

### Phase 2: Navigator Integration
**Goal**: Navigator knows about registry data

1. Add `registryIndexes` to `NavigatorState`
2. Load all indexes on navigator init
3. Add helper methods:
   - `getRegistryEntries(type)`
   - `isInRegistry(type, id)`
   - `hasFile(type, id)`
4. Update existing code to use registry for validation

**Deliverable**: Navigator has both file list AND registry data

### Phase 3: Enhanced NewFileModal
**Goal**: Modal supports both "create new" and "select from registry"

1. Enhance `NewFileModal.tsx`:
   - Add registry-aware props (`mode`, `showRegistryOption`, `registryEntries`)
   - Add creation mode toggle (scratch vs. registry)
   - Add registry search/filter
   - Show usage counts and status
   - Validation warnings for similar IDs
2. Update all callers to pass registry data when available
3. Styling for two-mode UI
4. Handle edge cases

**Deliverable**: Registry-aware file creation modal

### Phase 4: Parameter Selector Component
**Goal**: Generic selector UI component for properties panel

1. Create `ParameterSelector.tsx`:
   - Combobox/autocomplete input
   - Dropdown with filtered options
   - Search functionality
   - Visual indicators (has file, local, planned)
2. Integration with enhanced `NewFileModal`
3. Styling and accessibility
4. Handle edge cases (empty registry, no matches, etc.)

**Deliverable**: Reusable selector component

### Phase 5: PropertiesPanel Integration
**Goal**: Use selectors in graph editor

1. Replace text inputs with `ParameterSelector`:
   - `edge.p.parameter_id` → parameter selector
   - `edge.conditional_p[].p.parameter_id` → parameter selector
   - `node.case.id` → case selector
   - (Optional) `node.id` → node selector for validation
2. Add validation warnings
3. Add "Open in tab" quick action
4. Polish UX

**Deliverable**: Graph editor uses selectors

### Phase 6: Advanced Features (Future)
1. Rich previews (show parameter value on hover)
2. Usage tracking (update `usage_count` when saving graphs)
3. Cross-graph analysis (show where a parameter is used)
4. Batch operations (update multiple edges to use same parameter)
5. Registry management UI (add/remove/edit registry entries)
6. Auto-sync: When creating a new file, auto-add to registry

## Part 7: File Structure

```
graph-editor/
├─ src/
│  ├─ services/
│  │  ├─ paramRegistryService.ts → registryService.ts (rename)
│  │  └─ registryCache.ts (NEW - in-memory cache)
│  │
│  ├─ components/
│  │  ├─ ParameterSelector.tsx (NEW)
│  │  ├─ PropertiesPanel.tsx (MODIFIED)
│  │  └─ NewFileModal.tsx (existing, reused)
│  │
│  ├─ contexts/
│  │  └─ NavigatorContext.tsx (MODIFIED - add registryIndexes)
│  │
│  ├─ types/
│  │  └─ index.ts (MODIFIED - add NodeDefinition, NodesIndex)
│  │
│  └─ config/
│     └─ fileTypeRegistry.ts (MODIFIED - add node type)
│
└─ public/
   └─ param-schemas/
      ├─ node-schema.yaml (NEW)
      └─ nodes-index-schema.yaml (NEW)

param-registry/
└─ test/
   ├─ nodes-index.yaml (NEW)
   └─ nodes/
      ├─ homepage.yaml (NEW - example)
      └─ checkout-complete.yaml (NEW - example)
```

## Part 8: Key Design Decisions

### Decision 1: Registry is Source of Truth for IDs
**Rationale**: 
- Registry exists before files
- Can track "planned" items
- Enables validation without loading full files
- Supports usage analytics

### Decision 2: Navigator Shows Files, Registry Shows IDs
**Rationale**:
- Different concerns, different UIs
- Navigator = file browser (what to open)
- Registry = ID catalog (what exists conceptually)
- Both are needed, serve different purposes

### Decision 3: Node Registry is Optional But Recommended
**Rationale**:
- Nodes can exist without registry (backward compatible)
- Registry adds value but isn't required
- Validation warnings, not errors
- Gradual adoption path

### Decision 4: Single Generic Selector Component
**Rationale**:
- DRY principle
- Consistent UX across all types
- Easier to maintain
- Type safety via generics

### Decision 5: Registry Loaded Once, Cached
**Rationale**:
- Registry files are small (< 1KB typically)
- Changes infrequently
- Loading all indexes upfront is fast
- Enables instant autocomplete/validation

## Part 9: Migration Path

### Backward Compatibility
1. **Existing graphs work unchanged**: Nodes without registry entries are valid
2. **No forced migration**: Registry is additive, not required
3. **Gradual adoption**: Add registry entries as needed
4. **Validation warnings**: Non-breaking, informational only

### Migration Workflow
```
Phase 1: Use without registry (current state)
  ├─ Graphs have nodes
  └─ No validation or cross-referencing

Phase 2: Add empty registry
  ├─ Create nodes-index.yaml with version only
  ├─ System recognizes it but it's empty
  └─ No behavior change yet

Phase 3: Populate registry manually
  ├─ Extract node IDs from existing graphs
  ├─ Add to nodes-index.yaml
  ├─ System validates against registry
  └─ Warnings appear for unregistered nodes

Phase 4: Create detailed node files (optional)
  ├─ For important nodes, create nodes/*.yaml
  ├─ Add rich metadata
  └─ Enable advanced features

Phase 5: Full adoption
  ├─ All nodes in registry
  ├─ Validation enforced
  └─ Cross-graph analysis enabled
```

## Part 10: Example Scenarios

### Scenario 1: Creating a New Parameter (Current Problem)
**Without Registry/Selector:**
```
1. User typing in text field: "checkout-completion-rate"
2. Typo: "checkout-competion-rate"
3. Save graph
4. Later: "Why isn't this parameter working?"
5. Debug: Realize it's a typo
6. Fix in multiple places (error-prone)
```

**With Registry/Selector:**
```
1. User clicks parameter dropdown
2. Types "checkout"
3. Autocomplete shows: "checkout-completion-rate"
4. User selects it (no typo possible)
5. Done!
```

### Scenario 2: Creating a New Node ID
**Without Registry:**
```
1. User names node "CheckoutComplete"
2. Another user names node "checkout-complete"
3. Another user names node "checkout_complete"
4. Three different IDs for the same concept
5. Cross-graph analysis impossible
```

**With Registry:**
```
1. User starts typing "checkout"
2. Selector shows existing: "checkout-initiated", "checkout-complete"
3. User sees convention (lowercase, hyphenated)
4. User creates "checkout-abandoned" following pattern
5. Registry tracks it, others can find it
```

### Scenario 3: Referencing Planned Node
**Use Case:**
```
1. Building graph, need "abandoned-cart" node
2. Don't want to create full definition yet
3. Add to registry as "planned"
4. Reference it in graph
5. Later, create detailed node file when needed
```

**Registry Entry:**
```yaml
- id: abandoned-cart
  status: planned
  file_path: null
  type: exit
  usage_count: 3  # Used in 3 graphs!
```

## Summary

### Core Principles
1. **Registry = Lightweight Metadata Catalog** (IDs, status, usage)
2. **Navigator = File Browser** (actual files)
3. **Both Needed**: Registry for validation, Navigator for editing
4. **Nodes Follow Same Pattern** as parameters/contexts/cases
5. **Generic Selector Component** serves all types
6. **Enhanced Creation Flow**: Modal offers both "new" and "implement existing ID"

### Key Innovation: Registry-Aware File Creation

The **Enhanced NewFileModal** bridges the gap between registry and files:

```
Traditional Flow:                Registry-Aware Flow:
┌─────────────┐                 ┌─────────────────────────┐
│ Create New  │                 │ Create New:             │
│             │                 │  • From scratch   OR    │
│ [Type name] │                 │  • From registry (3 IDs │
│             │                 │    need files!)         │
│   [Create]  │                 │                         │
└─────────────┘                 │ Suggests most-used IDs  │
                                │ Shows usage counts      │
                                │ Prevents duplicates     │
                                └─────────────────────────┘
```

**Workflow it enables:**
1. Team references parameter IDs in graphs (registry tracks them)
2. Later, when ready to add metadata, modal shows these IDs
3. User picks from list → file created with correct ID
4. All graphs immediately benefit from the new file

### Benefits
- **Consistency**: All registry types work the same way
- **Validation**: Know what IDs exist before using them
- **Discovery**: Easy to find and reuse existing items
- **Analytics**: Track usage across graphs
- **Collaboration**: Shared understanding of IDs
- **Flexibility**: Registry items can exist without files
- **Efficiency**: Direct path from registry ID → file implementation
- **Prevention**: Avoid duplicate/conflicting IDs
- **Prioritization**: See most-used IDs first

### Next Steps
1. Review and approve this design
2. Implement Phase 1 (registry enhancement)
3. Implement Phase 2 (navigator integration)
4. Implement Phase 3 (enhanced modal)
5. Implement Phase 4 (selector component)
6. Integrate into graph editor

---

**Document Version**: 1.1  
**Date**: 2025-01-28  
**Author**: System Design Team  
**Status**: Pending Review  
**Changelog**: Added Part 5.5 - Enhanced NewFileModal with registry-aware creation


## Not Yet Started (implementation gaps)

- Nodes registry schemas and example files
  - Create `public/param-schemas/node-schema.yaml` and `public/param-schemas/nodes-index-schema.yaml`.
  - Add `param-registry/test/nodes-index.yaml` and example `param-registry/test/nodes/*.yaml` files.

- Registry service (nodes)
  - Implement in `paramRegistryService` (or `registryService` if renamed):
    - `loadNodesIndex()`, `loadNode(id)`.
    - Generic `loadIndex(type)` and `loadItem(type, id)`.
    - Validation helpers: `isValidId`, `searchRegistry`.
    - Usage tracking: `updateUsageCount('node', id, graphId)`.
    - In-memory caching layer for indexes.

- Navigator integration (nodes)
  - Surface `state.registryIndexes.nodes` in navigator UI lists.
  - Show planned-without-file nodes and usage counts.
  - Add right-click: "Create file from registry ID" action.

- NewFileModal enhancements (registry-aware)
  - Two-mode UI (scratch vs. select-from-registry) with search/sort, usage counts, and validation warnings.

- Auto-sync registry on save/commit
  - Detect new IDs referenced in graphs and add to nodes index as `planned`.
  - Increment `usage_count` when saving graphs using a node ID.

- Cross-graph features (nodes)
  - Queries: which graphs use node X; usage dashboards.
  - Analytics surfaces for node usage and status.

- Types and documentation
  - Add `NodesIndex` and `NodeDefinition` to `src/types` and reference them across the app.
  - Document new service APIs and registry data shapes in `src/docs`.

- Testing
  - Unit tests for registry service, navigator integration, and selector behaviors for nodes.

- Validation UX for node IDs
  - Strict/warning modes via `ValidationContext` for node ID selection.
  - Sidebar warnings for unregistered or planned-without-file node IDs.
