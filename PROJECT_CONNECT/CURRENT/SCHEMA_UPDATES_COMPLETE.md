# Schema Updates - Phase 1 Complete

**Date:** 2025-11-05  
**Status:** ✅ COMPLETE

---

## Changes Made

### 1. Graph Schema (`conversion-graph-1.0.0.json`)

#### A. Edge Parameters (`ProbabilityParam`)
**Added `data_source` object:**
```json
"data_source": {
  "source_type": "amplitude" | "sheets" | "api" | "manual",
  "connection_settings": "string",  // JSON blob
  "connection_overridden": boolean
}
```

**Deprecated:** `locked` field → Use `mean_overridden` instead

**Location:** Inside `edge.p` object

---

#### B. Cost Parameters (`CostParam`)
**Added same structure:**
- `parameter_id` (optional)
- `data_source` (optional) with same properties as ProbabilityParam
- Override flags: `mean_overridden`, `stdev_overridden`, `distribution_overridden`

**Applies to:** `edge.cost_gbp` and `edge.cost_time`

---

#### C. Case Nodes (`node.case`)
**Added:**
- `node.case.parameter_id` (optional)
- `node.case.data_source` (optional) with:
  - `source_type`: statsig | optimizely | launchdarkly | api | manual
  - `connection_settings`: JSON blob
  - `connection_overridden`: boolean
- `node.case.variants[].weight_overridden` per variant

---

### 2. Parameter Schema (`parameter-schema.yaml`)

**Simplified `connection` object:**

OLD:
```yaml
connection:
  type: amplitude
  config: {object}
  last_sync: date-time
  enabled: boolean
```

NEW:
```yaml
connection:
  source_type: amplitude | sheets | api | manual
  connection_settings: |  # JSON blob (opaque string)
    {"event_from": "...", "credential_ref": "amplitude-prod"}
```

**Already had:** `query_overridden` (no changes needed)

**Updated examples** to use new simplified structure

---

### 3. Case Parameter Schema (`case-parameter-schema.yaml`)

**Replaced `platform` object with `connection`:**

OLD:
```yaml
platform:
  type: statsig | optimizely | launchdarkly
  experiment_id: string
  project_id: string
  api_key_ref: string
```

NEW:
```yaml
connection:
  source_type: statsig | optimizely | launchdarkly | api | manual
  connection_settings: |  # JSON blob
    {"experiment_id": "...", "credential_ref": "statsig-prod"}
```

**Added:** `variants[].weight_overridden` per variant

---

### 4. Sample Files Updated

#### `/param-registry/test/parameters/homepage-to-product.yaml`
- ✅ Added `query_overridden: false`
- ✅ Updated `connection` to simplified structure
- ✅ Moved `data_source` inside each `values[]` entry
- ✅ Added complete `metadata` object with `description_overridden`

#### `/param-registry/test/cases/checkout-redesign.yaml`
- ✅ Updated `connection` to simplified structure  
- ✅ Added `weight_overridden: false` to each variant
- ✅ Updated schema version references

---

## Key Design Decisions

### 1. **Per-Parameter Connection Settings**
Each edge parameter (`p`, `cost_gbp`, `cost_time`) has its own optional `data_source`.

**Why:** Different parameters can use different sources (e.g., probability from Amplitude, cost from Sheets)

---

### 2. **Simplified Connection Structure**
**No explicit config fields** - just `source_type` + opaque JSON blob

**Why:**
- Secrets → `credentials.yaml` (separate file, gitignored)
- Connection Service generates the JSON blob (not UpdateManager)
- Keeps schemas simple and extensible

---

### 3. **All `data_source` Objects Are Optional**
Supports multiple modes:
- **Manual:** No `parameter_id`, no `data_source` (user edits directly)
- **File-backed:** Has `parameter_id`, no `data_source` (pulls from param file)
- **Ad-hoc:** No `parameter_id`, has `data_source` (quick prototyping)
- **Full setup:** Both `parameter_id` and `data_source` (file-backed with connection)

---

### 4. **Bidirectional Override Pattern**
**Query:** Mastered on GRAPH → cached on PARAM FILE
- Graph: `edge.query` (MSMDC auto-generated)
- Param file: `query` + `query_overridden`

**Connection:** Mastered on PARAM FILE → cached/overridden on GRAPH  
- Param file: `connection` object (canonical)
- Graph: `data_source` + `connection_overridden`

---

## Files Modified

### Schema Files:
1. `/graph-editor/public/schemas/schema/conversion-graph-1.0.0.json`
2. `/graph-editor/public/param-schemas/parameter-schema.yaml`
3. `/graph-editor/public/param-schemas/case-parameter-schema.yaml`

### Sample Files:
1. `/param-registry/test/parameters/homepage-to-product.yaml`
2. `/param-registry/test/cases/checkout-redesign.yaml`

**Note:** Other sample files still need updating, but these demonstrate the pattern.

---

## Next Steps

### Immediate (Non-Blocking):
- [ ] Update remaining sample files:
  - `/param-registry/test/parameters/customer-support-cost.yaml`
  - `/param-registry/test/parameters/checkout-duration.yaml`
  - `/param-registry/test/cases/pricing-test.yaml`

### Critical (Blocking for Phase 1):
- [ ] **Properties Panel updates** (see `PHASE_1_PROPERTIES_PANEL_SCHEMA_AUDIT.md`)
  - Fix `locked` → `mean_overridden`
  - Add `edge.label` + `label_overridden`
  - Add `edge.p.evidence` display
  - Add `node.event_id` selector
  - Add override indicators (`<Zap>`/`<ZapOff>`) throughout

---

## Validation

**Schema validation:**
- ✅ All `data_source` objects are optional (not in required arrays)
- ✅ `source_type` is required when `data_source` is present
- ✅ `connection_settings` is optional (some sources might not need it)
- ✅ Consistent structure across ProbabilityParam, CostParam, and Case nodes

**Sample files:**
- ✅ Validate against updated schemas
- ✅ Demonstrate all key features:
  - `query_overridden`
  - Simplified `connection` structure
  - `weight_overridden` on case variants
  - JSON blob for `connection_settings`

---

## Documentation Required

**User-facing docs** (write after UI implementation):
1. `/docs/data-connections/override-pattern.md`
2. `/docs/data-connections/query-sync.md`
3. `/docs/data-connections/connection-settings.md`
4. `/docs/data-connections/update-manager-flow.md`
5. `/docs/data-connections/parameter-files.md`

**See:** `SCHEMA_CHANGES_AND_TODO.md` for details

---

