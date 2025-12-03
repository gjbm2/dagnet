# Project LAG: Open Issues & Design Gaps

**Status:** Working Document  
**Last Updated:** 3-Dec-25

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

## NEW: p.mean Estimation and Display Policy (3-Dec-25)

### The Core Problem

For latency edges, we typically have both `window()` and `cohort()` data in the cache. There are **two distinct dimensions** to resolve:

1. **Measurement policy** (technical): What data/calculation do we use for p.mean?
2. **User intent** (UX): What do users expect to see when they select different query types?

These are related but separable questions.

---

### Dimension 1: Measurement Policy

**Question:** What data set do we use for calculating p.mean (until we build a proper stats model)?

| Approach | Description | Trade-offs |
|----------|-------------|------------|
| **Mature cohort data only** | p.mean from cohorts aged > maturity_days | Stable, trustworthy; but invariant under query changes |
| **Query-specific slice** | p.mean from the specific window/cohort queried | Responsive to query; but misleading for immature data |
| **Blended forecast** | Use mature p* to project immature cohorts | Best estimate; but hides "what actually happened" |

**The issue:** We will typically pin *both* `cohort()` and `window()` queries, so we have multiple data sources in the cache. When user selects a specific date window, which data informs p.mean?

**Current thinking:** Not resolved. Need to decide whether p.mean is:
- A property of the **edge** (invariant, derived from mature data)
- A property of the **query** (varies with window selection)

If invariant, we mask real trends. If query-specific, we risk showing misleading values (5% on an edge that's actually 45%).

---

### Dimension 2: User Intent

**Question:** What do users expect to see when they select different query types?

When a user selects a 7-day window on an edge with 30-day maturity, what are they asking for?

| Intent | User is asking... | Implies showing... |
|--------|-------------------|-------------------|
| **"What happened?"** | Show me the evidence from this period | Observed p (even if 5%), thin edge |
| **"What's the conversion rate?"** | Show me what p actually is for this edge | Forecast p (~45%), normal edge width |
| **"How's it trending?"** | Show me if things are improving/declining | Comparison to historical baseline |

**The tension:** These are legitimate but different questions. A single p.mean value can't serve all intents.

**Possible resolutions:**
1. **Mode toggle**: User chooses "evidence" vs "forecast" view
2. **Smart defaults**: Show forecast p, but flag with completeness badge
3. **Dual display**: Edge width = forecast, badge = observed evidence
4. **Query-type semantics**: `window()` = evidence intent, `cohort()` = forecast intent

**Not yet decided:** Which approach best serves users. May require user research or iterative refinement.

---

### Combined Matrix (What to Show?)

| Query Type | Maturity | User Intent | What to Show? |
|------------|----------|-------------|---------------|
| `window()` | mature | evidence | Observed p ✓ |
| `window()` | immature | evidence | Observed p (low) — but is this what they want? |
| `window()` | immature | forecast | ??? — window() doesn't naturally imply forecast |
| `cohort()` | mature | either | Observed p ✓ |
| `cohort()` | mixed | forecast | Layered edge (§7.1) with forecast p |
| `cohort()` | immature | forecast | Mostly forecast; show completeness |

**Open:** The `window()` + immature cases are unclear. §7.1 addresses cohort display but not window queries where evidence is thin.

---

### Relationship to Visual Layers (§7.1)

§7.1 specifies how to **display** mature vs forecast layers on edges. It answers the rendering question but not:
- Which p.mean value to use (measurement policy)
- What users expect to see (intent)

The visual layers communicate *uncertainty* about completeness. They don't resolve what p.mean should be.

---

### Design Decisions Required

Before implementation:

1. **Measurement policy:** Is p.mean per-edge invariant or per-query-window?
2. **User intent mapping:** Does `window()` imply evidence intent? Does `cohort()` imply forecast intent?
3. **Display strategy:** How to handle `window()` queries on immature data?
4. **Mode toggle:** Should there be an explicit "evidence" vs "forecast" view preference?

---

## NEW: Properties Panel Latency UI (3-Dec-25)

### The Issue

§7.7 specifies minimal UI ("Calculate Latency" toggle, "Cut-off Time" input) but lacks:
- Layout within the Probability param section
- Validation behaviour for "Cut-off Time" (accepts "30d"? What format?)
- How toggling `latency.track` affects other UI elements
- Whether derived values (median_lag_days, completeness) appear anywhere in properties

**Needs:** UI mockup or clearer specification before implementation.

---

## Summary of Open Issues

| ID | Issue | Type | Blocking? |
|----|-------|------|-----------|
| GAP-10 | ParsedConstraints interface for `cohort()` | Implementation | Yes |
| GAP-11 | DSL JSON schema for `cohort()` | Implementation | Yes |
| GAP-12 | Parameter UI schema for latency fields | Implementation | No |
| GAP-13 | Integrity check rules for latency | Implementation | No |
| GAP-14 | UpdateManager mapping config | Implementation | Partial |
| GAP-15 | buildScenarioRenderEdges data threading | Implementation | Partial |
| GAP-17 | windowAggregationService cohort routing | Implementation | Yes |
| GAP-18 | Amplitude adapter anchor node handling | Implementation | Yes |
| **p.mean policy** | Measurement policy + user intent | **Design** | **Yes** |
| **Properties Panel UI** | Latency settings layout | **Design** | No |

**Legend:**
- **Design** = Requires decision before implementation
- **Implementation** = Will be resolved during build

---

*End of Open Issues Document*
