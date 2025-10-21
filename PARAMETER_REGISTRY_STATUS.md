# Parameter Registry Implementation Status

**Last Updated:** October 21, 2025  
**Status:** Partially Implemented - Core infrastructure and connections remain

---

## Overview

The parameter registry system aims to centralize parameter management for conversion graphs, enabling:
- **Canonical parameter references** from edges/nodes to a shared registry
- **Immutable parameter definitions** with version control (Git-based)
- **External platform integration** (Statsig, Optimizely, etc.)
- **Analytics preparation** (Bayesian priors, MCMC config)

**Design Goal:** Parameters can be mapped to:
- ✅ Cases (node-level case configurations)
- 🟡 Edge probabilities (base `p.mean`, `p.stdev`)
- 🟡 Conditional probabilities (conditional `p.mean`, `p.stdev`)
- 🟡 Edge costs (`costs.monetary`, `costs.time`)
- ❌ Node names/slugs (not currently in schema)
- ❌ Edge names/slugs (not currently in schema)

Legend: ✅ Implemented | 🟡 Schema ready, no UI/loader | ❌ Not in schema

---

## What Has Been Implemented ✅

### 1. Schema & Type Definitions
**Location:** `graph-editor/src/lib/types.ts`

```typescript
// Cases can reference parameters
interface CaseData {
  id: string;
  parameter_id?: string; // ✅ Reference to param registry
  status: CaseStatus;
  variants: CaseVariant[];
}

// Edge probabilities can reference parameters
interface ProbabilityParam {
  mean?: number;
  stdev?: number;
  locked?: boolean;
  parameter_id?: string; // ✅ Reference to param registry
}
```

**Status:** ✅ Schema supports parameter references for cases and edge probabilities

---

### 2. Conditional Reference System
**Location:** `graph-editor/src/lib/conditionalReferences.ts`

**Complete implementation** for generating stable parameter references:
- Base probability: `e.<edge-slug>.p.mean`
- Conditional: `e.<edge-slug>.visited(<node-slug-1>,<node-slug-2>).p.mean`
- Alphabetically sorted for determinism
- Parse and generate functions implemented

**Status:** ✅ Fully implemented and documented

---

### 3. Parameter Registry Structure
**Location:** `param-registry/`

```
param-registry/
├── registry.yaml              # Registry index with 9 example parameters
├── schemas/
│   ├── parameter-schema.yaml  # Parameter definition schema
│   └── registry-schema.yaml   # Registry index schema
├── parameters/
│   ├── probability/
│   ├── cost/
│   └── time/
├── config/
│   └── registry.yaml          # Configuration settings
└── examples/                  # Example parameter files
```

**Status:** ✅ Structure defined, example files created, schemas complete

---

### 4. UI Scaffolding (Partial)
**Location:** `graph-editor/src/components/PropertiesPanel.tsx`

**For Case Nodes:**
- ✅ Case mode selector (registry vs manual)
- ✅ Parameter ID dropdown (with hardcoded mock data)
- ✅ Registry info display panel
- ✅ "Refresh" and "Edit" buttons (non-functional)
- ⚠️ **BUT:** Uses mock data, doesn't actually load from registry

**Lines 874-990:** Case parameter UI with TODOs:
```typescript
// TODO: Load parameter from registry (line 886)
// TODO: Refresh from registry (line 933)
// TODO: Edit in registry (line 953)
```

**Status:** 🟡 UI exists but no backend connection

---

### 5. Apps Script Parameter System
**Location:** `dagnet-apps-script-simple.js`

**Implemented functions:**
- ✅ `dagParams()` - Extract parameters to spreadsheet using dot notation
- ✅ `applyCustomParameters(graph, customParams)` - Apply parameter overrides
- ✅ Dot notation system: `e.<edge-slug>.p.mean`, `n.<node-slug>.costs.monetary`
- ✅ Works with slugs, IDs, and labels

**Status:** ✅ Functional for parameter overrides via spreadsheet

---

### 6. Documentation
**Completed documents:**
- ✅ `PARAMETER_REGISTRY_SPEC.md` - Full specification
- ✅ `PARAMETER_REGISTRY_SUMMARY.md` - Implementation summary
- ✅ `PARAMETER_REGISTRY_ARCHITECTURE_ANALYSIS.md` - Architecture analysis
- ✅ `CASE_PARAMETER_REGISTRY_DESIGN.md` - Case-specific design
- ✅ `CONDITIONAL_PROBABILITY_REFERENCES.md` - Reference format spec

**Status:** ✅ Comprehensive documentation

---

## What Still Needs to Be Done 🚧

### Critical Path: Core Infrastructure

#### 1. Parameter Registry Loader (HIGH PRIORITY)
**Currently:** Parameter IDs are stored but never resolved to actual values

**Needs:**
```typescript
// Load parameter from registry
async function loadParameter(parameterId: string): Promise<Parameter> {
  // Fetch from param-registry/ directory
  // Parse YAML
  // Return parameter object
}

// Apply parameters to graph
function resolveParameterReferences(graph: Graph): Graph {
  // For each node with case.parameter_id
  // For each edge with p.parameter_id
  // For each conditional_p with parameter_id
  // Resolve and populate actual values
}
```

**Impact:** Without this, parameter references are just strings with no effect

---

#### 2. GitHub API Integration (MEDIUM PRIORITY)
**Purpose:** Enable remote parameter registry access

**Needs:**
- GitHub API authentication (OAuth2)
- CRUD operations for parameters
- CRUD operations for graphs
- Branch management (main + sub-branches)
- Apps Script GitHub integration

**Current Status:** Designed but not implemented

---

### Parameter Connection Gaps

#### 3. Edge Probability → Registry Connection
**Schema:** ✅ `edge.p.parameter_id` exists  
**UI:** ❌ No interface to link edge probability to registry  
**Loader:** ❌ No code to resolve `parameter_id` to actual value

**Needs UI for:**
- Search/browse parameters in registry
- Associate edge probability with parameter
- Display current parameter value
- Create new parameter from current edge value

---

#### 4. Conditional Probability → Registry Connection
**Schema:** 🟡 Could use `conditional_p[].p.parameter_id`  
**UI:** ❌ No interface for conditional parameter linking  
**Loader:** ❌ No resolution logic

**Needs:**
- Extend schema to support `parameter_id` in conditional_p entries
- UI for linking each conditional to registry
- Resolution logic in loader

---

#### 5. Edge Costs → Registry Connection
**Schema:** 🟡 Could add `parameter_id` to `MonetaryCost`/`TimeCost`  
**UI:** ❌ No interface  
**Loader:** ❌ No resolution logic

**Needs:**
- Extend schema: `costs.monetary.parameter_id`, `costs.time.parameter_id`
- UI for cost parameter association
- Resolution logic

---

#### 6. Node Names/Edge Names (NOT IN SCOPE?)
**Current:** No schema support for parameterized names  
**Question:** Is this actually needed?

**If needed:**
- Add `node.name_param_ref` field
- Add `edge.name_param_ref` field
- UI and resolution logic

**Clarification needed:** What does "node names" and "edge names" mean in the context of parameter connections?
- Using slugs as keys? (Already done via conditional references)
- Dynamic/parameterized labeling? (Not implemented)

---

### Case Parameter Completion

#### 7. Make Case → Registry Connection Functional
**Currently:** UI exists but uses mock data

**Needs:**
1. Remove hardcoded parameter list (lines 910-912 in PropertiesPanel.tsx)
2. Implement actual parameter loading:
   ```typescript
   const loadCaseParameter = async (parameterId: string) => {
     const param = await loadParameter(parameterId);
     // Update case data from param.case
   };
   ```
3. Implement refresh from registry
4. Implement edit in registry (open parameter file)
5. Test end-to-end: select parameter → loads variants and weights

---

### Context System Integration

#### 8. "Bring Context into Graph" (TODO #2)
**Current:** No context system implemented

**Possible interpretations:**
1. **External context variables** (user segment, time of day, geo) that affect parameters
2. **Graph-level parameters** vs edge-level parameters
3. **Runtime context** passed to runner for parameter evaluation
4. **Context metadata** in parameter registry

**Needs clarification:** What exactly is "context" in this context?

---

## Implementation Priority

### Phase 1: Make Current Features Work (1-2 weeks)
**Goal:** Complete what's half-done

1. **Build Parameter Loader**
   - Read YAML files from `param-registry/`
   - Parse and validate parameters
   - Return structured parameter objects
   - ~2-3 days

2. **Connect Case Parameters**
   - Replace mock data with real loader
   - Implement refresh functionality
   - Test with actual registry files
   - ~2-3 days

3. **Resolve Parameters in Graph**
   - When graph loads, resolve all `parameter_id` references
   - Populate actual values from registry
   - Display parameter source in UI
   - ~2-3 days

**Deliverable:** Cases fully work with parameter registry

---

### Phase 2: Extend to Edge Parameters (2-3 weeks)
**Goal:** Full parameter connection coverage

1. **Edge Probability UI** (~3-4 days)
   - Parameter search/browse component
   - "Link to registry" button in edge properties
   - Display current parameter source
   - Create parameter from edge value

2. **Conditional Probability UI** (~3-4 days)
   - Extend schema for conditional parameter_id
   - UI for each conditional entry
   - Resolution logic in loader

3. **Edge Costs UI** (~2-3 days)
   - Extend schema for cost parameter_id
   - UI for cost parameter linking
   - Resolution logic

**Deliverable:** All edge properties can link to registry

---

### Phase 3: Infrastructure (2-3 weeks)
**Goal:** Enable remote registry and collaboration

1. **GitHub API Integration** (~5-7 days)
   - OAuth2 authentication
   - Repository operations
   - Branch management
   - Rate limiting and caching

2. **Apps Script Integration** (~3-5 days)
   - GitHub API functions in Apps Script
   - Parameter fetch/update functions
   - Graph pull/push functions

**Deliverable:** Remote parameter registry via GitHub

---

### Phase 4: Context System (TBD)
**Goal:** Depends on clarifying requirements

1. Define what "context" means
2. Design context integration
3. Implement context system
4. Test with real use cases

---

## Quick Wins (Can Do Today)

### 1. Remove Mock Data
**File:** `graph-editor/src/components/PropertiesPanel.tsx`  
**Lines:** 910-912

Replace hardcoded dropdown with:
```typescript
<option value="">Select parameter...</option>
{availableParameters.map(param => (
  <option key={param.id} value={param.id}>{param.name}</option>
))}
```

### 2. Create Parameter Loader
**New file:** `graph-editor/src/lib/parameterRegistry.ts`

```typescript
export async function loadParameter(parameterId: string): Promise<Parameter | null> {
  // Load from param-registry/registry.yaml
  // Find parameter by ID
  // Load parameter file
  // Parse YAML
  // Return parameter object
}
```

### 3. Test with Real Case Parameter
**Steps:**
1. Create `param-registry/parameters/cases/test-case.yaml`
2. Add to `param-registry/registry.yaml`
3. Load in PropertiesPanel
4. Verify variants populate correctly

---

## Open Questions

### 1. Node/Edge Name Parameterization
**Question:** What does "params can be mapped to node names and edge names" mean?

**Options:**
- A) Using slugs as parameter keys (already done via conditional references)
- B) Dynamic labeling where node.label is pulled from registry
- C) Something else?

**Action:** Clarify requirements before implementing

---

### 2. Context System Scope
**Question:** What is "context" and how does it relate to parameters?

**Possible meanings:**
- External variables (user segment, time, location)
- Graph-level vs edge-level parameter scope
- Runtime parameter evaluation context
- Parameter grouping/namespacing

**Action:** Define context system requirements

---

### 3. Node Parameters
**Question:** Do nodes need direct parameters beyond cases?

**Current:** Nodes have costs but no `parameter_id` field  
**Question:** Should `node.costs.monetary.parameter_id` exist?

**Action:** Decide if node costs should be parameterizable

---

## File Inventory

### Schema & Types
- ✅ `graph-editor/src/lib/types.ts` - Type definitions with parameter_id fields
- ✅ `schema/conversion-graph-1.0.0.json` - JSON schema (needs parameter_id addition?)

### Registry Files
- ✅ `param-registry/registry.yaml` - Registry index
- ✅ `param-registry/schemas/` - Parameter schemas
- ✅ `param-registry/parameters/` - Example parameters
- ✅ `param-registry/config/registry.yaml` - Configuration

### Utilities
- ✅ `graph-editor/src/lib/conditionalReferences.ts` - Reference generation
- ❌ `graph-editor/src/lib/parameterRegistry.ts` - **NEEDS TO BE CREATED**

### UI Components
- 🟡 `graph-editor/src/components/PropertiesPanel.tsx` - Has UI, needs backend
- ❌ `graph-editor/src/components/ParameterSelector.tsx` - **NEEDS TO BE CREATED**

### Apps Script
- ✅ `dagnet-apps-script-simple.js` - Parameter override functions
- ❌ GitHub API integration - **NEEDS TO BE ADDED**

### Documentation
- ✅ `PARAMETER_REGISTRY_SPEC.md` - Full specification
- ✅ `PARAMETER_REGISTRY_SUMMARY.md` - Implementation summary
- ✅ `CONDITIONAL_PROBABILITY_REFERENCES.md` - Reference format
- ✅ `CASE_PARAMETER_REGISTRY_DESIGN.md` - Case-specific design
- ✅ **THIS FILE** - Current status

---

## Next Session Action Items

### High Priority
1. **Create parameter loader** (`parameterRegistry.ts`)
2. **Connect case parameters** (replace mock data)
3. **Test end-to-end** with real parameter file

### Medium Priority
4. **Design edge parameter UI** (parameter selector component)
5. **Extend schema** for conditional parameter_id
6. **Plan GitHub API integration**

### Questions to Answer
7. **Clarify node/edge name parameterization** requirements
8. **Define context system** scope and design
9. **Decide on node parameter** support

---

## Success Criteria

### Phase 1 Complete When:
- ✅ Case parameters load from actual registry files
- ✅ Can select case parameter and see variants populate
- ✅ No more mock data in case parameter UI
- ✅ Can create test case parameter and use it in graph

### Phase 2 Complete When:
- ✅ Edge probabilities can link to registry
- ✅ Conditional probabilities can link to registry
- ✅ Edge costs can link to registry
- ✅ Can search/browse parameters in UI
- ✅ Can create new parameters from graph editor

### Phase 3 Complete When:
- ✅ Parameters stored in GitHub repository
- ✅ Can pull parameters from GitHub
- ✅ Can push parameter changes to GitHub
- ✅ Apps Script can access GitHub registry

---

**Ready to proceed:** Phase 1, starting with parameter loader implementation

