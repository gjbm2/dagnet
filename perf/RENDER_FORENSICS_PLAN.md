# Render Forensics Plan: Complete Diagnostic & Instrumentation

## Executive Summary

The graph editor exhibits systematic rendering instability: frequent frame-busting recomputes, flicker, incomplete redraws, and cascading re-renders during simple interactions like panning. Current performance logs show symptoms but not root causes.

This document outlines a **comprehensive forensic investigation** to:
1. Map the complete render path and dependency flows
2. Instrument every layer to expose what's actually happening
3. Identify race conditions, dependency instability, and render budget violations
4. Provide actionable data to fix the root causes

## Phase 0: Diagnostic Logging Service (Foundation)

Before adding any instrumentation, establish a centralized, configurable logging service that:
- Allows toggling log categories via const settings (no code changes)
- Provides consistent log formatting
- Supports structured data collection for analysis
- Can be permanently integrated (not removed after debugging)

### 0.1 Logging Service Design

**File: `graph-editor/src/diagnostics/logger.ts`**

```typescript
/**
 * Centralized diagnostic logging service
 * Control log visibility via LOG_CONFIG without code changes
 */

export enum LogLevel {
  NONE = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
  TRACE = 5
}

export enum LogCategory {
  // Contexts
  CONTEXT_GRAPH_STORE = 'context.graphStore',
  CONTEXT_SCENARIOS = 'context.scenarios',
  CONTEXT_TAB = 'context.tab',
  CONTEXT_NAVIGATOR = 'context.navigator',
  CONTEXT_VIEW_PREFS = 'context.viewPrefs',
  
  // Components
  RENDER_APP_SHELL = 'render.appShell',
  RENDER_GRAPH_EDITOR = 'render.graphEditor',
  RENDER_GRAPH_CANVAS = 'render.graphCanvas',
  RENDER_CONVERSION_EDGE = 'render.conversionEdge',
  RENDER_EDGE_BEADS = 'render.edgeBeads',
  
  // Heavy Computations
  MEMO_RENDER_EDGES = 'memo.renderEdges',
  MEMO_HIGHLIGHT_METADATA = 'memo.highlightMetadata',
  MEMO_CALCULATE_OFFSETS = 'memo.calculateOffsets',
  MEMO_BEAD_DEFINITIONS = 'memo.beadDefinitions',
  
  // Effects
  EFFECT_WHAT_IF_RECOMPUTE = 'effect.whatIfRecompute',
  EFFECT_GRAPH_SYNC = 'effect.graphSync',
  EFFECT_AUTO_REROUTE = 'effect.autoReroute',
  EFFECT_SANKEY_LAYOUT = 'effect.sankeyLayout',
  EFFECT_VIEWPORT_SAVE = 'effect.viewportSave',
  
  // Dependencies
  DEPS_RENDER_EDGES = 'deps.renderEdges',
  DEPS_HIGHLIGHT = 'deps.highlight',
  DEPS_BEAD_DEFS = 'deps.beadDefs',
  
  // Identity Tracking
  IDENTITY_GRAPH = 'identity.graph',
  IDENTITY_SCENARIOS = 'identity.scenarios',
  IDENTITY_ARRAYS = 'identity.arrays',
  IDENTITY_FUNCTIONS = 'identity.functions',
  
  // Performance
  PERF_FRAME = 'perf.frame',
  PERF_MEMO = 'perf.memo',
  PERF_EFFECT = 'perf.effect',
  PERF_BUILD_EDGES = 'perf.buildEdges',
  PERF_BUILD_BEADS = 'perf.buildBeads',
  PERF_CHEVRON_CALC = 'perf.chevronCalc',
  PERF_TEXT_MEASURE = 'perf.textMeasure',
  
  // ReactFlow
  REACTFLOW_CALLBACKS = 'reactflow.callbacks',
  REACTFLOW_STATE = 'reactflow.state',
  
  // Issues
  ISSUE_RENDER_LOOP = 'issue.renderLoop',
  ISSUE_RENDER_VIOLATION = 'issue.renderViolation',
  ISSUE_FRAME_BUDGET = 'issue.frameBudget',
  ISSUE_RACE_CONDITION = 'issue.raceCondition',
  
  // Cache
  CACHE_HITS = 'cache.hits',
  CACHE_MISSES = 'cache.misses',
}

// ============================================================================
// CONFIGURATION - Change these to control logging
// ============================================================================

export const LOG_CONFIG: Record<LogCategory, LogLevel> = {
  // Contexts - normally off, enable when diagnosing context re-emits
  [LogCategory.CONTEXT_GRAPH_STORE]: LogLevel.NONE,
  [LogCategory.CONTEXT_SCENARIOS]: LogLevel.NONE,
  [LogCategory.CONTEXT_TAB]: LogLevel.NONE,
  [LogCategory.CONTEXT_NAVIGATOR]: LogLevel.NONE,
  [LogCategory.CONTEXT_VIEW_PREFS]: LogLevel.NONE,
  
  // Component renders - enable when tracking render cascades
  [LogCategory.RENDER_APP_SHELL]: LogLevel.NONE,
  [LogCategory.RENDER_GRAPH_EDITOR]: LogLevel.NONE,
  [LogCategory.RENDER_GRAPH_CANVAS]: LogLevel.INFO,  // Keep for frame tracking
  [LogCategory.RENDER_CONVERSION_EDGE]: LogLevel.NONE,
  [LogCategory.RENDER_EDGE_BEADS]: LogLevel.NONE,
  
  // Heavy memos - enable when diagnosing unnecessary recomputes
  [LogCategory.MEMO_RENDER_EDGES]: LogLevel.INFO,     // Keep to track edge rebuilds
  [LogCategory.MEMO_HIGHLIGHT_METADATA]: LogLevel.NONE,
  [LogCategory.MEMO_CALCULATE_OFFSETS]: LogLevel.NONE,
  [LogCategory.MEMO_BEAD_DEFINITIONS]: LogLevel.NONE,
  
  // Effects - enable when diagnosing effect cascades
  [LogCategory.EFFECT_WHAT_IF_RECOMPUTE]: LogLevel.WARN, // Only log slow ones
  [LogCategory.EFFECT_GRAPH_SYNC]: LogLevel.NONE,
  [LogCategory.EFFECT_AUTO_REROUTE]: LogLevel.NONE,
  [LogCategory.EFFECT_SANKEY_LAYOUT]: LogLevel.NONE,
  [LogCategory.EFFECT_VIEWPORT_SAVE]: LogLevel.NONE,
  
  // Dependencies - enable when diagnosing memo instability
  [LogCategory.DEPS_RENDER_EDGES]: LogLevel.WARN,     // Log unexpected changes
  [LogCategory.DEPS_HIGHLIGHT]: LogLevel.NONE,
  [LogCategory.DEPS_BEAD_DEFS]: LogLevel.NONE,
  
  // Identity - enable when diagnosing object churn
  [LogCategory.IDENTITY_GRAPH]: LogLevel.WARN,        // Log identity churn
  [LogCategory.IDENTITY_SCENARIOS]: LogLevel.WARN,
  [LogCategory.IDENTITY_ARRAYS]: LogLevel.WARN,
  [LogCategory.IDENTITY_FUNCTIONS]: LogLevel.WARN,
  
  // Performance - always on for slow operations
  [LogCategory.PERF_FRAME]: LogLevel.INFO,
  [LogCategory.PERF_MEMO]: LogLevel.INFO,
  [LogCategory.PERF_EFFECT]: LogLevel.INFO,
  [LogCategory.PERF_BUILD_EDGES]: LogLevel.INFO,
  [LogCategory.PERF_BUILD_BEADS]: LogLevel.NONE,      // Too verbose, enable if needed
  [LogCategory.PERF_CHEVRON_CALC]: LogLevel.WARN,     // Only log slow ones
  [LogCategory.PERF_TEXT_MEASURE]: LogLevel.NONE,
  
  // ReactFlow - enable when diagnosing ReactFlow interaction issues
  [LogCategory.REACTFLOW_CALLBACKS]: LogLevel.NONE,
  [LogCategory.REACTFLOW_STATE]: LogLevel.NONE,
  
  // Issues - always on
  [LogCategory.ISSUE_RENDER_LOOP]: LogLevel.ERROR,
  [LogCategory.ISSUE_RENDER_VIOLATION]: LogLevel.ERROR,
  [LogCategory.ISSUE_FRAME_BUDGET]: LogLevel.WARN,
  [LogCategory.ISSUE_RACE_CONDITION]: LogLevel.ERROR,
  
  // Cache - enable when diagnosing cache effectiveness
  [LogCategory.CACHE_HITS]: LogLevel.NONE,
  [LogCategory.CACHE_MISSES]: LogLevel.NONE,
};

// ============================================================================
// Logging API
// ============================================================================

interface LogEntry {
  timestamp: number;
  frameId?: number;
  category: LogCategory;
  level: LogLevel;
  message: string;
  data?: any;
}

const diagnosticLog: LogEntry[] = [];
const MAX_LOG_ENTRIES = 2000;

export const logger = {
  /**
   * Log a message if the category's configured level allows it
   */
  log(category: LogCategory, level: LogLevel, message: string, data?: any, frameId?: number) {
    const configuredLevel = LOG_CONFIG[category];
    
    if (level > configuredLevel) {
      return; // Filtered out
    }
    
    const entry: LogEntry = {
      timestamp: performance.now(),
      frameId,
      category,
      level,
      message,
      data
    };
    
    // Store in diagnostic log
    diagnosticLog.push(entry);
    if (diagnosticLog.length > MAX_LOG_ENTRIES) {
      diagnosticLog.shift();
    }
    
    // Output to console with appropriate method
    const prefix = `[${category}]`;
    const formattedData = data ? data : '';
    
    switch (level) {
      case LogLevel.ERROR:
        console.error(prefix, message, formattedData);
        break;
      case LogLevel.WARN:
        console.warn(prefix, message, formattedData);
        break;
      case LogLevel.INFO:
      case LogLevel.DEBUG:
      case LogLevel.TRACE:
        console.log(prefix, message, formattedData);
        break;
    }
  },
  
  // Convenience methods
  error(category: LogCategory, message: string, data?: any, frameId?: number) {
    this.log(category, LogLevel.ERROR, message, data, frameId);
  },
  
  warn(category: LogCategory, message: string, data?: any, frameId?: number) {
    this.log(category, LogLevel.WARN, message, data, frameId);
  },
  
  info(category: LogCategory, message: string, data?: any, frameId?: number) {
    this.log(category, LogLevel.INFO, message, data, frameId);
  },
  
  debug(category: LogCategory, message: string, data?: any, frameId?: number) {
    this.log(category, LogLevel.DEBUG, message, data, frameId);
  },
  
  trace(category: LogCategory, message: string, data?: any, frameId?: number) {
    this.log(category, LogLevel.TRACE, message, data, frameId);
  },
  
  /**
   * Performance timing helper
   * Returns a function to call when operation completes
   */
  perf(category: LogCategory, operation: string, frameId?: number, threshold?: number) {
    const t0 = performance.now();
    
    return (data?: any) => {
      const t1 = performance.now();
      const duration = t1 - t0;
      
      // Only log if exceeds threshold (if provided) or if category is enabled
      if (threshold && duration < threshold) {
        return duration;
      }
      
      this.info(category, `${operation}: ${duration.toFixed(2)}ms`, data, frameId);
      return duration;
    };
  },
  
  /**
   * Get all diagnostic logs (for export)
   */
  getDiagnostics(): LogEntry[] {
    return [...diagnosticLog];
  },
  
  /**
   * Clear diagnostic logs
   */
  clearDiagnostics() {
    diagnosticLog.length = 0;
  },
  
  /**
   * Export diagnostics to JSON file
   */
  exportDiagnostics() {
    const blob = new Blob([JSON.stringify(diagnosticLog, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `render-diagnostics-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
};

// Expose on window for console access
if (typeof window !== 'undefined') {
  (window as any).__logger = logger;
  (window as any).__exportDiagnostics = () => logger.exportDiagnostics();
  (window as any).__clearDiagnostics = () => logger.clearDiagnostics();
  (window as any).__getDiagnostics = () => logger.getDiagnostics();
}
```

### 0.2 Usage Examples

Instead of direct `console.log`:

```typescript
// OLD:
console.log(`[PERF] buildScenarioRenderEdges: ${time}ms`);

// NEW:
import { logger, LogCategory } from '@/diagnostics/logger';

logger.info(
  LogCategory.PERF_BUILD_EDGES, 
  `buildScenarioRenderEdges: ${time}ms`,
  { edgeCount, layerCount },
  frameId
);
```

With performance timing helper:

```typescript
// OLD:
const t0 = performance.now();
const result = expensiveOperation();
const t1 = performance.now();
console.log(`Operation took ${t1-t0}ms`);

// NEW:
const endTimer = logger.perf(LogCategory.PERF_MEMO, 'renderEdges', frameId, 5); // 5ms threshold
const result = expensiveOperation();
endTimer({ resultCount: result.length });
```

### 0.3 Configuration Profiles

Create preset configurations for different diagnostic scenarios:

```typescript
// Diagnostic profiles - easy switching
export const LOG_PROFILES = {
  // Minimal - only critical issues
  PRODUCTION: {
    default: LogLevel.NONE,
    overrides: {
      [LogCategory.ISSUE_RENDER_LOOP]: LogLevel.ERROR,
      [LogCategory.ISSUE_RENDER_VIOLATION]: LogLevel.ERROR,
      [LogCategory.ISSUE_FRAME_BUDGET]: LogLevel.WARN,
      [LogCategory.ISSUE_RACE_CONDITION]: LogLevel.ERROR,
    }
  },
  
  // Normal development - performance tracking
  DEVELOPMENT: {
    default: LogLevel.NONE,
    overrides: {
      [LogCategory.PERF_FRAME]: LogLevel.INFO,
      [LogCategory.PERF_MEMO]: LogLevel.INFO,
      [LogCategory.PERF_BUILD_EDGES]: LogLevel.INFO,
      [LogCategory.ISSUE_RENDER_LOOP]: LogLevel.ERROR,
      [LogCategory.ISSUE_FRAME_BUDGET]: LogLevel.WARN,
    }
  },
  
  // Investigating dependency instability
  DEBUG_DEPENDENCIES: {
    default: LogLevel.NONE,
    overrides: {
      [LogCategory.DEPS_RENDER_EDGES]: LogLevel.INFO,
      [LogCategory.DEPS_HIGHLIGHT]: LogLevel.INFO,
      [LogCategory.DEPS_BEAD_DEFS]: LogLevel.INFO,
      [LogCategory.IDENTITY_GRAPH]: LogLevel.WARN,
      [LogCategory.IDENTITY_SCENARIOS]: LogLevel.WARN,
      [LogCategory.IDENTITY_ARRAYS]: LogLevel.WARN,
      [LogCategory.IDENTITY_FUNCTIONS]: LogLevel.WARN,
      [LogCategory.MEMO_RENDER_EDGES]: LogLevel.INFO,
    }
  },
  
  // Investigating context re-emits
  DEBUG_CONTEXTS: {
    default: LogLevel.NONE,
    overrides: {
      [LogCategory.CONTEXT_GRAPH_STORE]: LogLevel.INFO,
      [LogCategory.CONTEXT_SCENARIOS]: LogLevel.INFO,
      [LogCategory.CONTEXT_TAB]: LogLevel.INFO,
      [LogCategory.CONTEXT_NAVIGATOR]: LogLevel.INFO,
      [LogCategory.IDENTITY_GRAPH]: LogLevel.WARN,
      [LogCategory.IDENTITY_SCENARIOS]: LogLevel.WARN,
    }
  },
  
  // Investigating render cascades
  DEBUG_RENDERS: {
    default: LogLevel.NONE,
    overrides: {
      [LogCategory.RENDER_APP_SHELL]: LogLevel.INFO,
      [LogCategory.RENDER_GRAPH_EDITOR]: LogLevel.INFO,
      [LogCategory.RENDER_GRAPH_CANVAS]: LogLevel.INFO,
      [LogCategory.RENDER_CONVERSION_EDGE]: LogLevel.DEBUG,
      [LogCategory.RENDER_EDGE_BEADS]: LogLevel.DEBUG,
      [LogCategory.ISSUE_RENDER_LOOP]: LogLevel.ERROR,
    }
  },
  
  // Investigating effects
  DEBUG_EFFECTS: {
    default: LogLevel.NONE,
    overrides: {
      [LogCategory.EFFECT_WHAT_IF_RECOMPUTE]: LogLevel.INFO,
      [LogCategory.EFFECT_GRAPH_SYNC]: LogLevel.INFO,
      [LogCategory.EFFECT_AUTO_REROUTE]: LogLevel.INFO,
      [LogCategory.EFFECT_SANKEY_LAYOUT]: LogLevel.INFO,
      [LogCategory.EFFECT_VIEWPORT_SAVE]: LogLevel.INFO,
      [LogCategory.ISSUE_RACE_CONDITION]: LogLevel.ERROR,
    }
  },
  
  // Full diagnostic - everything
  FULL_DIAGNOSTIC: {
    default: LogLevel.DEBUG,
    overrides: {
      [LogCategory.PERF_TEXT_MEASURE]: LogLevel.NONE, // Too noisy
      [LogCategory.RENDER_CONVERSION_EDGE]: LogLevel.NONE, // Too many edges
    }
  }
};

// ============================================================================
// ACTIVE PROFILE - Change this to switch logging modes
// ============================================================================

const ACTIVE_PROFILE = LOG_PROFILES.DEVELOPMENT;

// Apply profile to LOG_CONFIG
export function applyProfile(profile: typeof LOG_PROFILES[keyof typeof LOG_PROFILES]) {
  // Reset all to default
  Object.keys(LOG_CONFIG).forEach(cat => {
    LOG_CONFIG[cat as LogCategory] = profile.default;
  });
  
  // Apply overrides
  Object.entries(profile.overrides).forEach(([cat, level]) => {
    LOG_CONFIG[cat as LogCategory] = level;
  });
}

// Auto-apply active profile on module load
applyProfile(ACTIVE_PROFILE);
```

To change logging mode, just change:

```typescript
const ACTIVE_PROFILE = LOG_PROFILES.DEBUG_DEPENDENCIES;
```

No other code changes needed.

### 0.4 Advanced Features

**Conditional logging based on conditions:**

```typescript
export const logger = {
  // ... existing methods
  
  /**
   * Log only if condition is met (for filtering specific cases)
   */
  logIf(condition: boolean, category: LogCategory, level: LogLevel, message: string, data?: any) {
    if (condition) {
      this.log(category, level, message, data);
    }
  },
  
  /**
   * Log with rate limiting (prevent log spam)
   */
  logThrottled(category: LogCategory, level: LogLevel, message: string, data?: any, minIntervalMs = 1000) {
    const key = `${category}:${message}`;
    const lastLog = (this as any)._lastLogTime?.[key] || 0;
    const now = performance.now();
    
    if (now - lastLog >= minIntervalMs) {
      this.log(category, level, message, data);
      (this as any)._lastLogTime = (this as any)._lastLogTime || {};
      (this as any)._lastLogTime[key] = now;
    }
  },
  
  /**
   * Performance tracking with automatic threshold filtering
   */
  perfAuto(category: LogCategory, operation: string, frameId?: number) {
    const thresholds = {
      [LogCategory.PERF_FRAME]: 5,
      [LogCategory.PERF_MEMO]: 2,
      [LogCategory.PERF_BUILD_EDGES]: 2,
      [LogCategory.PERF_BUILD_BEADS]: 2,
      [LogCategory.PERF_CHEVRON_CALC]: 2,
      [LogCategory.PERF_TEXT_MEASURE]: 1,
    };
    
    return this.perf(category, operation, frameId, thresholds[category]);
  }
};
```

## Phase 1: Complete Render Path Mapping

### 1.1 Component Hierarchy & State Flow

Document the exact render path from root to leaf:

```
App
└─ AppShell
   ├─ NavigatorContext (workspace files, git state, dirty flags)
   ├─ TabContext (tabs, active tab, per-tab state, rfViewport)
   ├─ ValidationContext
   └─ DialogContext
   └─ [Layout + Panels]
      └─ GraphEditor
         ├─ GraphStoreContext (graph data, history, undo/redo)
         ├─ ScenariosContext (scenarios, visible sets, colors, base/current params)
         └─ ViewPreferencesContext (view settings)
         └─ GraphCanvas (CanvasInner)
            ├─ ReactFlowProvider
            └─ ReactFlow
               ├─ Nodes (ConversionNode)
               └─ Edges (ConversionEdge)
                  └─ EdgeBeadsRenderer
                     └─ useEdgeBeads
```

**For each context, document:**
- What state it manages
- What triggers state changes
- Which components consume it (direct subscribers)
- Whether it uses object/array refs or primitives
- How often it re-emits (every render? only on actual change?)

### 1.2 Critical State Dependencies

Map dependencies for heavy computations:

**`GraphCanvas.renderEdges` useMemo:**
```
Dependencies (current):
  - edgeIdsKey (derived from edges.map(e => e.id))
  - nodeIdsKey (derived from nodes.map(n => n.id))
  - graph (from GraphStoreContext)
  - scenariosContext (from ScenariosContext)
  - visibleScenarioIds (from TabContext → scenarioState)
  - visibleColorOrderIds (from TabContext → scenarioState)
  - effectiveWhatIfDSL (computed in GraphCanvas from props + tab)
  - useUniformScaling (from TabContext → editorState)
  - massGenerosity (from TabContext → editorState)
  - useSankeyView (from TabContext → editorState)
  - calculateEdgeOffsets (useMemo/useCallback in GraphCanvas)
  - tabId (prop from GraphEditor)
  - highlightMetadata (useMemo in GraphCanvas)

For each dependency:
  - What's its SOURCE?
  - How is it derived?
  - What triggers its change?
  - Is it a stable primitive, or a mutable object/function?
  - Does it change on every render, or only on semantic changes?
```

**`GraphCanvas.highlightMetadata` useMemo:**
```
Dependencies (current):
  - nodeSelectionKey (derived from selectedNodesForAnalysis)
  - edgesChanged (boolean derived from edges topology comparison)
  - findPathEdges (useCallback, depends on ?)

Trace back:
  - What does findPathEdges depend on?
  - What makes selectedNodesForAnalysis change?
  - Is edgesChanged actually stable during pan/zoom?
```

**`GraphCanvas.calculateEdgeOffsets` useMemo/useCallback:**
```
Dependencies (current):
  - ? (need to find this in code)

Questions:
  - Does it change identity on every render?
  - Does it depend on graph/tabs/tabId?
  - Should it be hoisted to a higher scope or cached?
```

**What-if recompute effect:**
```
Dependencies (current):
  - overridesVersion (effectiveWhatIfDSL)
  - setEdges

Questions:
  - Why did it fire during pan (177ms spike)?
  - Was overridesVersion changing, or was it the old [nodes, edges.length] deps?
  - Is there a race where the effect sees stale state and recomputes unnecessarily?
```

## Phase 2: Comprehensive Instrumentation

### 2.1 Context Re-Render Tracking

**For each context provider**, instrument to log:
- When the context value changes (new object emitted)
- Which properties actually changed vs object identity churn
- How many consumers re-rendered as a result

**Implementation:**

Add to each context:

```typescript
// In NavigatorContext.tsx, ScenariosContext.tsx, TabContext.tsx, GraphStoreContext.tsx, etc.
import { logger, LogCategory, LogLevel } from '@/diagnostics/logger';

const contextVersion = useRef(0);
const prevValue = useRef(currentContextValue);

useEffect(() => {
  const changed = prevValue.current !== currentContextValue;
  const deepChanged = JSON.stringify(prevValue.current) !== JSON.stringify(currentContextValue);
  
  if (changed) {
    contextVersion.current++;
    
    const category = LogCategory.CONTEXT_GRAPH_STORE; // or CONTEXT_SCENARIOS, etc.
    const level = changed && !deepChanged ? LogLevel.WARN : LogLevel.INFO;
    
    logger.log(category, level, `${ContextName} re-emit v${contextVersion.current}`, {
      identityChanged: changed,
      semanticChanged: deepChanged,
      reason: changed && !deepChanged ? 'IDENTITY_CHURN' : 'SEMANTIC_CHANGE'
    });
  }
  
  prevValue.current = currentContextValue;
});
```

### 2.2 Dependency Change Tracking

**For each expensive `useMemo/useCallback`**, add dependency change detection:

```typescript
import { logger, LogCategory } from '@/diagnostics/logger';

const renderEdges = useMemo(() => {
  const endTimer = logger.perf(LogCategory.MEMO_RENDER_EDGES, 'renderEdges', frameId, 2);
  
  // DIAGNOSTIC: Log which deps changed
  const currentDeps = {
    edgeIdsKey,
    nodeIdsKey,
    graph: graph?.nodes?.length || 0, // summarize
    scenariosContext: scenariosContext?.scenarios?.length || 0,
    visibleScenarioIds: visibleScenarioIds.join(','),
    visibleColorOrderIds: visibleColorOrderIds.join(','),
    effectiveWhatIfDSL,
    useUniformScaling,
    massGenerosity,
    useSankeyView,
    calculateEdgeOffsets: calculateEdgeOffsets.name || 'fn',
    tabId,
    highlightMetadata: highlightMetadata?.highlightedEdgeIds.size || 0
  };
  
  if (prevRenderEdgeDeps.current) {
    const changes: string[] = [];
    Object.keys(currentDeps).forEach(key => {
      if (prevRenderEdgeDeps.current![key] !== currentDeps[key]) {
        changes.push(`${key}: ${prevRenderEdgeDeps.current![key]} → ${currentDeps[key]}`);
      }
    });
    
    if (changes.length > 0) {
      logger.info(LogCategory.DEPS_RENDER_EDGES, 'renderEdges recomputing due to changes', changes, frameId);
    }
  }
  prevRenderEdgeDeps.current = currentDeps;
  
  // ... actual memo logic
  const result = buildScenarioRenderEdges(...);
  
  endTimer({ edgeCount: result.length });
  
  return result;
}, [ all the deps ]);
```

Apply this pattern to:
- `renderEdges`
- `highlightMetadata`
- `calculateEdgeOffsets`
- `calculateEdgeWidth`
- `beadDefinitions` (in EdgeBeads.tsx)
- Any other expensive memos/callbacks

### 2.3 Effect Execution Tracking

**For every `useEffect` in GraphCanvas**, add execution logging:

```typescript
import { logger, LogCategory } from '@/diagnostics/logger';

useEffect(() => {
  const frameId = renderFrameRef.current;
  logger.info(LogCategory.EFFECT_WHAT_IF_RECOMPUTE, 'Effect FIRED', { overridesVersion }, frameId);
  
  const endTimer = logger.perf(LogCategory.EFFECT_WHAT_IF_RECOMPUTE, 'whatIfRecompute', frameId, 10);
  
  // ... effect logic
  
  endTimer();
  
  return () => {
    logger.debug(LogCategory.EFFECT_WHAT_IF_RECOMPUTE, 'Effect CLEANUP', {}, frameId);
  };
}, [overridesVersion, setEdges]);
```

Track:
- Which effects fire during pan
- Which effects fire multiple times in succession
- Which effects have cleanup running unexpectedly
- Effect execution order (React 18 can batch/defer)

### 2.4 Render Cascade Tracking

**Instrument each major component to log:**
- When it renders
- Why it rendered (props changed? context changed? parent re-render?)
- How long the render took

```typescript
// In AppShell, GraphEditor, GraphCanvas, ConversionEdge
import { logger, LogCategory } from '@/diagnostics/logger';

function ComponentName(props) {
  const renderCount = useRef(0);
  const prevProps = useRef(props);
  const t0 = performance.now();
  
  renderCount.current++;
  
  // Detect why we're rendering
  const propsChanged = prevProps.current !== props;
  const changedKeys = propsChanged ? Object.keys(props).filter(
    k => prevProps.current[k] !== props[k]
  ) : [];
  
  const category = LogCategory.RENDER_GRAPH_CANVAS; // or appropriate category
  logger.debug(category, `Render #${renderCount.current}`, {
    propsChanged,
    changedKeys,
    timestamp: Date.now()
  });
  
  prevProps.current = props;
  
  // ... component logic
  
  useEffect(() => {
    const t1 = performance.now();
    const duration = t1 - t0;
    
    logger.logIf(
      duration > 5,
      category,
      LogLevel.INFO,
      `Render #${renderCount.current} complete: ${duration.toFixed(2)}ms`
    );
  });
  
  return (...);
}
```

### 2.5 ReactFlow Integration Tracking

**Track ReactFlow's own render triggers:**

- `onNodesChange` / `onEdgesChange` callbacks
- When `setNodes` / `setEdges` are called
- Whether ReactFlow is mutating nodes/edges internally
- Viewport changes

```typescript
import { logger, LogCategory } from '@/diagnostics/logger';

const onNodesChange = useCallback((changes) => {
  logger.debug(LogCategory.REACTFLOW_CALLBACKS, 'onNodesChange', {
    changeTypes: changes.map(c => c.type),
    count: changes.length
  }, renderFrameRef.current);
  
  onNodesChangeBase(changes);
}, [onNodesChangeBase]);

const onEdgesChange = useCallback((changes) => {
  logger.debug(LogCategory.REACTFLOW_CALLBACKS, 'onEdgesChange', {
    changeTypes: changes.map(c => c.type),
    count: changes.length
  }, renderFrameRef.current);
  
  onEdgesChangeBase(changes);
}, [onEdgesChangeBase]);

const onMove = useCallback((event, viewport) => {
  logger.trace(LogCategory.REACTFLOW_CALLBACKS, 'onMove', { viewport }, renderFrameRef.current);
  // ... existing logic
}, [...]);
```

## Phase 3: Frame Budget Analysis

### 3.1 Per-Frame Work Breakdown

For each frame, log the complete breakdown:

```typescript
import { logger, LogCategory, LogLevel } from '@/diagnostics/logger';

// At top of GraphCanvas render:
const frameT0 = performance.now();
const frameWork = useRef({
  renderStart: 0,
  memos: {} as Record<string, number>,
  effects: {} as Record<string, number>,
  dom: {} as Record<string, number>,
  paint: 0
});

frameWork.current.renderStart = frameT0;

// After each expensive operation:
const memoEnd = logger.perf(LogCategory.MEMO_RENDER_EDGES, 'renderEdges', frameId);
const result = buildScenarioRenderEdges(...);
frameWork.current.memos.renderEdges = memoEnd();

// At end of render (in useEffect):
useEffect(() => {
  const frameT1 = performance.now();
  frameWork.current.paint = frameT1;
  
  const memosTotal = Object.values(frameWork.current.memos).reduce((sum, v) => sum + v, 0);
  const effectsTotal = Object.values(frameWork.current.effects).reduce((sum, v) => sum + v, 0);
  
  const breakdown = {
    totalFrame: frameT1 - frameWork.current.renderStart,
    memos: memosTotal,
    effects: effectsTotal,
    unaccounted: (frameT1 - frameWork.current.renderStart) - (memosTotal + effectsTotal)
  };
  
  if (breakdown.totalFrame > 16) {
    logger.error(
      LogCategory.ISSUE_FRAME_BUDGET, 
      `Frame #${renderFrameRef.current} EXCEEDED 16ms`,
      breakdown,
      renderFrameRef.current
    );
  }
  
  logger.info(
    LogCategory.PERF_FRAME,
    `Frame #${renderFrameRef.current} complete: ${breakdown.totalFrame.toFixed(2)}ms`,
    breakdown,
    renderFrameRef.current
  );
});
```

### 3.2 Identify Frame-Busting Operations

Track operations that consistently exceed frame budget:

- Text measurement (canvas `measureText` calls)
- DOM queries (`getTotalLength`, `getPointAtLength`, `getBoundingClientRect`)
- Chevron offset calculation (`computeVisibleStartOffsetForEdge`)
- What-if probability recompute
- Edge offset calculation
- Scenario composition

For each, log:
- How many times it runs per frame
- Total accumulated time
- Whether it's cached or recomputed

## Phase 4: Race Condition Detection

### 4.1 Effect Execution Order Tracking

```typescript
// Global effect tracker (in a dedicated diagnostics.ts utility)
const effectLog: Array<{ name: string; timestamp: number; frameId: number; action: 'start' | 'end' | 'cleanup' }> = [];

export function logEffect(name: string, frameId: number, action: 'start' | 'end' | 'cleanup') {
  effectLog.push({ name, timestamp: performance.now(), frameId, action });
  
  // Detect overlapping effects (potential races)
  const recentEffects = effectLog.filter(e => e.timestamp > performance.now() - 100);
  const concurrent = recentEffects.filter(e => 
    e.action === 'start' && 
    !recentEffects.some(e2 => e2.name === e.name && e2.action === 'end' && e2.timestamp > e.timestamp)
  );
  
  if (concurrent.length > 3) {
    console.warn(`[RACE?] ${concurrent.length} concurrent effects:`, concurrent.map(e => e.name));
  }
}

// Usage in every effect:
useEffect(() => {
  logEffect('GraphCanvas.whatIfRecompute', renderFrameRef.current, 'start');
  
  // ... effect logic
  
  logEffect('GraphCanvas.whatIfRecompute', renderFrameRef.current, 'end');
  
  return () => {
    logEffect('GraphCanvas.whatIfRecompute', renderFrameRef.current, 'cleanup');
  };
}, [deps]);
```

### 4.2 State Update Tracking

Detect setState calls that happen during render (should never happen):

```typescript
import { logger, LogCategory, LogLevel } from '@/diagnostics/logger';

// Wrap setState functions with diagnostic proxies

const setEdgesTracked = useCallback((arg) => {
  const callStack = new Error().stack;
  const isInRender = callStack?.includes('renderWithHooks') || callStack?.includes('beginWork');
  
  if (isInRender) {
    logger.error(
      LogCategory.ISSUE_RENDER_VIOLATION,
      'setEdges called during render!',
      { callStack },
      renderFrameRef.current
    );
  }
  
  logger.trace(
    LogCategory.REACTFLOW_STATE,
    'setEdges called',
    { isInRender },
    renderFrameRef.current
  );
  
  setEdges(arg);
}, [setEdges]);
```

Apply to:
- `setNodes`, `setEdges`
- `setGraph`
- Any context setters called from GraphCanvas
- `setIsPanningOrZooming`

### 4.3 Detect Render Loops

Track when the same component renders multiple times in quick succession:

```typescript
import { logger, LogCategory } from '@/diagnostics/logger';

const renderTimestamps = useRef<number[]>([]);

// In component body:
renderTimestamps.current.push(performance.now());

// Keep only last 10 renders
if (renderTimestamps.current.length > 10) {
  renderTimestamps.current = renderTimestamps.current.slice(-10);
}

// Detect rapid re-renders (>3 in 100ms = likely loop)
const recent = renderTimestamps.current.filter(t => t > performance.now() - 100);
if (recent.length > 3) {
  logger.error(
    LogCategory.ISSUE_RENDER_LOOP,
    `${ComponentName} rendered ${recent.length} times in 100ms`,
    { timestamps: recent }
  );
}
```

## Phase 5: Dependency Stability Analysis

### 5.1 Object Identity Tracking

For every object/array/function dependency in expensive memos, track identity changes:

```typescript
import { logger, LogCategory, LogLevel } from '@/diagnostics/logger';

const graphIdentity = useRef({ ref: graph, version: 0 });

useEffect(() => {
  if (graphIdentity.current.ref !== graph) {
    const prevRef = graphIdentity.current.ref;
    graphIdentity.current.version++;
    graphIdentity.current.ref = graph;
    
    // Is this a semantic change or just identity churn?
    const prevNodes = prevRef?.nodes?.length || 0;
    const currNodes = graph?.nodes?.length || 0;
    const prevEdges = prevRef?.edges?.length || 0;
    const currEdges = graph?.edges?.length || 0;
    
    const semanticChange = prevNodes !== currNodes || prevEdges !== currEdges;
    
    logger.log(
      LogCategory.IDENTITY_GRAPH,
      semanticChange ? LogLevel.INFO : LogLevel.WARN,
      `graph changed (v${graphIdentity.current.version})`,
      {
        semanticChange,
        reason: semanticChange ? 'TOPOLOGY_CHANGED' : 'IDENTITY_CHURN',
        nodes: `${prevNodes} → ${currNodes}`,
        edges: `${prevEdges} → ${currEdges}`
      },
      renderFrameRef.current
    );
  }
}, [graph]);
```

Apply to:
- `graph` (GraphStoreContext)
- `scenariosContext` (ScenariosContext)
- `visibleScenarioIds` / `visibleColorOrderIds` (TabContext)
- `calculateEdgeOffsets`, `calculateEdgeWidth` (callbacks)
- `highlightMetadata`

### 5.2 Detect Function Reference Instability

```typescript
const calculateEdgeOffsetsPrev = useRef(calculateEdgeOffsets);

useEffect(() => {
  if (calculateEdgeOffsetsPrev.current !== calculateEdgeOffsets) {
    console.log(`[IDENTITY] calculateEdgeOffsets changed:`, {
      prev: calculateEdgeOffsetsPrev.current.name || 'anonymous',
      curr: calculateEdgeOffsets.name || 'anonymous',
      frameId: renderFrameRef.current
    });
    calculateEdgeOffsetsPrev.current = calculateEdgeOffsets;
  }
}, [calculateEdgeOffsets]);
```

### 5.3 Array Stability Analysis

For `visibleScenarioIds`, `visibleColorOrderIds`:

```typescript
const visibleScenarioIdsPrev = useRef<string[]>([]);

useEffect(() => {
  const identitySame = visibleScenarioIdsPrev.current === visibleScenarioIds;
  const contentSame = visibleScenarioIdsPrev.current.join(',') === visibleScenarioIds.join(',');
  
  if (!identitySame) {
    console.log(`[IDENTITY] visibleScenarioIds changed:`, {
      identitySame,
      contentSame,
      reason: !identitySame && contentSame ? 'ARRAY_RECREATION' : 'CONTENT_CHANGED',
      prev: visibleScenarioIdsPrev.current.join(','),
      curr: visibleScenarioIds.join(',')
    });
  }
  
  visibleScenarioIdsPrev.current = visibleScenarioIds;
}, [visibleScenarioIds]);
```

## Phase 6: Bead/Edge Render Performance

### 6.1 Per-Edge Render Cost

Already partially instrumented, but expand to track:

```typescript
// In useEdgeBeads:

const breakdown = {
  beadDefsBuild: 0,
  pathMetrics: 0,
  textMeasurement: 0,
  layoutCalc: 0,
  svgConstruction: 0
};

// Around buildBeadDefinitions call:
const t0 = performance.now();
const beadDefinitions = ...;
breakdown.beadDefsBuild = performance.now() - t0;

// Around path.getTotalLength():
const t1 = performance.now();
const pathLength = path.getTotalLength();
breakdown.pathMetrics = performance.now() - t1;

// Around each measureTextWidth call:
const t2 = performance.now();
const width = measureTextWidth(...);
breakdown.textMeasurement += performance.now() - t2;

// etc.

console.log(`[PERF] useEdgeBeads(${edgeId}) breakdown:`, breakdown);
```

### 6.2 Chevron Offset Calculation Cost

```typescript
// In computeVisibleStartOffsetForEdge:

const diagnostic = {
  clipPathFound: !!clip,
  pathParsed: !!d,
  coarseSamples: 0,
  binaryIterations: 0,
  totalTime: 0
};

// Track samples:
for (let dLen = coarseStep; dLen <= maxProbe; dLen += coarseStep) {
  diagnostic.coarseSamples++;
  // ...
}

// Track binary search iterations:
while (lo < hi && iterations < maxIterations) {
  diagnostic.binaryIterations++;
  iterations++;
  // ...
}

diagnostic.totalTime = performance.now() - t0;

if (diagnostic.totalTime > 5) {
  console.warn(`[PERF] computeVisibleStartOffsetForEdge SLOW:`, diagnostic);
}
```

### 6.3 Text Measurement Caching Effectiveness

```typescript
// In measureTextWidth:

const textCache = new Map<string, number>();
let cacheHits = 0;
let cacheMisses = 0;

function measureTextWidth(text: string, fontSize: number, fontWeight: string): number {
  const key = `${fontSize}|${fontWeight}|${text}`;
  
  if (textCache.has(key)) {
    cacheHits++;
    return textCache.get(key)!;
  }
  
  cacheMisses++;
  const width = /* actual measurement */;
  textCache.set(key, width);
  
  // Periodically log cache effectiveness
  if ((cacheHits + cacheMisses) % 100 === 0) {
    console.log(`[CACHE] Text measurement:`, {
      hits: cacheHits,
      misses: cacheMisses,
      hitRate: (cacheHits / (cacheHits + cacheMisses) * 100).toFixed(1) + '%',
      cacheSize: textCache.size
    });
  }
  
  return width;
}
```

## Phase 7: React Profiler Integration

### 7.1 Add React Profiler

Wrap critical components in `<Profiler>`:

```typescript
import { Profiler } from 'react';

function onRenderCallback(
  id: string,
  phase: 'mount' | 'update',
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number
) {
  console.log(`[PROFILER] ${id} ${phase}:`, {
    actualDuration: actualDuration.toFixed(2),
    baseDuration: baseDuration.toFixed(2),
    startTime: startTime.toFixed(2),
    commitTime: commitTime.toFixed(2)
  });
}

// Wrap:
<Profiler id="GraphCanvas" onRender={onRenderCallback}>
  <GraphCanvas ... />
</Profiler>

<Profiler id="ConversionEdge" onRender={onRenderCallback}>
  <ConversionEdge ... />
</Profiler>
```

This will show:
- Actual render time vs theoretical minimum
- Mount vs update phases
- Commit timings (when React flushes to DOM)

### 7.2 React DevTools Timeline

In addition to code instrumentation:

1. Open React DevTools
2. Go to Profiler tab
3. Start recording
4. Perform a pan operation
5. Stop recording
6. Analyze:
   - Which components re-rendered
   - Why they re-rendered (props change, context change, parent re-render)
   - Flame graph of render time distribution
   - Commit phases (work done in each commit)

## Phase 8: Systematic Diagnostic Procedure

### 8.1 Baseline Measurement

**Test scenario: Single pan operation (no other interactions)**

Instrumentation should capture:

1. **Total frames rendered**: from pan start to stable state
2. **Per-frame breakdown**:
   - GraphCanvas render time
   - renderEdges memo recompute (yes/no + time if yes)
   - buildScenarioRenderEdges time
   - What-if recompute (yes/no + time if yes)
   - Bead-related work (total across all edges)
3. **Context re-emits**: which contexts emitted new values during pan
4. **Effect executions**: which effects fired during pan
5. **ReactFlow callbacks**: how many onNodesChange/onEdgesChange events
6. **App-level cascades**: how many times AppShell, Navigator, etc. re-rendered

**Expected outcome for a "clean" pan:**
- 2-3 frames total (onMoveStart → onMove → onMoveEnd)
- renderEdges memo: 0 recomputes (should be cached)
- What-if recompute: 0 executions
- Context re-emits: 0 or 1 (only TabContext for viewport save)
- Effects: only onMove handlers, no heavy recomputes
- App-level: 0 re-renders (pan is local to GraphCanvas)

**Actual vs expected delta** = where the problems are.

### 8.2 Isolation Tests

Run separate tests to isolate each subsystem:

**Test 1: Pan with beads disabled**
- Temporarily comment out `EdgeBeadsRenderer` in `ConversionEdge`
- Measure pan performance
- If it's smooth → beads are the bottleneck
- If still janky → problem is elsewhere

**Test 2: Pan with scenarios disabled**
- Set `visibleScenarioIds = ['current']` (only one layer)
- Measure pan performance
- If smooth → scenario layering is the issue
- If still janky → problem is in base rendering

**Test 3: Pan with minimal graph**
- Load a 2-node, 1-edge graph
- Measure pan performance
- If smooth → complexity scaling issue (O(n²) somewhere?)
- If still janky → fundamental architecture problem

**Test 4: Static render (no pan)**
- Just let graph sit idle for 10 seconds
- Count how many frames render
- If >5 frames → background effect loop
- If 0-2 frames → rendering is stable, only pan triggers issues

### 8.3 Dependency Flapping Detection

For each heavy memo, log when deps change without semantic reason:

```typescript
const depsStability = useRef<Map<string, number>>(new Map());

// Track each dep:
const trackDep = (name: string, value: any) => {
  const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const prev = depsStability.current.get(name);
  
  if (prev !== undefined && prev !== serialized) {
    const isIdentityOnly = prev === serialized; // Won't happen due to !== check, but logic is: if object identity changed but content didn't
    console.log(`[DEP-FLAP] ${name} changed:`, {
      isIdentityOnly,
      frameId: renderFrameRef.current
    });
  }
  
  depsStability.current.set(name, serialized);
};

// In renderEdges memo:
trackDep('graph', graph);
trackDep('scenariosContext', scenariosContext);
trackDep('visibleScenarioIds', visibleScenarioIds);
// ... etc for all deps
```

## Phase 9: Comprehensive Logging Schema

### 9.1 Log Levels

Implement structured logging with severity levels:

```typescript
enum LogLevel { DEBUG, INFO, WARN, ERROR }

const LOG_CONFIG = {
  contexts: LogLevel.INFO,
  renders: LogLevel.INFO,
  effects: LogLevel.DEBUG,
  memos: LogLevel.INFO,
  performance: LogLevel.INFO,
  identities: LogLevel.WARN,
  frames: LogLevel.INFO
};

function log(category: keyof typeof LOG_CONFIG, level: LogLevel, message: string, data?: any) {
  if (level >= LOG_CONFIG[category]) {
    const prefix = `[${category.toUpperCase()}]`;
    if (level >= LogLevel.WARN) {
      console.warn(prefix, message, data);
    } else {
      console.log(prefix, message, data);
    }
  }
}
```

### 9.2 Structured Data Format

All logs use consistent format:

```typescript
{
  timestamp: number,        // performance.now()
  frameId: number,          // monotonic frame counter
  component: string,        // component name
  operation: string,        // what happened
  duration?: number,        // ms if applicable
  trigger?: string,         // what caused this
  metadata?: any            // additional context
}
```

### 9.3 Log Aggregation

Collect logs for post-analysis:

```typescript
const diagnosticLog: any[] = [];

function recordDiagnostic(entry: any) {
  diagnosticLog.push({
    ...entry,
    timestamp: performance.now(),
    frameId: renderFrameRef.current
  });
  
  // Keep last 1000 entries
  if (diagnosticLog.length > 1000) {
    diagnosticLog.shift();
  }
}

// Expose on window for console access:
(window as any).__diagnosticLog = diagnosticLog;

// Add helper to export logs:
(window as any).__exportDiagnostics = () => {
  const blob = new Blob([JSON.stringify(diagnosticLog, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `render-diagnostics-${Date.now()}.json`;
  a.click();
};
```

## Phase 10: Implementation Plan

### Step 1: Core Infrastructure (Day 1)

1. **Create `graph-editor/src/diagnostics/logger.ts`** (from Phase 0):
   - Central logging service with configurable categories/levels
   - Log profiles for different diagnostic modes
   - Structured log storage and export
   - Performance timing helpers

2. **Create `graph-editor/src/diagnostics/renderTracking.ts`**:
   - Render loop detector (uses logger)
   - Render cascade tracker
   - Component render reason analyzer
   
3. **Create `graph-editor/src/diagnostics/dependencyTracking.ts`**:
   - Object identity tracker (uses logger)
   - Dependency change detector for memos
   - Array/function stability helpers
   
4. **Create `graph-editor/src/diagnostics/effectTracking.ts`**:
   - Effect execution tracker (uses logger)
   - Effect cascade detector
   - Race condition detector

5. **Create `graph-editor/src/diagnostics/performanceMonitor.ts`**:
   - Frame budget monitor (uses logger)
   - Per-component render timing
   - Cache effectiveness tracking

### Step 2: Context Instrumentation (Day 1-2)

Instrument each context in order:

1. **GraphStoreContext**: track `graph` changes, history operations
2. **ScenariosContext**: track scenario list, visible sets, param changes
3. **TabContext**: track tab switching, state updates, viewport saves
4. **NavigatorContext**: track file changes, dirty flag updates

For each:
- Add context value identity tracking
- Add semantic change detection
- Add re-emit logging

### Step 3: GraphCanvas Heavy Memos (Day 2)

Instrument in order of expense:

1. **`renderEdges` useMemo**:
   - Full dependency change detection
   - Per-frame recompute tracking
   - Time breakdown (memo overhead vs actual work)

2. **`highlightMetadata` useMemo**:
   - Dependency change detection
   - Track when it runs vs when it should run
   - Identify spurious recomputes

3. **`calculateEdgeOffsets` useMemo/useCallback**:
   - Find its definition and dependencies
   - Track identity changes
   - Measure execution time

4. **`calculateEdgeWidth` useMemo/useCallback**:
   - Same as above

### Step 4: Effects Audit (Day 2-3)

For every `useEffect` in `GraphCanvas.tsx`:

1. Add execution logging (start/end/cleanup)
2. Add dependency change detection
3. Track timing (how long effect body runs)
4. Flag if effect runs during pan (when it shouldn't)

Priority effects:
- What-if recompute
- Graph→ReactFlow sync
- ReactFlow→Graph sync
- Auto-reroute
- Sankey layout triggers
- Viewport save

### Step 5: Bead & Edge Render Path (Day 3)

1. **ConversionEdge**:
   - Log when it renders
   - Track prop changes (especially data object)
   - Time breakdown (path calculation vs beads vs chevrons)

2. **EdgeBeads**:
   - Already has some perf logs; expand to:
     - Text measurement cache hit/miss
     - Path metrics cache hit/miss
     - Per-bead layout time
     - Memo recompute reasons

3. **buildBeadDefinitions**:
   - Already logged; add:
     - Per-bead-type time (prob vs cost vs variant vs conditional)
     - Scenario value lookup time
     - Color computation time

### Step 6: ReactFlow Integration (Day 3)

Instrument ReactFlow callbacks:

1. `onNodesChange` / `onEdgesChange`: log change types, frequency
2. `onMove` / `onMoveStart` / `onMoveEnd`: log viewport, timing
3. `onSelectionChange`: log what changed, timing
4. Track when `setNodes` / `setEdges` are called:
   - From where (call stack)
   - How often
   - Whether during render (violation) or in effect

### Step 7: Data Collection & Analysis (Day 4)

1. Run baseline pan test with full instrumentation
2. Capture diagnostic log
3. Export to JSON
4. Analyze:
   - **Render frequency**: identify render loops
   - **Dependency churn**: find unstable deps causing unnecessary memos
   - **Effect cascades**: find effects triggering other effects
   - **Frame budget**: identify operations that consistently bust 16ms
   - **Identity vs semantic**: quantify how much work is identity churn vs real changes

### Step 8: Root Cause Identification (Day 4)

Based on collected data, identify top 3-5 issues by impact:

**Potential findings:**
1. Context X is re-emitting on every render (identity churn)
2. Dependency Y changes identity but not semantically (object recreation)
3. Effect Z triggers effect W which triggers effect Z (loop)
4. Operation Q runs on every frame and takes >10ms (cache it)
5. Component C re-renders 10× per interaction (stop propagation)

**Prioritization criteria:**
- Frequency (how often it happens)
- Cost (ms per occurrence)
- Necessity (should it happen at all?)
- Total impact = frequency × cost

### Step 9: Targeted Fixes (Day 5+)

For each identified issue, implement **minimal, surgical fix**:

**Example: "graph reference changes but topology doesn't"**
- Fix: Add `graphVersion` counter in GraphStoreContext
- Increment only when nodes/edges added/removed/reordered
- Use `graphVersion` (number) in renderEdges deps instead of `graph` (object)
- Measure: re-run pan test, verify renderEdges doesn't recompute

**Example: "visibleScenarioIds array recreated every render"**
- Fix: In TabContext, use `useMemo` to stabilize the array
- Only recreate when scenario visibility actually changes
- Measure: verify no "ARRAY_RECREATION" logs during pan

**One fix at a time**, measure impact, iterate.

## Phase 10: Success Criteria

After implementing fixes, verify:

### Performance Targets

**Pan operation (baseline):**
- Total frames: ≤3 (start, move, end)
- renderEdges recomputes: 0
- What-if recompute executions: 0
- App-level re-renders (AppShell, Navigator): 0
- Total interaction time: <100ms

**Edge selection:**
- Total frames: ≤2
- renderEdges recomputes: 0 or 1 (only if highlight changes)
- Bead state update: <5ms total
- Total interaction time: <50ms

**What-if DSL change:**
- Total frames: ≤2
- renderEdges recomputes: 1 (expected)
- What-if recompute: 1 (expected, <50ms for 10-edge graph)
- Total update time: <100ms

### Stability Targets

**Idle graph (no interaction for 10 seconds):**
- Total renders: ≤2 (initial + one settle)
- Effect executions: 0 (except passive housekeeping)
- Memory stable (no leaks from accumulating logs/caches)

**Sustained interaction (30 seconds of pan/zoom/select):**
- Frame rate: ≥30fps (≤33ms per frame)
- No frame budget violations (>50ms frame)
- No render loops detected
- No identity churn warnings

## Phase 11: Documentation & Cleanup

After fixes are validated:

1. **Document the render architecture**:
   - Final dependency graph (what depends on what, why)
   - Caching strategy (what's cached, invalidation rules)
   - Performance characteristics (expected render times)

2. **Remove diagnostic instrumentation**:
   - Keep high-level perf logs (>10ms warnings)
   - Remove verbose dependency tracking
   - Remove frame-by-frame logging
   - Keep cache effectiveness monitors (useful long-term)

3. **Update RENDER_PERFORMANCE_PLAN.md** with:
   - Findings summary
   - Fixes implemented
   - Remaining known issues (if any)
   - Maintenance notes (how to avoid regressions)

## Appendix: Quick Reference Checklist

- [ ] Phase 1: Map complete component hierarchy and contexts
- [ ] Phase 2: Instrument all contexts with identity/semantic change tracking
- [ ] Phase 3: Add dependency change logging to all heavy memos
- [ ] Phase 4: Add execution tracking to all effects in GraphCanvas
- [ ] Phase 5: Add render cascade tracking to major components
- [ ] Phase 6: Instrument ReactFlow integration callbacks
- [ ] Phase 7: Add detailed per-edge and per-bead breakdown
- [ ] Phase 8: Add React Profiler wrappers
- [ ] Phase 9: Run baseline tests, collect diagnostic logs
- [ ] Phase 10: Analyze logs, identify top issues by impact
- [ ] Phase 11: Implement targeted fixes one at a time
- [ ] Phase 12: Validate against success criteria
- [ ] Phase 13: Document architecture, remove verbose instrumentation

## Tools & Utilities

Create these helper modules:

```
graph-editor/src/diagnostics/
  ├── logger.ts              # ★ Core logging service with configurable categories
  ├── renderTracking.ts      # Render loop detection, cascade tracking
  ├── dependencyTracking.ts  # Identity tracking, change detection
  ├── effectTracking.ts      # Effect execution tracking, race detection
  ├── performanceMonitor.ts  # Frame budget, operation timing
  └── cacheMonitor.ts        # Cache hit/miss tracking
```

**All utilities use the central `logger` service**, ensuring:
- Consistent log formatting
- Centralized config control (via LOG_CONFIG and profiles)
- Structured data collection
- Easy on/off toggling without code changes

### Quick Start

To enable different diagnostic modes, just change in `logger.ts`:

```typescript
// For normal development (performance tracking only):
const ACTIVE_PROFILE = LOG_PROFILES.DEVELOPMENT;

// To investigate dependencies:
const ACTIVE_PROFILE = LOG_PROFILES.DEBUG_DEPENDENCIES;

// To investigate render cascades:
const ACTIVE_PROFILE = LOG_PROFILES.DEBUG_RENDERS;

// To see everything:
const ACTIVE_PROFILE = LOG_PROFILES.FULL_DIAGNOSTIC;
```

No other code changes needed. All instrumentation is permanent but silent unless the relevant categories are enabled.

