# Project LAG: Open Issues & Design Gaps

**Status:** Working Document  
**Last Updated:** 2-Dec-25

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
- Format: **"13d (75%)"** — median lag in days + maturity coverage percentage
- Show when: `latency.track === true` AND `median_lag_days > 0`
- Colour: Match existing bead styling (no new colour)
- **Completeness = maturity_coverage** = `mature_n / total_n` (already defined in §7.2)
**** I'M NOT SURE THIS IS QUITE RIGHT -- IT WILL OVER/UNDERSTATE IN CASES WHERE SOME EDGES HAVE HIGH VARIABILITY. LET'S REVIEW THE MATHS AGAIN ****
- Design doc updated: §7.4 (new section)

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

*End of Open Issues Document*
