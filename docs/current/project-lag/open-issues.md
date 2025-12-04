# Project LAG: Open Issues & Design Gaps

**Status:** Working Document  
**Last Updated:** 4-Dec-25

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

**Decision needed:**
- Can scenarios override `latency.median_days`?
- Can scenarios override `latency.maturity_days`?
- What happens to `maturity_coverage` when latency params are overridden?

*** I'M NOT SURE IT MAKES SENSE TO OVERRIDE THESE SETTINGS BY SCENARIO - THAT'S A BIT OF AN ODD IDEA. IT'S A FETURE OF THE GRAPH DESIGN/TOPOLOGY OR PARAM SETTINGS, NOT REALLY A PARAM IN ITS OWN RIGHT. WHAT WE WILL I PRESUME NEED IS TO EXPOSE SOME OF THE NEW DIRECT E.EDGE.P.* PARAMS IN SCENARIOS AS THEY WILL AFFECT DISPLAY --- WHAT SPECIFIC NEW FIELDS ARE WE PROPOSING TO ADD?? *** 

**Resolution:**
- **Latency config is NOT scenario-overridable** — it's a graph topology/design setting
- `latency.track`, `latency.maturity_days` are **edge-level settings**, not scenario params
- **What IS scenario-visible**: The computed `p.evidence` fields that affect display:
  - `p.evidence.maturity_coverage` — affects edge width split
  - `p.evidence.median_lag_days` — affects bead display
  - These are **read-only derived values**, not overridable
  **** THIS ISN'T QUITE RIGHT. THEY ARE VARIABLES WHICH THE USER MAY WRITE, WHICH REQUIRE 'OVERRIDDEN' HANDLING IN THE STANDARD PATTERN. AND THEY SHOULD BE SCENARIO-SEPCIFIC TOO THEREFORE, AS THEY ARE THINGS WE WILL DERIVE FROM DATA OR WHICH USER MAY SPECIFY ****
- **No changes to EdgeParamDiff** — latency config stays out of scenario system
- Design doc updated: §9.J clarified

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

### GAP-10: ParsedConstraints Interface for cohort()

**Issue:** `src/lib/queryDSL.ts` needs `cohort` added to `ParsedConstraints` interface, but no design specifies the structure.

**Decision needed:**
- What fields does `ParsedConstraints.cohort` contain?
- Is it identical to `window` structure or different?

**Proposed:**
```typescript
interface ParsedConstraints {
  // ... existing ...
  cohort?: {
    start: string;  // Date string
    end: string;    // Date string
    anchor?: string; // Optional anchor node ID
  };
}
```

---

### GAP-11: DSL JSON Schema for cohort()

**Issue:** `public/schemas/query-dsl-1.0.0.json` needs to be updated to validate `cohort()` clauses.

**Decision needed:**
- What pattern validates `cohort()` syntax?
- Should it be added to `QueryFunctionName` enum?

---

### GAP-12: Parameter UI Schema for Latency Fields

**Issue:** `public/ui-schemas/parameter-ui-schema.json` needs updates for new latency fields in parameter files.

**Decision needed:**
- How should `median_trans_times_ms` array be displayed?
- Should it be hidden/readonly since it's derived data?

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

### GAP-18: Amplitude Adapter Changes for Dual Queries

**Issue:** The Amplitude adapter (`connections.yaml` pre_request) needs to:
- Distinguish `cohort()` vs `window()` in the DSL payload.
- For `cohort()` on latency edges: build a 3-step funnel query with the anchor node prepended.
- For `window()` on latency edges: build a 2-step funnel query (X→Y only).

**Decision needed:**
- How does the adapter know the anchor node for a given edge?
- Should anchor node be passed explicitly in the query payload, or looked up from edge config?

---

## Remaining Significant Open Design Areas

### 1. Exact lag CDF fitting from limited histogram + medians

We've documented that medians are high-quality and histograms are coarse beyond ~10 days, but we still need to pick a concrete parametric family (e.g. log-normal) and fitting strategy for Phase 1 (currently sketched in §5.1+ as future work).

### 2. Formal formulae for per-cohort tail forecasting

The doc now clearly states the policy ("keep observed k_i, forecast the remaining tail using p* and F(t)"), but it does not yet codify the exact algebra for the residual probability of conversion conditional on "not yet converted by age a_i". That will need to be nailed down before implementation.

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
k̂_i = k_i + (n_i - k_i) · p* · (1 - F(a_i)) / (1 - p* · F(a_i))
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
| `p.forecast` | p* — mature baseline (forecast absent evidence) | Retrieval time | Yes, on slice |
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
| `window()` mature | window | QT: Σk/Σn | RT: p* | = evidence |
| `window()` immature | window | QT: Σk/Σn | RT: p* | QT: Formula A |
| `cohort()` mature | cohort | QT: Σk/Σn | RT: p* | = evidence |
| `cohort()` immature | cohort | QT: Σk/Σn | RT: p* | QT: Formula A |
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
│ Forecast:  45.0%  (p*)                  │
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
| GAP-10 | ParsedConstraints interface for `cohort()` | Implementation | Resolve during build |
| GAP-11 | DSL JSON schema for `cohort()` | Implementation | Resolve during build |
| GAP-12 | Parameter UI schema for latency fields | Implementation | Resolve during build |
| GAP-13 | Integrity check rules for latency | Implementation | Resolve during build |
| GAP-14 | UpdateManager mapping config | Implementation | Resolve during build |
| GAP-15 | buildScenarioRenderEdges data threading | Implementation | Resolve during build |
| GAP-17 | windowAggregationService cohort routing | Implementation | Resolve during build |
| GAP-18 | Amplitude adapter anchor node handling | Implementation | Resolve during build |
| ~~p.mean policy~~ | ~~Measurement policy + user intent~~ | ~~Design~~ | ✅ **Resolved** |
| ~~Per-scenario visibility~~ | ~~E/F/F+E on scenario chips~~ | ~~Design~~ | ✅ **Resolved** |
| ~~Data nomenclature~~ | ~~p.evidence / p.forecast / p.mean~~ | ~~Design~~ | ✅ **Resolved** |
| ~~Query-time computation~~ | ~~When to compute each value~~ | ~~Design~~ | ✅ **Resolved** |
| ~~Confidence bands~~ | ~~CI display by mode~~ | ~~Design~~ | ✅ **Resolved** |
| ~~Edge tooltips~~ | ~~Data provenance display~~ | ~~Design~~ | ✅ **Resolved** |
| ~~Properties Panel UI~~ | ~~Latency settings layout~~ | ~~Design~~ | ✅ **Resolved** |
| **Formula A validation** | Verify Bayesian tail forecasting | Implementation | Verify during build |

### True Open Design Items

**All design items are now resolved.**

Everything remaining is implementation detail that will be resolved during build.

### Key Decisions Made (3-4 Dec-25)

1. **Per-scenario visibility** replaces legend chips — 4-state cycle (F+E → F → E → hidden) on scenario chip eye icon
2. **Data nomenclature**: `p.evidence` (observed), `p.forecast` (p*), `p.mean` (blended)
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
