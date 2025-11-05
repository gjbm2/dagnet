# Override Pattern: Design Specification

**Purpose:** Define the architectural pattern for tracking auto-populated vs. manually-overridden fields across all schemas  
**Status:** Design Phase  
**Date:** 2025-11-05  

**Related Documents:**
- [DATA_CONNECTIONS_SCHEMA_VALIDATION.md](./DATA_CONNECTIONS_SCHEMA_VALIDATION.md) — Schema validation and design principles
- [DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md](./DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md) — Implementation phases

---

## Executive Summary

As the system becomes more intelligent about auto-populating data from registries, parameter files, and external sources, we need a systematic way to:

1. **Track when data is auto-populated** vs. manually entered
2. **Preserve user overrides** when auto-calculation would otherwise overwrite
3. **Provide UI affordances** for resetting to auto-calculated values
4. **Enable safe automated updates** without destroying intentional user edits

**The Pattern:** Add `{field}_overridden` boolean flag for any field that can be auto-populated from another source.

---

## Core Motivation

### Problem Statement

**Scenario 1: Parameter Values**
- User connects edge to parameter file (p=0.30, n=1000, k=300)
- User what-ifs: adjusts p to 0.35 for sensitivity analysis
- Parameter file updates with new data (p=0.32)
- **Question:** Should we overwrite user's 0.35 with 0.32?
  - ❌ **No** if user intentionally overrode
  - ✅ **Yes** if user wants to track parameter file

**Scenario 2: Query Expressions**
- MSMDC algorithm generates: `from(a).to(b).exclude(c)`
- User manually edits to: `from(a).to(b).exclude(c,d)` (knows graph better)
- Graph structure changes (node added)
- **Question:** Should MSMDC regenerate query?
  - ❌ **No** if user manually refined
  - ✅ **Yes** if user wants auto-maintenance

**Scenario 3: Node Metadata**
- User creates node, links to registry entry "Checkout Started"
- System pulls label, description, event_id from registry
- User renames label to "Begin Checkout" for clarity
- Registry updates description
- **Question:** Should we update node's description?
  - ✅ **Yes** for description (not overridden)
  - ❌ **No** for label (user intentionally changed)

### Solution: Override Tracking

Track which fields are auto-populated vs. manually overridden, enabling:
- **Intelligent updates:** Only update non-overridden fields
- **User affordances:** Show "overridden" badges, "reset to auto" buttons
- **Intentional divergence:** User can consciously choose to diverge from source
- **Safe automation:** System can auto-update without destroying user work

---

## Design Principles

### 1. **Explicit is Better Than Implicit**
- User action determines override status, not inference
- If user edits a field, mark it overridden
- Provide explicit "reset to auto" action

### 2. **Granular Tracking**
- Track per-field (not per-entity)
- User may override label but not description

### 3. **Fail Safe**
- If in doubt, DON'T overwrite
- Better to miss an update than destroy user work

### 4. **Progressive Enhancement**
- Override pattern is optional (backward compatible)
- Missing `_overridden` flag → assume not overridden (safe default)

### 5. **Consistent Naming**
- Standard suffix: `{field}_overridden`
- Predictable for generic components
- TypeScript-friendly autocomplete

---

## The Pattern

### Basic Structure

```typescript
interface OverridableField {
  // The actual value (always present)
  [fieldName]: T;
  
  // Override tracking (optional)
  [fieldName + "_overridden"]: boolean;
  
  // Optional: Store original auto-value for comparison/reset
  [fieldName + "_auto_value"]?: T;
  
  // Optional: Track what calculated it
  [fieldName + "_source"]?: "registry" | "parameter" | "calculated" | "manual";
}
```

### Example: Node with Auto-Populated Fields

```typescript
node = {
  // Core identity (NOT overridden - these ARE the connections)
  id: "node-uuid-123",
  slug: "checkout-started",           // User chooses this (creates link)
  
  // Auto-populated from node registry
  label: "Begin Checkout",            // User edited from "Checkout Started"
  label_overridden: true,             // ← Marked as override
  label_auto_value: "Checkout Started", // Original from registry
  label_source: "registry",
  
  description: "User begins checkout process",
  description_overridden: false,      // ← Still tracking registry
  description_source: "registry",
  
  event_id: "checkout_started",
  event_id_overridden: false,
  event_source: "registry"
}
```

### Example: Edge Probability with Evidence

```typescript
edge.p = {
  // User-facing values (primary)
  p: 0.35,                    // User overrode from 0.30
  p_overridden: true,         // ← Override flag (suffix pattern)
  
  stdev: 0.015,               // Still using calculated value
  stdev_overridden: false,
  
  distribution: "beta",       // Still using inferred value
  distribution_overridden: false,
  
  // Evidence (observations from data source, NOT overridable)
  evidence: {
    n: 1000,
    k: 300,                   // Would give p=0.30
    window_from: "2025-10-01T00:00:00Z",
    window_to: "2025-10-31T23:59:59Z",
    retrieved_at: "2025-11-05T10:00:00Z",
    source: "amplitude"
  },
  
  // Metadata
  parameter_id: "checkout-conversion",
  locked: false
}
```

**Note:** We do NOT store auto-calculated values. When user clears override flag, we recalculate from source on demand.

---

## When to Apply Override Pattern

### The Rule

**A field should support override tracking if ALL of:**

1. ✅ **It CAN be automatically populated** from another source
2. ✅ **User might have legitimate reason** to override the auto-value
3. ✅ **The source might change** (triggering potential re-population)
4. ✅ **The divergence is meaningful** (not just stale)

### Examples

| Field | Auto-Source | Override? | Rationale |
|-------|-------------|-----------|-----------|
| `node.label` | Node registry | ✅ YES | User may want graph-specific label |
| `node.id` | - | ❌ NO | Internal UUID, never auto-populated |
| `node.slug` | - | ❌ NO | User chooses this (IS the connection) |
| `edge.p.p` | Parameter file or k/n | ✅ YES | User may what-if with different value |
| `edge.p.n` | Data source | ❌ NO | Observation, not calculation |
| `edge.query` | MSMDC algorithm | ✅ YES | User may refine auto-generated query |
| `case.weight` | Statsig API | ✅ YES | User may what-if with different weights |
| `metadata.created_at` | System timestamp | ❌ NO | Fact, rarely overridden |

---

## Systematic Schema Review

### 1. Graph Nodes

**Auto-populated from:** Node registry, Parameter file

```typescript
interface GraphNode {
  // Structure (NOT overridden)
  id: string;                         // ❌ Internal UUID
  slug: string;                       // ❌ User choice (connection mechanism)
  type: "regular" | "case";           // ❌ User choice
  
  // Metadata (CAN be overridden)
  label: string;                      // ✅ From registry or parameter.name
  label_overridden?: boolean;
  
  description?: string;               // ✅ From registry
  description_overridden?: boolean;
  
  event_id?: string;                  // ✅ From registry
  event_id_overridden?: boolean;
  
  // Visual properties (NOT override pattern - user positioning)
  x: number;                          // ❌ User drags
  y: number;                          // ❌ User drags
  color?: string;                     // ❓ MAYBE (if theme-based coloring in future)
}
```

**Use case:**
1. User creates node, links to `checkout-started` in registry
2. System pulls `label="Checkout Started"`, `description="..."`, `event_id="checkout_started"`
3. User edits label to "Begin Checkout" → `label_overridden: true`
4. Registry description updates → system updates node description (not overridden)
5. Registry label updates → system DOESN'T update node label (overridden)

---

### 2. Graph Edges

**Auto-populated from:** Parameter file, MSMDC algorithm

```typescript
interface GraphEdge {
  // Structure (NOT overridden)
  id: string;                         // ❌ Internal UUID
  from: string;                       // ❌ Structural (node UUID)
  to: string;                         // ❌ Structural (node UUID)
  
  // Metadata (CAN be overridden)
  label?: string;                     // ✅ From parameter.name
  label_overridden?: boolean;
  
  description?: string;               // ✅ From parameter.description
  description_overridden?: boolean;
  
  // Parameter values (CAN be overridden - using suffix pattern)
  p: {
    p: number;                        // ✅ From parameter or k/n
    p_overridden?: boolean;           // Override flag (suffix pattern)
    
    stdev?: number;                   // ✅ From parameter or binomial
    stdev_overridden?: boolean;
    
    distribution?: string;            // ✅ From parameter or inferred
    distribution_overridden?: boolean;
    
    evidence?: {                      // ❌ Observations (not overridable)
      n: number;
      k: number;
      window_from: string;            // Time window context
      window_to?: string;
      retrieved_at: string;
      source: string;
    };
    
    parameter_id?: string;            // Link to parameter file
    locked?: boolean;                 // User locked (no edits)
  };
  
  // Query expression (CAN be overridden)
  query?: string;                     // ✅ From MSMDC algorithm
  query_overridden?: boolean;         // Simple: false = auto-generated, true = manual
  // REMOVED: query_auto_generated (redundant - if not overridden, it's auto-generated)
  // REMOVED: query_calculated_from (can infer from overridden flag)
}
```

**Use cases:**
- **Parameter connection:** Edge links to parameter file, values auto-populate
- **What-if analysis:** User adjusts p from 0.30 to 0.35 for sensitivity
- **Query refinement:** User adds exclusion to MSMDC-generated query
- **Parameter update:** New data arrives, updates non-overridden fields only

---

### 3. Case Nodes (Graph)

**Auto-populated from:** Case registry, Statsig API

```typescript
interface CaseNode extends GraphNode {
  type: "case";
  
  case: {
    id: string;                       // ❌ Connection mechanism
    
    variants: Array<{
      name: string;                   // ❌ Structural (from case file)
      
      weight: number;                 // ✅ From case file or Statsig
      weight_overridden?: boolean;
      weight_auto_value?: number;
      weight_source?: "statsig" | "manual";
      
      description?: string;           // ✅ From case file
      description_overridden?: boolean;
      
      edges: string[];                // ❌ Structural (user assignment)
    }>;
  };
}
```

**Use case:**
- Statsig says 50/50 split
- User what-ifs with 60/40 split
- `weight_overridden: true` → Statsig updates don't overwrite user's what-if

---

### 4. Parameter Files

**Auto-populated from:** MSMDC algorithm (when created from graph), external sources (Amplitude, etc.)

```typescript
interface Parameter {
  // Core identity (NOT overridden)
  id: string;                         // ❌ User defines
  name: string;                       // ❌ User defines initially
  type: "probability" | "cost_gbp" | "cost_time"; // ❌ User defines
  
  // Query expression (CAN be overridden)
  query?: string;                     // ✅ From MSMDC (when param created from graph)
  query_overridden?: boolean;         // Simple: false = auto-generated, true = manual
  // REMOVED: query_auto_generated (redundant)
  
  // Condition (for conditional probabilities)
  condition?: {                       // ✅ From graph's conditional_p
    visited: string[];
  };
  condition_overridden?: boolean;
  
  // Metadata (MAYBE overridden - future AI features)
  description: string;                // ❓ Could be AI-generated (future)
  description_overridden?: boolean;
  
  tags?: string[];                    // ❓ Could be inferred (future)
  tags_overridden?: boolean;
  
  // Values array - historical record (NOT override pattern at param level)
  // Override pattern applies when PULLING from param to graph
  values: Array<ParameterValue>;
}
```

**Note:** Parameter files are append-only historical records. Override pattern mainly applies when **pulling from parameter file into graph**.

---

### 5. Case Files

**Auto-populated from:** Statsig API

```typescript
interface Case {
  // Core identity (NOT overridden)
  id: string;                         // ❌ User defines
  name: string;                       // ❌ User defines initially
  
  // Metadata - Registration data (NOT overridden at file level)
  description?: string;               // ❌ User-curated registration data
  
  // Platform connection
  platform: {
    type: "statsig" | "optimizely";  // ❌ User chooses
    experiment_id: string;            // Connection to platform
  };
  
  // Variants - STRUCTURE (names) from platform, WEIGHTS are data
  // Important: Variant NAMES are structural (define the branches)
  // Variant WEIGHTS are temporal data (retrieved from Statsig periodically)
  // Override pattern applies to WEIGHTS at GRAPH LEVEL (case nodes), not file level
  variants: Array<{
    name: string;                     // ❌ Structural (defines branches in graph)
    description?: string;             // ❌ Registration data
    
    // Baseline weight (from initial platform config)
    weight: number;                   // Default weight (for reference)                                    
  }>;
  
  // Schedules (time-windowed weights - DATA retrieved from Statsig)
  // Similar to parameter values array: append-only historical record
  schedules: Array<{
    start_date: string;
    end_date?: string;
    variants: Record<string, number>; // name → weight at this time
    retrieved_at: string;
    source: "statsig" | "manual";
  }>;
}

/**
 * IMPORTANT: Case File vs. Graph Case Node
 * 
 * Case File (param-registry/cases/):
 *   - Structural definition (variant names, descriptions)
 *   - Historical weight data (schedules array - like parameter values)
 *   - Append-only (retrieved from Statsig periodically)
 *   - NO override pattern (it's the source of truth)
 * 
 * Graph Case Node:
 *   - References case file by ID
 *   - Current working weights (pulled from latest schedule OR manually set)
 *   - Override pattern applies HERE (user what-ifs with different weights)
 *   - Example: Statsig says 50/50, user what-ifs with 60/40 → weight_overridden: true
 */
```

---

### 6. Node Registry

**Auto-populated from:** Rarely (manual curation primarily)

```typescript
interface NodeDefinition {
  // All fields typically manual
  // Future: Could have import from production schema
  
  id: string;                         // ❌ Manual
  name: string;                       // ❌ Manual
  description?: string;               // ❓ Could be from production schema (future)
  event_id?: string;                  // ❓ Could be from Amplitude discovery (future)
}
```

**Probably no override pattern needed in Phase 1** (manual curation).

---

### 7. Event Registry

**Auto-populated from:** Not in current design (manual curation)

```typescript
interface Event {
  id: string;                         // ❌ Canonical event ID
  name: string;                       // ❌ User-curated
  description?: string;               // ❌ User-curated
  
  connectors?: {
    amplitude?: {
      event_name?: string;            // Platform-specific mapping (if differs)
    };
  };
}
```

**Phase 1-3:** Manual curation, no override pattern needed

**Future (Phase 4+):** If we add Amplitude schema discovery, THEN consider override pattern for auto-discovered event properties

---

## Consistent Pattern: Suffix for ALL Override Flags

**No exceptions:** ALL override flags use the `{field}_overridden` suffix pattern, including edge parameter values.

```typescript
edge.p = {
  // Values with individual override flags (suffix pattern)
  p: number;
  p_overridden?: boolean;
  
  stdev?: number;
  stdev_overridden?: boolean;
  
  distribution?: string;
  distribution_overridden?: boolean;
  
  // Evidence (grouped - different concern, this is data not metadata)
  evidence?: {
    n: number;
    k: number;
    window_from: string;
    window_to?: string;
    retrieved_at: string;
    source: string;
  };
  
  // Metadata
  parameter_id?: string;
  locked?: boolean;
}
```

**Benefits of consistency:**
- One pattern to learn across entire system
- Generic components work uniformly: `Object.keys(entity).filter(k => k.endsWith('_overridden'))`
- TypeScript autocomplete works consistently
- No special cases in schema validation

### Visual Indicators on Graph Canvas

**Node Badges:**
- Show small `<ZapOff>` badge in top-right corner if ANY field has auto-updates disabled
- Tooltip: "Has disabled auto-updates (click for details)"

**Edge Badges:**
- Show small `<ZapOff>` badge near edge label if ANY field has auto-updates disabled
- Tooltip: "Has disabled auto-updates (click for details)"

**Implementation:**
```typescript
function NodeRenderer({ node }: { node: GraphNode }) {
  const hasOverrides = hasAnyOverrides(node); // Check all _overridden fields
  
  return (
    <g>
      {/* Node shape */}
      <circle ... />
      
      {/* Override indicator */}
      {hasOverrides && (
        <Tooltip content="Auto-updates disabled for some fields">
          <g transform="translate(45, -45)">
            <circle r="8" fill="var(--amber-500)" />
            <ZapOff size={10} color="white" />
          </g>
        </Tooltip>
      )}
    </g>
  );
}
```

---

## UI Component Patterns

### 1. Generic Overridable Field Display

```typescript
interface OverridableFieldProps {
  entity: any;
  fieldName: string;
  label: string;
  onEdit?: (newValue: any) => void;
  onReset?: () => void;
}

function OverridableField({ entity, fieldName, label, onEdit, onReset }: OverridableFieldProps) {
  const value = entity[fieldName];
  const overridden = entity[`${fieldName}_overridden`];
  const autoValue = entity[`${fieldName}_auto_value`];
  const source = entity[`${fieldName}_source`];
  
  return (
    <div className="field-group">
      <label>{label}</label>
      
      <div className="field-value-container">
        {/* Editable value */}
        {onEdit ? (
          <input 
            value={value} 
            onChange={(e) => onEdit(e.target.value)}
            className={overridden ? "overridden" : ""}
          />
        ) : (
          <span className={overridden ? "overridden" : ""}>{value}</span>
        )}
        
        {/* Override indicator */}
        {overridden && (
          <Badge variant="warning" title="Manually overridden">
            <AlertCircle size={12} />
            Override
          </Badge>
        )}
        
        {/* Source indicator */}
        {!overridden && source && (
          <Badge variant="info" title={`Auto-populated from ${source}`}>
            <Zap size={12} />
            {source}
          </Badge>
        )}
      </div>
      
      {/* Reset action */}
      {overridden && onReset && autoValue !== undefined && (
        <div className="field-actions">
          <span className="auto-value">Auto: {autoValue}</span>
          <Button size="sm" variant="ghost" onClick={onReset}>
            <RotateCcw size={12} />
            Reset to Auto
          </Button>
        </div>
      )}
    </div>
  );
}
```

### 2. Batch Reset Action

```typescript
function hasOverrides(entity: any): boolean {
  return Object.keys(entity).some(key => 
    key.endsWith('_overridden') && entity[key] === true
  );
}

function ResetAllOverridesButton({ entity, onReset }: Props) {
  const hasAnyOverrides = hasOverrides(entity);
  
  if (!hasAnyOverrides) return null;
  
  return (
    <Button variant="outline" onClick={onReset}>
      <RotateCcw size={16} />
      Reset All Overrides
    </Button>
  );
}
```

### 3. Override Indicator Icons

**Purpose:** Consistent, minimal visual treatment across properties panel AND graph canvas

**Standard Icon Treatment:**
- **Auto-update DISABLED (overridden):** `<ZapOff size={12} className="text-amber-500" />` + tooltip
- **Auto-update ENABLED:** `<Zap size={12} className="text-blue-500" />` + tooltip (when source connected)
- **Manual/No source:** No icon (default state)

**Semantic Meaning:**
- `<ZapOff>` = "Auto-updates disabled for this field" (NOT "user edited" - we don't track that)
- `<Zap>` = "Auto-updates enabled, synced with source"
- No icon = "Manual value, no auto-source"

```typescript
function OverrideIcon({ overridden, source }: { overridden?: boolean; source?: string }) {
  if (overridden) {
    return (
      <Tooltip content="Auto-updates disabled - click to re-enable automatic sync">
        <ZapOff size={12} className="text-amber-500" />
      </Tooltip>
    );
  }
  
  if (source) {
    return (
      <Tooltip content={`Auto-synced from ${source}`}>
        <Zap size={12} className="text-blue-500" />
      </Tooltip>
    );
  }
  
  return null; // Manual value, no auto-source
}

// Usage in field display
<div className="field-row">
  <label>Label</label>
  <input value={node.label} onChange={handleChange} />
  <OverrideIcon overridden={node.label_overridden} source={node.label_source} />
  {node.label_overridden && (
    <Button 
      size="xs" 
      onClick={() => clearOverride(node, 'label')}
      title="Re-enable auto-updates"
    >
      <Zap size={10} />
    </Button>
  )}
</div>

// Clear override and trigger recalc
function clearOverride(node: GraphNode, field: string) {
  updateManager.markOverridden(node, field, false);
  // Trigger update from source
  updateManager.updateEntity(sourceRegistry, node, 'registry_to_node', {...});
}
```

**Graph Canvas Treatment:** See "Visual Indicators on Graph Canvas" section above

---

## Centralized Update Manager Architecture

### Motivation

All automated updates (graph→graph inferences, file→graph syncs, external→param/graph retrievals) should flow through a **single system** that:

1. **Handles field-to-field mappings** across schemas (ONE place to maintain mappings)
2. **Respects override status** (never overwrites user-intentional edits)
3. **Manages UI interactions** (warnings, confirmations, modals)
4. **Provides audit trail** (what changed, when, why)
5. **Ensures consistency** (same logic for all update sources)
6. **Works in both modes** (interactive UI AND unattended API/batch)

**Without this:** Update logic scattered across components, inconsistent override handling, hard to maintain schema mappings.

**With this:** Single source of truth for all automated updates, guaranteed respect for overrides, works everywhere.

#### 🎯 Key Question: Will This Work for API Routes & Batch Processing?

**YES! The SAME UpdateManager.ts class handles both:**

**Interactive Mode (UI):**
```typescript
await updateManager.updateEntity(source, target, mapping, context, {
  interactive: true  // Shows modals for conflict resolution
});
```

**Unattended Mode (API/Batch/Scheduled Jobs):**
```typescript
await updateManager.updateEntity(source, target, mapping, context, {
  interactive: false,              // No UI
  conflictStrategy: 'skip',        // How to handle conflicts
  validateOnly: false,             // Apply changes (not dry-run)
  stopOnError: false               // Continue on conflict
});
```

**The design explicitly supports:**
- ✅ API routes (bulk updates)
- ✅ Scheduled jobs (nightly syncs)
- ✅ Batch imports (CSV/sheets)
- ✅ Background processing (queues)
- ✅ Validation endpoints (dry-run mode)

See "Batch & Async Mode Support" section below for detailed examples.

---

### System Design

```typescript
/**
 * UpdateManager: Central authority for all automated entity updates
 * 
 * Responsibilities:
 * - Map fields across schemas (registry → graph, param → graph, etc.)
 * - Check override status before applying updates
 * - Handle user confirmations for conflict resolution
 * - Emit events for UI updates and audit logging
 */

import { EventEmitter } from 'events';

interface UpdateContext {
  source: 'registry' | 'parameter' | 'msmdc' | 'external' | 'manual' | 'api' | 'batch';
  reason: string;
  userId?: string;
  timestamp: string;
  batchId?: string;            // For grouping batch operations
}

interface UpdateOptions {
  interactive: boolean;        // Show conflict resolution UI?
  conflictStrategy?: 'skip' | 'overwrite' | 'error';  // For non-interactive mode
  validateOnly?: boolean;      // Dry-run (don't apply changes)
  stopOnError?: boolean;       // For batch operations
}

interface UpdateResult {
  success: boolean;
  fieldsUpdated: string[];
  fieldsSkipped: string[];    // Skipped due to override
  fieldsConflicted: string[]; // Require user decision (or error in batch mode)
  errors?: string[];
  warnings?: string[];         // Non-fatal issues
}

interface FieldMapping {
  sourcePath: string;          // e.g., "parameter.name"
  targetPath: string;          // e.g., "edge.label"
  transform?: (value: any) => any; // Optional transformation
  overrideKey: string;         // e.g., "label_overridden"
  condition?: (source: any, target: any) => boolean; // Apply conditionally
}

class UpdateManager extends EventEmitter {
  private mappings: Map<string, FieldMapping[]>;
  private updateHistory: UpdateRecord[];
  
  constructor() {
    super();
    this.mappings = new Map();
    this.updateHistory = [];
    this.registerDefaultMappings();
  }
  
  /**
   * Update target entity from source entity, respecting overrides
   */
  async updateEntity<TSource, TTarget>(
    source: TSource,
    target: TTarget,
    mappingType: string,
    context: UpdateContext,
    options?: UpdateOptions
  ): Promise<UpdateResult> {
    const mappings = this.mappings.get(mappingType);
    if (!mappings) {
      throw new Error(`No mappings registered for type: ${mappingType}`);
    }
    
    const result: UpdateResult = {
      success: true,
      fieldsUpdated: [],
      fieldsSkipped: [],
      fieldsConflicted: []
    };
    
    for (const mapping of mappings) {
      const sourceValue = this.getNestedValue(source, mapping.sourcePath);
      const targetValue = this.getNestedValue(target, mapping.targetPath);
      const isOverridden = this.getNestedValue(target, mapping.overrideKey);
      
      // Skip if overridden (user has intentionally diverged)
      if (isOverridden) {
        result.fieldsSkipped.push(mapping.targetPath);
        continue;
      }
      
      // Check condition (if specified)
      if (mapping.condition && !mapping.condition(source, target)) {
        continue;
      }
      
      // Apply transformation (if specified)
      const newValue = mapping.transform 
        ? mapping.transform(sourceValue)
        : sourceValue;
      
      // Detect conflicts (source changed but target also changed)
      if (this.hasConflict(mapping, source, target)) {
        result.fieldsConflicted.push(mapping.targetPath);
        
        if (options?.interactive) {
          // INTERACTIVE MODE: Prompt user for resolution
          const resolution = await this.resolveConflict(mapping, sourceValue, targetValue);
          if (resolution === 'skip') continue;
          if (resolution === 'source') {
            // User chose source value, mark as NOT overridden
            this.setNestedValue(target, mapping.overrideKey, false);
          } else {
            // User chose target value, mark as overridden
            this.setNestedValue(target, mapping.overrideKey, true);
            continue;
          }
        } else {
          // NON-INTERACTIVE MODE (API/batch): Use conflict strategy
          const strategy = options?.conflictStrategy || 'skip';
          
          switch (strategy) {
            case 'skip':
              // Skip conflicted fields (safest for batch)
              result.fieldsSkipped.push(mapping.targetPath);
              result.warnings?.push(`Conflict skipped: ${mapping.targetPath}`);
              continue;
              
            case 'overwrite':
              // Force overwrite with source value (batch import mode)
              this.setNestedValue(target, mapping.overrideKey, false);
              result.warnings?.push(`Conflict overwritten: ${mapping.targetPath}`);
              break;
              
            case 'error':
              // Fail entire operation (strict validation mode)
              result.success = false;
              result.errors?.push(`Conflict detected: ${mapping.targetPath}`);
              if (options?.stopOnError) {
                throw new Error(`Update failed: conflict at ${mapping.targetPath}`);
              }
              continue;
          }
        }
      }
      
      // Apply update
      this.setNestedValue(target, mapping.targetPath, newValue);
      result.fieldsUpdated.push(mapping.targetPath);
      
      // Emit event for audit/UI updates
      this.emit('fieldUpdated', {
        path: mapping.targetPath,
        oldValue: targetValue,
        newValue,
        context
      });
    }
    
    // Record update in history
    this.recordUpdate(source, target, result, context);
    
    return result;
  }
  
  /**
   * Register field mappings for a specific entity type relationship
   */
  registerMappings(type: string, mappings: FieldMapping[]): void {
    this.mappings.set(type, mappings);
  }
  
  /**
   * Check if a field can be auto-updated (not overridden)
   */
  canAutoUpdate(entity: any, fieldName: string): boolean {
    const overrideKey = `${fieldName}_overridden`;
    return !entity[overrideKey];
  }
  
  /**
   * Mark a field as overridden (disable auto-updates)
   */
  markOverridden(entity: any, fieldName: string, overridden: boolean = true): void {
    const overrideKey = `${fieldName}_overridden`;
    entity[overrideKey] = overridden;
    
    // NOTE: We do NOT store auto-values
    // When user clears override flag, they must request recalc from source
  }
  
  /**
   * Clear override flag and trigger recalc from source
   */
  async clearOverride(
    entity: any, 
    fieldName: string,
    source: any,
    mappingType: string,
    context: UpdateContext
  ): Promise<void> {
    // Clear override flag
    this.markOverridden(entity, fieldName, false);
    
    // Trigger recalc from source
    await this.updateEntity(source, entity, mappingType, context);
  }
  
  /**
   * Default mapping registrations
   */
  private registerDefaultMappings(): void {
    // Registry Node → Graph Node
    this.registerMappings('registry_to_node', [
      {
        sourcePath: 'name',
        targetPath: 'label',
        overrideKey: 'label_overridden'
      },
      {
        sourcePath: 'description',
        targetPath: 'description',
        overrideKey: 'description_overridden'
      },
      {
        sourcePath: 'event_id',
        targetPath: 'event_id',
        overrideKey: 'event_id_overridden'
      }
    ]);
    
    // Parameter → Graph Edge
    this.registerMappings('parameter_to_edge', [
      {
        sourcePath: 'name',
        targetPath: 'label',
        overrideKey: 'label_overridden'
      },
      {
        sourcePath: 'description',
        targetPath: 'description',
        overrideKey: 'description_overridden'
      },
      {
        sourcePath: 'values[latest].mean',
        targetPath: 'p.p',
        overrideKey: 'p.p_overridden',        // ← Suffix pattern
        transform: (val) => val // Direct mapping (p is primary)
      },
      {
        sourcePath: 'values[latest].stdev',
        targetPath: 'p.stdev',
        overrideKey: 'p.stdev_overridden'    // ← Suffix pattern
      },
      {
        sourcePath: 'values[latest].distribution',
        targetPath: 'p.distribution',
        overrideKey: 'p.distribution_overridden' // ← Suffix pattern
      },
      {
        sourcePath: 'values[latest].n',
        targetPath: 'p.evidence.n',
        overrideKey: null  // Evidence not overridable
      },
      {
        sourcePath: 'values[latest].k',
        targetPath: 'p.evidence.k',
        overrideKey: null  // Evidence not overridable
      }
    ]);
    
    // Graph → Parameter (query generation)
    this.registerMappings('graph_to_parameter_query', [
      {
        sourcePath: 'msmdc_result.query',
        targetPath: 'query',
        overrideKey: 'query_overridden',
        condition: (source, target) => {
          // Only update if graph structure changed AND not overridden
          return source.graph_structure_hash !== target.last_graph_structure_hash;
        }
      }
    ]);
    
    // Case File → Graph Case Node
    this.registerMappings('case_to_node', [
      {
        sourcePath: 'name',
        targetPath: 'label',
        overrideKey: 'label_overridden'
      },
      {
        sourcePath: 'schedules[latest].variants',
        targetPath: 'case.variants',
        overrideKey: 'case.variants_overridden',
        transform: (scheduleVariants) => {
          // Map schedule weights to variant array
          return Object.entries(scheduleVariants).map(([name, weight]) => ({
            name,
            weight,
            weight_overridden: false // Default for new data
          }));
        }
      }
    ]);
    
    // Add more mappings as needed...
  }
  
  // Helper methods
  private getNestedValue(obj: any, path: string): any {
    // Handle special paths like "values[latest]"
    if (path.includes('[latest]')) {
      const [basePath, rest] = path.split('[latest].');
      const array = this.getNestedValue(obj, basePath);
      if (!Array.isArray(array) || array.length === 0) return undefined;
      const latest = array[array.length - 1];
      return rest ? this.getNestedValue(latest, rest) : latest;
    }
    
    return path.split('.').reduce((curr, key) => curr?.[key], obj);
  }
  
  private setNestedValue(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    const lastKey = keys.pop()!;
    const target = keys.reduce((curr, key) => {
      if (!curr[key]) curr[key] = {};
      return curr[key];
    }, obj);
    target[lastKey] = value;
  }
  
  private hasConflict(mapping: FieldMapping, source: any, target: any): boolean {
    // Check if target value changed since last sync
    const targetValue = this.getNestedValue(target, mapping.targetPath);
    const lastSyncKey = `${mapping.targetPath}_last_sync_value`;
    const lastSyncValue = this.getNestedValue(target, lastSyncKey);
    
    return lastSyncValue !== undefined && targetValue !== lastSyncValue;
  }
  
  private async resolveConflict(
    mapping: FieldMapping,
    sourceValue: any,
    targetValue: any
  ): Promise<'source' | 'target' | 'skip'> {
    // Emit event for UI to show modal
    return new Promise((resolve) => {
      this.emit('conflictDetected', {
        field: mapping.targetPath,
        sourceValue,
        targetValue,
        resolve
      });
    });
  }
  
  private recordUpdate(source: any, target: any, result: UpdateResult, context: UpdateContext): void {
    this.updateHistory.push({
      timestamp: context.timestamp,
      source: context.source,
      reason: context.reason,
      fieldsUpdated: result.fieldsUpdated,
      fieldsSkipped: result.fieldsSkipped,
      userId: context.userId
    });
    
    // Emit for audit logging
    this.emit('updateComplete', { source, target, result, context });
  }
}

// Singleton instance
export const updateManager = new UpdateManager();
```

---

### Batch & Async Mode Support

**The UpdateManager works in BOTH interactive and unattended modes using the SAME class.**

#### Interactive Mode (UI)
- `interactive: true` — Shows modals for conflict resolution
- User makes decisions in real-time
- Suitable for: Properties panel, drag-drop operations, user-triggered syncs

#### Non-Interactive Mode (API/Batch)
- `interactive: false` — No UI, uses `conflictStrategy`
- **Conflict Strategies:**
  - `skip` (default) — Skip conflicted fields, continue (safest)
  - `overwrite` — Force update with source value (batch import)
  - `error` — Fail operation, return error (strict validation)
- Suitable for: API routes, scheduled jobs, bulk imports, background sync

#### Use Cases

**API Route (Bulk Parameter Update):**
```typescript
// POST /api/parameters/sync-from-amplitude
async function syncFromAmplitude(req, res) {
  const results = [];
  
  for (const paramId of req.body.paramIds) {
    const param = await loadParameter(paramId);
    const amplitudeData = await amplitudeAPI.query(param.query);
    
    const result = await updateManager.updateEntity(
      amplitudeData,
      param,
      'amplitude_to_parameter',
      {
        source: 'api',
        reason: 'Scheduled sync from Amplitude',
        userId: 'system',
        timestamp: new Date().toISOString(),
        batchId: req.body.batchId
      },
      {
        interactive: false,           // ← No modals
        conflictStrategy: 'overwrite', // ← Force update
        stopOnError: false             // ← Continue on conflict
      }
    );
    
    results.push({ paramId, ...result });
  }
  
  res.json({ results });
}
```

**Scheduled Job (Nightly Registry Sync):**
```typescript
// cron: 0 2 * * * (2am daily)
async function syncNodesWithRegistry() {
  const graphs = await loadAllGraphs();
  const registry = await loadNodeRegistry();
  
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      const nodeDef = registry.find(n => n.id === node.slug);
      if (!nodeDef) continue;
      
      const result = await updateManager.updateEntity(
        nodeDef,
        node,
        'registry_to_node',
        {
          source: 'batch',
          reason: 'Nightly registry sync',
          timestamp: new Date().toISOString(),
          batchId: `sync-${Date.now()}`
        },
        {
          interactive: false,       // ← Unattended
          conflictStrategy: 'skip', // ← Respect user overrides
          validateOnly: false
        }
      );
      
      // Log conflicts for manual review
      if (result.fieldsConflicted.length > 0) {
        logger.warn(`Node ${node.id} has conflicts`, result.fieldsConflicted);
      }
    }
    
    await saveGraph(graph);
  }
}
```

**Validation Endpoint (Dry-Run):**
```typescript
// POST /api/parameters/validate-sync
async function validateSync(req, res) {
  const { paramId, sourceData } = req.body;
  const param = await loadParameter(paramId);
  
  const result = await updateManager.updateEntity(
    sourceData,
    param,
    'amplitude_to_parameter',
    {
      source: 'api',
      reason: 'Validation check',
      timestamp: new Date().toISOString()
    },
    {
      interactive: false,
      validateOnly: true,    // ← DRY-RUN: Don't apply changes
      conflictStrategy: 'error'
    }
  );
  
  res.json({
    valid: result.success,
    conflicts: result.fieldsConflicted,
    errors: result.errors,
    wouldUpdate: result.fieldsUpdated
  });
}
```

#### Benefits of Single Class

✅ **Consistency:** Same logic for UI and API  
✅ **Maintainability:** One place to update mappings  
✅ **Testability:** Test once, works everywhere  
✅ **Audit Trail:** All updates logged (batch or interactive)  
✅ **Override Respect:** Guaranteed in all modes

---

### Usage Examples

#### 1. Pull from Parameter File to Graph Edge (Interactive)

```typescript
import { updateManager } from '@/services/updateManager';

async function pullFromParameter(edge: Edge, parameter: Parameter) {
  const result = await updateManager.updateEntity(
    parameter,
    edge,
    'parameter_to_edge',
    {
      source: 'parameter',
      reason: 'User clicked "Pull from Parameter"',
      timestamp: new Date().toISOString()
    },
    { interactive: true } // Show conflict resolution UI if needed
  );
  
  console.log(`Updated: ${result.fieldsUpdated.join(', ')}`);
  console.log(`Skipped (overridden): ${result.fieldsSkipped.join(', ')}`);
  
  if (result.fieldsConflicted.length > 0) {
    showNotification(`Resolved ${result.fieldsConflicted.length} conflicts`);
  }
}
```

#### 2. Auto-update from Node Registry (on registry change)

```typescript
// In registryService.ts
registryService.on('nodeUpdated', async (updatedNodeDef) => {
  // Find all graph nodes referencing this registry entry
  const affectedNodes = graph.nodes.filter(n => n.slug === updatedNodeDef.id);
  
  for (const node of affectedNodes) {
    const result = await updateManager.updateEntity(
      updatedNodeDef,
      node,
      'registry_to_node',
      {
        source: 'registry',
        reason: `Registry entry "${updatedNodeDef.id}" updated`,
        timestamp: new Date().toISOString()
      },
      { interactive: false } // Silent update, respect overrides
    );
    
    if (result.fieldsUpdated.length > 0) {
      showNotification(`Node "${node.label}" synced with registry`);
    }
  }
});
```

#### 3. MSMDC Query Auto-generation (on graph structure change)

```typescript
// In graph editor, after node/edge added
graph.on('structureChanged', async () => {
  for (const edge of graph.edges) {
    if (!edge.query_overridden) {
      // Generate new query from MSMDC
      const msmdc_result = await msmdc.generateConstraints(edge, graph);
      
      const result = await updateManager.updateEntity(
        { msmdc_result, graph_structure_hash: graph.getStructureHash() },
        edge,
        'graph_to_parameter_query',
        {
          source: 'msmdc',
          reason: 'Graph structure changed',
          timestamp: new Date().toISOString()
        },
        { interactive: false }
      );
    }
  }
});
```

#### 4. User Manual Edit (mark as overridden)

```typescript
// In PropertiesPanel
function handleLabelChange(node: GraphNode, newLabel: string) {
  node.label = newLabel;
  
  // Mark as overridden so auto-updates don't overwrite
  updateManager.markOverridden(node, 'label');
  
  // Emit change event
  graphEditor.emit('nodeChanged', node);
}
```

#### 5. Clear Override and Recalculate

```typescript
// In PropertiesPanel, "Re-enable Auto-updates" button
async function handleClearOverride(node: GraphNode, fieldName: string) {
  const nodeDef = registryService.getNodeById(node.slug);
  
  if (nodeDef) {
    await updateManager.clearOverride(
      node,
      fieldName,
      nodeDef,
      'registry_to_node',
      {
        source: 'registry',
        reason: 'User re-enabled auto-updates',
        timestamp: new Date().toISOString()
      }
    );
    
    graphEditor.emit('nodeChanged', node);
  }
}
```

---

### Conflict Resolution UI

```typescript
// ConflictResolutionModal.tsx
function ConflictResolutionModal({ field, sourceValue, targetValue, onResolve }) {
  return (
    <Modal>
      <h2>Update Conflict: {field}</h2>
      <p>The source has a different value than your current value.</p>
      
      <div className="conflict-options">
        <div className="option">
          <strong>Source value:</strong> {sourceValue}
          <Button onClick={() => onResolve('source')}>
            Use Source (Overwrite)
          </Button>
        </div>
        
        <div className="option">
          <strong>Current value:</strong> {targetValue}
          <Button onClick={() => onResolve('target')}>
            Keep Current (Mark as Override)
          </Button>
        </div>
        
        <Button variant="ghost" onClick={() => onResolve('skip')}>
          Skip This Field
        </Button>
      </div>
    </Modal>
  );
}

// Wire up to UpdateManager
updateManager.on('conflictDetected', ({ field, sourceValue, targetValue, resolve }) => {
  showModal(
    <ConflictResolutionModal
      field={field}
      sourceValue={sourceValue}
      targetValue={targetValue}
      onResolve={resolve}
    />
  );
});
```

---

### Audit Trail & History

```typescript
// updateManager.getUpdateHistory()
const history = updateManager.getUpdateHistory();

// Display in UI
{history.map(record => (
  <div className="update-record">
    <time>{record.timestamp}</time>
    <span>{record.reason}</span>
    <ul>
      {record.fieldsUpdated.map(field => (
        <li key={field}>{field} updated</li>
      ))}
      {record.fieldsSkipped.map(field => (
        <li key={field} className="text-muted">{field} skipped (overridden)</li>
      ))}
    </ul>
  </div>
))}
```

---

### Benefits of Centralized Approach

1. **Single Source of Truth** for all schema mappings
2. **Guaranteed Override Respect** (can't accidentally overwrite)
3. **Consistent Behavior** across all update sources
4. **Easy to Maintain** (add new mapping once, works everywhere)
5. **Audit Trail** (know what changed, when, why)
6. **Interactive Conflict Resolution** (user stays in control)
7. **Testable** (mock update manager, test mapping logic in isolation)

---

## Implementation Guidelines

### Phase 0: Schema Updates & Field Mapping Validation

**Critical:** Phase 0 has an explicit "do, pause, check" gate:
1. Update all schemas
2. Build UpdateManager with ALL field mappings
3. **PAUSE:** Validate mappings with test data
4. **CHECK:** Confirm schemas dovetail correctly
5. Only then proceed to Phase 1

This ensures schema integrity BEFORE building features.

---

#### Phase 0.1: Schema Updates

Add `_overridden` fields to schemas as **optional** fields:

```yaml
# node-schema.yaml
properties:
  label:
    type: string
    description: "Display label for node"
  
  label_overridden:
    type: boolean
    description: "True if label was manually edited after auto-population from registry"
  
  label_auto_value:
    type: string
    description: "Original value from auto-population source (for reset)"
  
  label_source:
    type: string
    enum: [registry, parameter, manual]
    description: "Source of label value"
```

**Backward compatibility:** All override fields are optional. Missing `_overridden` means `false` (not overridden).

---

#### Phase 0.2: Build UpdateManager with Complete Field Mappings ⚠️ CRITICAL GATE

**Purpose:** Build centralized field mapping system BEFORE any other coding to validate schema integrity.

**Deliverable:** `src/services/updateManager.ts` with ALL mappings registered

**ALL Field Mappings to Implement:**

```typescript
// File: src/services/updateManager.ts

export class UpdateManager extends EventEmitter {
  // ... (class implementation from earlier section)
  
  private registerDefaultMappings(): void {
    // ========================================
    // MAPPING 1: Node Registry → Graph Node
    // ========================================
    this.registerMappings('registry_to_node', [
      {
        sourcePath: 'name',
        targetPath: 'label',
        overrideKey: 'label_overridden'
      },
      {
        sourcePath: 'description',
        targetPath: 'description',
        overrideKey: 'description_overridden'
      },
      {
        sourcePath: 'event_id',
        targetPath: 'event_id',
        overrideKey: 'event_id_overridden'
      }
    ]);
    
    // ========================================
    // MAPPING 2: Parameter File → Graph Edge
    // ========================================
    this.registerMappings('parameter_to_edge', [
      {
        sourcePath: 'name',
        targetPath: 'label',
        overrideKey: 'label_overridden'
      },
      {
        sourcePath: 'description',
        targetPath: 'description',
        overrideKey: 'description_overridden'
      },
      {
        sourcePath: 'values[latest].mean',
        targetPath: 'p.p',
        overrideKey: 'p.p_overridden',  // ← Suffix pattern
        transform: (mean) => mean // Direct mapping (p is primary)
      },
      {
        sourcePath: 'values[latest].stdev',
        targetPath: 'p.stdev',
        overrideKey: 'p.stdev_overridden'  // ← Suffix pattern
      },
      {
        sourcePath: 'values[latest].distribution',
        targetPath: 'p.distribution',
        overrideKey: 'p.distribution_overridden'  // ← Suffix pattern
      },
      {
        sourcePath: 'values[latest].n',
        targetPath: 'p.evidence.n',
        overrideKey: null, // Evidence not overridable (it's observations)
        condition: (source, target) => !target.p?.p_overridden // Only if p not overridden
      },
      {
        sourcePath: 'values[latest].k',
        targetPath: 'p.evidence.k',
        overrideKey: null,
        condition: (source, target) => !target.p?.p_overridden  // Suffix pattern
      }
    ]);
    
    // ========================================
    // MAPPING 3: Graph Edge → Parameter File (query sync)
    // ========================================
    this.registerMappings('graph_to_parameter_query', [
      {
        sourcePath: 'query', // From MSMDC generation
        targetPath: 'query',
        overrideKey: 'query_overridden',
        condition: (source, target) => {
          // Only if graph structure changed AND query not overridden
          return source.graph_structure_hash !== target.last_graph_structure_hash;
        }
      }
    ]);
    
    // ========================================
    // MAPPING 4: Case File → Graph Case Node
    // ========================================
    this.registerMappings('case_to_node', [
      {
        sourcePath: 'name',
        targetPath: 'label',
        overrideKey: 'label_overridden'
      },
      {
        sourcePath: 'schedules[latest].variants',
        targetPath: 'case.variants',
        overrideKey: 'case.variants_overridden',
        transform: (scheduleVariants: Record<string, number>) => {
          // Transform schedule weights to variant array
          return Object.entries(scheduleVariants).map(([name, weight]) => ({
            name,
            weight,
            weight_overridden: false // Default for fresh data
          }));
        }
      }
    ]);
    
    // ========================================
    // MAPPING 5: External Source (Amplitude) → Parameter File
    // ========================================
    this.registerMappings('amplitude_to_parameter', [
      {
        sourcePath: 'funnel_result.n',
        targetPath: 'values[new].n', // Append new value
        overrideKey: null // Not overridable (source data)
      },
      {
        sourcePath: 'funnel_result.k',
        targetPath: 'values[new].k',
        overrideKey: null
      },
      {
        sourcePath: 'funnel_result.p',
        targetPath: 'values[new].mean',
        overrideKey: null,
        transform: (result) => result.k / result.n // Calculate p from k/n
      },
      {
        sourcePath: 'funnel_result',
        targetPath: 'values[new].stdev',
        overrideKey: null,
        transform: (result) => {
          const p = result.k / result.n;
          return Math.sqrt(p * (1 - p) / result.n); // Binomial stdev
        }
      }
    ]);
    
    // ========================================
    // MAPPING 6: Google Sheets → Parameter File
    // ========================================
    this.registerMappings('sheets_to_parameter', [
      {
        sourcePath: 'row.mean', // From sheet cell
        targetPath: 'values[new].mean',
        overrideKey: null
      },
      {
        sourcePath: 'row.stdev',
        targetPath: 'values[new].stdev',
        overrideKey: null
      },
      {
        sourcePath: 'row.n',
        targetPath: 'values[new].n',
        overrideKey: null
      },
      {
        sourcePath: 'row.distribution',
        targetPath: 'values[new].distribution',
        overrideKey: null
      }
    ]);
    
    // ========================================
    // MAPPING 7: Statsig API → Case File
    // ========================================
    this.registerMappings('statsig_to_case', [
      {
        sourcePath: 'experiment.variants',
        targetPath: 'schedules[new].variants', // Append new schedule
        overrideKey: null,
        transform: (variants) => {
          // Transform Statsig format to our schedule format
          return variants.reduce((acc, v) => {
            acc[v.name] = v.allocation_percent / 100;
            return acc;
          }, {});
        }
      }
    ]);
  }
}
```

---

#### Phase 0.3: Validation Test Suite ⚠️ DO NOT SKIP

**Purpose:** Prove schemas dovetail correctly with real-world data flows

**File:** `src/services/__tests__/updateManager.test.ts`

**Test Cases:**

```typescript
describe('UpdateManager - Schema Field Mapping Validation', () => {
  
  // ========================================
  // Test 1: Node Registry → Graph Node
  // ========================================
  test('maps node registry to graph node correctly', async () => {
    const nodeRegistry = {
      id: 'checkout-started',
      name: 'Checkout Started',
      description: 'User begins checkout',
      event_id: 'checkout_started'
    };
    
    const graphNode = {
      id: 'node-uuid-123',
      slug: 'checkout-started',
      label: '',
      description: '',
      event_id: ''
    };
    
    const result = await updateManager.updateEntity(
      nodeRegistry,
      graphNode,
      'registry_to_node',
      { source: 'registry', reason: 'test', timestamp: now() }
    );
    
    expect(graphNode.label).toBe('Checkout Started');
    expect(graphNode.description).toBe('User begins checkout');
    expect(graphNode.event_id).toBe('checkout_started');
    expect(result.fieldsUpdated).toEqual(['label', 'description', 'event_id']);
  });
  
  // ========================================
  // Test 2: Parameter → Graph Edge (with override)
  // ========================================
  test('respects override flags when mapping parameter to edge', async () => {
    const parameter = {
      name: 'Checkout Conversion',
      description: 'Rate of checkout to purchase',
      values: [
        { mean: 0.30, stdev: 0.015, n: 1000, k: 300, distribution: 'beta' }
      ]
    };
    
    const edge = {
      label: 'Custom Label', // User overrode this
      label_overridden: true,
      description: '',
      p: {
        p: 0.25, // User overrode this
        p_overridden: true,       // ← Suffix pattern
        stdev: 0.02,
        stdev_overridden: false,
        distribution: 'beta',
        distribution_overridden: false
      }
    };
    
    const result = await updateManager.updateEntity(
      parameter,
      edge,
      'parameter_to_edge',
      { source: 'parameter', reason: 'test', timestamp: now() }
    );
    
    // Overridden fields NOT updated
    expect(edge.label).toBe('Custom Label'); // Skipped
    expect(edge.p.p).toBe(0.25); // Skipped
    
    // Non-overridden fields updated
    expect(edge.description).toBe('Rate of checkout to purchase');
    expect(edge.p.stdev).toBe(0.015);
    
    expect(result.fieldsSkipped).toContain('label');
    expect(result.fieldsSkipped).toContain('p.p');
    expect(result.fieldsUpdated).toContain('description');
    expect(result.fieldsUpdated).toContain('p.stdev');
  });
  
  // ========================================
  // Test 3: Amplitude → Parameter (append new value)
  // ========================================
  test('appends new value from Amplitude to parameter', async () => {
    const amplitudeResult = {
      funnel_result: { n: 1200, k: 360 } // p = 0.30
    };
    
    const parameter = {
      values: [
        { mean: 0.27, n: 1000, k: 270 } // Existing
      ]
    };
    
    await updateManager.updateEntity(
      amplitudeResult,
      parameter,
      'amplitude_to_parameter',
      { source: 'external', reason: 'test', timestamp: now() }
    );
    
    // New value appended
    expect(parameter.values).toHaveLength(2);
    expect(parameter.values[1].n).toBe(1200);
    expect(parameter.values[1].k).toBe(360);
    expect(parameter.values[1].mean).toBe(0.30);
    expect(parameter.values[1].stdev).toBeCloseTo(0.0132, 4); // Binomial calculation
  });
  
  // ========================================
  // Test 4: Case File → Graph Case Node
  // ========================================
  test('maps case schedules to graph node variants', async () => {
    const caseFile = {
      name: 'Checkout Test',
      schedules: [
        {
          start_date: '2025-11-01',
          variants: { control: 0.5, treatment: 0.5 }
        }
      ]
    };
    
    const caseNode = {
      label: '',
      case: { variants: [] }
    };
    
    await updateManager.updateEntity(
      caseFile,
      caseNode,
      'case_to_node',
      { source: 'case', reason: 'test', timestamp: now() }
    );
    
    expect(caseNode.label).toBe('Checkout Test');
    expect(caseNode.case.variants).toHaveLength(2);
    expect(caseNode.case.variants[0]).toEqual({
      name: 'control',
      weight: 0.5,
      weight_overridden: false
    });
  });
  
  // ========================================
  // Test 5: ALL schemas integrate correctly
  // ========================================
  test('INTEGRATION: full data flow from Amplitude to graph', async () => {
    // 1. Amplitude data arrives
    const amplitudeData = {
      funnel_result: { n: 1500, k: 450 }
    };
    
    // 2. Update parameter file
    const param = {
      id: 'test-conversion',
      values: []
    };
    
    await updateManager.updateEntity(
      amplitudeData,
      param,
      'amplitude_to_parameter',
      { source: 'external', reason: 'test', timestamp: now() }
    );
    
    // 3. Pull parameter into graph edge
    const edge = {
      p: { p: 0, stdev: 0, distribution: '' }
    };
    
    await updateManager.updateEntity(
      param,
      edge,
      'parameter_to_edge',
      { source: 'parameter', reason: 'test', timestamp: now() }
    );
    
    // Verify full flow
    expect(param.values[0].n).toBe(1500);
    expect(param.values[0].k).toBe(450);
    expect(edge.p.p).toBe(0.30);
    expect(edge.p.evidence.n).toBe(1500);
    expect(edge.p.evidence.k).toBe(450);
  });
  
  // ========================================
  // Test 6: Verify NO orphaned fields
  // ========================================
  test('all schema fields have mappings or explicit reason for exclusion', () => {
    const allMappings = updateManager.getAllMappings();
    
    // Check that every auto-populatable field has a mapping
    const expectedMappings = [
      'registry_to_node',
      'parameter_to_edge',
      'graph_to_parameter_query',
      'case_to_node',
      'amplitude_to_parameter',
      'sheets_to_parameter',
      'statsig_to_case'
    ];
    
    expectedMappings.forEach(mapping => {
      expect(allMappings.has(mapping)).toBe(true);
    });
    
    // Document which fields are intentionally NOT mapped
    const unmappedFields = {
      node: ['id', 'x', 'y', 'color'], // User positioning
      edge: ['id', 'from', 'to'],      // Structural
      parameter: ['id', 'type'],       // Core identity
      case: ['id', 'platform']         // Core identity
    };
    
    // This test serves as documentation
    expect(unmappedFields).toBeDefined();
  });
});
```

---

#### Phase 0.4: Validation Checklist ⚠️ GATE

**Before proceeding to Phase 1, confirm:**

- [ ] UpdateManager hierarchical architecture implemented (5 handlers + 18 mapping configs - see MAPPING_TYPES.md)
- [ ] All 6 integration tests passing
- [ ] No TypeScript errors in updateManager.ts
- [ ] Manually reviewed: every auto-populatable field has a mapping OR documented exclusion
- [ ] Schemas validated against test data (no type mismatches)
- [ ] Override flags work correctly (skipped fields confirmed)
- [ ] Transformation functions tested (k/n → p, schedule → variants, etc.)

**If ANY test fails:** Fix schemas or mappings before Phase 1.

**Output:** Document in `SCHEMA_FIELD_MAPPING_VALIDATION.md`:
- All mappings confirmed working
- Any schema changes needed
- Any discovered edge cases

---

### Phase 1: Basic Implementation

**Priority 1: Edge parameter values**
- Track `p.overridden.p` when user adjusts probability
- Track `query_overridden` when user edits MSMDC-generated query
- UI: Show override badge, reset button

**Priority 2: Node metadata**
- Track `label_overridden`, `description_overridden` when user edits after registry pull
- Auto-update non-overridden fields when registry changes

### Phase 2: Advanced Features

- Batch reset all overrides
- Override summary panel
- Visualize overridden vs. synced fields
- Smart conflict resolution (when source changes, prompt user)

### Phase 3: AI Integration

- Track `description_overridden` for AI-generated descriptions
- Track `tags_overridden` for AI-inferred tags
- Track `distribution_overridden` for distributional fitting

---

## COMMENTS NEEDED

**Please review and comment on:**

### 1. **Nested vs. Suffix Pattern for Edge Parameters**

For `edge.p` (probability parameters), should override flags be nested or use suffix pattern?

```typescript
// Option A: Nested
edge.p = {
  p: 0.35,
  stdev: 0.015,
  overridden: { p: true, stdev: false }
}

// Option B: Suffix (consistent with all other fields)
edge.p = {
  p: 0.35,
  p_overridden: true,
  stdev: 0.015,
  stdev_overridden: false
}
```

**Pros & Cons:**

**Option A (Nested):**
- ✅ **Pro:** Groups related override flags together
- ✅ **Pro:** Matches `evidence` grouping pattern (consistent nesting)
- ✅ **Pro:** Cleaner when multiple param fields overridden
- ❌ **Con:** Exception to suffix pattern (inconsistent)
- ❌ **Con:** Slightly harder for generic components: `entity.overridden?.p` vs `entity.p_overridden`
- ❌ **Con:** Adds more nesting depth (`.p.overridden.p` is awkward)

**Option B (Suffix):**
- ✅ **Pro:** Consistent with ALL other fields (no exceptions)
- ✅ **Pro:** Easier for generic components (uniform access pattern)
- ✅ **Pro:** Simpler to understand (one pattern to learn)
- ✅ **Pro:** Easier to iterate: `Object.keys(entity).filter(k => k.endsWith('_overridden'))`
- ✅ **Pro:** TypeScript autocomplete works better
- ❌ **Con:** More top-level fields in `edge.p` object
- ❌ **Con:** Less clear that p/stdev/distribution are related

### **DECISION: Option B (Suffix Pattern)** ✅

**Rationale:**
1. **Consistency >> Slight convenience** — ONE pattern across entire system (no exceptions to learn)
2. **Practical implementation** — Generic components work uniformly, easier to iterate over fields
3. **Edge.p is already nested** — Adding `.overridden.p` adds awkward depth; suffix keeps it flat
4. **Evidence pattern doesn't conflict** — `edge.p.evidence` is data (observations), `edge.p.p_overridden` is metadata (system state); these are different concerns, nesting isn't needed

**Implementation:**
```typescript
edge.p = {
  // Primary values
  p: 0.30,
  p_overridden: false,
  
  stdev: 0.015,
  stdev_overridden: false,
  
  distribution: "beta",
  distribution_overridden: false,
  
  // Evidence (observations, not overridable)
  evidence: {
    n: 1000,
    k: 300,
    window_from: "2025-10-01T00:00:00Z",
    window_to: "2025-10-31T23:59:59Z",
    retrieved_at: "2025-11-05T10:00:00Z",
    source: "amplitude"
  },
  
  // Metadata
  parameter_id: "checkout-conversion",
  locked: false
}
```

**This removes the ONLY exception to the suffix pattern.**

---

### 2. **Storage of Auto-Values**

~~Should we always store `{field}_auto_value` for reset functionality?~~

**DECISION: NO - Do NOT store auto-values**

**Rationale:**
- ❌ Storage overhead (2x data for overridden fields)
- ❌ Can go stale if calculation logic changes
- ❌ Adds complexity to schema
- ✅ User can clear `_overridden` flag and request recalc on demand
- ✅ Recalculation from source is fast (milliseconds)
- ✅ Always uses current calculation logic (not stale cached value)

**Pattern:**
```typescript
// User clicks "Re-enable Auto-updates"
// 1. Clear override flag
node.label_overridden = false;

// 2. Trigger recalc from source
await updateManager.updateEntity(nodeDefFromRegistry, node, 'registry_to_node', {...});

// Result: Field recalculated with current logic
```

**Question:** ~~Store auto-values or recalculate?~~ **ANSWERED: Recalculate on demand**

---

### 3. **Override at File vs. Graph Level**

For parameter files:
- Should case variant weights be overridable at CASE FILE level?
- Or only at GRAPH LEVEL (case node)?

**DECISION: Override at GRAPH level only**

**Rationale:**

**Case Files (param-registry/cases/):**
- Historical record of weights from Statsig (like parameter values array)
- Append-only: schedules array stores time-windowed weights
- If source connected (Statsig), that's the source of truth
- If NO source, manual entries in file
- NO override pattern needed (it IS the truth)

**Graph Case Nodes:**
- Working copy of current weights (pulled from latest schedule)
- User what-ifs with different weights (sensitivity analysis)
- Override pattern applies HERE: `weight_overridden: true`
- Example: Statsig says 50/50, user tries 60/40 → marked as override

**Key Insight:** Unlike edge.p (which is INFERRED from evidence), variant weights are FACTS:
- If Statsig connected: Statsig is master (we don't infer, we retrieve)
- If manual: File is master
- Graph is working copy for what-if scenarios

**Question:** ~~Confirm this is correct?~~ **CONFIRMED** 

---

### 4. **Source Tracking**

~~Should we track `{field}_source` for ALL auto-populated fields?~~

**DECISION: NO - Provenance tracking deferred to future phase**

**Rationale:**
- Not needed for Phase 0-2 functionality
- Adds schema complexity without immediate value
- Can be inferred from context (if parameter_id present, source is parameter)
- Can add later if needed (optional field, backward compatible)

**Phase 0-2:** No `{field}_source` tracking
**Phase 3+:** Consider adding if provenance becomes valuable

**Question:** ~~Track source everywhere or just for key fields?~~ **ANSWERED: Not at this stage**

---

### 5. **Naming Alternatives**

Current: `{field}_overridden`

Alternatives:
- `{field}_modified` (more general?)
- `{field}_manual` (clearer intent?)
- `{field}_locked` (prevents auto-update?)

**Question:** Stick with `_overridden` or prefer alternative?

---

## Summary: Data Storage & Override Pattern

### Key Design Decision: p is Primary, n/k is Evidence

**Edge Probability Storage (CONFIRMED):**
```typescript
edge.p = {
  // PRIMARY: User-facing values (always present, user edits these)
  p: 0.30,                    // Probability (what user sees/adjusts)
  p_overridden: false,        // Override flag (suffix pattern)
  
  stdev: 0.015,               // Standard deviation
  stdev_overridden: false,
  
  distribution: "beta",       // Distribution type
  distribution_overridden: false,
  
  // SECONDARY: Evidence/provenance (optional, from data sources, NOT overridable)
  evidence?: {
    n: 1000,                  // Sample size
    k: 300,                   // Successes
    window_from: "2025-10-01T00:00:00Z",  // Time window context (CRITICAL)
    window_to: "2025-10-31T23:59:59Z",
    retrieved_at: "2025-11-05T10:00:00Z",
    source: "amplitude"
  },
  
  // Metadata
  parameter_id: "checkout-conversion",
  locked: false
}
```

**NOT:** ~~n as primary with p derived~~ (incorrect)

---

## Summary: Fields Needing Override Pattern

### Graph Schema

**Nodes:**
- `label_overridden`
- `description_overridden`
- `event_id_overridden`

**Edges:**
- `label_overridden`
- `description_overridden`
- `query_overridden`
- `p.p_overridden`          // ← Suffix pattern (consistent!)
- `p.stdev_overridden`
- `p.distribution_overridden`

**Case Nodes:**
- `label_overridden`
- `description_overridden`
- `variants[].weight_overridden` (what-if at graph level)
- `variants[].description_overridden`

### Parameter Schema

- `query_overridden`
- `condition_overridden`
- (Future: `description_overridden`, `tags_overridden`)

### Case Schema

- `description_overridden`
- `variants[].name_overridden`
- `variants[].description_overridden`

### Event Schema (Future)

- `name_overridden`
- `description_overridden`
- `connectors.*.event_name_overridden`

---

## Next Steps

1. **Review & Finalize:** Address questions above
2. **Schema Updates:** Add optional `_overridden` fields to Phase 0
3. **Type Definitions:** Update TypeScript interfaces
4. **UI Components:** Build `OverridableField` generic component
5. **Implementation:** Phase 1 (edge params, queries), Phase 2 (node metadata), Phase 3 (AI features)

---

**Status:** Awaiting review and comments on open questions.

