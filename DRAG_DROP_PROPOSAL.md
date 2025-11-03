# Drag & Drop from Navigator to Graph Canvas

## Overview

Enable users to drag items from the Navigator panel and drop them onto the Graph Canvas to create or connect graph elements. This provides a more intuitive, direct manipulation interface for building graphs.

## User Stories

### 1. Creating Nodes
**As a user, I want to drag a node from the navigator and drop it onto empty canvas space to create a new node with that connection.**

- Drag a node item from navigator
- Drop on empty space → Creates new node with `slug` set to dropped node ID
- Visual: Ghost node follows cursor during drag

### 2. Connecting Nodes
**As a user, I want to drag a node from the navigator and drop it onto an existing node to set that node's connection.**

- Drag a node item from navigator
- Drop on existing node → Sets that node's `slug` to dropped node ID
- Visual: Target node highlights on hover

### 3. Applying Cost Parameters
**As a user, I want to drag a cost parameter and drop it onto an edge to apply that parameter.**

- Drag a `cost_gbp` or `cost_time` parameter from navigator
- Drop on edge → Sets edge's `cost_gbp_parameter_id` or `cost_time_parameter_id`
- Visual: Target edge highlights and thickens on hover

### 4. Applying Probability Parameters
**As a user, I want to drag a probability parameter and drop it onto an edge with options for how to apply it.**

- Drag a `probability` parameter from navigator
- Drop on edge → Context menu appears with options:
  - "Apply as Probability" → Sets edge's `parameter_id`
  - "Add as Conditional Probability" → Adds new conditional probability entry
- Visual: Context menu appears at drop location

### 5. Creating Case Nodes
**As a user, I want to drag a case from the navigator and drop it onto empty space to create a case node.**

- Drag a case item from navigator
- Drop on empty space → Creates new case node with `case.id` set to dropped case ID
- Visual: Ghost case node follows cursor

### 6. Converting to Case Nodes
**As a user, I want to drag a case from the navigator and drop it onto an existing node to convert it to a case node.**

- Drag a case item from navigator
- Drop on existing node → Converts node to case type with `case.id` set to dropped case ID
- Visual: Target node highlights with case icon overlay

---

## Technical Architecture

### Phase 1: Basic Infrastructure (8-10 hours)

#### 1.1 Make Navigator Items Draggable

**File:** `graph-editor/src/components/Navigator/ObjectTypeSection.tsx`

```typescript
<div
  className="navigator-item"
  draggable={true}
  onDragStart={(e) => {
    const dragData = {
      type: entry.type,        // 'node', 'parameter', 'case', 'context'
      id: entry.id,
      name: entry.name,
      hasFile: entry.hasFile,
      isLocal: entry.isLocal,
      // For parameters, include subtype
      parameterType: entry.type === 'parameter' ? getParameterType(entry.id) : undefined
    };
    
    e.dataTransfer.setData('application/dagnet-item', JSON.stringify(dragData));
    e.dataTransfer.effectAllowed = 'copy';
    
    // Optional: Custom drag image
    const dragImage = createDragImage(entry);
    e.dataTransfer.setDragImage(dragImage, 0, 0);
  }}
  onDragEnd={(e) => {
    // Cleanup if needed
  }}
>
```

**CSS:**
```css
.navigator-item[draggable="true"] {
  cursor: grab;
}

.navigator-item:active {
  cursor: grabbing;
  opacity: 0.7;
}
```

#### 1.2 Set Up Drop Zone on GraphCanvas

**File:** `graph-editor/src/components/GraphCanvas.tsx`

```typescript
// Add drop handlers to the ReactFlow wrapper
<div
  onDragOver={handleDragOver}
  onDrop={handleDrop}
  onDragLeave={handleDragLeave}
  style={{ width: '100%', height: '100%' }}
>
  <ReactFlow {...props} />
</div>

const handleDragOver = useCallback((e: React.DragEvent) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  
  // Calculate position and highlight potential drop target
  const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
  updateDropTarget(position);
}, [screenToFlowPosition]);

const handleDrop = useCallback((e: React.DragEvent) => {
  e.preventDefault();
  
  const rawData = e.dataTransfer.getData('application/dagnet-item');
  if (!rawData) return;
  
  const dragData = JSON.parse(rawData);
  const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
  
  processDropAction(dragData, position);
}, [screenToFlowPosition, processDropAction]);
```

#### 1.3 Coordinate Conversion

```typescript
const screenToFlowPosition = useCallback(({ x, y }: { x: number; y: number }) => {
  const reactFlowBounds = reactFlowWrapper.current.getBoundingClientRect();
  const flowPosition = reactFlowInstance.project({
    x: x - reactFlowBounds.left,
    y: y - reactFlowBounds.top,
  });
  return flowPosition;
}, [reactFlowInstance]);
```

---

### Phase 2: Drop Target Detection (10-14 hours)

#### 2.1 Node Detection

```typescript
const getNodeAtPosition = useCallback((position: { x: number; y: number }) => {
  return nodes.find(node => {
    const nodeWidth = node.width || 200;
    const nodeHeight = node.height || 100;
    
    return position.x >= node.position.x &&
           position.x <= node.position.x + nodeWidth &&
           position.y >= node.position.y &&
           position.y <= node.position.y + nodeHeight;
  });
}, [nodes]);
```

#### 2.2 Edge Detection

**Challenge:** ReactFlow doesn't provide built-in edge hit testing.

**Solution:** Calculate distance from point to edge path.

```typescript
const getEdgeNear = useCallback((position: { x: number; y: number }, threshold = 20) => {
  for (const edge of edges) {
    const sourceNode = nodes.find(n => n.id === edge.source);
    const targetNode = nodes.find(n => n.id === edge.target);
    
    if (!sourceNode || !targetNode) continue;
    
    // Get edge handle positions
    const sourcePos = getHandlePosition(sourceNode, edge.sourceHandle);
    const targetPos = getHandlePosition(targetNode, edge.targetHandle);
    
    // Calculate distance from position to edge line segment
    const distance = distanceToLineSegment(position, sourcePos, targetPos);
    
    if (distance < threshold) {
      return edge;
    }
  }
  return null;
}, [nodes, edges]);

const distanceToLineSegment = (point, lineStart, lineEnd) => {
  // Standard point-to-line-segment distance calculation
  // https://stackoverflow.com/questions/849211
};
```

#### 2.3 Visual Feedback State

```typescript
const [dropTarget, setDropTarget] = useState<{
  type: 'node' | 'edge' | 'empty';
  id?: string;
  position?: { x: number; y: number };
} | null>(null);

// Update during drag
const updateDropTarget = useCallback((position) => {
  const nodeAtPos = getNodeAtPosition(position);
  const edgeNear = getEdgeNear(position);
  
  if (nodeAtPos) {
    setDropTarget({ type: 'node', id: nodeAtPos.id });
  } else if (edgeNear) {
    setDropTarget({ type: 'edge', id: edgeNear.id });
  } else {
    setDropTarget({ type: 'empty', position });
  }
}, [getNodeAtPosition, getEdgeNear]);
```

---

### Phase 3: Type-Specific Drop Actions (10-14 hours)

#### 3.1 Node Drops

```typescript
const handleNodeDrop = useCallback((dragData, position, targetNode) => {
  if (targetNode) {
    // Connect existing node
    const next = structuredClone(graph);
    const nodeIndex = next.nodes.findIndex(n => n.id === targetNode.id);
    if (nodeIndex >= 0) {
      next.nodes[nodeIndex].slug = dragData.id;
      setGraph(next);
      saveHistoryState(`Connect node to ${dragData.id}`, targetNode.id);
    }
  } else {
    // Create new node
    const newNode = {
      id: generateUUID(),
      type: 'normal',
      label: dragData.name,
      slug: dragData.id,
      position: { x: position.x - 100, y: position.y - 50 }, // Center on drop
      absorbing: false,
      tags: []
    };
    
    const next = structuredClone(graph);
    next.nodes.push(newNode);
    setGraph(next);
    saveHistoryState(`Create node from ${dragData.id}`, newNode.id);
  }
}, [graph, setGraph, saveHistoryState]);
```

#### 3.2 Case Drops

```typescript
const handleCaseDrop = useCallback((dragData, position, targetNode) => {
  if (targetNode) {
    // Convert to case node
    const next = structuredClone(graph);
    const nodeIndex = next.nodes.findIndex(n => n.id === targetNode.id);
    if (nodeIndex >= 0) {
      next.nodes[nodeIndex].type = 'case';
      next.nodes[nodeIndex].case = {
        id: dragData.id,
        parameter_id: '',
        status: 'active',
        variants: []
      };
      setGraph(next);
      saveHistoryState(`Convert node to case ${dragData.id}`, targetNode.id);
    }
  } else {
    // Create new case node
    const newNode = {
      id: generateUUID(),
      type: 'case',
      label: dragData.name,
      slug: '',
      position: { x: position.x - 100, y: position.y - 50 },
      absorbing: false,
      tags: [],
      case: {
        id: dragData.id,
        parameter_id: '',
        status: 'active',
        variants: []
      }
    };
    
    const next = structuredClone(graph);
    next.nodes.push(newNode);
    setGraph(next);
    saveHistoryState(`Create case node from ${dragData.id}`, newNode.id);
  }
}, [graph, setGraph, saveHistoryState]);
```

#### 3.3 Parameter Drops

```typescript
const [parameterContextMenu, setParameterContextMenu] = useState<{
  show: boolean;
  x: number;
  y: number;
  dragData: any;
  targetEdgeId: string;
} | null>(null);

const handleParameterDrop = useCallback((dragData, position, targetEdge) => {
  if (!targetEdge) return;
  
  const paramType = dragData.parameterType;
  
  if (paramType === 'cost_gbp' || paramType === 'cost_time') {
    // Direct application
    const next = structuredClone(graph);
    const edgeIndex = next.edges.findIndex(e => 
      e.id === targetEdge.id || `${e.from}->${e.to}` === targetEdge.id
    );
    
    if (edgeIndex >= 0) {
      const fieldName = paramType === 'cost_gbp' ? 'cost_gbp_parameter_id' : 'cost_time_parameter_id';
      next.edges[edgeIndex][fieldName] = dragData.id;
      setGraph(next);
      saveHistoryState(`Apply ${paramType} parameter to edge`, undefined, targetEdge.id);
    }
  } else if (paramType === 'probability') {
    // Show context menu
    const screenPos = flowToScreenPosition(position);
    setParameterContextMenu({
      show: true,
      x: screenPos.x,
      y: screenPos.y,
      dragData,
      targetEdgeId: targetEdge.id
    });
  }
}, [graph, setGraph, saveHistoryState]);

// Context menu component
{parameterContextMenu?.show && (
  <div 
    className="drop-context-menu"
    style={{
      position: 'fixed',
      left: parameterContextMenu.x,
      top: parameterContextMenu.y,
      zIndex: 10000
    }}
    onClick={(e) => e.stopPropagation()}
  >
    <div 
      className="drop-context-menu-item"
      onClick={() => {
        applyAsProbability(parameterContextMenu.targetEdgeId, parameterContextMenu.dragData.id);
        setParameterContextMenu(null);
      }}
    >
      Apply as Probability
    </div>
    <div 
      className="drop-context-menu-item"
      onClick={() => {
        addConditionalProbability(parameterContextMenu.targetEdgeId, parameterContextMenu.dragData.id);
        setParameterContextMenu(null);
      }}
    >
      Add as Conditional Probability
    </div>
  </div>
)}
```

---

### Phase 4: Visual Feedback & Polish (8-10 hours)

#### 4.1 Ghost Elements

```typescript
// Show ghost node during drag
{dropTarget?.type === 'empty' && dragData?.type === 'node' && (
  <GhostNode 
    position={dropTarget.position}
    label={dragData.name}
  />
)}
```

#### 4.2 Highlight Drop Targets

```css
/* Highlight node when valid drop target */
.react-flow__node.drop-target-hover {
  outline: 2px solid #3B82F6;
  outline-offset: 2px;
  box-shadow: 0 0 12px rgba(59, 130, 246, 0.4);
}

/* Highlight edge when valid drop target */
.react-flow__edge.drop-target-hover path {
  stroke: #3B82F6;
  stroke-width: 3;
}
```

#### 4.3 Cursor Changes

```typescript
// Update cursor based on drop validity
const getCursorForDrag = (dragData, dropTarget) => {
  if (!dropTarget) return 'no-drop';
  
  if (dragData.type === 'node' && (dropTarget.type === 'node' || dropTarget.type === 'empty')) {
    return 'copy';
  }
  
  if (dragData.type === 'parameter' && dropTarget.type === 'edge') {
    return 'copy';
  }
  
  return 'no-drop';
};
```

---

## Edge Cases & Error Handling

### 1. Invalid Drops
- Drop non-parameter on edge → Show toast: "Can only drop parameters on edges"
- Drop parameter on node → Ignore (no valid action)
- Drop on canvas boundary → Adjust position to keep node in viewport

### 2. Validation
- Before creating/connecting, validate:
  - Node slug is valid registry ID (if in strict mode)
  - Parameter type matches expected type
  - Case ID exists in registry

### 3. Undo/Redo
- All drop actions must call `saveHistoryState`
- Include descriptive action names
- Test undo after each drop type

### 4. Concurrent Operations
- Disable other graph interactions during drag (e.g., panning)
- Clear selection on drop to focus on new/modified element
- Re-enable panning on drag end

---

## Testing Checklist

### Drag Behavior
- [ ] Navigator items are draggable
- [ ] Drag cursor shows correct feedback
- [ ] Drag ghost/preview visible
- [ ] Drag outside browser cancels cleanly

### Drop on Empty Space
- [ ] Node → Creates new node at correct position
- [ ] Case → Creates new case node
- [ ] Parameter → No action (expected)
- [ ] Position centered on cursor

### Drop on Node
- [ ] Node → Sets node.slug
- [ ] Case → Converts to case node with case.id
- [ ] Parameter → No action (expected)

### Drop on Edge
- [ ] Cost parameter → Sets cost_parameter_id
- [ ] Probability parameter → Shows context menu
- [ ] Context menu: "Apply as Probability" works
- [ ] Context menu: "Add Conditional" works
- [ ] Node/Case → No action (expected)

### Visual Feedback
- [ ] Target node highlights on valid hover
- [ ] Target edge highlights and thickens
- [ ] Invalid targets show no-drop cursor
- [ ] Ghost elements render correctly

### Integration
- [ ] Undo/redo works for all actions
- [ ] Graph dirty state updates
- [ ] Properties panel updates on drop
- [ ] Navigator doesn't lose selection

---

## Implementation Timeline

| Phase | Description | Time | Priority |
|-------|-------------|------|----------|
| 1 | Basic Infrastructure | 8-10 hours | P0 (MVP) |
| 2 | Drop Target Detection | 10-14 hours | P0 (MVP) |
| 3 | Type-Specific Actions | 10-14 hours | P0 (MVP) |
| 4 | Visual Polish | 8-10 hours | P1 |
| **Total** | **Full Implementation** | **36-48 hours** | |

**MVP Scope (Phase 1-3):** ~28-38 hours
- All drop behaviors working
- Basic visual feedback
- No advanced polish

**Full Feature (All Phases):** ~36-48 hours
- All behaviors + polished UX
- Ghost elements, highlights
- Error handling

---

## Future Enhancements

### Context Drops (Later)
Similar pattern to case/parameter drops:
- Context → Empty space: Create node with context_id
- Context → Node: Set node.context_id
- Context → Edge: Set edge.context_id

### Multi-Select Drag
- Drag multiple items from navigator
- Drop creates/connects multiple elements at once

### Drag from Graph to Navigator
- Reverse operation: "Export" node as registry item
- Create new parameter/node/case from graph element

---

## Open Questions

1. **Should we allow dropping on edges that already have parameters?**
   - Option A: Overwrite existing (with confirmation)
   - Option B: Prevent drop, show tooltip
   - **Recommendation:** Option A (overwrite) - undo is available

2. **What happens when dropping a node that doesn't exist in registry (strict mode)?**
   - Option A: Create anyway, show warning
   - Option B: Prevent drop, show error
   - **Recommendation:** Option B (prevent) - maintain strict mode integrity

3. **Should drag & drop auto-save the graph?**
   - **Recommendation:** No - follow existing pattern (user must save)

---

## Dependencies

- Existing navigator item rendering (✓ Done)
- Graph store with undo/redo (✓ Done)
- ReactFlow coordinate conversion (✓ Available)
- Registry service for validation (✓ Done)

---

## Accessibility Considerations

- Keyboard equivalent: Context menu "Add to Graph"
- Screen reader announcements for drag/drop actions
- Focus management after drop
- Touch device support (may need separate implementation)


