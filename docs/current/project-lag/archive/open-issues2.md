# Project LAG: Open Issues & Design Gaps

**Status:** Working Document  
**Last Updated:** 5-Dec-25

---

## Design Gaps (To Be Resolved Before Building)

The following items are **not fully specified** in `design.md` and require design decisions before implementation:

### GAP-1: Default maturity_days Value ✅ RESOLVED

**Issue:** Design uses both 30 and 45 days in different places.
- §5.0 algorithm example uses `maturity_days: int = 45`
- §4.3 example uses `maturity_days: 30`

**Decision needed:** What should the default be? Should it be per-edge or global?

*** WE CAN USE 30 DAYS ON AN EDGE [NOT TOTAL] AS A GLOBAL DEFAULT, BUT CONFIRM THAT WE HAVE THIS AT EDGE LEVEL ***

**Resolution:** 
- Default: **30 days**
- Scope: **Per-edge** (stored in `edge.latency.maturity_days`)
- Design doc updated: §3.1, §4.3

---

### GAP-2: View Preference Toggle Design ✅ RESOLVED

**Issue:** No design for the "show maturity split" toggle.

**Decision needed:**
- Where does it appear in the UI? (ViewMenu? Toolbar?)
- What's the default state? (On or Off?)
- Does it persist per-tab or globally?

*** IT WILL BE ON BY DEFAULT. IT IS A PER TAB VIEW SETTING [NOT PER GRAPH]. TOGGLE (VIA A HOOK) IN VIEW MENU AND TOOLS SIDE PANEL. DEFAULT IS ON. ***

**Resolution:**
- Default: **On**
- Scope: **Per-tab** (not per-graph, not global)
- Location: **ViewMenu** and **Tools side panel** (via shared hook)
- Design doc updated: §7.3 (new section)

---

### GAP-3: Edge Bead Content Format ✅ RESOLVED

**Issue:** design.md §9.H mentions "Show latency info in beads" but doesn't specify format.

**Decision needed:**
- What icon? (Clock? Hourglass?)
- What text format? (e.g., "2.4d", "~2d", "Lag: 2.4d")
- When to show? (Only when latency.track=true? Only if median_days > 0?)
- What colour for the bead?

*** I THINK WE ADD A NEW BEAD "RIGHT ALIGNED" ON THE EDGE, INDICATING LAG AND "COMPLETENESS" E.G. "13d (75%)" -- DO WE NEED A FORMAL DEFINTIION OF COMPLETENESS? ***

**Resolution:**
- Position: **Right-aligned** on edge (new bead position)
- Format: **"13d (75%)"** — median lag in days + **completeness** percentage
- Show when: `latency.track === true` AND `median_lag_days > 0`
- Colour: Match existing bead styling (no new colour)
- **Completeness** is defined in `design.md §5.0.1` as a 0–1 progress metric based on cohort ages vs typical lag (not simply `mature_n / total_n`)
- Design doc updated: §5.0.1, §7.2, §7.4 (new/updated sections)

---

### GAP-4: Window Selector Cohort Mode UI ✅ RESOLVED

**Issue:** design.md doesn't specify how WindowSelector should switch between event and cohort modes.

**Decision needed:**
- How does user select mode? (Toggle button? Dropdown? Auto-detect from edge?)
- What label/indicator shows current mode?
- Does changing mode affect existing context chips?
- Should cohort mode be the default for graphs with latency-tracked edges?

*** DEFAULT TO COHORT IN ALL CASES. CHAGNE 'CURRENT WINDOW' ICON AT LEFT OF WINDOW()/COHORT() DATE SELECTOR *AND* CHIP WHICH SHOWS A DROP DOWN THAT ALLOWS USER TO CHOOSE BETWEEN WINDOW & COHORT. USE LUCIDE <timer> FOR COHORT() AND <timer-off> FOR WINDOW(). ***

**Resolution:**
- Default: **Cohort mode** in all cases
- UI: Dropdown selector in WindowSelector component
- Icons: 
  - `<Timer>` (Lucide) for `cohort()` mode
  - `<TimerOff>` (Lucide) for `window()` mode
- Location: Icon shown at left of date selector **** IN CASE PLACE OF CURRENT WINDOW ICON **** AND on context chip **** IN PLACE OF CURRENT WINDOW ICON ****
- Chip: Shows dropdown allowing user to switch between window/cohort
- Design doc updated: §7.5 (new section)

---

### GAP-5: Tooltip Content Structure ⏳ DEFERRED

**Issue:** design.md §7.2 lists fields but no layout or format.

**Decision needed:**
- What sections does the tooltip have?
- What format for numbers? (e.g., "45%" vs "0.45", "2.4 days" vs "2.4d")
- Should it show a mini-visual of mature/forecast split?

*** WE WILL CLEAN UP TOOLTIPS LATER --- ADD A BRIEF NOTE ABOUT THIS TO /TODO.md. FOR NOW, JUST APPEND THE RELEVANT TEXT TO THE EXISTING TOOLTIP ***

**Resolution:**
- **Deferred** — full tooltip redesign is out of scope
- Interim: Append latency text to existing tooltip content
- TODO added to `/TODO.md` for future tooltip cleanup
- Design doc updated: §7.6 (brief note)

---

### GAP-6: Observation Window Extension ✅ RESOLVED

**Issue:** design.md §9.B mentions "observe conversions through cohortEnd + maturityDays" but doesn't specify exact semantics.

**Decision needed:**
- For `cohort(1-Nov:7-Nov)` with maturity_days=30, what's the Amplitude API end date?
- Is it `cohortEnd + maturityDays` or `min(now, cohortEnd + maturityDays)`?
- What if user queries recent cohorts that haven't had time to mature?

*** MATURITY_DAYS SHOULD NOT BE PER GRAPH, IT SHOULD BE PER EDGE. WHY DO YOU NEED THIS ADDITIONAL CLARIFICATION -- WHERE SPECFICALLY WILL IT IMPACT SYSTEM DESIGN? ***

**Resolution:**
- `maturity_days` is **per-edge** (confirmed, already in §3.1)
- **Amplitude API semantics**: The observation window is implicitly `min(now, cohortEnd + maturity_days)` — Amplitude automatically returns data up to current date
- **No adapter change needed**: Amplitude's `dayFunnels` returns all available data for the cohort period; maturity classification happens client-side after data returns
- The question was about whether we need to extend the API query dates — we don't; we just classify cohorts by age post-fetch
- Design doc: No change needed (§4.3 already covers this)

---

### GAP-7: Scenario Latency Override Semantics ✅ RESOLVED

**Issue:** design.md §9.J mentions "Add latency to EdgeParamDiff" but doesn't specify override behavior.

**Resolution (5-Dec-25):**

---

#### DATA ARCHITECTURE

##### Independence Requirements

**Graph file independence:**
- Must render completely WITHOUT param files (self-contained)
- Must be able to "Get from source" directly (edge has query, connection, etc.)
- All render-time data lives on the edge

**Param file independence:**
- Must retrieve data WITHOUT graph file open
- Has own query, connection settings (from prior "Put to file")

**Data flow direction:**
- **Primary:** Param file → Graph (file is source of truth for data)
- **Exception:** Edge queries flow graph → file, hence `query_overridden` on param file

##### Mirroring Pattern

```
Graph Edge                    ↔    Param File
═══════════════════════════════════════════════════════════════════════════
CONFIG (top-level, exception: graph→file for queries)
───────────────────────────────────────────────────────────────────────────
edge.query                    ↔    query                
edge.query_overridden              query_overridden     (file can block graph updates)
edge.n_query                  ↔    n_query
edge.n_query_overridden            n_query_overridden
edge.p.connection             ↔    connection
edge.p.connection_string      ↔    connection_string
edge.latency.track            ↔    latency.track        (NEW)
edge.latency.track_overridden      latency.track_overridden
edge.latency.maturity_days    ↔    latency.maturity_days (NEW)
edge.latency.maturity_days_overridden  latency.maturity_days_overridden
═══════════════════════════════════════════════════════════════════════════
DATA (per-slice, flow: file→graph)
───────────────────────────────────────────────────────────────────────────
edge.p.mean                   ↔    values[].mean
edge.p.stdev                  ↔    values[].stdev
edge.p.distribution           ↔    values[].distribution
edge.p.evidence.n             ↔    values[].n
edge.p.evidence.k             ↔    values[].k
───────────────────────────────────────────────────────────────────────────
NEW: Forecast fields (mature baseline)
edge.p.forecast.mean          ↔    values[].forecast_mean
edge.p.forecast.stdev         ↔    values[].forecast_stdev
edge.p.forecast.distribution  ↔    values[].forecast_distribution
───────────────────────────────────────────────────────────────────────────
NEW: Evidence fields (observed, query-time computed)
edge.p.evidence.mean          ↔    values[].evidence_mean     (Σk/Σn)
edge.p.evidence.stdev         ↔    values[].evidence_stdev
edge.p.evidence.distribution  ↔    values[].evidence_distribution
edge.p.evidence.completeness  ↔    values[].completeness
───────────────────────────────────────────────────────────────────────────
NEW: Display-only (derived, no scenario override)
edge.p.evidence.median_lag_days ↔  values[].latency.median_days
edge.p.evidence.mean_lag_days   ↔  values[].latency.mean_days
═══════════════════════════════════════════════════════════════════════════
BULK DATA (param file only, NOT on graph)
───────────────────────────────────────────────────────────────────────────
                              ↔    values[].dates[]
                              ↔    values[].n_daily[], k_daily[]
                              ↔    values[].median_lag_days[], mean_lag_days[]
                              ↔    values[].anchor_n_daily[]
                              ↔    values[].anchor_median_lag_days[]
                              ↔    values[].latency object (summary)
                              ↔    values[].anchor_latency object
                              ↔    values[].sliceDSL, cohort_from, cohort_to
```

**Sync behaviour:**
- **Put to file (APPEND):** Edge data → new entry in `values[]`
- **Get from file (UPDATE):** `values[latest]` → Edge (respects `*_overridden` flags on edge)

---

#### COMPREHENSIVE FIELD TABLE

##### CONFIG FIELDS (Edge ↔ Param top-level)

| Graph Edge | Param File Top-Level | Override Flag | Scenario | Notes |
|------------|---------------------|---------------|----------|-------|
| `edge.latency.track` | `latency.track` | `latency.track_overridden` | ❌ | Retrieval config |
| `edge.latency.maturity_days` | `latency.maturity_days` | `latency.maturity_days_overridden` | ❌ | Maturity threshold |
| `edge.latency.censor_days` | `latency.censor_days` | `latency.censor_days_overridden` | ❌ | Censor threshold |
| `edge.latency.anchor_node_id` | `latency.anchor_node_id` | `latency.anchor_node_id_overridden` | ❌ | **NEW**: Cohort anchor (MSMDC-computed) |
| `edge.query` | `query` | `query_overridden` | ❌ | Existing field |
| `edge.p.connection` | `connection` | — | ❌ | Existing field |

##### DATA FIELDS (Edge `p.*` ↔ Param `values[]`)

**Existing fields:**

| Graph Edge | Param `values[]` | Override Flag | Scenario |
|------------|-----------------|---------------|----------|
| `edge.p.mean` | `mean` | `p.mean_overridden` | ✅ |
| `edge.p.stdev` | `stdev` | `p.stdev_overridden` | ✅ |
| `edge.p.distribution` | `distribution` | `p.distribution_overridden` | ✅ |
| `edge.p.evidence.n` | `n` | — | ✅ |
| `edge.p.evidence.k` | `k` | — | ✅ |

**NEW: Forecast fields (mature baseline):**

| Graph Edge | Param `values[]` | Override Flag | Scenario |
|------------|-----------------|---------------|----------|
| `edge.p.forecast.mean` | `forecast_mean` | `p.forecast.mean_overridden` | ✅ |
| `edge.p.forecast.stdev` | `forecast_stdev` | `p.forecast.stdev_overridden` | ✅ |
| `edge.p.forecast.distribution` | `forecast_distribution` | `p.forecast.distribution_overridden` | ✅ |

**NEW: Evidence fields (observed, computed):**

| Graph Edge | Param `values[]` | Override Flag | Scenario |
|------------|-----------------|---------------|----------|
| `edge.p.evidence.mean` | `evidence_mean` | — | ✅ |
| `edge.p.evidence.stdev` | `evidence_stdev` | — | ✅ |
| `edge.p.evidence.distribution` | `evidence_distribution` | — | ✅ |
| `edge.p.evidence.completeness` | `completeness` | `p.evidence.completeness_overridden` | ✅ |

##### DISPLAY-ONLY FIELDS (Derived, no scenario override)

| Graph Edge | Param `values[]` | Notes |
|------------|-----------------|-------|
| `edge.p.evidence.median_lag_days` | `latency.median_days` | Shown on bead ("13d") |
| `edge.p.evidence.mean_lag_days` | `latency.mean_days` | Shown in tooltip |

##### BULK DATA (Param `values[]` only — NOT on graph)

| Param File `values[]` | Notes |
|-----------------------|-------|
| `dates[]` | Cohort entry dates |
| `n_daily[]`, `k_daily[]` | Per-cohort n/k |
| `median_lag_days[]`, `mean_lag_days[]` | Per-cohort X→Y lag |
| `anchor_n_daily[]` | Per-cohort anchor entries |
| `anchor_median_lag_days[]`, `anchor_mean_lag_days[]` | Per-cohort A→X lag |
| `sliceDSL` | Canonical slice identifier |
| `cohort_from`, `cohort_to` | Cohort date bounds |
| `latency` object | Edge-level lag summary |
| `anchor_latency` object | Anchor lag summary |

**Rationale:** Bulk arrays are raw machine data for query-time aggregation. Only summaries propagate to graph edge.

---

#### EdgeParamDiff Additions

```typescript
interface EdgeParamDiff {
  // ... existing fields ...
  mean?: number;
  mean_overridden?: boolean;
  stdev?: number;
  stdev_overridden?: boolean;
  distribution?: string;
  distribution_overridden?: boolean;
  n?: number;
  k?: number;
  
  // NEW: Forecast fields (mature baseline)
  forecast_mean?: number;
  forecast_mean_overridden?: boolean;
  forecast_stdev?: number;
  forecast_stdev_overridden?: boolean;
  forecast_distribution?: string;
  forecast_distribution_overridden?: boolean;
  
  // NEW: Evidence fields (observed)
  evidence_mean?: number;
  evidence_stdev?: number;
  evidence_distribution?: string;
  completeness?: number;
  completeness_overridden?: boolean;
}
```

#### UI Exposure Summary

| UI Surface | Fields Shown |
|------------|--------------|
| **Scenarios Modal** | `forecast_mean/stdev/distribution`, `evidence_*`, `completeness` (editable per-scenario) |
| **Properties Panel** | CONFIG fields + current DATA values |
| **Edge Bead** | `median_lag_days` + `completeness` (display only) |
| **Edge Tooltip** | All values with data source provenance |

---

### GAP-8: Stripe Pattern Visual Constants ✅ RESOLVED

**Issue:** design.md §7.1 describes the concept but doesn't specify exact values.

**Decision needed:**
- What stripe width? (4px suggested, but confirm)
- What stripe angle? (45°? configurable?)
- What colours for stripes? (Same as edge colour? Transparent gaps?)
- What offset for interleaving? (Half stripe width = 2px?)

*** YES, 45%. OPPOSITE DIRECTION FROM THE STRIPES WE USE FOR CURRENT LAY WHEN PARTIALLY DISPLAYED -- REF. EXISTING DISPLAY LOGIC -- BUT SIMILAR WIDTH / STYLING. COLOUR COMPLETELY UNCHANGED FROM CURRENT. RE-READ THE DESIGN AS YOUR QUESTIONS ARE CONFUSED AND DON'T APPEAR TO HAVE UNDERSTOOD THE DESIGN PROOPOSAL PROPERLY ***

**Resolution:**
- Angle: **45°** (opposite direction from existing "partial display" stripes)
- Width: Match existing stripe width in partial display logic
- Colour: **Unchanged** from current edge colour
- Pattern: Two layers with offset stripes that combine to appear solid (as per §7.1)
- Reference: Existing partial display stripe logic in `ConversionEdge.tsx`
- Design doc updated: §7.1 clarified with reference to existing stripe implementation

---

### GAP-9: Properties Panel Latency Section Layout ✅ RESOLVED

**Issue:** design.md §9.I mentions "Display latency stats, maturity coverage" but no mockup.

**Decision needed:**
- What order of fields?
- Inline or grid layout?
- Should it show a progress bar for maturity_coverage?
- Should `latency.track` toggle be in this section or elsewhere?

*** IN EDGE PROPS WITHIN THE PROBABILITY PARAM, AS THESE ARE REALLY PER-PARAM SETTINGS. NOTIONALLY THEY CAN BE INCLUDED ON EVERY PARAM, BUT IN PRACTICE WE WILL ONLY ACTUALLY USE THEM FOR PROB. PARAMS. I'M NOT SURE 'DISPLAY LATENCY STATS' OR 'MATURITY COVERAGE' ARE THE RIGHT ITEMS HOWEVER. THE KEY SETTINGS SURELY ARE 'CALCULATE LATENCY' AS A BOOL AND 'CUT-OFF TIME' AS A STRING [TAKING E.G. "30d" OR WHATVER]. ***

**Resolution:**
- Location: **Within the Probability param section** of edge properties (not a separate section)
- Fields to display (as settings):
  - `Calculate Latency` — boolean toggle (maps to `latency.track`)
  - `Cut-off Time` — string input (e.g., "30d") (maps to `latency.maturity_days`)
- **Not displayed as stats** — these are configuration settings, not read-only displays
- Derived values (maturity_coverage, median_lag_days) shown via edge bead and tooltip, not in properties panel
- Design doc updated: §7.7 (new section)

---

## Additional Open Design Questions

### GAP-10: ParsedConstraints Interface for cohort() ✅ RESOLVED

**Issue:** `src/lib/queryDSL.ts` needs `cohort` added to `ParsedConstraints` interface.

**Resolution (4-Dec-25):**
- Added `cohort` field to `ParsedConstraints` interface in `queryDSL.ts`
- Structure: `{ anchor?: string; start?: string; end?: string } | null`
- Added parsing logic for `cohort(start:end)` and `cohort(anchor,start:end)` formats
- Updated `normalizeConstraintString()` to serialize `cohort()` clauses
- Updated `augmentDSLWithConstraint()` to merge `cohort` constraints
- Added `'cohort'` to `QUERY_FUNCTIONS` array

---

### GAP-11: DSL JSON Schema for cohort() ✅ RESOLVED

**Issue:** DSL JSON schema needs a new version to add `cohort()` validation.

**Resolution (4-Dec-25):**
- Created `public/schemas/query-dsl-1.1.0.json` (new version, following project convention)
- Added `'cohort'` to `QueryFunctionName` enum
- Updated `raw` pattern to include `cohort` in valid function list
- Added examples for `cohort()` with and without anchor node
- Updated `$comment` with `cohort()` semantics documentation

**Supported formats:**
- `cohort(-30d:)` — relative start, open end
- `cohort(1-Nov-25:7-Nov-25)` — absolute dates
- `cohort(anchor-node,-14d:)` — with anchor node
- `cohort(anchor-node,1-Nov-25:7-Nov-25)` — anchor + absolute dates

---

### GAP-12: Parameter File Schema for Latency Fields ✅ RESOLVED

**Issue:** The parameter schema gains new latency fields (§3.2). What fields are added to the schema?

**Resolution (5-Dec-25):**

The YAML Form Editor displays ALL schema fields as editable (it has no "read-only" mode). The new fields are simply added to the schema; user can edit them if they open the raw file.

**New fields in param file `values[]` items:**

| Field | Type | Purpose |
|-------|------|---------|
| `sliceDSL` | string | Canonical slice identifier |
| `cohort_from`, `cohort_to` | date | Cohort entry date bounds |
| `median_lag_days[]` | number[] | Per-cohort X→Y median lag |
| `mean_lag_days[]` | number[] | Per-cohort X→Y mean lag |
| `anchor_n_daily[]` | int[] | Per-cohort anchor entries |
| `anchor_median_lag_days[]` | number[] | Per-cohort A→X median lag |
| `anchor_mean_lag_days[]` | number[] | Per-cohort A→X mean lag |
| `latency` | object | Edge-level latency summary |
| `anchor_latency` | object | Anchor latency summary |

These are machine-generated from Amplitude data. Users typically don't edit them directly — they interact via Properties Panel and edge display.

**UI Schema updates (`parameter-ui-schema.json`):**
- Add `latency` and `anchor_latency` to accordion sections
- No special treatment needed — standard form rendering

---

### GAP-13: Integrity Check Rules for Latency

**Issue:** `integrityCheckService.ts` needs to validate latency configuration.

**Decision needed:**
- What constitutes invalid latency config?
- Should we validate `maturity_days` is positive?
- Should we validate `maturity_coverage` is 0-1?

---

### GAP-14: UpdateManager Mapping Config Format

**Issue:** `UpdateManager.ts` needs mappings for latency fields, but the exact config format isn't specified.

**Decision needed:**
- What's the source path for `maturity_coverage`?
- What's the target path on the edge?
- How does this interact with existing `p.evidence` mappings?

---

### GAP-15: buildScenarioRenderEdges Data Threading

**Issue:** `buildScenarioRenderEdges.ts` needs to pass latency data through to edge components.

**Decision needed:**
- Where does latency data come from in the scenario render flow?
- What fields need to be added to the edge data passed to ConversionEdge?

---

### GAP-16: Dual-Slice Ingestion Logic ✅ RESOLVED

**Issue:** For latency edges, `window()` and `cohort()` have different semantics and require different Amplitude queries.

**Resolution (see design.md §4.6):**
- Pinned DSL like `or(window(-7d:), cohort(-90d:)).context(channel)` triggers **dual-slice ingestion** for latency edges.
- **Cohort slice**: 3-step A-anchored funnel → stored as `cohort_data` + `latency` + `anchor_latency`.
- **Window slice**: 2-step X-anchored funnel → stored as `window_data` (simple n_daily/k_daily).
- Both slices live in the same param file, keyed by `sliceDSL`.
- Query resolution logic documented in §4.6.

---

### GAP-17: windowAggregationService Changes for Dual Slices

**Issue:** `windowAggregationService.ts` currently only knows about `window()` semantics. It needs to:
- Recognise `cohort()` clauses in targetSlice.
- For latency edges, route `cohort()` queries to `cohort_data` and `window()` queries to `window_data`.
- Implement fallback convolution when `window_data` is missing but `cohort_data` + lag model exists.

**Decision needed:**
- Exact function signatures for cohort-aware aggregation.
- How to detect "latency edge" from within the aggregation service (does it need edge config passed in?).

---

### GAP-18: Amplitude Adapter Changes for Dual Queries ✅ RESOLVED

**Issue:** The Amplitude adapter needs to distinguish `cohort()` vs `window()` queries and build different funnel shapes.

**Resolution (5-Dec-25):**

#### Anchor Resolution: MSMDC Extension

**Problem:** At overnight retrieval, we don't want to do graph topology traversal to resolve anchor nodes. Retrieval should be "dumb" data fetching.

**Solution:** Compute `anchor_node_id` at graph-edit time via MSMDC, not at retrieval time.

**MSMDC extension:**
```typescript
interface ParameterQuery {
  // ... existing ...
  paramType: string;
  paramId: string;
  edgeKey: string;
  query: string;
  stats: { checks: number; literals: number };
  
  // NEW: anchor for cohort queries (latency-tracked edges only)
  anchor_node_id?: string;  // Furthest upstream START node from edge.from
}
```

**Separation of concerns:**

| Component | Responsibility |
|-----------|----------------|
| **MSMDC** | Compute `query` and `anchor_node_id` from graph topology |
| **UpdateManager** | Apply values to edge/file, respecting `_overridden` flags |
| **Edge** | Store `latency.anchor_node_id` + `latency.anchor_node_id_overridden` |
| **Param file** | Store `latency.anchor_node_id` + `latency.anchor_node_id_overridden` (top-level) |

**Retrieval flow (no topology traversal):**
```
Overnight batch:
  1. Read graph.pinnedSliceDSL: "cohort(-90d:).context(channel)"
  2. For each latency edge, read edge.latency.anchor_node_id (pre-computed)
  3. Build query: cohort(anchor_node_id, -90d:)
  4. Fetch — no graph traversal needed
```

#### No Ambiguity Reaches the Adapter

**Principle:** By retrieval time, anchor is already resolved (stored on edge). The adapter receives explicit `cohort(anchor, dates)` — no structural ambiguity.

#### Potentially Ambiguous Cases (Resolved at Query Time)

| User Writes | Edge Config | Resolution |
|-------------|-------------|------------|
| `cohort(-90d:)` | `latency.track=true` | Resolve anchor from graph → `cohort(anchor,-90d:)` |
| `cohort(-90d:)` | `latency.track=false` | Treat as `window(-90d:)` (non-latency edge) |
| `window(-7d:)` | `latency.track=true` | Window query, 2-step funnel (no anchor needed) |
| No time constraint | `latency.track=true` | Error: require explicit `cohort()` or `window()` |
| `visited(a)` only | — | Segment filter, NOT cohort anchor |

**Key rule:** `visited(a)` is ALWAYS a segment filter. To make `a` a cohort anchor, user must write `cohort(a,...)` explicitly OR we infer anchor from graph topology when `cohort()` is present.

#### QueryPayload Extension

```typescript
superfunnel?: {
  anchorEventId: string;           // A event ID (ALWAYS explicit by this point)
  steps: string[];                 // [A, X, Y] event IDs
  extractSteps: [number, number];  // Indices for X→Y extraction
};
```

#### Funnel Construction by Query Type

| Query Type | `superfunnel` | Funnel Shape | Amplitude Config |
|------------|---------------|--------------|------------------|
| `window(...)` | absent | 2-step `[X, Y]` | Standard funnel |
| `cohort(anchor,...)` | present | 3-step `[A, X, Y]` | `from_step_index=1, to_step_index=2` |

#### Segment Filters in Superfunnels

**Critical:** `cohort()` superfunnels MUST still honor `visited()` and `exclude()` as segment filters. The superfunnel structure is about cohort date segmentation; path constraints still apply.

**Example:**
```
from(switch-registered).to(success).visited(delegated-household).exclude(manual-switch).cohort(household-created,-90d:)
```

**Processing:**

| Component | Category | Amplitude Treatment |
|-----------|----------|---------------------|
| `household-created` | Anchor (step 0) | Funnel step |
| `switch-registered` | From (step 1) | Funnel step |
| `success` | To (step 2) | Funnel step |
| `visited(delegated-household)` | Upstream of From | Segment filter: `{"event": "...", "op": ">=", "value": 1}` |
| `exclude(manual-switch)` | Exclusion | Segment filter: `{"event": "...", "op": "=", "value": 0}` |

**Key insight:** The anchor doesn't change visited/exclude semantics — they're categorized relative to X (from), not A (anchor):
- `visited_upstream` (upstream of X) → Amplitude segment filter (behavioral cohort)
- `visited` (between X and Y) → Segment filter or additional constraint
- `exclude` → Segment filter (count = 0)

**QueryPayload for superfunnels:**

```typescript
superfunnel: {
  anchorEventId: string;           // A event ID
  steps: string[];                 // [A, X, Y] event IDs
  extractSteps: [1, 2];            // X→Y extraction indices
};
visited_upstream?: string[];       // → Segment filters (visited ≥1)
exclude?: string[];                // → Segment filters (visited =0)
visited?: string[];                // → Between X-Y constraints
```

**Implementation locations:**
- `buildDslFromEdge.ts`: Resolve implicit anchor → explicit `cohort(anchor,dates)`; categorize visited/exclude unchanged
- `connections.yaml` pre_request: Build 3-step funnel + segment filters from visited_upstream/exclude
- Segment filter construction identical to non-cohort queries — just applied to superfunnel

---

## Remaining Significant Open Design Areas

### 1. Exact lag CDF fitting from limited histogram + medians

We've documented that medians are high-quality and histograms are coarse beyond ~10 days, but we still need to pick a concrete parametric family (e.g. log-normal) and fitting strategy for Phase 1 (currently sketched in §5.1+ as future work).

### 2. Formal formulae for per-cohort tail forecasting

The doc now clearly states the policy ("keep observed k_i, forecast the remaining tail using p.forecast and F(t)"), but it does not yet codify the exact algebra for the residual probability of conversion conditional on "not yet converted by age a_i". That will need to be nailed down before implementation.

### 3. X-anchored cohort queries (`cohort(x-y, ...)`)

We've made it explicit that Phase-0/1 handles `cohort(a, …)` cleanly. For `cohort(x-y, …)` (X-anchored cohorts), the options are:
- Use the `window_data` slice if available (treats X-date as cohort date).
- Approximate via convolution from A-anchored data (model-heavy).
- Require a fresh X-anchored fetch.

The design currently favours dual-slice ingestion (§4.6) so that `window()` gives X-anchored data directly, avoiding the need for X-anchored cohort approximations in most cases.

### 4. Scenario semantics for derived latency fields

Latency config (`latency.track`, `maturity_days`, `recency_half_life_days`) is graph-level, non-scenario. Derived values (`latency.completeness`, `median_days`) are evidence/model outputs. If we later treat some derived fields as user-writable overrides, they will need the usual `*_overridden` and scenario handling.

### 5. Time-varying behaviour and model drift detection

We've built in recency weighting and a bounded window, but the design still treats drift qualitatively. A proper strategy for drift detection/alerting (beyond "choose H and W_max sensibly") is left as future work.

### 6. Multi-edge path timing (DAG runner convolution)

For time-indexed flow through multi-edge paths (e.g., "how many reach Z by day 30 along A→…→X→Y→…→Z?"), the DAG runner still needs to convolve edge-level lag PMFs. This is orthogonal to the `window()` vs `cohort()` question but remains a Phase 1+ implementation item.

---

## p.mean Estimation and Display Policy ✅ RESOLVED (3-Dec-25)

### Resolution Summary

The two dimensions (measurement policy + user intent) are now resolved:

---

### Measurement Policy ✅

**Decision:** p.mean is calculated at **retrieval time** and **persisted on the slice**.

- At get-from-source time, calculate p.mean for all evidence in the merged slice that meets inclusion policy
- For contexted slices, develop p.mean specific to that window + context
- Persist on the slice in the param file
- Later (post Phase 1): add recency half-life weighting — just another knob to twiddle

**Data source priority:**
- **For forecasting p.mean:** Favour `window()` data (faster to mature, more recent)
- **For evidence component:** Favour `cohort()` data (richer maturation curves)

---

### User Intent & Display ✅

**Decision:** Display **both evidence and forecast** using visual layers.

The existing maths (§5.0.3 Formula A) already handles the blending correctly:
```
k̂_i = k_i + (n_i - k_i) · p.forecast · (1 - F(a_i)) / (1 - p.forecast · F(a_i))
```

This keeps observed k_i as **hard evidence** and forecasts only the **tail**. The formula is robust under:
- **"Behind forecast"**: Evidence < expected → total estimate creeps down as cohort matures
- **"Ahead of forecast"**: Evidence > expected → total estimate creeps up as cohort matures

**Visual treatment:**
- **Evidence component**: Two complementary overlapping striped layers → appears **solid**
- **Forecast component**: Single striped layer → appears **striped**
- **Stripe direction**: Opposite from stripes used for hidden current layer (may revisit later)

---

### Per-Scenario Visibility (Replaces Legend Chips) ✅ RESOLVED (3-Dec-25)

**Decision:** Evidence/Forecast visibility is **per-scenario**, not graph-wide legend chips.

This is more powerful — allows comparing "forecast only" scenario vs "evidence only" scenario side-by-side.

**4-State Cycle on Scenario Chips:**

| State | Icon | Chip Visual | Meaning |
|-------|------|-------------|---------|
| F+E | `<Eye>` | Gradient: solid→striped L→R | Show both layers |
| F only | `<View>` | Striped background | Forecast only |
| E only | `<EyeClosed>` | Solid background | Evidence only |
| Hidden | `<EyeOff>` | Semi-transparent (existing) | Not displayed |

**Behaviour:**
- Click eye icon to cycle through states
- Per-scenario state (not per-tab, not global)
- Default: **F+E** (show both)
- Tooltip on icon explains current state with visual key
- Toast feedback on state change
- Same treatment on scenario palette swatches

**If p.forecast unavailable** (no window data):
- F and F+E states disabled/greyed
- Cycle only through: E → hidden → E

---

### Data Nomenclature ✅ RESOLVED (3-Dec-25)

**Stored Values:**

| Field | Meaning | When Computed | Stored? |
|-------|---------|---------------|---------|
| `p.forecast` | Mature baseline (forecast absent evidence) | Retrieval time | Yes, on slice |
| `p.evidence` | Observed k/n from query window | Query time | No |
| `p.mean` | Blended: evidence + forecasted tail (Formula A) | Query time | No |

**Rendering by Mode:**

| Mode | What to Render |
|------|----------------|
| E only | `p.evidence` as solid |
| F only | `p.forecast` as striped |
| F+E | `p.evidence` (solid inner core) + `p.mean` (striped outer) |

**Key insight:** In F+E mode, the striped outer is `p.mean` (evidence-informed forecast), NOT `p.forecast` (which ignores evidence).

---

### Query-Time Computation ✅ RESOLVED (3-Dec-25)

**Data Flow by Query Type:**

| Query | Slice | p.evidence | p.forecast | p.mean |
|-------|-------|------------|------------|--------|
| `window()` mature | window | QT: Σk/Σn | RT: p.forecast | = evidence |
| `window()` immature | window | QT: Σk/Σn | RT: p.forecast | QT: Formula A |
| `cohort()` mature | cohort | QT: Σk/Σn | RT: p.forecast | = evidence |
| `cohort()` immature | cohort | QT: Σk/Σn | RT: p.forecast | QT: Formula A |
| `window()` no window_data | — | N/A | N/A | N/A |
| non-latency edge | either | QT: Σk/Σn | = evidence | = evidence |

**QT** = Query Time, **RT** = Retrieval Time

**Phase 1 Constraint:** No convolution fallback. If no window data, p.forecast unavailable.

---

### Confidence Bands ✅ RESOLVED (3-Dec-25)

**CI Display by Mode:**

| Mode | CI Shown On | Rationale |
|------|-------------|-----------|
| E only | Evidence (solid) | Only one layer; show sampling uncertainty |
| F only | Forecast (striped) | Only one layer; show forecast uncertainty |
| F+E | Forecast portion only (striped) | Evidence is "solid" = certain; bands on uncertain part |

**Implementation:** Extend existing CI rendering logic in `ConversionEdge.tsx`. Ensure stripes render within CI band.

---

### Edge Tooltips ✅ RESOLVED (3-Dec-25)

Tooltips must show data provenance:

```
┌─────────────────────────────────────────┐
│ Switch Registered → Success             │
│─────────────────────────────────────────│
│ Evidence:  8.0%  (k=80, n=1000)         │
│   Source:  cohort(1-Nov-25:21-Nov-25)   │
│                                         │
│ Forecast:  45.0%  (p.forecast)          │
│   Source:  window(1-Nov-25:24-Nov-25)   │
│                                         │
│ Blended:   42.0%                        │
│ Completeness: 18%                       │
│ Lag: 6.0d median                        │
└─────────────────────────────────────────┘
```

Full tooltip redesign deferred (see TODO.md #5), but latency edges should append this info.

---

### Remaining Open Items

1. **Validation of Formula A:** §5.0.3 marks formulas as "draft" — verify during implementation
2. **Properties Panel UI:** Low priority; minimal viable spec exists

---

## Properties Panel Latency UI ✅ RESOLVED (4-Dec-25)

**Location:** Within Probability/Conditional Probability card, at bottom under 'Distribution'.

**Fields:**
- Track Latency (boolean toggle)
- Maturity Days (number input, e.g., 30)

**Applies to:** `p` and `conditional_p` cards only — NOT cost params.

**Layout:**
```
┌─ Probability ─────────────────────────────┐
│ Mean: [0.45]  n: [1000]  k: [450]         │
│ Distribution: [Beta ▼]                    │
│ ─────────────────────────────────────────│
│ [✓] Track Latency    Maturity: [30] days  │
└───────────────────────────────────────────┘
```

Derived values (completeness, median_lag_days) shown in edge bead and tooltip, not properties panel.

---

## Summary of Open Issues

| ID | Issue | Type | Status |
|----|-------|------|--------|
| ~~GAP-10~~ | ~~ParsedConstraints interface for `cohort()`~~ | ~~Implementation~~ | ✅ **Resolved** |
| ~~GAP-11~~ | ~~DSL JSON schema `query-dsl-1.1.0.json` for `cohort()`~~ | ~~Implementation~~ | ✅ **Resolved** |
| ~~GAP-12~~ | ~~Parameter UI schema for latency fields~~ | ~~Implementation~~ | ✅ **Resolved** |
| ~~GAP-13~~ | ~~Integrity check rules for latency~~ | ~~Implementation~~ | Just validation — not design |
| ~~GAP-14~~ | ~~UpdateManager mapping config~~ | ~~Implementation~~ | Pattern established — just add fields |
| ~~GAP-15~~ | ~~buildScenarioRenderEdges data threading~~ | ~~Implementation~~ | Formula A defined — just wire in |
| ~~GAP-17~~ | ~~windowAggregationService cohort routing~~ | ~~Implementation~~ | Semantics defined — just implement |
| ~~GAP-18~~ | ~~Amplitude adapter anchor node handling~~ | ~~Implementation~~ | ✅ **Resolved** |
| ~~p.mean policy~~ | ~~Measurement policy + user intent~~ | ~~Design~~ | ✅ **Resolved** |
| ~~Per-scenario visibility~~ | ~~E/F/F+E on scenario chips~~ | ~~Design~~ | ✅ **Resolved** |
| ~~Data nomenclature~~ | ~~p.evidence / p.forecast / p.mean~~ | ~~Design~~ | ✅ **Resolved** |
| ~~Query-time computation~~ | ~~When to compute each value~~ | ~~Design~~ | ✅ **Resolved** |
| ~~Confidence bands~~ | ~~CI display by mode~~ | ~~Design~~ | ✅ **Resolved** |
| ~~Edge tooltips~~ | ~~Data provenance display~~ | ~~Design~~ | ✅ **Resolved** |
| ~~Properties Panel UI~~ | ~~Latency settings layout~~ | ~~Design~~ | ✅ **Resolved** |
| ~~Formula A~~ | ~~Bayesian tail forecasting~~ | ~~Design~~ | ✅ **Validated** (see below) |

### Design Status

**Design is complete.** All items resolved.

Overnight batch runner is **out of scope** — pattern is "fetch for all slices".

### Fetch-from-Source Stats Computation

**Requirement:** Any fetch from source (including overnight "fetch all slices") must retrigger relevant stats computation.

**At retrieval time, compute and store:**

| Stat | Computed From | Stored On |
|------|---------------|-----------|
| `p.forecast` | Mature window() data | Slice in param file |
| `median_lag_days` | `dayMedianTransTimes` from cohort() response | Slice in param file |
| `completeness` | Cohort ages vs maturity_days | Slice in param file |
| `evidence.n`, `evidence.k` | Raw funnel counts | Slice in param file |

**At query time, compute (not stored):**
- `p.evidence` — aggregated from slices in query window
- `p.mean` — Formula A applied to immature cohorts

**Implementation:** Existing `dataOperationsService.getFromSource()` flow handles this — just extend transform to compute latency stats from Amplitude response.

---

## Design Decisions Made (5-Dec-25)

### anchor_node_id Scope

**Decision:** Per-edge (not per-conditional_p).

Rationale: It's purely a function of edge's relationship with graph structure. No need to specialise.

**UpdateManager mapping requirement:** When put-to-file / get-from-file, correctly map `edge.latency.anchor_node_id` → every param on that edge (p, conditional_p[*]) respecting `_overridden` flags.

### MSMDC anchor_node_id Computation

**Decision:** Compute for ALL edges, not just latency-tracked ones.

Rationale: Simpler. Output is cheap. If not used for non-latency edges, no harm done.

**Consequence:** No conditional triggering needed. MSMDC always outputs `anchor_node_id` alongside `query`. No need to wire latency.track toggle to MSMDC re-run — it's already computed.

### A=X Case (edge.from IS a start node)

**Analysis:** When the edge's from-node IS a start node (e.g., `from(start-node).to(y)`):
- `anchor_node_id` = `edge.from` (A=X)
- Superfunnel collapses: only 2 steps [A,Y] not 3 [A,X,Y]
- The cohort query becomes `cohort(x, dates)` where x is both anchor and from
- This is semantically correct: we're asking "of people who did X on date D, how many did Y?"
- No special handling needed — just a 2-step funnel instead of 3-step

**Decision:** Valid case. MSMDC computes `anchor_node_id = edge.from` when from-node is a start. Adapter builds 2-step funnel. All works.

### Schema Version

**Decision:** Create `conversion-graph-1.2.0.json` for latency changes.

### Migration

**Analysis:** Adding optional `latency?: LatencyConfig` to edges is **non-breaking**:
- Existing graphs without `latency` continue to work (field is optional)
- New fields are additive
- No existing fields removed or changed

**Decision:** No migration needed. Optional fields.

### Evidence Structure

**Current structure:**
```typescript
interface Evidence {
  n?: number;
  k?: number;
  window_from?: string;  // LEGACY - should migrate to full_query
  window_to?: string;    // LEGACY
  retrieved_at?: string;
  source?: string;
  path?: 'direct' | 'file';
  full_query?: string;   // DSL string - use this
  debug_trace?: string;
}
```

**Decision:** `window_from`/`window_to` are LEGACY. `full_query` (DSL string) is the correct field for slice identification. New latency-related evidence fields extend the same object:
- `mean?: number` — computed p.evidence mean
- `stdev?: number` — computed stdev
- `completeness?: number` — maturity metric
- `median_lag_days?: number` — display only

---

## Code Impact Analysis

### Files Requiring Changes

| File | Change Type | Description |
|------|-------------|-------------|
| `src/types/index.ts` | **Type extension** | Add `LatencyConfig` interface, add `latency?: LatencyConfig` to `GraphEdge`, extend `Evidence` interface, add `forecast` to `ProbabilityParam` |
| `src/services/UpdateManager.ts` | **Mapping additions** | Add file↔graph mappings for `latency.*`, `p.forecast.*`, new evidence fields |
| `src/lib/graphComputeClient.ts` | **Interface extension** | Add `anchor_node_id` to `ParameterQuery` interface |
| `lib/graph_types.py` | **Model extension** | Add `LatencyConfig`, `anchor_node_id` to edge model |
| `lib/msmdc.py` | **Logic addition** | Compute `anchor_node_id` alongside query (BFS to furthest start) |
| `src/lib/das/buildDslFromEdge.ts` | **Superfunnel logic** | Build `superfunnel` when `cohort()` detected |
| `public/connections/amplitude/connections.yaml` | **Transform extension** | Handle `superfunnel` payload, extract `dayMedianTransTimes` |
| `src/components/edges/ConversionEdge.tsx` | **Rendering** | Two-layer edge (solid/striped) |
| `src/components/PropertiesPanel.tsx` | **UI** | Latency config section |
| `public/schemas/conversion-graph-1.1.0.json` → `1.2.0` | **Schema** | Add latency config |
| `public/param-schemas/parameter-schema.yaml` | **Schema** | Add latency fields |

### Evidence Field Usage Audit

Evidence is accessed in these patterns — all are **safe** for extension:

| Location | Pattern | Impact |
|----------|---------|--------|
| `UpdateManager.ts` | `source.p.evidence.n`, `.k`, `.window_*`, etc. | Safe — accessing optional fields |
| `dataOperationsService.ts` | `combined.evidence?.time_series` | Safe — optional chaining |
| `ConversionEdge.tsx` | Read-only display | Safe — just rendering what exists |
| Tests | Assertions on `.evidence.n`, `.k` | Safe — testing existing fields |

**Conclusion:** Adding new optional fields to `Evidence` is non-breaking. No existing code accesses fields that would conflict.

### Forecast Field (NEW)

`p.forecast` is entirely **new** — no existing usage. Just add the type and wire up mappings.

---

## Formula A: Tail Forecasting (Review)

### Current Draft (§5.0.3)

```
k̂_i = k_i + (n_i - k_i) · p.forecast · (1 - F(a_i)) / (1 - p.forecast · F(a_i))
```

Where:
- `k_i` = observed conversions for cohort i
- `n_i` = total in cohort i
- `p.forecast` = mature baseline probability (retrieval-time)
- `a_i` = age of cohort i (days since cohort entry)
- `F(a_i)` = CDF of lag distribution at age a_i

### Analysis

This is a Bayesian posterior mean under the model:
- Prior: p.forecast fraction will eventually convert
- Likelihood: Of those who will convert, F(t) have converted by time t
- Observation: k_i have converted so far

The formula says: "Of the unconverted (n_i - k_i), some fraction p.forecast will still convert. Of those, (1 - F(a_i)) haven't had time to yet."

**Derivation check:**

Let C = "will eventually convert". Prior: P(C) = p.forecast

Given C, time to convert follows distribution with CDF F(t).

Observed: k_i converted by age a_i.

Expected additional conversions = (n_i - k_i) × P(C | not converted by a_i)

By Bayes:
```
P(C | not converted by a_i) = P(not converted by a_i | C) × P(C) / P(not converted by a_i)
                            = (1 - F(a_i)) × p.forecast / (1 - p.forecast × F(a_i))
```

So:
```
k̂_i = k_i + (n_i - k_i) × p.forecast × (1 - F(a_i)) / (1 - p.forecast × F(a_i))
```

**Formula is mathematically correct.**

### Phase 0 Simplification: F(a_i)

For Phase 0, we can use a simple step function:
```
F(a_i) = 0  if a_i < maturity_days
F(a_i) = 1  if a_i >= maturity_days
```

This means:
- Immature cohorts (a_i < maturity): k̂_i = k_i + (n_i - k_i) × p.forecast (assume all remaining will convert at p.forecast rate)
- Mature cohorts (a_i >= maturity): k̂_i = k_i (use observed)

**Phase 0 formula:**
```
k̂_i = k_i                       if a_i >= maturity_days (mature)
k̂_i = k_i + (n_i - k_i) × p.forecast    if a_i < maturity_days (immature)
```

**Then:**
```
p.mean = Σk̂_i / Σn_i
```

**Status:** ✅ Formula validated. Phase 0 simplification defined.

---

## Test Coverage Requirements

### Unit Tests

| Component | Test Cases |
|-----------|------------|
| MSMDC anchor computation | Edge from start node (A=X), edge not from start (A≠X), multiple starts, disconnected (no start reachable) |
| Formula A | Mature cohort, immature cohort, mixed, edge cases (p.forecast=0, p.forecast=1) |
| DSL parsing | `cohort(dates)`, `cohort(anchor,dates)` |
| Superfunnel builder | 3-step (A≠X), 2-step (A=X), with segment filters |

### Integration Tests

| Flow | Test Cases |
|------|------------|
| UpdateManager | Put latency config to file, get from file, _overridden respect |
| Amplitude adapter | 3-step funnel request, 2-step funnel, response transform |
| Query-time computation | Mature-only query, immature-only query, mixed |

---

### Key Decisions Made (3-4 Dec-25)

1. **Per-scenario visibility** replaces legend chips — 4-state cycle (F+E → F → E → hidden) on scenario chip eye icon
2. **Data nomenclature**: `p.evidence` (observed), `p.forecast` (mature baseline), `p.mean` (blended)
3. **Rendering**: E=solid, F=striped, F+E=evidence inner + mean outer
4. **Query-time computation**: p.forecast at retrieval; p.evidence and p.mean at query time
5. **Phase 1 constraint**: No convolution fallback; need window data for F modes
6. **CI bands**: Only on striped portion in F+E mode; on whole edge in E or F only modes
7. **Tooltips**: Show data provenance (which sliceDSL contributed to each value)
8. **Properties Panel UI**: Latency settings within Probability card, under Distribution
9. **conditional_p**: First-class citizen — identical latency treatment to `p`
10. **Cost params**: NO latency treatment — just direct inputs
11. **Override pattern**: `track_overridden`, `maturity_days_overridden` for put/get to file

---

*End of Open Issues Document*
