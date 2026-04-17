# Schema/Types/Code Consistency Implementation Plan

**Created:** 4-Dec-24  
**Status:** Draft - Pending Review  
**Scope:** Fix drift between JSON schema, TypeScript types, Python Pydantic models, and frontend behaviour

---

## Executive Summary

We have significant drift between:
- **JSON Schema:** `conversion-graph-1.0.0.json`
- **TypeScript Types:** `types/index.ts`
- **Python Models:** `lib/graph_types.py`
- **Actual Frontend Behaviour:** What gets saved to files

The goal is to achieve **100% parity** across all four, with comprehensive tests to prevent future drift.

---

## Current Issues Found

### Bug 1: `_noHistory` Leak (Code Bug)

**Severity:** High - corrupts saved files  
**Location:** `PropertiesPanel.tsx`

`updateConditionalPParam` does NOT strip `_noHistory` before persisting, unlike `updateEdgeP`:

```typescript
// updateEdgeP (lines 667-670) - CORRECTLY strips _noHistory
const { _noHistory, ...actualChanges } = changes;
Object.assign(next.edges[edgeIndex][paramSlot], actualChanges);

// updateConditionalPParam (line 812) - DOES NOT strip it!
Object.assign(next.edges[edgeIndex].conditional_p![condIndex].p!, changes);
```

**Impact:** `_noHistory` (an internal UI flag for suppressing undo history during slider drag) is being persisted to graph files in `conditional_p` entries.

---

### Bug 2: Schema Missing Properties (Schema Drift)

Properties used by frontend but **missing from schema**:

| Property | Location | Description |
|----------|----------|-------------|
| `currentQueryDSL` | Root level | Current query DSL string for UI persistence |
| `type` | Node | Enum: `normal` \| `case` |
| `name` | Metadata | Human-readable graph name |
| `colour` | Layout | Node colour override (UK spelling) |

---

### Bug 3: `case_id` Documentation Unclear

**Current schema description:** "Reference to parent case node ID"  
**Actual frontend behaviour:** Prefers `node.case.id`, falls back to `node.uuid` if case.id is empty.

This caused confusion when manually creating test files - the documentation didn't explain the fallback chain or which identifier to use.

---

### Bug 4: Tests Don't Catch Drift

Current consistency tests (`schemaTypesConsistency.test.ts`, `test_schema_python_consistency.py`) validate that:
- Schemas are well-formed
- Minimal test objects pass validation

But they **don't catch**:
- Properties in code but not in schema
- Properties in schema but not in code
- Actual values produced by frontend vs schema requirements
- Internal flags leaking to persistence

---

## Proposed Solution

### Phase 1: Fix Immediate Bugs

**Priority:** Immediate  
**Files:** 
- `graph-editor/src/components/PropertiesPanel.tsx`
- `param-registry/test/graphs/sample.json` (clean if polluted)

**Changes:**

1. Fix `updateConditionalPParam` to strip `_noHistory`:

```typescript
const updateConditionalPParam = useCallback((condIndex: number, changes: Record<string, any>) => {
  // ... existing code ...
  
  // Extract _noHistory flag before applying changes (matches updateEdgeP pattern)
  const { _noHistory, ...actualChanges } = changes;
  
  Object.assign(next.edges[edgeIndex].conditional_p![condIndex].p!, actualChanges);
  
  // ... rest of function ...
});
```

2. Search for and clean any existing `_noHistory` from saved files.

---

### Phase 2: Update JSON Schema

**File:** `graph-editor/public/schemas/conversion-graph-1.0.0.json`

**Goal:** An attentive, technically competent non-expert should be able to create a correctly formed graph by reading only the schema.

---

#### 2.1 Root Level - Add `currentQueryDSL`

```json
"currentQueryDSL": {
  "type": "string",
  "description": "Current user query DSL for UI persistence (e.g., window(1-Jan-25:31-Mar-25)). Optional."
}
```

---

#### 2.2 Node Definition - Add `type` Field (CRITICAL)

**Problem:** The schema has no `type` field. Frontend generates `type: "case"` but schema doesn't define it.

```json
"type": {
  "type": "string",
  "enum": ["normal", "case"],
  "default": "normal",
  "description": "Node type. Use 'case' for A/B test nodes that split traffic across experiment variants. Case nodes MUST also have a 'case' property defining variants."
}
```

---

#### 2.3 Node Definition - Improve `case` Property Description

**Current:** "Case/experiment node metadata (for A/B tests, feature flags, etc.)"

**Update to:**
```json
"case": {
  "type": "object",
  "description": "A/B test or experiment configuration. Required when type='case'. The case node routes 100% of incoming traffic across its variants according to variant weights. Each variant MUST have a corresponding outgoing edge with case_variant matching the variant name and case_id referencing this case.",
  ...
}
```

Also update `case.id` within the case object:
```json
"id": { 
  "$ref": "#/$defs/Id",
  "description": "Semantic identifier for this experiment (e.g., 'checkout-ab-test', 'cart-experiment-2025'). Strongly recommended - used by case edges and conditional_p references. If empty, system falls back to node.uuid."
}
```

---

#### 2.4 Node Definition - Improve `id` Description

**Current:** References `Id` type with `minLength: 1`

**Update `Id` definition:**
```json
"Id": { 
  "type": "string", 
  "minLength": 0,
  "maxLength": 128,
  "pattern": "^[a-zA-Z0-9_-]*$",
  "$comment": "Empty IDs are permitted but discouraged. Assign meaningful kebab-case identifiers for clarity.",
  "description": "Human-readable identifier (letters, numbers, hyphens, underscores). Empty is allowed but discouraged."
}
```

---

#### 2.5 Node Definition - Improve `absorbing` Description

**Current:** "If true, node is terminal and MUST have zero outgoing edges"

**Update to:**
```json
"absorbing": { 
  "type": "boolean", 
  "default": false,
  "description": "Terminal node flag. If true, this node ends a path and MUST have zero outgoing edges. Typically used for success/failure/abandon outcomes. Should be paired with outcome_type."
}
```

---

#### 2.6 Node Definition - Improve `entry` Description

**Update:**
```json
"entry": {
  "type": "object",
  "description": "Entry point configuration. At least one node in the graph MUST have is_start=true to define where traffic enters.",
  "properties": {
    "is_start": { 
      "type": "boolean", 
      "default": false,
      "description": "If true, this node is a traffic entry point. At least one node must have is_start=true."
    },
    "entry_weight": { 
      "type": "number", 
      "minimum": 0,
      "description": "Relative weight for multi-entry graphs. If multiple nodes have is_start=true, traffic is split proportionally by entry_weight."
    }
  }
}
```

---

#### 2.7 Edge Definition - Fix `case_id` Description (CRITICAL)

**Current:** "Reference to parent case node ID (for case edges only)"

**This caused confusion - "case node ID" is ambiguous.**

**Update to:**
```json
"case_id": {
  "type": "string",
  "description": "For case edges only: identifies the parent case node. Preferred: use Node.case.id (the semantic experiment identifier). Fallback: if case.id is empty, the system uses Node.uuid. When creating graphs manually, set this to match either the case node's case.id (preferred) or its uuid."
}
```

---

#### 2.8 Edge Definition - Improve `case_variant` Description

**Current:** "Name of the variant this edge represents (for case edges only)"

**Update to:**
```json
"case_variant": {
  "type": "string",
  "maxLength": 128,
  "description": "For case edges only: the variant name this edge represents. Must exactly match one of the variant names in the parent case node's case.variants array."
}
```

---

#### 2.9 Edge Definition - Add Case Edge Semantic Comment

Add a `$comment` to the Edge definition:

```json
"Edge": {
  "type": "object",
  "$comment": "Case edges (from case nodes to variant destinations) have special semantics: (1) case_id should match the parent case node's case.id (preferred) or node.uuid (fallback if case.id is empty), (2) case_variant must match a variant name from case.variants, (3) p.mean should be 1.0 because traffic split is controlled by variant weights not edge probability, (4) there should be exactly one case edge per variant.",
  ...
}
```

---

#### 2.10 Edge Definition - Improve `p` Description

**Current:** "Base probability (fallback when no conditional probabilities match)"

**Update to:**
```json
"p": { 
  "$ref": "#/$defs/ProbabilityParam",
  "description": "Transition probability P(to|from). For normal edges: probability of taking this path (outgoing edges from a node should sum to 1.0 or use residual_behavior). For case edges: should be 1.0 (traffic split controlled by variant weights)."
}
```

---

#### 2.11 Condition Definition - Improve Case Syntax Documentation

**Current examples are good but don't explain the syntax.**

**Update:**
```json
"Condition": {
  "type": "string",
  "pattern": "^(visited|exclude|context|case)\\(",
  "description": "Constraint expression using query DSL syntax. Supported functions: visited(node-id,...) - path must include these nodes; exclude(node-id,...) - path must not include these nodes; context(key:value) - context must match; case(case-id:variant) - must be in this experiment variant where case-id is the Node.case.id value (preferred) or node.uuid (fallback), and variant is the variant name from case.variants.",
  "examples": [
    "visited(promo-viewed,feature-demo)",
    "exclude(cart-abandoned)", 
    "context(device:mobile)",
    "case(checkout-experiment:treatment)",
    "visited(promo-viewed).context(device:mobile)"
  ]
}
```

---

#### 2.12 Metadata Definition - Add `name`

```json
"name": {
  "type": "string",
  "maxLength": 256,
  "description": "Human-readable graph name for display in UI"
}
```

---

#### 2.13 Layout Definition - Already Has `colour`

Verified: `colour` (UK spelling) is already in the schema at line 149. No change needed.

---

#### 2.14 Add Graph-Level Semantic Comment

Add to root schema:

```json
{
  "$comment": "Graph JSON for a conversion funnel DAG. Key semantics: (1) At least one node must have entry.is_start=true; (2) Terminal nodes must have absorbing=true and zero outgoing edges; (3) Outgoing edge probabilities from non-absorbing nodes should sum to 1.0 or use residual_behavior/policies; (4) Case nodes (type='case') split traffic across variants - each variant needs a corresponding case edge with case_id matching case.id (preferred) or node.uuid (fallback), and case_variant matching the variant name; (5) Case edges use p.mean=1.0 because split is controlled by variant weights.",
  ...
}
```

---

**Version:** Bump to `1.1.0` and update `$id` to `conversion-graph-1.1.0.json`.

---

### Phase 3: Align TypeScript Types

**File:** `graph-editor/src/types/index.ts`

Verify/add to ensure 100% match with updated schema:

| Property | Interface | Expected Type | Status |
|----------|-----------|---------------|--------|
| `type` | `GraphNode` | `'normal' \| 'case'` | Verify |
| `colour` | `Layout` (in GraphNode) | `string` | Verify |
| `name` | `Metadata` | `string` | Verify |
| `currentQueryDSL` | `ConversionGraph` | `string` | Verify |

Add JSDoc comments referencing schema version.

---

### Phase 4: Align Python Pydantic Models

**File:** `graph-editor/lib/graph_types.py`

Verify/add to ensure 100% match with updated schema:

| Property | Model | Expected Type | Status |
|----------|-------|---------------|--------|
| `type` | `Node` | `Literal["normal", "case"]` | Check |
| `colour` | `Layout` | `str` with pattern | Check |
| `name` | `Metadata` | `str` | Check |

Update docstring to reference schema version.

---

### Phase 5: Add Comprehensive Consistency Tests

#### TypeScript Tests

**File:** `graph-editor/src/services/__tests__/schemaTypesConsistency.test.ts`

Add tests that:

1. **Validate frontend output:** Parse `sample.json` (created by frontend) against schema
2. **Check property coverage:** Every schema property has corresponding TS type property
3. **Check type coverage:** Every TS type property exists in schema (or is explicitly internal)
4. **Case edge validation:** Verify `case_id` matches either `case.id` or node UUID of a case node
5. **No internal flags:** Ensure `_noHistory` never appears in saved files
6. **Conditional_p structure:** Validate complete structure

```typescript
describe('Frontend output matches schema', () => {
  it('should validate frontend-generated graph against schema', () => {
    // Load sample.json, validate against schema
  });
  
  it('case edges should use node UUID for case_id', () => {
    // Find case edges, verify case_id matches a node UUID
  });
  
  it('should not contain internal flags like _noHistory', () => {
    // Deep search for _noHistory in saved files
  });
  
  it('schema Node properties should match GraphNode type', () => {
    // Compare schema.Node.properties keys with GraphNode interface keys
  });
});
```

#### Python Tests

**File:** `graph-editor/lib/tests/test_schema_python_consistency.py`

Add tests that:

1. **Parse frontend output:** Load `sample.json` with Pydantic models
2. **Round-trip test:** Parse → serialize → parse again should be identical
3. **Property coverage:** Every schema property exists in Pydantic model
4. **Model coverage:** Every Pydantic field exists in schema

---

### Phase 6: Bi-directional Property Check (Optional)

**New file:** `graph-editor/scripts/check-schema-consistency.ts`

Script that programmatically:
1. Parses JSON schema, extracts all properties
2. Parses TypeScript types (via ts-morph or AST)
3. Reports mismatches

Can be run as CI check to prevent future drift.

**Decision needed:** Is this worth the complexity, or are manual tests sufficient?

---

### Phase 7: Regenerate Sample Test Files

Once schema is updated and bugs fixed:

1. Delete existing sample files in `param-registry/test/graphs/`
2. Create new samples through frontend with all features:
   - Normal nodes
   - Case nodes with variants
   - Edges with conditional_p
   - Various handle positions
3. Validate new samples pass all schema tests
4. Commit as golden reference files

---

## Testing Strategy

| Test Type | What it Checks | Where |
|-----------|----------------|-------|
| Schema validation | Sample files are valid per JSON Schema | TS + Py tests |
| TS type coverage | All schema props exist in TS types | TS tests |
| Py model coverage | All schema props exist in Pydantic | Py tests |
| Round-trip | Parse → serialize → parse is idempotent | Py tests |
| Bug regression | No `_noHistory` in output | Both |
| Case edge structure | `case_id` matches case.id or node UUID | Both |
| Conditional_p | Complete structure with query, condition, p | Both |
| **Meta test** | Schema/docs are clear enough for AI to generate valid file | Fresh AI session |

---

## File Changes Summary

| File | Change Type | Phase |
|------|-------------|-------|
| `PropertiesPanel.tsx` | Bug fix (`_noHistory` leak) | 1 |
| `conversion-graph-1.0.0.json` | Schema additions | 2 |
| `types/index.ts` | Verify/add missing properties | 3 |
| `lib/graph_types.py` | Verify/add missing properties | 4 |
| `schemaTypesConsistency.test.ts` | Add comprehensive tests | 5 |
| `test_schema_python_consistency.py` | Add comprehensive tests | 5 |
| `param-registry/test/graphs/*.json` | Regenerate from frontend | 7 |
| `param-registry/test/graphs/ai-generated-*.json` | AI-generated validation file | 8 |

---

## Execution Order

1. **Phase 1:** Fix `_noHistory` bug (immediate, prevents further pollution)
2. **Phase 2:** Update schema (foundation for everything else)
3. **Phase 3:** Align TS types (quick check/update)
4. **Phase 4:** Align Python models (quick check/update)
5. **Phase 5:** Add tests (prevents regression - runs in CI)
6. ~~**Phase 6:** CI script~~ - SKIPPED (tests already run in CI)
7. **Phase 7:** Regenerate samples (clean test data)
8. **Phase 8:** Meta test - fresh AI agent validation (final validation)

---

## Estimated Effort

| Phase | Effort | Risk |
|-------|--------|------|
| 1 - Bug fix | 15 mins | Low |
| 2 - Schema update | 30 mins | Low (no breaking changes) |
| 3 - TS types | 15 mins | Low |
| 4 - Python models | 15 mins | Low |
| 5 - Tests | 1-2 hours | Low |
| ~~6 - CI script~~ | ~~2-4 hours~~ | SKIPPED |
| 7 - Regenerate samples | 30 mins | Low |
| 8 - Meta test | 30 mins | Low (but high signal) |

**Total:** ~3 hours

---

## Open Questions

1. ~~**Schema version bump:**~~ **RESOLVED:** Bump to `1.1.0` (adding new properties is a minor version change)

2. ~~**Backwards compatibility:**~~ **RESOLVED:** Yes, maintain backwards compatibility. Analysis:
   - **SAFE:** Adding new optional properties (`currentQueryDSL`, `type`, `name`) - old files without these remain valid
   - **SAFE:** Relaxing `Id.minLength` from 1 to 0 - old files with non-empty IDs remain valid
   - **SAFE:** Adding `type` enum to Node - if optional with default, old files work
   - **SAFE:** Improved descriptions - documentation only, no structural change
   - **NOT BREAKING:** All changes either ADD optional properties or RELAX constraints
   - **Note:** Old files may have `type: "case"` that would have failed validation against current schema (because `additionalProperties: false` but `type` wasn't defined). After our changes, these files become valid.

3. ~~**Phase 6 CI script:**~~ **RESOLVED:** Skip - tests already run during CI. Phase 5 tests will catch drift automatically.

4. ~~**`colour` vs `color`:**~~ **RESOLVED:** Schema already uses UK spelling (`colour`). No change needed.

---

## Phase 8: Meta Test - AI Agent Validation

**Purpose:** Validate that schema and documentation are sufficiently clear that an AI agent can generate a valid, schema-compliant graph file **without reference to existing samples**.

**When to run:** After all other phases are complete.

**Process:**
1. Start a fresh AI agent session (no conversation history)
2. Provide ONLY the prompt below and access to the schema file
3. AI generates a graph JSON file
4. Validate the generated file against schema
5. Load the file in the frontend and verify it renders correctly

If the AI cannot generate a valid file, our documentation/schema is unclear and needs improvement.

---

### Meta Test Prompt

Copy the following prompt into a fresh AI session:

---

```
You are tasked with creating a sample graph file for DagNet, a conversion funnel modelling tool.

**Schema:** Read the JSON schema at `graph-editor/public/schemas/conversion-graph-1.1.0.json` - this is your ONLY reference for technical requirements. The schema should fully specify all field formats, required properties, valid values, and relationships.

**Your task:** Create a JSON file representing this e-commerce checkout flow:

- Entry point: Landing page (users arrive here)
- Product view page
- An A/B test after product view testing two different cart experiences:
  - "classic" variant: Traditional multi-step cart (50% traffic)
  - "quick" variant: Streamlined quick-add cart (50% traffic)
- Both cart variants lead to a shared Checkout page
- Checkout leads to Payment
- Payment can succeed (Order Confirmed) or fail (Payment Failed)
- Order Confirmed leads to either Shipped or Cancelled
- Shipped leads to either Delivered or Returned
- Include an Abandon terminal - users can abandon at any step before Payment
- A Phone Order path: users can call from Product View and rejoin at Payment
- Add conditional probabilities on some downstream edges showing how conversion differs based on which cart variant the user experienced

**Output:** A complete, schema-valid JSON file.

**You are NOT permitted to refer to ANY other graph samples in the codebase.**
```

---

**Critical note:** The prompt above contains ZERO technical implementation details. If the AI cannot generate a valid file from just the schema and this business description, it indicates **schema deficiencies** that must be fixed in Phases 2-4 before this test can pass.

The schema should fully document:
- UUID format requirements
- Required vs optional fields on nodes/edges
- Case node structure (`type: "case"`, `case` object with variants)
- Case edge requirements (`case_id` should be case.id or node UUID, with fallback chain)
- Conditional probability structure and DSL syntax
- Valid handle values
- Metadata requirements

---

### Expected Outcome

A fresh AI agent should be able to:
1. Read the schema file
2. Understand all field requirements from schema descriptions
3. Generate a valid JSON file without errors
4. The file should load and render correctly in the frontend

### Failure Modes = Schema Deficiencies

Every failure indicates a schema problem to fix:

| Failure | Schema Fix Needed |
|---------|-------------------|
| AI doesn't understand `case_id` fallback | Improve `case_id` description to explain case.id preferred, UUID fallback |
| AI omits `type: "case"` on case node | Add `type` to schema with clear description of when `case` is required |
| AI uses wrong `conditional_p` syntax | Add DSL syntax documentation to `condition` field description |
| AI generates invalid UUIDs | Add `format: uuid` or pattern to UUID fields |
| AI omits required fields | Review `required` arrays in schema definitions |
| AI uses wrong handle values | Verify `enum` on `fromHandle`/`toHandle` is complete |
| Generated file fails schema validation | Schema has structural bugs |
| File loads but doesn't render correctly | Code expects fields not documented in schema |

**The meta test is a litmus test for schema completeness.** If we need to add hints to the prompt, we've failed - fix the schema instead.

---

## Approval

- [ ] Implementation plan reviewed
- [ ] Open questions resolved
- [ ] Ready to proceed with Phase 1

