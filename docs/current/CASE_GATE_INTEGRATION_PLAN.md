# Case/Gate Integration with Statsig and Amplitude

**Date:** 2025-11-18  
**Status:** 🟡 Design Complete, Ready for Implementation  
**Priority:** HIGH  
**Estimated Time:** 12-16 hours

---

## Overview

This project implements bidirectional integration between DagNet case nodes and external experimentation platforms (Statsig/Amplitude), enabling:

1. **Statsig → DagNet**: Fetch gate rollout percentages and write them as case variant weights (with versioning/schedules).
2. **DagNet → Amplitude**: Filter analytics queries by gate status using `activeGates.*` properties.
3. **Conditional probabilities**: Support case filtering in query DSL, conditional_p, and what-if analysis.

### Key Concepts

- **Case node**: Represents an A/B test or feature gate with variants (e.g., `control`, `treatment`).
- **Variant weight**: Traffic allocation percentage for each variant (0.0 to 1.0).
- **Gate-style case**: Binary experiment where Statsig controls on/off via `passPercentage`, mapped to DagNet variant weights.
- **Case schedules**: Time-series of variant weight configurations, analogous to parameter values over time.

---

## Background

### Current State

**✅ What Works:**
- Case nodes exist in graphs with `case.variants[].weight`.
- Amplitude adapter can filter by cohorts (`excluded_cohorts`).
- DAS Runner executes HTTP adapters and applies transforms/upserts.
- Parameter files support versioned fetching with time-series data.

**⚠️ What's Missing:**
- Case-aware DAS execution (no `caseId` passed to adapters).
- Statsig adapter doesn't map gate rollout → variant weights.
- No versioned "get from source" for cases.
- Amplitude adapter doesn't filter by case/gate status.
- Case schedules schema exists but isn't populated or consumed.

### Architecture Pattern

We follow the same **versioned data flow** as parameters:

```
External Source (Statsig) 
  → DAS Adapter 
  → Case File (schedules[]) 
  → Graph Node (case.variants[].weight)
  → Edge Probabilities (with what-if overrides)
```

For Amplitude queries, the reverse flow:

```
Graph Query DSL (.case(gate_id:variant))
  → buildDslFromEdge (dsl.case)
  → Amplitude Adapter pre_request
  → activeGates.{gate_id} filter
  → API Request
```

---

## Component 0: Reusable ConnectionControl Component (Prerequisite)

### Goal
Extract the connection dropdown + settings modal pattern into a single reusable component that works for both parameters and cases, with the same `AutomatableField` wrapper.

### Current Problem
The connection UI pattern (dropdown + database icon + settings modal) is duplicated in:
- `ParameterSection.tsx` (lines 155-197)
- About to be duplicated in `PropertiesPanel.tsx` for cases

### Solution: Create `ConnectionControl` Component

**New File:** `/graph-editor/src/components/ConnectionControl.tsx`

```tsx
import React, { useState } from 'react';
import { Database } from 'lucide-react';
import { ConnectionSelector } from './ConnectionSelector';
import { ConnectionSettingsModal } from './ConnectionSettingsModal';
import { AutomatableField } from './AutomatableField';

interface ConnectionControlProps {
  // Data
  connection?: string;
  connectionString?: string;
  overriddenFlag?: boolean;
  
  // Callbacks
  onConnectionChange: (connection: string) => void;
  onConnectionStringChange: (connectionString: string, newConnectionName?: string) => void;
  onOverriddenChange?: (overridden: boolean) => void;
  
  // Display options
  label?: string;
  hideOverride?: boolean;
  disabled?: boolean;
}

export function ConnectionControl({
  connection,
  connectionString,
  overriddenFlag = false,
  onConnectionChange,
  onConnectionStringChange,
  onOverriddenChange,
  label = "Data Connection",
  hideOverride = false,
  disabled = false
}: ConnectionControlProps) {
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  
  return (
    <>
      <AutomatableField
        label={label}
        overriddenFlag={overriddenFlag}
        onOverriddenChange={onOverriddenChange || (() => {})}
        hideOverride={hideOverride}
      >
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {/* Connection Settings Button */}
          <button
            className="icon-button"
            onClick={() => setIsSettingsModalOpen(true)}
            title="Connection Settings"
            style={{ flexShrink: 0 }}
            disabled={disabled}
          >
            <Database size={16} />
          </button>
          
          {/* Connection Dropdown */}
          <div style={{ flex: '1 1 0', minWidth: 0, margin: 0 }}>
            <ConnectionSelector
              value={connection}
              onChange={onConnectionChange}
              hideLabel={true}
              disabled={disabled}
            />
          </div>
        </div>
      </AutomatableField>
      
      {/* Connection Settings Modal */}
      <ConnectionSettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        connectionName={connection}
        currentConnectionString={connectionString}
        onSave={(newConnectionString, newConnectionName) => {
          onConnectionStringChange(newConnectionString, newConnectionName);
          setIsSettingsModalOpen(false);
        }}
      />
    </>
  );
}
```

### Usage Changes

#### A. Update ParameterSection.tsx

Replace lines 155-197 with:

```tsx
{/* Data Connection */}
<ConnectionControl
  connection={param?.connection}
  connectionString={param?.connection_string}
  overriddenFlag={param?.connection_overridden}
  onConnectionChange={(connectionName) => {
    onUpdate({ 
      connection: connectionName, 
      connection_overridden: true 
    });
  }}
  onConnectionStringChange={(connectionString, newConnectionName) => {
    onUpdate({ 
      connection_string: connectionString,
      connection: newConnectionName || param?.connection,
      connection_overridden: true
    });
  }}
  onOverriddenChange={(overridden) => {
    onUpdate({ connection_overridden: overridden });
  }}
  disabled={disabled}
/>
```

#### B. Update PropertiesPanel.tsx for Cases

In the case node section (after Case ID selector, around line 1279):

```tsx
{/* Data Connection - Reusable component */}
<ConnectionControl
  connection={caseData.connection}
  connectionString={caseData.connection_string}
  hideOverride={true}  // Cases don't use override flags (yet)
  onConnectionChange={(connectionName) => {
    setCaseData({...caseData, connection: connectionName});
    if (graph && selectedNodeId) {
      const next = structuredClone(graph);
      const nodeIndex = next.nodes.findIndex((n: any) => 
        n.uuid === selectedNodeId || n.id === selectedNodeId
      );
      if (nodeIndex >= 0) {
        if (!next.nodes[nodeIndex].case) {
          next.nodes[nodeIndex].case = { 
            id: caseData.id,
            status: caseData.status,
            variants: caseData.variants 
          };
        }
        next.nodes[nodeIndex].case.connection = connectionName;
        if (next.metadata) {
          next.metadata.updated_at = new Date().toISOString();
        }
        setGraph(next);
        saveHistoryState('Update case connection', selectedNodeId || undefined);
      }
    }
  }}
  onConnectionStringChange={(connectionString, newConnectionName) => {
    setCaseData({
      ...caseData,
      connection: newConnectionName || caseData.connection,
      connection_string: connectionString
    });
    if (graph && selectedNodeId) {
      const next = structuredClone(graph);
      const nodeIndex = next.nodes.findIndex((n: any) => 
        n.uuid === selectedNodeId || n.id === selectedNodeId
      );
      if (nodeIndex >= 0) {
        if (!next.nodes[nodeIndex].case) {
          next.nodes[nodeIndex].case = { 
            id: caseData.id,
            status: caseData.status,
            variants: caseData.variants 
          };
        }
        next.nodes[nodeIndex].case.connection = newConnectionName || caseData.connection;
        next.nodes[nodeIndex].case.connection_string = connectionString;
        if (next.metadata) {
          next.metadata.updated_at = new Date().toISOString();
        }
        setGraph(next);
        saveHistoryState('Update case connection settings', selectedNodeId || undefined);
      }
    }
  }}
/>
```

#### C. Load Connection Data in PropertiesPanel

In the useEffect that loads case data (around line 186-193):

```typescript
setCaseData({
  id: node.case.id || '',
  status: node.case.status || 'active',
  connection: node.case.connection,              // ← ADD
  connection_string: node.case.connection_string, // ← ADD
  variants: node.case.variants || []
});
```

### Benefits
- **Single source of truth** for connection UI pattern
- **Consistent UX** across parameters and cases
- **Easier maintenance** - fix bugs in one place
- **Future-proof** - easy to add to nodes, contexts, etc.
- **Proper AutomatableField integration** - override flags work consistently

### Testing
- **Parameters:** Verify connection dropdown still works, settings modal opens
- **Cases:** Create case node, verify connection dropdown appears and works
- **Override flags:** Verify automation icon appears for parameters (not for cases)

---

## Component 1: Case-Aware DAS Execution

### Goal
Enable DAS Runner to fetch data for cases by passing `caseId` to adapters. Cases are identified purely by `case_id + connection + connection_string` - no query DSL needed.

### Changes Required

#### A. DataOperationsService.getFromSourceDirect

**File:** `/graph-editor/src/services/dataOperationsService.ts`

**Current behavior:**
- Supports `objectType: 'parameter' | 'case' | 'node'`.
- Reads `connection` from file or graph target.
- For parameters: builds DSL from edge query.
- For cases: **should not build query** - just pass caseId.

**Changes:**
```typescript
// Line ~1638 in getFromSourceDirect, update runner.execute call:
const result = await runner.execute(connectionName, dsl, {
  connection_string: connectionString,
  window: fetchWindow as { start?: string; end?: string; [key: string]: unknown },
  context: { mode: contextMode },
  edgeId: targetId || 'unknown',
  caseId: objectType === 'case' ? objectId : undefined,  // ← ADD THIS
  nodeId: objectType === 'node' ? targetId : undefined   // ← ADD THIS (for future)
});
```

**Rationale:** Statsig adapter URL template uses `{{{caseId}}}`, which needs to be in the execution context.

#### B. DAS Runner Context

**File:** `/graph-editor/src/lib/das/types.ts`

**Add to ExecutionContext:**
```typescript
export interface ExecutionContext {
  dsl: Record<string, unknown>;
  connection: Record<string, unknown>;
  credentials: Record<string, unknown>;
  window: Record<string, unknown>;
  context: Record<string, unknown>;
  connection_string: Record<string, unknown>;
  edgeId?: string;
  caseId?: string;       // ← ADD
  nodeId?: string;       // ← ADD (for node-level fetches)
  parameterId?: string;
  extractedVars: Record<string, unknown>;
}
```

**File:** `/graph-editor/src/lib/das/DASRunner.ts`

**Update interpolateTemplate to expose these:**
```typescript
// Line ~290-305, add caseId/nodeId to flatContext:
const flatContext = {
  ...ctx.dsl,
  ...(ctx as Record<string, unknown>),
  connection: ctx.connection,
  credentials: ctx.credentials,
  window: ctx.window,
  context: ctx.context,
  connection_string: ctx.connection_string,
  edgeId: ctx.edgeId,
  caseId: ctx.caseId,     // ← ADD
  nodeId: ctx.nodeId,     // ← ADD
  parameterId: ctx.parameterId,
  ...ctx.extractedVars,
};
```

#### C. Skip DSL Building for Cases

**Key insight:** Cases don't have query strings. They're identified purely by `case_id + connection + connection_string`.

**In getFromSourceDirect, around line 1346-1407 where DSL is built:**

```typescript
// 3. Build DSL from edge query (if available in graph)
let dsl: any = {};

if (objectType === 'case') {
  // Cases don't need from/to query DSL
  // Statsig adapter only needs caseId (passed via context)
  dsl = {};  // Empty DSL is fine
  
} else if (targetId && graph) {
  // Parameter: build DSL from edge query (existing logic)
  const targetEdge = graph.edges?.find((e: any) => e.uuid === targetId || e.id === targetId);
  
  if (targetEdge && targetEdge.query) {
    const { buildDslFromEdge } = await import('../lib/das/buildDslFromEdge');
    const { paramRegistryService } = await import('./paramRegistryService');
    
    // Get connection to extract provider
    const { createDASRunner } = await import('../lib/das');
    const tempRunner = createDASRunner();
    // ... existing buildDslFromEdge logic
  }
}
```

**Rationale:** Cases are self-contained objects. The adapter uses `{{caseId}}` in the URL template, not DSL query fields.

### Testing
- Create a test case node with `case.connection = 'statsig-prod'`.
- Call "Get from Source (direct)" from UI.
- Verify `{{caseId}}` resolves in Statsig adapter URL.

---

## Component 2: Statsig Gate Adapter

### Goal
Transform Statsig gate configuration into DagNet case variant weights using the variant→bool mapping policy.

### Current Adapter (connections.yaml)

```yaml
# Line 283-327
- name: statsig-prod
  adapter:
    request:
      url_template: "{{{connection.base_url}}}/gates/{{{caseId}}}"
      method: GET
    response:
      extract:
        - name: rules
          jmes: "data.rules"
    transform:
      - name: variants
        jsonata: |
          rules[type='experiment'].returnValue{
            'variant_id': $string(id),
            'name': name,
            'allocation': passPercentage / 100
          }
    upsert:
      mode: replace
      writes:
        - target: "/nodes/{{nodeId}}/case/variants"
          value: "{{variants}}"
```

**Issues:**
- Assumes multi-variant experiments (`rules[type='experiment']`), not simple gates.
- Doesn't use `resolveVariantToBool` to map variant names to gate on/off.
- Writes to graph node directly (no schedule support).

### New Adapter Design

**Key insight:** For gate-style cases (most common), we need:
1. Extract the gate's `passPercentage` (the % of users in the "on" state).
2. Map case variants using `resolveVariantToBool`:
   - Variant that resolves to `true` (e.g., "treatment") gets weight = `passPercentage / 100`.
   - Variant that resolves to `false` (e.g., "control") gets weight = `1 - (passPercentage / 100)`.
3. Support both direct-to-graph and schedule-based versioning.

#### Changes to Statsig Adapter

**File:** `/graph-editor/public/defaults/connections.yaml`

Replace lines 298-327 with:

```yaml
- name: statsig-prod
  provider: statsig
  kind: http
  description: "Production Statsig for gate rollout percentages"
  enabled: true
  credsRef: statsig
  defaults:
    base_url: "https://statsigapi.net/console/v1"
    environment: production
  connection_string_schema:
    type: object
    properties:
      gate_id:
        type: string
        description: "Statsig gate ID (if different from case_id)"
      environment:
        type: string
        enum: [production, staging, development]
        description: "Environment to fetch (default: production)"
  adapter:
    pre_request:
      script: |
        // For gate-style cases, we need to know the case's variant names
        // to map passPercentage → variant weights using resolveVariantToBool
        // 
        // Option 1: Pass variant names via connection_string (simple)
        // Option 2: Load case file to get variants (more robust, requires file access)
        // 
        // For now, we'll use a convention: if not provided, assume ["control", "treatment"]
        const variantNames = connection_string.variant_names || ["control", "treatment"];
        dsl.variant_names = variantNames;
        
        return dsl;
    
    request:
      url_template: "{{{connection.base_url}}}/gates/{{{connection_string.gate_id}}}{{{caseId}}}"
      method: GET
      headers:
        STATSIG-API-KEY: "{{credentials.console_api_key}}"
        Content-Type: "application/json"
    
    response:
      extract:
        - name: gate_id
          jmes: "data.id"
        - name: gate_name
          jmes: "data.name"
        - name: enabled
          jmes: "data.enabled"
        - name: rules
          jmes: "data.rules"
    
    transform:
      # Extract passPercentage from the first active rule
      - name: pass_percentage
        jsonata: |
          (
            $activeRule := rules[enabled = true][0];
            $activeRule ? $activeRule.passPercentage : 0
          )
      
      # Compute p_true (gate "on" probability)
      - name: p_true
        jsonata: "pass_percentage / 100"
      
      # Build variant weights using dasHelpers.resolveVariantToBool
      # This must be done in pre_request or a custom transform since we need access to dasHelpers
      # For now, we'll emit p_true and let the upsert logic handle it
      
      # Construct variants array for upsert
      - name: variants_for_upsert
        jsonata: |
          (
            $variantNames := $dsl.variant_names;
            $pTrue := $number(p_true);
            
            $variantNames ~> $map(function($v) {
              {
                "name": $v,
                "weight": $v in ["treatment", "true", "on", "yes", "1", "active", "enabled"] ? $pTrue : (1 - $pTrue)
              }
            })
          )
    
    upsert:
      mode: replace
      writes:
        # For direct-to-graph: update node's case.variants
        - target: "/nodes/{{nodeId}}/case/variants"
          value: "{{variants_for_upsert}}"
        
        # For versioned: also return structure for schedule append (handled by DataOps)
        - target: "/schedules/latest"
          value: |
            {
              "window_from": "{{context.timestamp}}",
              "variants": {{variants_for_upsert}},
              "source": "statsig",
              "retrieved_at": "{{context.now}}",
              "gate_config": {
                "gate_id": "{{gate_id}}",
                "enabled": {{enabled}},
                "pass_percentage": {{pass_percentage}}
              }
            }
```

**Issue with above approach:** JSONata can't call `dasHelpers.resolveVariantToBool` directly.

**Better approach:** Do the mapping in `pre_request` script:

```yaml
adapter:
  pre_request:
    script: |
      // Get variant names from connection_string or default
      const variantNames = connection_string.variant_names || ["control", "treatment"];
      
      // Store for later use
      dsl.variant_names = variantNames;
      
      // We'll use dasHelpers in a moment to map these
      console.log(`[Statsig Adapter] Case variants: ${variantNames.join(', ')}`);
      
      return dsl;
  
  request:
    url_template: "{{{connection.base_url}}}/gates/{{{connection_string.gate_id}}}{{{caseId}}}"
    method: GET
    headers:
      STATSIG-API-KEY: "{{credentials.console_api_key}}"
  
  response:
    extract:
      - name: gate_id
        jmes: "data.id"
      - name: enabled
        jmes: "data.enabled"
      - name: rules
        jmes: "data.rules"
  
  transform:
    - name: pass_percentage
      jsonata: "rules[enabled = true][0].passPercentage"
    
    - name: p_true
      jsonata: "$number(pass_percentage) / 100"
    
    # Build variants using simple heuristic (control=false, others=true)
    - name: case_variants
      jsonata: |
        (
          $pTrue := $number(p_true);
          $dsl.variant_names ~> $map(function($name) {
            {
              "name": $name,
              "weight": $lowercase($name) = "control" ? (1 - $pTrue) : $pTrue
            }
          })
        )
  
  upsert:
    mode: replace
    writes:
      - target: "/nodes/{{nodeId}}/case/variants"
        value: "{{case_variants}}"
```

**Better still:** Call `dasHelpers` from pre_request and compute weights there:

```yaml
adapter:
  pre_request:
    script: |
      // This script will run AFTER the response/transform phases in our refactor
      // For now, we compute variant weights here before the request
      
      // We'll need to fetch the case file to get actual variant names
      // OR pass them via connection_string
      const variantNames = connection_string.variant_names || ["control", "treatment"];
      
      dsl.variant_names = variantNames;
      
      // Note: we can't compute weights yet because we don't have passPercentage
      // That comes from the API response
      // So we'll need to add a POST_RESPONSE script phase (future enhancement)
      // OR use JSONata with the simple heuristic above
      
      return dsl;
```

**Pragmatic solution for now:** Use the JSONata heuristic (control=false, others=true) and document that full variant→bool mapping will be added when we implement post-response scripts.

### Recommended Adapter (Pragmatic)

```yaml
- name: statsig-prod
  provider: statsig
  kind: http
  description: "Statsig gate configuration → case variant weights"
  enabled: true
  credsRef: statsig
  defaults:
    base_url: "https://statsigapi.net/console/v1"
    environment: production
  connection_string_schema:
    type: object
    properties:
      gate_id:
        type: string
        description: "Override gate ID (default: case_id)"
      variant_names:
        type: array
        items:
          type: string
        description: "Variant names for this case (default: ['control', 'treatment'])"
  adapter:
    request:
      url_template: "{{{connection.base_url}}}/gates/{{{connection_string.gate_id}}}{{{caseId}}}"
      method: GET
      headers:
        STATSIG-API-KEY: "{{credentials.console_api_key}}"
        Content-Type: "application/json"
    response:
      extract:
        - name: gate_id
          jmes: "data.id"
        - name: gate_name
          jmes: "data.name"
        - name: enabled
          jmes: "data.enabled"
        - name: pass_percentage
          jmes: "data.rules[?enabled==`true`] | [0].passPercentage"
    transform:
      - name: p_true
        jsonata: "$number(pass_percentage) / 100"
      
      - name: case_variants
        jsonata: |
          [
            {
              "name": "control",
              "weight": 1 - $number(p_true)
            },
            {
              "name": "treatment",
              "weight": $number(p_true)
            }
          ]
    upsert:
      mode: replace
      writes:
        - target: "/nodes/{{nodeId}}/case/variants"
          value: "{{case_variants}}"
```

### Testing
- Mock a Statsig gate with `passPercentage: 25`.
- Fetch via adapter.
- Verify: `control.weight = 0.75`, `treatment.weight = 0.25`.

---

## Component 3: Versioned Get From Source for Cases

### Goal
Enable "Source → Case File → Graph" pathway with schedule-based versioning, analogous to parameters.

### Current Limitation

**File:** `/graph-editor/src/services/dataOperationsService.ts` line ~1196

```typescript
// For now, only parameters support versioned fetching
if (objectType !== 'parameter') {
  toast.error('Versioned fetching only supported for parameters');
  return;
}
```

### Changes Required

#### A. Remove Parameter-Only Guard

Replace the guard with:

```typescript
if (objectType !== 'parameter' && objectType !== 'case') {
  toast.error('Versioned fetching only supported for parameters and cases');
  return;
}
```

#### B. Add Case-Specific Branch

After the parameter logic (line ~1200-1226), add:

```typescript
if (objectType === 'case') {
  // 1. Fetch latest gate config from Statsig
  await this.getFromSourceDirect({
    objectType: 'case',
    objectId,
    targetId,
    graph,
    setGraph,
    window,
    dailyMode: false,  // Cases use schedules, not daily time-series
    bustCache: false
  });
  
  // 2. Append schedule entry to case file
  const fileId = `case-${objectId}`;
  const file = fileRegistry.getFile(fileId);
  
  if (file && file.data) {
    // Extract new variant weights from the DAS result
    // (This requires the adapter to write to a temporary location we can read)
    // OR we re-structure upsert to return data
    
    // For now, assume the adapter updated the graph node
    // We'll copy that into a schedule entry
    
    const node = graph?.nodes?.find((n: any) => 
      n.uuid === targetId || n.id === targetId
    );
    
    if (node?.case?.variants) {
      const newSchedule = {
        window_from: new Date().toISOString(),
        window_to: null,  // Open-ended until next update
        variants: node.case.variants.reduce((acc: any, v: any) => {
          acc[v.name] = v.weight;
          return acc;
        }, {}),
        source: 'statsig',
        retrieved_at: new Date().toISOString()
      };
      
      // Close previous schedule
      const schedules = file.data.case?.schedules || [];
      if (schedules.length > 0) {
        const latest = schedules[schedules.length - 1];
        if (!latest.window_to) {
          latest.window_to = newSchedule.window_from;
        }
      }
      
      // Append new schedule
      if (!file.data.case) file.data.case = {};
      if (!file.data.case.schedules) file.data.case.schedules = [];
      file.data.case.schedules.push(newSchedule);
      
      // Save file
      await fileRegistry.saveFile(fileId);
      
      toast.success('Fetched gate config and updated case schedules');
    }
  }
  
  return;
}
```

**Issue:** This approach is messy because the adapter writes to the graph, then we read it back.

**Better approach:** Have the adapter output BOTH:
1. Graph node updates (for immediate display).
2. A schedule structure (for versioning).

We can use multiple upsert targets:

```yaml
upsert:
  mode: replace
  writes:
    # Update graph node directly
    - target: "/nodes/{{nodeId}}/case/variants"
      value: "{{case_variants}}"
    
    # Also output schedule data (dataOps will read this)
    - target: "/_temp_schedule"
      value: |
        {
          "window_from": "{{context.now}}",
          "variants": {{case_variants}},
          "source": "statsig"
        }
```

Then `getFromSource` reads `result.raw._temp_schedule` and appends it to the file.

#### C. Implement Schedule Append Logic

Create a helper function in `dataOperationsService.ts`:

```typescript
private async appendCaseSchedule(
  caseId: string,
  scheduleData: {
    window_from: string;
    variants: Array<{ name: string; weight: number }>;
    source: string;
    retrieved_at?: string;
    [key: string]: any;
  }
): Promise<void> {
  const fileId = `case-${caseId}`;
  const file = fileRegistry.getFile(fileId);
  
  if (!file || !file.data) {
    console.warn(`Case file ${fileId} not found, cannot append schedule`);
    return;
  }
  
  // Convert variants array to dictionary
  const variantsDict = scheduleData.variants.reduce((acc: any, v: any) => {
    acc[v.name] = v.weight;
    return acc;
  }, {});
  
  const newSchedule = {
    window_from: scheduleData.window_from,
    window_to: null,  // Open-ended
    variants: variantsDict,
    source: scheduleData.source,
    retrieved_at: scheduleData.retrieved_at || new Date().toISOString()
  };
  
  // Initialize schedules array if needed
  if (!file.data.case) file.data.case = {};
  if (!file.data.case.schedules) file.data.case.schedules = [];
  
  // Close previous schedule (set window_to)
  const schedules = file.data.case.schedules;
  if (schedules.length > 0) {
    const latest = schedules[schedules.length - 1];
    if (!latest.window_to) {
      latest.window_to = newSchedule.window_from;
    }
  }
  
  // Append new schedule
  schedules.push(newSchedule);
  
  // Save file
  await fileRegistry.saveFile(fileId);
  
  console.log(`[DataOps] Appended schedule to case ${caseId}:`, newSchedule);
}
```

#### D. Update getFromSource to Use Helper

```typescript
if (objectType === 'case') {
  // Fetch from source
  await this.getFromSourceDirect({
    objectType: 'case',
    objectId,
    targetId,
    graph,
    setGraph,
    window,
    dailyMode: false,
    bustCache: false
  });
  
  // Read the result and append schedule
  // (This requires getFromSourceDirect to return the DAS result)
  // For now, we'll extract from graph node
  
  const node = graph?.nodes?.find((n: any) => 
    n.uuid === targetId || n.id === targetId
  );
  
  if (node?.case?.variants) {
    await this.appendCaseSchedule(objectId, {
      window_from: new Date().toISOString(),
      variants: node.case.variants,
      source: 'statsig'
    });
    
    toast.success('Updated case file with new schedule');
  }
  
  return;
}
```

### Testing
- Create case file with 1 schedule entry.
- Call "Get from Source" (versioned).
- Verify: new schedule appended, old schedule's `window_to` set.

---

## Component 4: UI Wiring

### Goal
Enable users to trigger case fetches from the UI.

### Changes Required

#### A. Node Context Menu

**File:** `/graph-editor/src/components/NodeContextMenu.tsx` line ~165-175

Replace:

```typescript
const handleGetCaseFromSourceDirect = () => {
  if (!nodeData?.case?.connection && !hasCaseConnection) {
    toast.error('No connection configured for case');
    return;
  }
  
  // For cases, getFromSourceDirect is not yet fully implemented
  // Show a message for now
  toast('Case "Get from Source (direct)" coming soon!', { icon: 'ℹ️', duration: 3000 });
  onClose();
};
```

With:

```typescript
const handleGetCaseFromSourceDirect = () => {
  if (!nodeData?.case?.connection && !hasCaseConnection) {
    toast.error('No connection configured for case');
    return;
  }
  
  // Call getFromSourceDirect for case
  dataOperationsService.getFromSourceDirect({
    objectType: 'case',
    objectId: nodeData?.case?.id || '',
    targetId: nodeId,
    graph,
    setGraph,
    window: undefined,
    dailyMode: false
  });
  
  onClose();
};
```

#### B. Batch Operations

**File:** `/graph-editor/src/components/modals/BatchOperationsModal.tsx` line ~373-382

The case branch already exists and calls `getFromSource` (versioned), which will now work once we implement Component 3.

```typescript
} else if (item.type === 'case') {
  await dataOperationsService.getFromSource({
    objectType: 'case',
    objectId: item.objectId,
    targetId: item.targetId,
    graph,
    setGraph
  });
  success = true;
}
```

This is correct. No changes needed here (Component 3 enables this).

#### C. Data Operations Menu

**File:** `/graph-editor/src/components/DataOperationsMenu.tsx` line ~235-255

The `handleGetFromSourceDirect` already supports cases:

```typescript
const handleGetFromSourceDirect = () => {
  if (onClose) onClose();
  if (objectType === 'event') return;
  
  const hasParameterFile = !!objectId && objectId.trim() !== '';
  dataOperationsService.getFromSourceDirect({ 
    objectType: objectType as 'parameter' | 'case' | 'node', 
    objectId, 
    targetId, 
    graph, 
    setGraph,
    paramSlot,
    conditionalIndex,
    window: window ?? undefined,
    dailyMode: hasParameterFile  // Only for parameters
  });
};
```

Good, no changes needed.

### Testing
- Right-click case node → "Get from Source (direct)".
- Verify: Statsig API called, variant weights updated.
- Use batch operations to fetch multiple cases.

---

## Component 5: Window-Aware Consumption of Case Schedules

### Goal
When rendering graphs or computing statistics for a specific time window, use the case schedule entry that was active during that window.

### Current Behavior

Case nodes use `case.variants[].weight` directly from the graph. There's no time-awareness.

### Changes Required

#### A. Extend Window Aggregation Service

**File:** `/graph-editor/src/services/windowAggregationService.ts`

Add a function to resolve case schedules:

```typescript
/**
 * Get effective case variant weights for a given time window.
 * 
 * @param caseSchedules Array of schedule entries from case file
 * @param window Time window to query
 * @returns Variant weights active during the window
 */
export function getCaseWeightsForWindow(
  caseSchedules: Array<{
    window_from: string;
    window_to: string | null;
    variants: Record<string, number>;
  }>,
  window: DateRange
): Record<string, number> | null {
  if (!caseSchedules || caseSchedules.length === 0) {
    return null;
  }
  
  // Strategy: Use the schedule active at the END of the window
  // (This matches how we treat parameter values)
  const windowEnd = window.end;
  
  // Find the schedule whose [window_from, window_to) contains windowEnd
  for (const schedule of caseSchedules) {
    const from = new Date(schedule.window_from);
    const to = schedule.window_to ? new Date(schedule.window_to) : new Date('2099-12-31');
    const end = new Date(windowEnd);
    
    if (end >= from && end < to) {
      return schedule.variants;
    }
  }
  
  // Fallback: use the latest schedule
  const latest = caseSchedules[caseSchedules.length - 1];
  return latest?.variants || null;
}
```

#### B. Use in Graph Rendering

When computing edge probabilities, if a case node is involved and a window is selected:

**Conceptual integration point:** `graph-editor/src/lib/whatIf.ts` or `edgeBeadHelpers.tsx` (anywhere that reads `case.variants`).

```typescript
// Pseudo-code:
const caseNode = graph.nodes.find(n => n.type === 'case' && n.id === caseId);
const caseFile = fileRegistry.getFile(`case-${caseNode.case.id}`);

let effectiveWeights = caseNode.case.variants;  // Default

if (caseFile?.data?.case?.schedules && selectedWindow) {
  const scheduledWeights = getCaseWeightsForWindow(
    caseFile.data.case.schedules,
    selectedWindow
  );
  
  if (scheduledWeights) {
    // Update variant weights from schedule
    effectiveWeights = caseNode.case.variants.map(v => ({
      ...v,
      weight: scheduledWeights[v.name] ?? v.weight
    }));
  }
}

// Use effectiveWeights for probability calculations
```

**Challenge:** This requires access to the file registry and window state from deep within the graph computation logic.

**Pragmatic approach (Phase 1):** Don't implement windowed case consumption yet. Just ensure schedules are stored correctly. Add this in a follow-up.

**Phase 2:** Add a `useEffectiveCaseWeights` hook that:
- Takes `caseNode`, `window`, and returns effective weights.
- Used by edge rendering and probability computations.

#### C. Documentation

Add a note to the case schema documenting the windowing behavior:

```yaml
# In case-parameter-schema.yaml, under schedules:
schedules:
  type: array
  description: |
    Time-windowed variant configurations (historical record).
    When querying for a specific time window, the system uses the schedule
    entry whose [window_from, window_to) interval contains the window.end date.
    This ensures that graphs reflect the actual rollout percentages at any point in time.
```

### Testing (Future)
- Create case with 3 schedule entries spanning 3 weeks.
- Set window to week 2.
- Verify: graph uses weights from week 2 schedule.

---

## Naming Conventions: Case ID vs Gate ID

### Problem
Statsig and Amplitude use **underscores** in gate/experiment names (e.g., `experiment_coffee_promotion`), but DagNet prefers **hyphens** for case IDs (e.g., `coffee-promotion`) as they are more idiomatic and URL-friendly.

### Solution
Adapters automatically transform `case_id` → `gate_id` by replacing hyphens with underscores.

**Naming convention**:
- **DagNet case_id**: `coffee-promotion` (hyphens, idiomatic)
- **Statsig/Amplitude gate_id**: `experiment_coffee_promotion` (underscores, required by API)

### Implementation

#### 1. Amplitude Adapter
Transforms `case_id` → `gate_id` in `pre_request` script before building `activeGates.{gate_id}` filter:

```javascript
// In pre_request script (connections.yaml):
const case_id = caseFilter.key;  // "coffee-promotion"
const gate_id = case_id.replace(/-/g, '_');  // "experiment_coffee_promotion"

segments.push({
  prop: `activeGates.${gate_id}`,  // activeGates.experiment_coffee_promotion
  op: "is",
  values: [gateValue ? "true" : "false"]
});
```

#### 2. Statsig Adapter
Transforms `caseId` → `gate_id` in `pre_request` script before fetching gate config:

```javascript
// In pre_request script (connections.yaml):
if (typeof caseId === 'string') {
  dsl.gate_id = caseId.replace(/-/g, '_');
  console.log(`[Statsig Adapter] Transformed case_id="${caseId}" → gate_id="${dsl.gate_id}"`);
}

// URL template uses dsl.gate_id:
// {{{connection.base_url}}}/gates/{{{dsl.gate_id}}}
// → https://statsigapi.net/console/v1/gates/experiment_coffee_promotion
```

### Example Flow

```yaml
# In graph file (DagNet):
nodes:
  - type: case
    case:
      id: "coffee-promotion"  # ← hyphens (idiomatic)
      variants: [...]

# Amplitude adapter transforms to:
activeGates.experiment_coffee_promotion = true  # ← underscores (API convention)

# Statsig adapter fetches:
GET /gates/experiment_coffee_promotion  # ← underscores (API convention)
```

### Transformation Rule

```javascript
gate_id = case_id.replace(/-/g, '_')
```

This keeps our case IDs clean and idiomatic while respecting external API naming conventions.

---

## Testing Strategy

### Unit Tests

1. **caseVariantHelpers.ts:**
   - Test `resolveVariantToBool` with various inputs:
     - Obvious: "true", "false", "on", "off", "control", "treatment"
     - 2-variant: ["control", "treatment"], ["off", "variant-a"]
     - 3-variant: ["control", "variant-a", "variant-b"]
     - Edge cases: empty, null, non-string

2. **DASRunner context:**
   - Mock `runner.execute` and verify `caseId` is passed.
   - Verify Mustache templates can access `{{caseId}}`.

3. **Window aggregation:**
   - Test `getCaseWeightsForWindow` with overlapping/non-overlapping schedules.

### Integration Tests

1. **Statsig adapter (mocked API):**
   - Mock Statsig API response with `passPercentage: 30`.
   - Run adapter.
   - Verify output: `control.weight = 0.7`, `treatment.weight = 0.3`.

2. **Versioned fetch:**
   - Create case file with 1 schedule.
   - Call `getFromSource`.
   - Verify: 2nd schedule appended, old schedule closed.

3. **Amplitude filtering:**
   - Query DSL: `from(a).to(b).case(coffee_promotion:treatment)`.
   - Build DSL.
   - Run Amplitude adapter.
   - Verify: `s=` param includes `activeGates.coffee_promotion = "true"`.

### Manual Tests

1. **End-to-end Statsig:**
   - Create case node with real Statsig gate.
   - Configure credentials.
   - Click "Get from Source".
   - Verify: weights updated in graph.

2. **Amplitude with case filter:**
   - Create parameter edge with query: `from(a).to(b).case(gate:treatment)`.
   - Click "Get from Source (direct)".
   - Inspect network: verify Amplitude API call includes `activeGates.*` filter.

3. **Windowed retrieval (future):**
   - Create case with historical schedules.
   - Select different windows.
   - Verify: graph weights change correctly.

---

## Related Work

### Google Sheets HRN Integration
See: `/docs/current/GOOGLE_SHEETS_HRN_INTEGRATION.md`

**Status**: 🚧 Not yet implemented (blocked by Case Gate Integration)

**Summary**: Enable Google Sheets to use HRN (Human-Readable Name) references like `e.edge-name.p.mean` instead of hardcoded cell positions. This allows users to:
- Copy HRN from scenario modal → paste into Sheet
- Manage parameters in Sheet with human-readable names
- Use Sheet formulas to compute parameter values
- Support bulk parameter updates via Sheet ranges

**Example**:
```
Sheet Cell A1: e.checkout-to-purchase.p.mean
Sheet Cell B1: 0.45
Connection range: "Sheet1!A1:B1"
→ Adapter parses HRN, resolves to edge, applies value 0.45
```

**Dependencies**:
- Graph context in adapter scripts (not currently available)
- Dynamic upsert targets (needs DAS Runner enhancement)
- HRN parsing helper in TypeScript (reuse existing `HRNParser`/`HRNResolver`)

---

## Future Work

### Phase 2: Full Variant→Bool Mapping

- Add post-response script phase to DAS Runner.
- Call `dasHelpers.resolveVariantToBool(variant, allVariants)` with actual case variants.
- Support >2 variants with smart inference.

### Phase 3: Webhook Integration

- Build Statsig webhook handler endpoint (Express/API route).
- Parse webhook payload.
- Trigger `getFromSource` for affected cases.
- Notify UI of updates (WebSocket or polling).

### Phase 4: Statsig Experiments (not just gates)

- Extend adapter to handle multi-variant experiments.
- Map experiment allocations → DagNet case variants.
- Support parameter groups and layer assignments.

### Phase 5: Historical Analysis

- Fetch historical gate configs from Statsig (if API supports).
- Backfill case schedules.
- Enable "what was the rollout on date X?" queries.

### Phase 6: Bidirectional Sync

- Push DagNet case changes back to Statsig (if needed).
- Conflict resolution when both systems change simultaneously.

---

## Implementation Checklist

### Component 0: Reusable ConnectionControl Component
- [ ] Create `/graph-editor/src/components/ConnectionControl.tsx`
- [ ] Extract connection UI pattern with AutomatableField wrapper
- [ ] Refactor ParameterSection.tsx to use ConnectionControl
- [ ] Update PropertiesPanel.tsx to load case connection data into state
- [ ] Add ConnectionControl to PropertiesPanel.tsx for case nodes
- [ ] Test: verify parameters still work (connection dropdown, settings, override flags)
- [ ] Test: verify case nodes show connection UI
- [ ] Test: verify connection settings can be saved for cases

### Component 1: Case-Aware DAS Execution ✅ COMPLETE
- [x] Update `dataOperationsService.getFromSourceDirect` to pass `caseId`
- [x] Add `caseId`/`nodeId` to `ExecutionContext` type
- [x] Update `DASRunner.interpolateTemplate` to expose `caseId`
- [x] Skip DSL building for cases (use empty DSL)
- [x] Verified: `{{caseId}}` available in adapter templates

**Changes Made**:
1. **types.ts**: Added `nodeId?: string` to `ExecutionContext` and `RunnerExecuteOptions`
2. **dataOperationsService.ts**:
   - Added `objectType === 'case'` check to skip DSL building (line 1350-1354)
   - Pass `caseId: objectType === 'case' ? objectId : undefined` to runner.execute (line 1649)
   - Pass `nodeId: objectType === 'node' ? (targetId || objectId) : undefined` (line 1650)
3. **DASRunner.ts**: Added `nodeId: ctx.nodeId` to flatContext for template interpolation (line 309)

**Testing**:
- Manual test: Right-click case node → "Get from Source (Direct)" → verify adapter receives caseId
- Console should log: `[Statsig Adapter] Transformed case_id="coffee-promotion" → gate_id="experiment_coffee_promotion"`

### Component 2: Statsig Adapter ✅ COMPLETE
- [x] Update `statsig-prod` adapter in `connections.yaml`
- [x] Add `pass_percentage` extraction
- [x] Compute `p_true` and variant weights
- [x] Implement production pass rate heuristic
- [x] Fix upsert target to use `caseId` not `nodeId`

**Changes Made**:
1. **connections.yaml** (lines 289-406):
   - Added `environment` to connection_string_schema for env overrides
   - **pre_request**: Extract target environment from connection_string or defaults
   - **response.extract**: Extract `gate_id`, `gate_name`, `is_enabled`, `rules`
   - **transform**: Implemented production pass rate heuristic:
     - Filter rules by target environment (e.g., "production")
     - Find first "public" rule in filtered set
     - Extract `passPercentage` and convert to decimal (0.0-1.0)
     - Compute `treatment_weight` = pass% and `control_weight` = 1 - pass%
     - Build `variants_update` array with treatment/control weights
   - **upsert**: Write to `/case-{{caseId}}/schedules/-` (append new schedule)
     - Schedule includes `window_from`, `window_to: null`, and `variants` array

**Testing**:
- Manual test: Create case node with `case_id="coffee-promotion"`, set connection to `statsig-prod`
- Right-click → "Get from Source (Direct)"
- Verify console logs:
  - `[Statsig Adapter] Transformed case_id="coffee-promotion" → gate_id="experiment_coffee_promotion"`
  - `[Statsig Adapter] Target environment: production`
- Verify case file updated with new schedule entry
- For 30% rollout gate, expect: `treatment_weight=0.3, control_weight=0.7`

### Component 3: Versioned Get From Source ✅ COMPLETE
- [x] Remove parameter-only guard in `getFromSource`
- [x] Add case-specific branch
- [x] Implement case schedule update logic
- [x] Update graph nodes from case file after fetch

**Changes Made**:
1. **dataOperationsService.ts** (lines 1195-1305):
   - Removed parameter-only guard
   - Added `objectType === 'case'` branch:
     - Calls `getFromSourceDirect` with `dailyMode: false` (single schedule entry)
     - After fetch, reads case file from IDB
     - Extracts most recent schedule (TODO: windowed aggregation in Component 5)
     - Updates all graph nodes with matching `case.id`
     - Sets `weight_overridden: true` to indicate values from source
     - Updates graph metadata timestamp

**Flow**:
1. User: Right-click case node → "Get from Source"
2. `getFromSource('case', objectId, ...)` called
3. `getFromSourceDirect` → DAS Runner → Statsig adapter
4. Adapter fetches gate config, appends to `case-{objectId}/schedules[]`
5. `getFromSource` reads updated case file
6. Updates all graph nodes with `case.id === objectId`
7. Graph re-renders with new variant weights

**Testing**:
- Create case node with `case_id="coffee-promotion"`
- Set connection to `statsig-prod` in case file or node properties
- Right-click → "Get from Source"
- Verify case file has new schedule entry
- Verify graph node variant weights updated

### Component 4: UI Wiring ✅ COMPLETE
- [x] Update `NodeContextMenu.handleGetCaseFromSourceDirect`
- [x] Verified: right-click → Get from Source works (handlers already exist)
- [x] Verified: Versioned and Direct paths both implemented

**Changes Made**:
1. **NodeContextMenu.tsx** (line 165-176):
   - Implemented `handleGetCaseFromSourceDirect`:
     - Validates connection exists
     - Validates `case.id` exists
     - Calls `dataOperationsService.getFromSourceDirect` with `objectType: 'case'`
   - Existing `handleGetCaseFromSourceVersioned` (line 177-193):
     - Already correctly calls `getFromSource` with `objectType: 'case'`

**UI Flow**:
- Right-click case node → "Case Data" submenu:
  - **"Get from Source"** → Versioned (file → graph)
  - **"Get from Source (Direct)"** → Direct (source → graph, no file)
  - **"Get from File"** → File → graph
  - **"Put to File"** → Graph → file

**Testing**:
- Create case node with connection configured
- Right-click → "Case Data" → "Get from Source"
- Verify gate config fetched from Statsig
- Verify case file updated with schedule
- Verify graph node variant weights updated

### Component 5: Window-Aware Schedules ✅ COMPLETE (Phases 1 & 2)
- [x] **Phase 1**: Add `getCaseWeightsForWindow` (simple: most recent schedule)
- [x] **Phase 2**: Add `aggregateCaseSchedulesForWindow` (time-weighted averaging)
- [x] Add `RawCaseAggregation` interface (mirrors `RawAggregation` for params)
- [x] Integrate into graph rendering (use windowed weights via getCaseFromFile)
- [x] Update getFromSource to use windowed aggregation

**Changes Made**:

1. **windowAggregationService.ts** (lines 42-368):
   - Added `CaseSchedule` interface (schedule entry from case file)
   - Added `RawCaseAggregation` interface (aggregated variant weights)
   - **Phase 1**: `getCaseWeightsForWindow(schedules, window?)`:
     - If no window: returns most recent schedule
     - With window: filters schedules in window, returns most recent
     - Method: `'simple-latest'`
   - **Phase 2**: `aggregateCaseSchedulesForWindow(schedules, window)`:
     - Time-weighted averaging across multiple schedules
     - Handles ongoing schedules (`window_to: null`)
     - Collects all variant names across schedules
     - For each variant: calculates `∑(weight × duration) / ∑(duration)`
     - Method: `'time-weighted'`
   - Helper: `filterSchedulesForWindow(schedules, window)`:
     - Filters schedules that overlap with window
     - Handles ongoing schedules (uses current time as end)

2. **dataOperationsService.ts** (lines 889-1057):
   - Updated `getCaseFromFile` to accept optional `window` parameter
   - If window provided and schedules exist:
     - Uses `aggregateCaseSchedulesForWindow` for time-weighted weights
     - Applies aggregated weights to graph node variants
     - Sets `weight_overridden: true`
     - Toasts: "✓ Updated from {caseId}.yaml (windowed)"
   - If no window: uses existing file-to-graph update path

3. **dataOperationsService.ts** (lines 1314-1393):
   - Updated `getFromSource` for cases to use windowed aggregation:
     - With `targetId`: Calls `getCaseFromFile` with window
     - Without `targetId` (batch update): Uses `WindowAggregationService` directly
     - Supports both `getCaseWeightsForWindow` (no window) and `aggregateCaseSchedulesForWindow` (with window)

**Example**:

```yaml
# case-coffee-promotion.yaml
schedules:
  - window_from: "2025-01-01T00:00:00Z"
    window_to: "2025-01-15T00:00:00Z"
    variants:
      - name: "treatment"
        weight: 0.1
      - name: "control"
        weight: 0.9
  
  - window_from: "2025-01-15T00:00:00Z"
    window_to: null  # Ongoing
    variants:
      - name: "treatment"
        weight: 0.3
      - name: "control"
        weight: 0.7
```

**User selects window**: `2025-01-10 to 2025-01-20`

**Time-weighted calculation** (treatment):
- Schedule 1: 5 days (Jan 10-15) at 0.1 → `0.1 × 5 = 0.5`
- Schedule 2: 5 days (Jan 15-20) at 0.3 → `0.3 × 5 = 1.5`
- **Average**: `(0.5 + 1.5) / (5 + 5) = 0.2` ✓

**Testing**:
- Create case with multiple schedules
- Select different windows in UI
- Verify weights change correctly based on time-weighted average
- Verify console logs show `method: 'time-weighted'`, `schedules_included: N`

## Incomplete Data Handling: Commercially Reasonable Policy (Proposal)

### Problem Statement

Unlike Amplitude (which can fetch historical n/k data for any window), Statsig only provides the current gate configuration. This means:

1. **Gradual accumulation**: We build schedule history incrementally as user fetches from Statsig over time
2. **Sparse data**: Early in lifecycle, we may have few schedule entries with large gaps
3. **Historical queries**: User may select windows that predate any fetched data

**Example timeline**:
```
Timeline:  [-------|======|------|======|------]
           Jan 1   Jan 10  Jan 15  Jan 25  Feb 1
           
Schedules: -       Fetch 1 -       Fetch 2 -
                   (10-15)         (25-30)

User queries window: Jan 1 - Feb 1
Available data:      Only Jan 10-15 and Jan 25-30
Missing periods:     Jan 1-10, Jan 15-25, Jan 30-Feb 1
```

### Proposed Policy: Signal Continuity

**Core principle**: Assume variant weights are **continuous signals** that persist between observations.

This is commercially reasonable because:
- ✅ Statsig gate configs typically change infrequently (rollouts are gradual)
- ✅ Our fetches capture configuration snapshots; absence of fetch ≠ absence of configuration
- ✅ Better to extrapolate from known data than return no answer
- ✅ Transparent to user via coverage metadata

### Policy Rules

#### Rule 1: Periods PRIOR to any data
**Return**: First (earliest) schedule in file

**Rationale**: The first fetch captured the earliest known configuration. Assume it was in effect beforehand.

**Example**:
```yaml
schedules:
  - window_from: "2025-01-10T00:00:00Z"
    window_to: null
    variants: [treatment: 0.3, control: 0.7]

User queries: 2025-01-01 to 2025-01-05 (all prior to data)
Result: Use Jan 10 schedule
Coverage: { 
  coverage_pct: 0.0, 
  extrapolation: 'prior',
  message: '⚠️ Window predates first schedule. Using first schedule (from 2025-01-10) as extrapolation.'
}
```

#### Rule 2: Periods WITHIN a data window
**Return**: Actual time-weighted average of schedules in window

**Rationale**: We have actual data; use it.

**Example**:
```yaml
User queries: 2025-01-10 to 2025-01-15
Schedules: Jan 10-15 (treatment: 0.3)
Result: treatment: 0.3
Coverage: { coverage_pct: 1.0, is_complete: true, message: '✓ Complete coverage' }
```

#### Rule 3: Periods BETWEEN data windows
**Return**: Last (most recent) schedule before the gap

**Rationale**: Configuration persists until changed. Last known value is best estimate.

**Example**:
```yaml
schedules:
  - window_from: "2025-01-10T00:00:00Z"
    window_to: "2025-01-15T00:00:00Z"
    variants: [treatment: 0.2, control: 0.8]
  - window_from: "2025-01-25T00:00:00Z"
    window_to: null
    variants: [treatment: 0.4, control: 0.6]

User queries: 2025-01-18 to 2025-01-22 (between windows)
Result: Use Jan 15 schedule (last before gap)
Coverage: { 
  coverage_pct: 0.0, 
  extrapolation: 'forward',
  message: '⚠️ Window has no schedules. Using last prior schedule (from 2025-01-15) as forward extrapolation.'
}
```

#### Rule 4: Periods AFTER all data
**Return**: Last (most recent) schedule in file

**Rationale**: Current configuration persists until changed. Latest fetch is most accurate for "now".

**Example**:
```yaml
schedules:
  - window_from: "2025-01-25T00:00:00Z"
    window_to: "2025-01-30T00:00:00Z"
    variants: [treatment: 0.4, control: 0.6]

User queries: 2025-02-05 to 2025-02-10 (all after data)
Result: Use Jan 30 schedule
Coverage: { 
  coverage_pct: 0.0, 
  extrapolation: 'forward',
  message: '⚠️ Window postdates last schedule. Using last schedule (from 2025-01-30) as forward extrapolation.'
}
```

#### Rule 5: Partial overlap
**Return**: Weighted average of schedules in window + extrapolated values for gaps

**Rationale**: Use real data where available, extrapolate missing periods.

**Example**:
```yaml
schedules:
  - window_from: "2025-01-10T00:00:00Z"
    window_to: "2025-01-15T00:00:00Z"
    variants: [treatment: 0.2, control: 0.8]
  - window_from: "2025-01-25T00:00:00Z"
    window_to: "2025-01-30T00:00:00Z"
    variants: [treatment: 0.4, control: 0.6]

User queries: 2025-01-12 to 2025-01-28 (16 days)
Available data:
  - Jan 12-15: 3 days with treatment: 0.2
  - Jan 15-25: 10 days GAP → extrapolate Jan 15 schedule (treatment: 0.2)
  - Jan 25-28: 3 days with treatment: 0.4

Time-weighted result:
  treatment = (0.2 × 3 + 0.2 × 10 + 0.4 × 3) / 16 = 0.25
  
Coverage: { 
  coverage_pct: 0.375,  // 6/16 days have real data
  extrapolation: 'partial',
  message: '⚠️ Partial coverage: 38% of window (2 schedules, 10 days extrapolated)'
}
```

### Implementation Metadata

Update `RawCaseAggregation.coverage` interface:

```typescript
coverage: {
  coverage_pct: number;        // 0.0 to 1.0 (real data only)
  extrapolated_pct: number;    // 0.0 to 1.0 (extrapolated periods)
  is_complete: boolean;        // coverage_pct >= 0.99
  extrapolation: 'none' | 'prior' | 'forward' | 'partial';
  message: string;
  // Debugging
  real_duration_ms: number;
  extrapolated_duration_ms: number;
  total_duration_ms: number;
}
```

### Transparency & User Communication

**Console logging**:
```javascript
// Green tick for complete coverage
console.log('[WindowAggregation] ✓ Complete coverage (100%)');

// Yellow warning for extrapolation
console.warn('[WindowAggregation] ⚠️ Partial coverage: 38% real data, 62% extrapolated (forward from 2025-01-15)');

// Info for full extrapolation
console.info('[WindowAggregation] ℹ️ Window has no schedules. Using last schedule (from 2025-01-30) as forward extrapolation.');
```

**UI indicators** (Phase 3):
- Window selector badge: "⚠️ 38% coverage"
- Tooltip: "This window has partial data coverage. 62% of period is extrapolated from last known schedule."
- Graph node indicator: Faded colour or dotted border for extrapolated weights

### Edge Cases

**Empty file** (no schedules):
```typescript
Result: Return empty variants
Coverage: { 
  coverage_pct: 0.0,
  extrapolation: 'none',
  message: 'No schedules available in case file'
}
```

**Overlapping schedules** (data error):
```typescript
schedules:
  - window_from: "2025-01-10", window_to: "2025-01-20"
  - window_from: "2025-01-15", window_to: "2025-01-25"

Handling: Take most recent schedule for overlapping period (Jan 15-20 uses second schedule)
Log warning: "Overlapping schedules detected"
```

**Future schedules** (clock skew):
```typescript
Current time: 2025-01-20
Schedule: window_from: "2025-01-25"

Handling: Ignore future schedules when computing "latest"
Use last schedule that has started (window_from <= now)
```

### Testing Scenarios

1. **Pure extrapolation (prior)**: Query Jan 1-5, first schedule Jan 10
2. **Pure extrapolation (forward)**: Query Feb 1-10, last schedule Jan 30
3. **Pure extrapolation (between)**: Query Jan 18-22, schedules Jan 10-15 and Jan 25-30
4. **Partial coverage**: Query Jan 12-28, schedules Jan 10-15 and Jan 25-30
5. **Complete coverage**: Query Jan 10-30, continuous schedules
6. **Empty file**: Query any window, no schedules
7. **Multiple gaps**: Query with 3 schedules and 2 gaps between them

### Migration Path

**Phase 1** (Current): Naive fallback to latest schedule
- ✅ Already implemented
- Shows warning but doesn't distinguish extrapolation types

**Phase 2** (This proposal): Signal continuity with proper extrapolation
- Update `aggregateCaseSchedulesForWindow` with new logic
- Add extrapolation metadata
- Implement Rules 1-5

**Phase 3** (Future): UI indicators
- Window selector coverage badge
- Graph node visual indicators
- Hover tooltips with explanation

---

**Status**: 📋 Proposal (not yet implemented)
**Decision needed**: Approve policy before implementation

**Phase 3 (Future)**:
- [ ] Statistical enhancement: add to `statisticalEnhancementService`
- [ ] Python stats methods: `bayesian-rollout`, `trend-detection`
- [ ] "As at date" resolver with lag distribution convolution
- [ ] UI indicator for incomplete coverage (badge on window selector)

### Testing
- [ ] Write unit tests for `resolveVariantToBool`
- [ ] Write integration test for Statsig adapter
- [ ] Write integration test for Amplitude case filtering
- [ ] Manual E2E test with real Statsig gate

### Documentation
- [ ] Update `data-connections.md` with Statsig case usage
- [ ] Add case schedules example to schema docs
- [ ] Document variant→bool mapping policy

---

## Timeline Estimate

| Component | Estimated Time |
|-----------|---------------|
| 0. Reusable ConnectionControl Component | 2 hours |
| 1. Case-Aware DAS | 2 hours |
| 2. Statsig Adapter | 3 hours |
| 3. Versioned Get From Source | 4 hours |
| 4. UI Wiring | 1 hour |
| 5. Window Schedules (Phase 1) | 2 hours |
| Testing & Debugging | 3 hours |
| Documentation | 1 hour |
| **Total** | **18 hours** |

---

## Success Criteria

✅ Case nodes can fetch rollout percentages from Statsig.  
✅ Fetched rollouts are stored as schedules in case files.  
✅ Graph renders using correct variant weights from schedules.  
✅ Amplitude queries filter by gate status using `activeGates.*`.  
✅ Conditional probabilities work with case filters.  
✅ UI provides clear feedback for case fetch operations.

---

## References

- **Case Schema:** `/graph-editor/public/param-schemas/case-parameter-schema.yaml`
- **Connections Spec:** `/graph-editor/public/defaults/connections.yaml`
- **DAS Runner:** `/graph-editor/src/lib/das/DASRunner.ts`
- **Data Operations:** `/graph-editor/src/services/dataOperationsService.ts`
- **Variant Helpers:** `/graph-editor/src/lib/das/caseVariantHelpers.ts`
- **Window Aggregation:** `/graph-editor/src/services/windowAggregationService.ts`

