# React Profiler Findings

## Recording Details
- **Duration**: 2,318ms (2.3 seconds)
- **Total commits**: 131
- **Commit rate**: **56.5 commits/second**

## Root Cause Identified

### Continuous ReactFlow Rendering Loop

**Evidence from profiler `updaters` field:**

Commits 2-19+ are ALL triggered by **ReactFlow's internal components**:

```
Commit 2-19 (repeating pattern):
  - NodeRenderer (Type 8 = useEffect)
  - Viewport (Type 5 = useState)  
  - Background (Type 8 = useEffect)
  - MiniMap (Type 8 = useEffect)
```

**These ReactFlow internals are rendering continuously at ~10ms intervals (60+ times/second).**

### Secondary Issue: App Component Cascade

When GraphEditorInner or CanvasInner DO trigger:
- Fiber-401: 131 renders (on EVERY commit) - likely AppShellContent or a provider
- Fiber-519: 127 renders
- Fiber-554: 122 renders  
- Fiber-517: 111 renders (210ms total CPU time!)

Each renders due to **context + props + state + hooks all changing simultaneously**, indicating a provider cascade issue that we partially fixed with memoization, but ReactFlow's continuous loop keeps retriggering everything.

## The Problem

**ReactFlow is creating a continuous render loop that:**
1. Triggers 56 commits/second (should be ~2-5 during pan)
2. Each commit cascades through your app due to context subscriptions
3. Results in 593 RunTasks/second (from Chrome trace)
4. Causes visible jank and incomplete renders

## Next Step

Find what in your ReactFlow configuration is causing `NodeRenderer`, `Viewport`, `Background`, and `MiniMap` to continuously update.

Common causes:
- Non-stable props passed to `<ReactFlow>`
- Viewport being set in an effect that responds to viewport changes (loop)
- MiniMap or Background with non-memoized styles/props
- `fitView` or viewport manipulation in effects without proper guards

Look for `fitView`, viewport setters, or anything that might trigger ReactFlow's internal state on every frame.

