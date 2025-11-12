# Context Parameters - Key Design Decisions

**Purpose:** Document critical design decisions and rationale  
**Status:** Proposed - Awaiting Approval  
**Date:** October 21, 2025

---

## Decision 1: Reference Notation Format

### Options Considered

#### Option A: Separate `context()` Only
```
e.signup.context(channel='google').p.mean
e.signup.context(channel='google',device='mobile').p.mean
```
**Cannot combine with visited nodes**

#### Option B: Chainable (RECOMMENDED)
```
e.signup.context(channel='google').p.mean
e.signup.visited(pricing).context(channel='google').p.mean
```
**Both structural and external conditions**

#### Option C: Unified Conditional
```
e.signup.cond(visited=[pricing],channel='google').p.mean
```
**Single function, more complex parsing**

### Recommendation: Option B (Chainable)

**Rationale:**
- ✅ Conceptually separates structural (visited) from external (context)
- ✅ Allows pure context, pure visited, or combined
- ✅ Extensible (can add more chain elements later)
- ✅ Natural fallback hierarchy
- ✅ Familiar dot-chain syntax
- ❌ Slightly more verbose than Option C
- ❌ Requires chain-ordering rules

**Parsing Rules:**
1. Order-independent input (user can write in any order)
2. Canonical form: always `visited()` then `context()`
3. Alphabetical sorting within each function
4. Generated: `e.<slug>.visited(<n1>,<n2>).context(<k1>='<v1>',<k2>='<v2>').p.{mean|stdev}`

**Decision:** ✅ Approved / ⏳ Pending / ❌ Rejected

---

## Decision 2: Context Definition Storage

### Options Considered

#### Option A: Single File (RECOMMENDED)
```
param-registry/contexts.yaml
```
**All contexts in one file**

#### Option B: Directory Structure
```
param-registry/contexts/
  channel.yaml
  device.yaml
  utm_source.yaml
```
**One file per context**

#### Option C: Embedded in Parameters
**No separate context definitions**

### Recommendation: Option A (Single File)

**Rationale:**
- ✅ Simple to manage (one file)
- ✅ Easy to see all contexts at once
- ✅ Fast to load (single HTTP request)
- ✅ Natural for UI dropdowns
- ✅ Versioning straightforward
- ❌ Could become large with many contexts (unlikely)
- ❌ No per-context versioning (probably fine)

**When to switch to Option B:**
- If file exceeds 1000 lines
- If contexts change independently at high frequency
- If permissions needed per-context

**Decision:** ✅ Approved / ⏳ Pending / ❌ Rejected

---

## Decision 3: Resolution Fallback Order

### Options Considered

#### Option A: Specific to General (RECOMMENDED)
```
1. Exact: visited + context
2. Context only (ignore visited requirement)
3. Visited only (ignore context requirement)
4. Base (no filters)
```

#### Option B: Context Priority
```
1. Exact: visited + context
2. Context only
3. Base (skip visited-only)
```

#### Option C: Visited Priority
```
1. Exact: visited + context
2. Visited only
3. Base (skip context-only)
```

### Recommendation: Option A (Specific to General)

**Rationale:**
- ✅ Most specific parameter wins (least surprising)
- ✅ Both visited and context matter
- ✅ Allows context-only OR visited-only parameters
- ✅ Flexible parameter creation
- ❌ More complex resolution logic
- ❌ Could have unexpected fallbacks

**Example Fallback:**
```
User: Google mobile, visited pricing
Available params:
  - signup-google (context only)
  - signup-visited-pricing (visited only)
  - signup-base (base)

Resolution: Falls through to signup-google (step 2)
```

**Alternative Consideration:**
If this is too confusing, we can simplify to Option B (context wins) with clear documentation.

**Decision:** ✅ Approved / ⏳ Pending / ❌ Rejected

---

## Decision 4: Initial Context Set

### Options Considered

#### Option A: Marketing Focus (RECOMMENDED)
```yaml
contexts: [channel, utm_source, device]
```
**3 contexts, ~15-30 value combinations**

#### Option B: Comprehensive
```yaml
contexts: [channel, utm_source, device, browser, geo_country, time_of_day]
```
**6 contexts, ~hundreds of combinations**

#### Option C: Minimal
```yaml
contexts: [channel]
```
**1 context to start**

### Recommendation: Option A (Marketing Focus)

**Rationale:**
- ✅ Covers primary use cases (channel attribution)
- ✅ Manageable number of combinations
- ✅ Demonstrates multi-context support
- ✅ Device is high-impact (mobile vs desktop)
- ❌ May need to add more later
- ❌ Some use cases wait for browser/geo contexts

**Initial Contexts:**
1. **channel:** google, facebook, organic, email, direct (5 values)
2. **device:** mobile, desktop, tablet (3 values)
3. **utm_source:** newsletter, promo, referral, partner (4 values)

**Total Combinations:** 5 × 3 × 4 = 60 (manageable)

**Add Later:** browser, geo, time_of_day as needed

**Decision:** ✅ Approved / ⏳ Pending / ❌ Rejected

---

## Decision 5: Multiple Active Contexts Behavior

### Options Considered

#### Option A: Union (Match Any) (RECOMMENDED)
```
Active: channel=[google, facebook], device=[mobile]
Matches:
  - channel=google, device=mobile ✅
  - channel=facebook, device=mobile ✅
  - channel=google (no device) ✅
  - channel=organic, device=mobile ❌
```
**Parameter matches if its context values are in active set**

#### Option B: Intersection (Match All)
```
Active: channel=[google, facebook], device=[mobile]
Matches only:
  - channel=google, device=mobile ✅
  - channel=facebook, device=mobile ✅
```
**Parameter must match all active contexts**

### Recommendation: Option A (Union/Match Any)

**Rationale:**
- ✅ Allows filtering "show only these channels"
- ✅ Natural checkbox behavior (check = include)
- ✅ Enables "all but X" scenarios
- ✅ More flexible analysis
- ❌ Could be confusing (why does base param match?)

**How it works:**
- Empty context (no active values) = matches everything
- Active values = parameter's value must be in the set
- Base parameters (no context filter) = always match

**Example:**
```
User checks: [Google] [Facebook] in channel filter
Graph uses:
  - signup-google (✅ google in active set)
  - signup-facebook (✅ facebook in active set)
  - signup-organic (❌ organic not in active set)
  - signup-base (✅ no filter = always matches)
```

**Decision:** ✅ Approved / ⏳ Pending / ❌ Rejected

---

## Decision 6: UI Placement

### Options Considered

#### Option A: What-If Panel (RECOMMENDED)
```
[Graph Editor]
  ├── Canvas
  ├── Properties Panel (right side)
  └── What-If Panel (expandable bottom)
      └── Context Selector (collapsible section)
```

#### Option B: Separate Contexts Tab
```
[Graph Editor]
  ├── Graph Tab
  ├── Contexts Tab ← New tab
  └── Parameters Tab
```

#### Option C: Properties Panel
**Context selector always visible in edge properties**

### Recommendation: Option A (What-If Panel)

**Rationale:**
- ✅ Contexts are for analysis (what-if), not editing
- ✅ Keeps properties panel focused on selected element
- ✅ Natural home for scenario exploration
- ✅ Can expand/collapse as needed
- ❌ May not be visible by default
- ❌ Needs clear "What-If" panel implementation

**What-If Panel Contents:**
```
┌─ What-If Analysis ──────────────────┐
│ ▼ Context Filters                   │
│   [context selector component]      │
│                                      │
│ ▼ Parameter Overrides                │
│   [temporary value adjustments]     │
│                                      │
│ ▼ Scenario Comparison                │
│   [save/load scenarios]             │
└──────────────────────────────────────┘
```

**Decision:** ✅ Approved / ⏳ Pending / ❌ Rejected

---

## Decision 7: Parameter Creation Workflow

### Options Considered

#### Option A: UI + YAML (RECOMMENDED)
**Users can create via UI, which generates YAML files**

#### Option B: YAML Only
**Users manually create YAML files, UI only reads**

#### Option C: Database
**Parameters stored in DB, not files**

### Recommendation: Option A (UI + YAML)

**Rationale:**
- ✅ UI lowers barrier for creating parameters
- ✅ YAML files preserve Git workflow
- ✅ Generated YAML is canonical, editable
- ✅ UI ensures valid structure
- ❌ More complex implementation
- ❌ Needs file write permissions

**Workflow:**
1. User clicks "Create Context Parameter" in edge properties
2. Dialog opens with context selectors
3. User fills in values
4. UI generates YAML file in `param-registry/parameters/`
5. File saved, parameter linked to edge
6. User can edit YAML directly if desired

**For v1:** Focus on creation dialog, defer editing UI to later

**Decision:** ✅ Approved / ⏳ Pending / ❌ Rejected

---

## Decision 8: Context in Case Parameters

### Options Considered

#### Option A: Support Contexts (RECOMMENDED)
```yaml
id: ab-test-button-mobile
type: case
context_filter:
  device: mobile
case:
  variants: [blue, green, red]
  weights: [0.5, 0.3, 0.2]
```

#### Option B: Cases Separate
**Contexts only for probabilities, not cases**

### Recommendation: Option A (Support Contexts)

**Rationale:**
- ✅ Real use case: A/B test results vary by channel/device
- ✅ Consistent with probability parameters
- ✅ Enables context-aware experimentation
- ❌ Adds complexity to case resolution
- ❌ More combinations to manage

**Example Use Case:**
```
A/B Test: Button color
- Mobile: Blue wins (45% vs 40% for green)
- Desktop: Green wins (52% vs 48% for blue)

Solution: Two case parameters with context filters
- button-color-mobile: weights=[0.6, 0.4] (blue, green)
- button-color-desktop: weights=[0.4, 0.6] (blue, green)
```

**Implementation Note:** Extend case resolution to check context filters

**Decision:** ✅ Approved / ⏳ Pending / ❌ Rejected

---

## Decision 9: Coverage Analysis Priority

### Options Considered

#### Option A: Phase 4 (Included in v1) (RECOMMENDED)
**Build coverage analysis as part of initial release**

#### Option B: Phase 6 (Post v1)
**Ship basic contexts first, add analysis later**

### Recommendation: Option A (Include in v1)

**Rationale:**
- ✅ Prevents combinatorial explosion (guides users)
- ✅ Shows value of context system
- ✅ Identifies high-priority parameters to create
- ✅ Relatively simple to implement
- ❌ Adds ~3 days to schedule
- ❌ Delays v1 launch

**Minimum Coverage Features:**
- Show X/Y combinations covered
- List missing combinations
- Prioritize by traffic volume (if available)
- "Create parameter" button for missing combos

**Decision:** ✅ Approved / ⏳ Pending / ❌ Rejected

---

## Decision 10: Performance Targets

### Options Considered

#### Option A: Optimize Now (RECOMMENDED)
```
- Parameter resolution: < 1ms per edge
- Graph recalculation: < 100ms (100 nodes)
- Context change: < 200ms end-to-end
```

#### Option B: Optimize Later
**Ship first, optimize if slow**

### Recommendation: Option A (Optimize Now)

**Rationale:**
- ✅ Performance critical for good UX
- ✅ Easier to build right than fix later
- ✅ Caching strategy needed from start
- ✅ Users expect instant feedback on context change
- ❌ Adds complexity (caching, memoization)
- ❌ May over-engineer if not needed

**Optimization Strategies:**
1. **Cache context definitions** (load once)
2. **Cache parameter list** (invalidate on registry change)
3. **Memoize resolution results** (clear on context change)
4. **Debounce UI updates** (wait 100ms after last checkbox change)
5. **Lazy load parameters** (only load what's needed)

**Measure:** Add performance monitoring, set alerts

**Decision:** ✅ Approved / ⏳ Pending / ❌ Rejected

---

## Summary of Recommendations

| Decision | Recommendation | Confidence |
|----------|---------------|------------|
| 1. Reference Format | Chainable `.visited().context()` | High |
| 2. Context Storage | Single `contexts.yaml` | High |
| 3. Fallback Order | Specific to General (4-tier) | Medium |
| 4. Initial Contexts | channel, device, utm_source | High |
| 5. Multiple Active | Union (Match Any) | Medium |
| 6. UI Placement | What-If Panel | High |
| 7. Creation Workflow | UI + YAML | High |
| 8. Case Context Support | Yes, include | Medium |
| 9. Coverage Analysis | Include in v1 | Medium |
| 10. Performance Targets | Optimize from start | High |

**Overall Confidence:** High - Design is well-reasoned and extensible

---

## Open Questions Still Needing Input

### Q1: Context Value Validation Strategy
**Question:** Should we strictly validate context values against `contexts.yaml`?

**Options:**
- **Strict:** Reject unknown context values (safer, more rigid)
- **Permissive:** Allow but warn (flexible, riskier)
- **Hybrid:** Strict in UI, permissive in YAML (best of both?)

**Recommendation:** Start strict, add permissive mode if needed

**Your Input Needed:** Is strict validation acceptable for v1?

---

### Q2: Default Context Selection
**Question:** When graph loads, what contexts are active?

**Options:**
- **All active** (inclusive, shows full picture)
- **None active** (exclusive, user must opt-in)
- **Remember last selection** (convenient, may be stale)

**Recommendation:** All active by default (least surprising)

**Your Input Needed:** Agree with "all active" default?

---

### Q3: Context Naming Convention
**Question:** Should contexts use `snake_case` or `kebab-case`?

**Current:** Mixed in examples (`utm_source` vs context values `google`)

**Recommendation:**
- Context IDs: `snake_case` (e.g., `utm_source`)
- Context values: `kebab-case` (e.g., `google-ads`)
- Edge slugs: `kebab-case` (already established)

**Rationale:** Matches existing slug convention, clear separation

**Your Input Needed:** Approve naming convention?

---

### Q4: Scope of Phase 1
**Question:** Should we complete full Phase 0 (parameter loader for all types) before starting contexts?

**Options:**
- **Sequential:** Finish Phase 0 completely, then start contexts
- **Parallel:** Build context infrastructure while Phase 0 ongoing
- **Integrated:** Merge Phase 0 + Phase 1 context work

**Recommendation:** Parallel (save time, builds on Phase 0 foundation)

**Your Input Needed:** Okay to start context work while Phase 0 in progress?

---

## Approval Checklist

Before implementation begins, approve:

- [ ] **Decision 1-10:** All recommendations approved or modified
- [ ] **Q1-Q4:** Open questions answered
- [ ] **Timeline:** 4-week timeline acceptable
- [ ] **Resources:** Developer time allocated
- [ ] **Scope:** v1 feature set finalized
- [ ] **Examples:** Example parameters make sense
- [ ] **Documentation:** Design docs reviewed and understood

---

## Next Actions

### After Approval:
1. ✅ Finalize design based on feedback
2. ✅ Update roadmap with any scope changes
3. ✅ Create implementation tickets
4. ✅ Set up development branch
5. ✅ Begin Phase 1 coding

### Before Coding:
1. ✅ Review CONTEXT_PARAMETERS_DESIGN.md
2. ✅ Review CONTEXT_PARAMETERS_ROADMAP.md
3. ✅ Review this decisions doc
4. ✅ Answer open questions (Q1-Q4)
5. ✅ Get stakeholder sign-off

---

**Status:** Awaiting design review and approval ⏳

**Ready to implement:** ❌ Not yet / ⏳ Pending approval / ✅ Approved



