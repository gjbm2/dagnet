# UUID vs ID: When to Use Which

**Date:** 2025-11-06  
**Status:** Design Clarification  
**Purpose:** Stop confusing these two completely different concepts!

---

## The Core Distinction

### `uuid` - Local Graph Instance Identifier
- **Scope:** Single graph file instance only
- **Purpose:** React Flow rendering, local selection tracking, drag/drop
- **Generated:** Automatically when node/edge created in graph
- **Type:** System-generated unique identifier (typically a UUID string)
- **Visibility:** Internal to graph rendering, never shown to user
- **Mutability:** Never changes once created
- **Use cases:**
  - React Flow node IDs (what React Flow uses to render)
  - Tracking which node user selected/clicked/dragged
  - Finding a specific node instance in THIS graph
  - Local graph integrity (ensuring edges reference valid nodes)

### `id` - Semantic Entity Identifier (aka "Connection ID")
- **Scope:** Cross-file, repository-wide
- **Purpose:** Connecting graph entities to external definitions
- **Generated:** User types it, or selects from registry via EnhancedSelector
- **Type:** Human-readable string (e.g., `"checkout-page"`, `"conversion-rate"`)
- **Visibility:** Shown to user, primary way users think about entities
- **Mutability:** Can be changed (user can reconnect to different entity)
- **Use cases:**
  - **Foreign keys:** `node.id` → `node-{id}.yaml` file
  - **Foreign keys:** `edge.parameter_id` → `parameter-{id}.yaml` file
  - **Foreign keys:** `node.case.id` → `case-{id}.yaml` file
  - Registry lookups (finding files by human-readable name)
  - User-facing labels and connections

---

## Key Mental Model

```
Graph File (conversion-funnel.json)
├─ Node A
│  ├─ uuid: "550e8400-e29b-41d4-a716-446655440000"  ← Local instance ID
│  └─ id: "checkout-page"                           ← Connection to node-checkout-page.yaml
│
├─ Node B  
│  ├─ uuid: "6ba7b810-9dad-11d1-80b4-00c04fd430c8"  ← Different local instance
│  └─ id: "checkout-page"                           ← SAME semantic entity!
│
└─ Edge (A → B)
   ├─ uuid: "7c9e6679-7425-40de-944b-e07fc1f90ae7"  ← Local edge instance
   ├─ source: "550e8400-e29b-41d4-a716-446655440000" ← References Node A's UUID
   ├─ target: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" ← References Node B's UUID
   └─ parameter_id: "conversion-rate"               ← Connection to parameter file
```

**Key insight:** Nodes A and B are different instances in the graph (different UUIDs, can be positioned differently, have different local states), but they represent the SAME semantic entity (same `id`). This is intentional and useful for modeling repeated events in a funnel.

---

## Where NOT to Use UUID

❌ **NEVER use UUID as a foreign key**
- Don't look up files by UUID
- Don't pass UUID to `dataOperationsService` to find files
- Don't store UUID in parameter/case/node files
- Don't use UUID in `EnhancedSelector` connections

❌ **NEVER show UUID to users**
- Not in properties panel fields
- Not in EnhancedSelector dropdowns
- Not in file names

❌ **NEVER expect UUID to be stable across**
- Different graph files
- Graph file edits/saves
- Git commits/merges
- Different users' clones

---

## Where TO Use UUID

✅ **Local graph operations**
- React Flow node/edge IDs (for rendering)
- Selection tracking: `selectedNodeId`, `selectedEdgeId` in UI state
- Finding which node/edge user clicked on
- `hiddenNodes` Set (tracking which instances are hidden)
- Undo/redo history (referencing specific instances)

✅ **Within-graph references**
- `edge.source` → source node UUID
- `edge.target` → target node UUID
- `node.data.id` → human-readable ID (not UUID!)

---

## Common Patterns

### Pattern 1: User Selects a Node
```typescript
// ✅ CORRECT
function handleNodeClick(reactFlowNode: Node) {
  const uuid = reactFlowNode.id;              // React Flow uses UUID
  setSelectedNodeId(uuid);                    // Track which instance selected
  
  const graphNode = graph.nodes.find(n => n.uuid === uuid);  // Find by UUID
  const humanId = graphNode.id;               // Get semantic ID
  
  // Display to user: humanId ("checkout-page")
  // NOT: uuid ("550e8400-e29b-41d4-a716-446655440000")
}
```

### Pattern 2: User Connects a Node to a File
```typescript
// ✅ CORRECT
function handleNodeIdChange(newId: string) {
  // User typed or selected "checkout-page" in EnhancedSelector
  // This is the semantic ID, NOT a UUID
  
  // Update the graph node's ID
  const node = graph.nodes.find(n => n.uuid === selectedNodeId);  // Find by UUID
  node.id = newId;  // Set semantic ID
  
  // If file exists, auto-get from it
  if (fileExists(`node-${newId}.yaml`)) {
    dataOperationsService.getNodeFromFile({
      nodeId: newId,           // ✅ File name: node-checkout-page.yaml
      targetNodeUuid: selectedNodeId  // ✅ Which instance to update
    });
  }
}
```

### Pattern 3: DataOperationsService Methods

```typescript
// ✅ CORRECT: Parameter operations
getParameterFromFile({
  paramId: "conversion-rate",     // Semantic ID → finds parameter-conversion-rate.yaml
  edgeId: selectedEdgeId,         // UUID → finds which edge instance to update
  graph,
  setGraph
})

// ✅ CORRECT: Case operations  
getCaseFromFile({
  caseId: "abandoned-cart",       // Semantic ID → finds case-abandoned-cart.yaml
  nodeId: selectedNodeId,         // UUID → finds which node instance to update
  graph,
  setGraph
})

// ✅ CORRECT: Node operations
getNodeFromFile({
  nodeId: "checkout-page",        // Semantic ID → finds node-checkout-page.yaml
  targetNodeUuid: selectedNodeId, // UUID → finds which node instance to update
  graph,
  setGraph
})
```

---

## The Confusion in Current Code

### Problem: EnhancedSelector Receiving `targetId`

**What we're currently passing:**
```tsx
<EnhancedSelector
  type="parameter"
  value={edge.parameter_id}     // Semantic ID ✅
  targetId={selectedEdgeId}      // UUID ❓❓❓
  onChange={...}
/>
```

**The confusion:**
- `EnhancedSelector` deals with semantic IDs (`parameter_id`, `case_id`, `node.id`)
- It needs to know which graph instance to update
- But the prop name `targetId` suggests it's another semantic ID
- Really it's a UUID (for finding the instance)

**Better naming:**
```tsx
<EnhancedSelector
  type="parameter"
  value={edge.parameter_id}        // Semantic ID
  targetInstanceUuid={selectedEdgeId}  // ✅ Clear it's a UUID
  onChange={...}
/>
```

---

## Correct Auto-Get Logic

### When User Connects Parameter
```typescript
// User selects "conversion-rate" from EnhancedSelector for an edge's probability param

1. selectedEdgeId = "550e8400-..."  // UUID of edge instance (from props)
2. paramId = "conversion-rate"      // Semantic ID (user's selection)

Auto-get should:
- Find file: `parameter-conversion-rate.yaml` (using paramId)
- Update edge instance: find by selectedEdgeId (UUID)
- Apply data from file to that edge

Code:
dataOperationsService.getParameterFromFile({
  paramId: "conversion-rate",      // ✅ Semantic
  edgeId: selectedEdgeId,          // ✅ UUID
  graph,
  setGraph
})
```

### When User Connects Node ID
```typescript
// User selects "checkout-page" from EnhancedSelector for a node's ID field

1. selectedNodeId = "7c9e6679-..."  // UUID of node instance (from props)
2. nodeId = "checkout-page"         // Semantic ID (user's selection)

Auto-get should:
- Find file: `node-checkout-page.yaml` (using nodeId)
- Update node instance: find by selectedNodeId (UUID)
- Apply data from file to that node

Code:
dataOperationsService.getNodeFromFile({
  nodeId: "checkout-page",          // ✅ Semantic (for file lookup)
  targetNodeUuid: selectedNodeId,   // ✅ UUID (for instance lookup)
  graph,
  setGraph
})
```

---

## Action Items to Fix Current Mess

### 1. Rename Prop in EnhancedSelector
```typescript
interface EnhancedSelectorProps {
  // ... other props ...
  
  // OLD (confusing):
  targetId?: string;
  
  // NEW (clear):
  targetInstanceUuid?: string;  // UUID of the graph node/edge being edited
}
```

### 2. Update All Call Sites
```tsx
// Edge parameter selectors
<EnhancedSelector
  targetInstanceUuid={selectedEdgeId}  // ✅ UUID
/>

// Case selector (on case nodes)
<EnhancedSelector
  targetInstanceUuid={selectedNodeId}  // ✅ UUID
/>

// Node ID selector
<EnhancedSelector
  targetInstanceUuid={selectedNodeId}  // ✅ UUID
/>
```

### 3. Fix LightningMenu Prop
```tsx
<LightningMenu
  objectId={inputValue}                    // Semantic ID
  targetInstanceUuid={targetInstanceUuid}  // UUID
/>
```

### 4. Clarify DataOperationsService Signatures
Add comments to make parameter roles crystal clear:

```typescript
async getParameterFromFile(options: {
  paramId: string;        // Semantic ID - which file to load
  edgeId?: string;        // UUID - which edge instance to update
  graph: Graph | null;
  setGraph: (graph: Graph | null) => void;
}): Promise<void>

async getNodeFromFile(options: {
  nodeId: string;            // Semantic ID - which file to load  
  targetNodeUuid?: string;   // UUID - which node instance to update
  graph: Graph | null;
  setGraph: (graph: Graph | null) => void;
}): Promise<void>
```

---

## Testing Strategy

After fixes, verify:

1. ✅ Select edge, connect parameter → auto-get works
2. ✅ Select node, set ID → auto-get works  
3. ✅ Click ⚡ on parameter → get/put works
4. ✅ Click ⚡ on case → get/put works
5. ✅ Multiple nodes with same `id` → each updates independently
6. ✅ Hide/unhide node → uses correct identifier (UUID for local state)
7. ✅ Delete node → uses correct identifier

---

## Summary

| Concept | Purpose | Scope | Example | Used For |
|---------|---------|-------|---------|----------|
| **UUID** | Instance identifier | Single graph | `550e8400-...` | React Flow, selection, local state |
| **ID** | Semantic identifier | Cross-file | `"checkout-page"` | File connections, foreign keys |

**Golden Rule:** If it's connecting to a file or shown to the user, it's `id`. If it's tracking which instance in this graph, it's `uuid`.

**Never mix them up!**


