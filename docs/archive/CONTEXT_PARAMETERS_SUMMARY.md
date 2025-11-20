# Context Parameters - Executive Summary

**Date:** October 21, 2025  
**Status:** Design Complete, Awaiting Approval  
**Effort:** v1 (4 weeks) → v2 (3-4 weeks, future)

---

## What Are Context Parameters?

Context parameters allow conversion graph probabilities to vary based on external factors:
- **Marketing channel** (Google, Facebook, organic, etc.)
- **Device type** (mobile, desktop, tablet)
- **UTM parameters** (campaign tracking)
- **Browser** (Chrome, Safari, Firefox)
- **Geography**, **time of day**, and more

**Example:** Signup conversion might be:
- 35% for Google Ads traffic
- 28% for Facebook traffic  
- 32% for Google Ads on mobile
- 42% for organic search

---

## Why This Matters

### 1. **More Accurate Models**
Instead of one average conversion rate, model different rates for different contexts.

### 2. **What-If Analysis**
"What if we cut Facebook ads?" → Uncheck Facebook, see impact instantly

### 3. **Data-Driven Decisions**
"Should we optimize for mobile?" → See mobile-specific conversion rates

### 4. **Channel Attribution**
Understand which channels perform best, with real data

---

## Proposed Design

### Reference Notation
```
# Base parameter (no context)
e.signup.p.mean

# With context
e.signup.context(channel='google').p.mean

# Multiple contexts
e.signup.context(channel='google',device='mobile').p.mean

# Combined with visited nodes
e.signup.visited(pricing).context(channel='google').p.mean
```

**Key Features:**
- Chainable syntax (visited + context)
- Alphabetically sorted for determinism
- Backward compatible (base parameters still work)

---

### Context Definitions

**File:** `param-registry/contexts.yaml`

```yaml
contexts:
  - id: channel
    name: "Marketing Channel"
    values:
      - id: google
        label: "Google Ads"
      - id: facebook
        label: "Facebook Ads"
      - id: organic
        label: "Organic Search"
  
  - id: device
    name: "Device Type"
    values:
      - id: mobile
        label: "Mobile"
      - id: desktop
        label: "Desktop"
```

**Initial contexts:** `channel`, `device`, `utm_source` (expandable later)

---

### Parameter Files with Context

```yaml
# param-registry/parameters/probability/signup-google-mobile.yaml

id: signup-google-mobile
name: "Signup Conversion - Google Mobile"
type: probability
edge_reference: e.signup.context(channel='google',device='mobile').p.mean

context_filter:
  channel: google
  device: mobile

value:
  mean: 0.32
  stdev: 0.06
```

---

### UI: Context Selector

In the **What-If Analysis** panel:

```
┌─ Context Filters ────────────────┐
│                                   │
│ ▼ Marketing Channel  [All] [None]│
│   ☑ Google Ads                    │
│   ☑ Facebook Ads                  │
│   ☐ Organic Search                │
│   ☐ Email Campaign                │
│                                   │
│ ▼ Device Type        [All] [None]│
│   ☑ Mobile                        │
│   ☑ Desktop                       │
│   ☐ Tablet                        │
└───────────────────────────────────┘
```

**User Action:** Check/uncheck contexts → Graph recalculates with filtered parameters

---

### Resolution Fallback Hierarchy

When multiple parameters exist for an edge, use most specific:

1. **Exact match:** visited + context both match → **USE THIS**
2. **Context only:** context matches, no visited requirement → use this
3. **Visited only:** visited matches, no context requirement → use this  
4. **Base:** no filters → use this as fallback

**Example:**
```
User: Google mobile, visited pricing page
Edge: signup

Available parameters:
  1. signup-google-mobile-pricing (exact) ← USE (most specific)
  2. signup-google-mobile (context only)
  3. signup-visited-pricing (visited only)
  4. signup-base (base fallback)
```

---

## Implementation Plan

### Phase 1: Core Infrastructure (1 week)
- Context definitions and loader
- Reference notation parser
- TypeScript types

### Phase 2: Resolution Logic (1 week)
- Parameter resolution with contexts
- Fallback hierarchy
- Graph integration

### Phase 3: UI Components (1 week)
- Context selector component
- What-if panel integration
- Edge properties display

### Phase 4: Parameter Management (1 week)
- Create context parameters from UI
- Parameter browser
- Coverage analysis

**Total v1:** 4 weeks to production-ready context parameters

---

## Staged Implementation: v1 → v2

### v1: Context Parameters (Now)
**What you get:**
- ✅ Context-aware parameters (channel, device, etc.)
- ✅ What-if analysis with context filtering
- ✅ Static parameter values (YAML files)
- ✅ Manual monitoring and updates
- ✅ Git version control

**Time:** 4 weeks  
**Infrastructure:** Minimal (just YAML files + Git)

---

### v2: Data Pipeline Integration (Future)
**What you add:**
- ✅ Parameters from external sources (Sheets, SQL, APIs)
- ✅ Data persistence (historical tracking)
- ✅ Observation queries (from data lake)
- ✅ Daily automated monitoring
- ✅ Bayesian posterior updates
- ✅ Model fit detection (divergence alerts)
- ✅ RAG dashboard (🟢🟡🔴 visual health indicators)

**Time:** 3-4 weeks (after v1)  
**Infrastructure:** Data lake, database, scheduled jobs

**See:** `STAGED_IMPLEMENTATION_PLAN.md` for detailed comparison and migration path

---

## Key Decisions Needed

Before implementation, approve:

### 1. Reference Format
**Proposed:** `e.signup.visited(node).context(channel='google').p.mean` (chainable)

**Alternatives:** Unified `cond()` function, separate notations

**Recommendation:** Approve chainable format ✅

---

### 2. Initial Context Set
**Proposed:** `channel`, `device`, `utm_source`

**Alternatives:** Add browser, geography, time (more complex)

**Recommendation:** Start with 3 contexts, expand later ✅

---

### 3. UI Placement
**Proposed:** Context selector in What-If panel (bottom)

**Alternatives:** Separate tab, always-visible sidebar

**Recommendation:** What-If panel (analysis tool) ✅

---

### 4. Multiple Active Contexts
**Proposed:** Union (match any) - checking Google+Facebook shows both

**Alternatives:** Intersection (must match all selected)

**Recommendation:** Union (more intuitive) ✅

---

### 5. Case Parameter Contexts
**Proposed:** Support contexts for A/B test cases

**Use case:** Button colour test performs differently on mobile vs desktop

**Recommendation:** Include in v1 ✅

---

## Example Use Cases

### Use Case 1: Channel Attribution
**Question:** "Which channel converts best?"

**Steps:**
1. Select all channels in context filter
2. View conversion rates by channel
3. Compare Google (35%) vs Facebook (28%) vs Organic (42%)
4. **Decision:** Invest more in organic optimization

---

### Use Case 2: Mobile Optimization
**Question:** "If we improve mobile conversion, what's the impact?"

**Steps:**
1. Filter to mobile only
2. See current mobile conversion: 28%
3. Adjust parameter to 32% (+4%)
4. See overall impact on graph
5. **Decision:** Mobile optimization worth 2% overall lift

---

### Use Case 3: Budget Reallocation
**Question:** "What if we cut Facebook and increase Google?"

**Steps:**
1. Uncheck Facebook in channel filter
2. See graph without Facebook traffic
3. Increase Google parameter weight
4. Compare scenarios
5. **Decision:** Data supports reallocation

---

## Benefits

### For Analysts
- ✅ More accurate models (context-specific rates)
- ✅ Faster what-if analysis (UI-driven)
- ✅ Better channel attribution

### For Marketers
- ✅ Understand channel performance
- ✅ Compare device strategies  
- ✅ Data-driven budget decisions

### For Developers
- ✅ Extensible system (easy to add contexts)
- ✅ Clean separation of concerns
- ✅ Backward compatible

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Combinatorial explosion** (too many params) | Coverage analysis shows gaps, prioritize top combinations |
| **User confusion** (complexity) | Good UI, documentation, examples |
| **Performance issues** | Caching, optimization, lazy loading |
| **Parameter conflicts** | Validation, conflict detection |

---

## Success Metrics

### Short-term (1 month)
- ✅ Context system deployed
- ✅ 3 contexts defined
- ✅ 10+ context-aware parameters created
- ✅ Users can filter contexts in UI

### Medium-term (3 months)
- ✅ 80%+ coverage for top context combinations
- ✅ Users creating context parameters weekly
- ✅ What-if analysis used in decision-making
- ✅ No performance complaints

### Long-term (6 months)
- ✅ Context system extended (new contexts added)
- ✅ Integration with analytics platforms
- ✅ Automated parameter updates from data sources
- ✅ Case studies of context-driven decisions

---

## Files Created

### Documentation
- ✅ `CONTEXT_PARAMETERS_DESIGN.md` - Full specification (12 sections)
- ✅ `CONTEXT_PARAMETERS_ROADMAP.md` - Implementation plan (5 phases)
- ✅ `CONTEXT_PARAMETERS_EXAMPLES.md` - Usage examples (scenarios)
- ✅ `CONTEXT_PARAMETERS_DECISIONS.md` - Design decisions (10 decisions)
- ✅ `CONTEXT_PARAMETERS_SUMMARY.md` - This document

### Registry Files
- ✅ `param-registry/schemas/context-schema.yaml` - Context validation schema
- ✅ `param-registry/contexts.yaml` - Context definitions (example for dev)
- ✅ `param-registry/examples/context-aware-parameters.yaml` - 8 example parameters

### Status Update
- ✅ `PARAMETER_REGISTRY_STATUS.md` - Updated with context system section

### Additional Design Docs
- ✅ `REGISTRY_DEPLOYMENT_STRATEGY.md` - File location strategy (schemas in app, data in registry repo)
- ✅ `CONDITIONAL_PROBABILITY_UI_DESIGN.md` - UI for selecting nodes + contexts
- ✅ `PARAMETER_DATA_ARCHITECTURE.md` - Data architecture (priors, posteriors, observations)
- ✅ `PARAMETER_DATA_PIPELINE.md` - Complete data pipeline with Bayesian updating
- ✅ `STAGED_IMPLEMENTATION_PLAN.md` - v1 (basic) → v2 (data pipeline)

**Total:** 9 design docs, 3 registry files, 1 status update

---

## Next Steps

### Immediate
1. **Review** all design documents
2. **Decide** on open questions (Q1-Q4 in decisions doc)
3. **Approve** design or request changes
4. **Prioritize** - Start now or after Phase 0?

### This Week
1. **Set up** development branch
2. **Create** implementation tickets
3. **Begin** Phase 1 (core infrastructure)
4. **Test** reference parsing and context loading

### Next Week
1. **Complete** Phase 1-2 (resolution logic)
2. **Start** Phase 3 (UI components)
3. **Review** progress, adjust timeline

---

## Open Questions

### Q1: Validation Strategy
Should context values be strictly validated against `contexts.yaml`?

**Recommendation:** Yes, strict validation (reject unknown values)

**Your input:** Approve? ⏳

---

### Q2: Default Context State
When graph loads, should all contexts be active or none?

**Recommendation:** All active (shows full picture by default)

**Your input:** Approve? ⏳

---

### Q3: Naming Convention
Context IDs: `snake_case` or `kebab-case`?

**Recommendation:** 
- Context IDs: `snake_case` (e.g., `utm_source`)
- Context values: `kebab-case` (e.g., `google-ads`)

**Your input:** Approve? ⏳

---

### Q4: Implementation Timing
Start context work now or wait for Phase 0 (parameter loader) completion?

**Recommendation:** Parallel (save time, some dependency okay)

**Your input:** Approve? ⏳

---

## Approval Checklist

Ready to proceed when:

- [ ] Design reviewed and approved
- [ ] Open questions (Q1-Q4) answered
- [ ] Timeline acceptable (3-4 weeks)
- [ ] Resource allocation confirmed
- [ ] Initial context set approved (channel, device, utm_source)
- [ ] Reference notation approved (chainable format)
- [ ] UI placement approved (what-if panel)

---

## Conclusion

The context parameters system is a natural extension of the existing parameter registry that enables **context-aware modeling** and **powerful what-if analysis**.

**Design is complete and ready for implementation.**

Key advantages:
- ✅ Backward compatible (base parameters still work)
- ✅ Extensible (easy to add new contexts)
- ✅ Intuitive UI (checkbox-based filtering)
- ✅ Well-scoped (3-4 weeks to v1)

**Recommendation:** Approve design and proceed with Phase 1 implementation.

---

**Questions?** Review detailed docs:
- Design: `CONTEXT_PARAMETERS_DESIGN.md`
- Roadmap: `CONTEXT_PARAMETERS_ROADMAP.md`
- Examples: `CONTEXT_PARAMETERS_EXAMPLES.md`
- Decisions: `CONTEXT_PARAMETERS_DECISIONS.md`

