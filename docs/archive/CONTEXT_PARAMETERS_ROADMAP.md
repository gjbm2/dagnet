# Context Parameters Implementation Roadmap

**Status:** Design Complete, Ready for Implementation  
**Timeline:** 3-4 weeks for full implementation  
**Dependencies:** Requires Phase 1 of PARAMETER_REGISTRY_STATUS.md (parameter loader)

---

## Overview

This roadmap breaks down the context parameters implementation into phases, with clear deliverables and dependencies.

---

## Phase 0: Foundation (Prerequisite)

**Duration:** 1 week (parallel with context design)  
**From:** PARAMETER_REGISTRY_STATUS.md Phase 1

### Tasks
1. ✅ Create parameter loader (`parameterRegistry.ts`)
2. ✅ Connect case parameters (replace mock data)
3. ✅ Test end-to-end with real parameter file

**Deliverable:** Basic parameter loading works, cases load from registry

**Status:** Must complete before Phase 1

---

## Phase 1: Context Core Infrastructure

**Duration:** 1 week  
**Goal:** Context definitions and parsing work

### 1.1 Schema & Type Definitions
**Files:**
- `param-registry/contexts.yaml` ✅ (created)
- `param-registry/schemas/context-schema.yaml` ✅ (created)
- `graph-editor/src/lib/types.ts` (extend)

**Tasks:**
- [x] Create `contexts.yaml` with initial definitions
- [x] Create context YAML schema for validation
- [ ] Add TypeScript interfaces:
  - `ContextDefinition`
  - `ContextValue`
  - `ContextFilter`
  - `ActiveContexts`
- [ ] Extend `Parameter` interface with:
  - `edge_reference?: string`
  - `context_filter?: ContextFilter`
  - `visited_filter?: string[]`

**Acceptance Criteria:**
- Contexts.yaml validates against schema
- TypeScript types compile without errors
- Can import and use types in other files

---

### 1.2 Reference Notation Parser
**Files:**
- `graph-editor/src/lib/conditionalReferences.ts` (extend)

**Tasks:**
- [ ] Extend `parseConditionalReference()` to support `.context()`
- [ ] Extend `generateConditionalReference()` to include context
- [ ] Add context sorting (alphabetical keys)
- [ ] Add chain ordering (`visited` before `context`)
- [ ] Write unit tests for parsing:
  - `e.signup.context(channel='google').p.mean`
  - `e.signup.visited(node).context(key='val').p.mean`
  - Multiple context values (sorted output)

**Acceptance Criteria:**
- All reference formats parse correctly
- Generated references are deterministic (sorted)
- Unit tests pass (15+ test cases)

---

### 1.3 Context Loader
**Files:**
- `graph-editor/src/lib/parameterRegistry.ts` (extend)

**Tasks:**
- [ ] Implement `loadContexts()` function
- [ ] Add YAML parsing for contexts.yaml
- [ ] Add context validation
- [ ] Cache contexts in memory
- [ ] Handle errors gracefully (missing file, invalid format)

**Code:**
```typescript
export async function loadContexts(): Promise<ContextDefinition[]> {
  const response = await fetch('/param-registry/contexts.yaml');
  const yaml = await response.text();
  const data = parseYAML(yaml);
  validateContexts(data.contexts);
  return data.contexts;
}
```

**Acceptance Criteria:**
- Can load contexts from registry
- Invalid contexts rejected with clear error
- Works in both dev and production environments

---

### Phase 1 Deliverables
- ✅ Contexts defined in YAML
- ✅ TypeScript types complete
- ✅ Reference parser supports context
- ✅ Context loader functional

**Test:** Can load contexts, parse references, generate canonical strings

---

## Phase 2: Parameter Resolution with Contexts

**Duration:** 1 week  
**Goal:** Parameters resolve correctly based on contexts

### 2.1 Parameter Schema Extension
**Files:**
- `param-registry/schemas/parameter-schema.yaml` (extend)
- `param-registry/examples/context-aware-parameters.yaml` ✅ (created)

**Tasks:**
- [ ] Add `context_filter` to parameter schema
- [ ] Add `visited_filter` to parameter schema
- [ ] Add `edge_reference` to parameter schema
- [ ] Update validation logic
- [ ] Create 5-10 example parameters with contexts

**Acceptance Criteria:**
- Example parameters validate successfully
- Schema rejects invalid context values
- Can save and load context-aware parameters

---

### 2.2 Resolution Logic
**Files:**
- `graph-editor/src/lib/parameterRegistry.ts` (extend)

**Tasks:**
- [ ] Implement `matchesActiveContexts()` helper
- [ ] Implement `resolveEdgeParameter()` with fallback hierarchy:
  1. Exact match (visited + context)
  2. Context-only match
  3. Visited-only match
  4. Base parameter
- [ ] Add parameter caching for performance
- [ ] Handle missing parameters gracefully
- [ ] Log resolution path for debugging

**Code:**
```typescript
export function resolveEdgeParameter(
  edgeSlug: string,
  visitedNodes: string[],
  activeContexts: ActiveContexts,
  paramType: 'mean' | 'stdev',
  parameters: Parameter[]
): number | null {
  // Fallback hierarchy implementation
}
```

**Acceptance Criteria:**
- Resolution follows correct fallback order
- Performance acceptable (< 1ms per edge)
- Handles edge cases (no parameters, all filtered out)

---

### 2.3 Graph Integration
**Files:**
- `graph-editor/src/lib/graphCalculations.ts` (extend)
- `graph-editor/src/components/GraphCanvas.tsx` (extend)

**Tasks:**
- [ ] Add `activeContexts` to graph state
- [ ] Recalculate graph when contexts change
- [ ] Use `resolveEdgeParameter()` for all edge probabilities
- [ ] Show parameter source in edge tooltips
- [ ] Add "parameter not found" warnings

**Acceptance Criteria:**
- Graph updates when contexts change
- Correct parameters applied to edges
- Users can see which parameter is active

---

### Phase 2 Deliverables
- ✅ Parameters support context filters
- ✅ Resolution logic works with fallback
- ✅ Graph calculations use context-aware parameters

**Test:** Load graph, set contexts, verify correct parameters applied

---

## Phase 3: UI Components

**Duration:** 1 week  
**Goal:** User can filter contexts and see impact

### 3.1 Context Selector Component
**Files:**
- `graph-editor/src/components/ContextSelector.tsx` (create)

**Tasks:**
- [ ] Create `ContextSelector` component
- [ ] Implement checkbox UI for context values
- [ ] Add "All" / "None" toggles per context
- [ ] Add collapsible sections
- [ ] Style to match existing UI
- [ ] Add tooltips for context descriptions

**UI Mockup:**
```
┌─ Context Filters ────────────────────┐
│ Select which contexts to include     │
│                                       │
│ ▼ Marketing Channel       [All][None]│
│   ☑ Google Ads                        │
│   ☑ Facebook Ads                      │
│   ☐ Organic Search                    │
│   ☐ Email Campaign                    │
│                                       │
│ ▼ Device Type             [All][None]│
│   ☑ Mobile                            │
│   ☑ Desktop                           │
│   ☐ Tablet                            │
└───────────────────────────────────────┘
```

**Acceptance Criteria:**
- Component renders correctly
- State updates on checkbox change
- Persists selection in localStorage
- Responsive design

---

### 3.2 What-If Panel Integration
**Files:**
- `graph-editor/src/components/WhatIfPanel.tsx` (create or extend)

**Tasks:**
- [ ] Create/extend What-If panel
- [ ] Integrate `ContextSelector`
- [ ] Add context state management
- [ ] Show active context summary
- [ ] Add "Reset to All" button
- [ ] Show impact metrics (how many params affected)

**Acceptance Criteria:**
- Context selector appears in what-if panel
- Changing contexts triggers graph recalculation
- Shows which contexts are active

---

### 3.3 Edge Properties Context Display
**Files:**
- `graph-editor/src/components/PropertiesPanel.tsx` (extend)

**Tasks:**
- [ ] Show active parameter source for edge
- [ ] Display context filters for current parameter
- [ ] List all context-specific parameters for this edge
- [ ] Add "Create Context Parameter" button
- [ ] Show fallback chain when parameter missing

**UI Mockup:**
```
┌─ Edge: signup ───────────────────────┐
│ Probability: 35% ± 4%                 │
│                                       │
│ Parameter Source:                     │
│ 📋 signup-google                      │
│ Context: channel=google               │
│ [View] [Edit]                         │
│                                       │
│ Other Context Parameters:             │
│ • google + mobile: 32%                │
│ • facebook + desktop: 28%             │
│                                       │
│ [Create Context Parameter...]         │
└───────────────────────────────────────┘
```

**Acceptance Criteria:**
- Shows which parameter is active
- Lists available context parameters
- Buttons functional (view/edit)

---

### Phase 3 Deliverables
- ✅ Context selector UI complete
- ✅ Integrated into what-if panel
- ✅ Edge properties show context info

**Test:** User can select contexts, see graph update, view parameter sources

---

## Phase 4: Parameter Creation & Management

**Duration:** 1 week  
**Goal:** Users can create and edit context parameters

### 4.1 Create Context Parameter Dialog
**Files:**
- `graph-editor/src/components/CreateContextParameterDialog.tsx` (create)

**Tasks:**
- [ ] Create modal dialog component
- [ ] Context filter selector (dropdowns)
- [ ] Parameter name/ID generation
- [ ] Value input (mean, stdev)
- [ ] Validation
- [ ] Save to registry (file creation)

**UI Mockup:**
```
┌─ Create Context Parameter ───────────┐
│                                       │
│ Edge: signup                          │
│ Parameter Type: probability (mean)    │
│                                       │
│ Context Filters:                      │
│ Channel:  [Google Ads      ▼] [×]    │
│ Device:   [Mobile          ▼] [×]    │
│ [+ Add Context]                       │
│                                       │
│ Parameter ID: signup-google-mobile    │
│ Name: Signup - Google Mobile          │
│                                       │
│ Value:                                │
│ Mean:  [0.32] StDev: [0.06]          │
│                                       │
│ [Cancel]        [Create & Link]       │
└───────────────────────────────────────┘
```

**Acceptance Criteria:**
- Dialog opens from edge properties
- Validates input
- Generates correct YAML file
- Links parameter to edge

---

### 4.2 Parameter Browser
**Files:**
- `graph-editor/src/components/ParameterBrowser.tsx` (create)

**Tasks:**
- [ ] Search/filter parameters
- [ ] Filter by context
- [ ] Show parameter details
- [ ] Multi-select for edges with multiple contexts
- [ ] Link selected parameters to edge

**Acceptance Criteria:**
- Can search by name, tag, context
- Shows filtered results
- Can link parameters to edges

---

### 4.3 Context Coverage Analysis
**Files:**
- `graph-editor/src/lib/contextAnalysis.ts` (create)
- `graph-editor/src/components/CoverageAnalysis.tsx` (create)

**Tasks:**
- [ ] Calculate parameter coverage matrix
- [ ] Identify missing combinations
- [ ] Suggest high-priority parameters to create
- [ ] Show traffic estimates per combination
- [ ] Generate parameter templates

**UI Mockup:**
```
┌─ Parameter Coverage: signup ─────────┐
│                                       │
│ Coverage: 6/15 combinations (40%)    │
│                                       │
│ Missing High-Traffic Combinations:   │
│ 1. organic + mobile (18% traffic)    │
│    Currently using: signup-base       │
│    [Create Parameter]                 │
│                                       │
│ 2. facebook + mobile (8% traffic)    │
│    Currently using: signup-mobile     │
│    [Create Parameter]                 │
└───────────────────────────────────────┘
```

**Acceptance Criteria:**
- Shows coverage percentage
- Identifies missing combinations
- Prioritizes by traffic volume
- Can create parameters from suggestions

---

### Phase 4 Deliverables
- ✅ Can create context parameters from UI
- ✅ Parameter browser functional
- ✅ Coverage analysis shows gaps

**Test:** Create new context parameter, verify YAML file, link to edge, use in graph

---

## Phase 5: Advanced Features & Polish

**Duration:** 1 week  
**Goal:** Production-ready with advanced features

### 5.1 Performance Optimization
**Tasks:**
- [ ] Parameter loading lazy/async
- [ ] Cache resolution results
- [ ] Debounce context changes
- [ ] Optimize graph recalculation
- [ ] Profile and benchmark

**Target Performance:**
- Parameter resolution: < 1ms per edge
- Graph recalculation: < 100ms for 100-node graph
- Context change: < 200ms total (with debounce)

---

### 5.2 Error Handling & Validation
**Tasks:**
- [ ] Validate context values against definitions
- [ ] Warn on missing parameters
- [ ] Detect parameter conflicts (duplicate references)
- [ ] Graceful degradation (missing context file)
- [ ] Error messages in UI

---

### 5.3 Documentation & Examples
**Tasks:**
- [ ] Update user documentation
- [ ] Create video tutorial
- [ ] Add inline help tooltips
- [ ] Create example graphs with contexts
- [ ] Update API documentation

---

### 5.4 Testing
**Tasks:**
- [ ] Unit tests for all utilities
- [ ] Integration tests for resolution logic
- [ ] E2E tests for UI workflows
- [ ] Performance tests
- [ ] Edge case testing

**Test Coverage Target:** > 80%

---

### Phase 5 Deliverables
- ✅ Performance optimized
- ✅ Error handling robust
- ✅ Documentation complete
- ✅ Tests passing

**Test:** Full regression suite, production load testing

---

## Phase 6: Data Pipeline Integration (Future)

**Duration:** 3-4 weeks  
**Goal:** Connect parameters to external data sources, monitoring, and Bayesian updating  
**Status:** Not in v1 scope - design documented, implementation deferred

**See:** `PARAMETER_DATA_ARCHITECTURE.md` and `PARAMETER_DATA_PIPELINE.md` for complete design

---

### 6.1 External Data Sources (Week 1)
**Goal:** Parameters fetch values from external sources instead of static YAML

**Features:**
- Google Sheets integration (read priors)
- SQL database connections (read from data warehouse)
- Webhook/REST API support (real-time values)
- Caching with configurable refresh frequency
- Fallback to static values if source unavailable

**Example:**
```yaml
id: signup-google-mobile
prior_source:
  type: sheets
  url: "https://docs.google.com/spreadsheets/d/..."
  range: "Priors!B2:C2"
  refresh_frequency: "1h"
  
fallback_value:
  mean: 0.32
  stdev: 0.06
```

---

### 6.2 Data Persistence Layer (Week 2)
**Goal:** Store parameter values, posteriors, and history in database

**Features:**
- Parameter value cache (in-memory + persistent)
- Historical tracking (prior values over time)
- Audit log (who changed what, when)
- Version control integration (Git commits)

**Database Schema:**
```sql
CREATE TABLE parameter_values (
  param_id VARCHAR,
  timestamp TIMESTAMP,
  mean FLOAT,
  stdev FLOAT,
  source VARCHAR,  -- 'sheets', 'sql', 'manual', etc.
  PRIMARY KEY (param_id, timestamp)
);

CREATE TABLE parameter_posteriors (
  param_id VARCHAR,
  timestamp TIMESTAMP,
  prior_mean FLOAT,
  prior_stdev FLOAT,
  observations_trials INT,
  observations_successes INT,
  posterior_mean FLOAT,
  posterior_stdev FLOAT,
  divergence FLOAT,
  PRIMARY KEY (param_id, timestamp)
);
```

---

### 6.3 Observation Queries (Week 2-3)
**Goal:** Query raw event data for Bayesian updating

**Features:**
- SQL query templates with context injection
- Conditional filtering (visited nodes → event stream filtering)
- Date sharding for time series analysis
- Aggregation to trials/successes
- Minimum sample size enforcement

**Example Query:**
```yaml
observation_source:
  type: sql
  connection: "analytics_datalake"
  query: |
    WITH visited_users AS (
      SELECT user_id, session_id
      FROM events
      WHERE node_slug IN ('homepage', 'pricing')
      AND channel = 'google'
      AND device = 'mobile'
      GROUP BY user_id, session_id
      HAVING COUNT(DISTINCT node_slug) = 2  -- Visited ALL
    )
    SELECT 
      COUNT(*) as trials,
      SUM(converted) as successes
    FROM user_journeys j
    INNER JOIN visited_users v USING (user_id, session_id)
    WHERE j.edge_slug = 'signup'
```

---

### 6.4 Daily Monitoring Service (Week 3)
**Goal:** Automated daily checks of parameter health

**Features:**
- Scheduled parameter refresh (cron jobs)
- Fetch latest priors from sources
- Query observations from data lake
- Basic monitoring: sample size, conversion rate
- Alerts for missing data or source failures
- Write monitoring data to dashboard

**Service:**
```typescript
// Runs daily via cron
export class DailyMonitoringService {
  async run() {
    const params = await loadAllActiveParameters();
    
    for (const param of params) {
      // Fetch prior
      const prior = await fetchPrior(param.prior_source);
      
      // Query observations
      const obs = await queryObservations(param.observation_source);
      
      // Basic monitoring
      if (obs.trials < param.min_sample_size) {
        await alert('Low sample size', param.id, obs.trials);
      }
      
      // Store for dashboard
      await writeToDashboard({
        param_id: param.id,
        prior: prior.mean,
        observed_rate: obs.successes / obs.trials,
        sample_size: obs.trials,
        timestamp: new Date()
      });
    }
  }
}
```

**Deliverable:** Basic health monitoring operational, no Bayesian updating yet

---

### 6.5 Bayesian Updating Engine (Week 4)
**Goal:** Update priors based on observed data

**Features:**
- Beta-Binomial conjugate updates (probabilities)
- Normal-Normal conjugate updates (costs, times)
- Configurable update frequency (daily, weekly)
- Write posteriors back to storage
- Posterior can become next prior

**Algorithm:**
```typescript
async function updateParameter(paramId: string) {
  const param = await loadParameter(paramId);
  
  // Get prior
  const prior = await fetchPrior(param.prior_source);
  
  // Get observations
  const obs = await queryObservations(param.observation_source);
  
  // Bayesian update (Beta-Binomial)
  const posterior = {
    alpha: prior.alpha + obs.successes,
    beta: prior.beta + (obs.trials - obs.successes),
  };
  posterior.mean = posterior.alpha / (posterior.alpha + posterior.beta);
  
  // Write posterior
  await writePosterior(param.posterior_destination, posterior);
}
```

---

### 6.6 Model Fit Analysis (Week 4)
**Goal:** Detect when priors diverge from reality

**Features:**
- Compare prior to observed data
- Calculate divergence (standard deviations from expected)
- Alert thresholds (e.g., > 2 SD = warning, > 3 SD = critical)
- Time series drift detection (priors drifting over time)

**Divergence Calculation:**
```typescript
function calculateDivergence(prior, observed, sampleSize) {
  const expectedRate = prior.mean;
  const observedRate = observed.successes / observed.trials;
  
  // Standard error of observed rate
  const se = Math.sqrt(
    (observedRate * (1 - observedRate)) / sampleSize
  );
  
  // Z-score: how many standard errors away?
  const divergence = Math.abs(observedRate - expectedRate) / se;
  
  return {
    divergence,
    status: divergence > 3 ? 'critical' : divergence > 2 ? 'warning' : 'ok'
  };
}
```

---

### 6.7 RAG Dashboard (Week 4)
**Goal:** Visual dashboard showing parameter health (Red/Amber/Green)

**Features:**
- **Red:** Prior diverges significantly (> 3 SD), needs attention
- **Amber:** Prior diverging moderately (> 2 SD), monitor
- **Green:** Prior aligns with observations, healthy
- Visual overlay on graph editor
- Drill-down to see specific parameter details
- Time series charts showing drift over time

**UI Mockup:**
```
┌─ Parameter Health Dashboard ──────────────────────────────────────┐
│                                                                    │
│  Graph: Checkout Flow                                             │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                                                             │  │
│  │     [Node]──────●──────>[Node]──────●──────>[Node]         │  │
│  │               🟢                  🟡                        │  │
│  │               signup              checkout                  │  │
│  │                                                             │  │
│  │  [Node]──────●──────>[Node]                                │  │
│  │            🔴                                               │  │
│  │            abandoned                                        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  Parameter Status:                                                │
│                                                                    │
│  🔴 CRITICAL (3)                                                  │
│  • abandoned.p.mean: Expected 15%, Observed 22% (+7pp, 3.2σ)    │
│    → Sample: 1,234 trials | Updated: 2h ago                      │
│    [View Details] [Update Prior]                                 │
│                                                                    │
│  • checkout-mobile.p.mean: Expected 45%, Observed 38% (-7pp)     │
│    → Sample: 892 trials | Updated: 1h ago                        │
│                                                                    │
│  🟡 WARNING (2)                                                   │
│  • checkout.p.mean: Expected 55%, Observed 52% (-3pp, 2.1σ)     │
│                                                                    │
│  🟢 HEALTHY (8)                                                   │
│  • signup.p.mean: Expected 32%, Observed 33% (+1pp, 0.4σ) ✓     │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

**Visual Indicators on Graph:**
- 🟢 Green dot: Parameter healthy
- 🟡 Amber dot: Parameter diverging moderately
- 🔴 Red dot: Parameter needs attention
- Click for details panel

---

### Phase 6 Deliverables

**After completion:**
- ✅ Parameters fetch priors from external sources (Sheets, SQL, APIs)
- ✅ Parameter values cached and persisted
- ✅ Observation queries working (context + conditional filtering)
- ✅ Daily monitoring service operational
- ✅ Bayesian updating running (posteriors calculated)
- ✅ Model fit analysis detecting divergence
- ✅ RAG dashboard showing parameter health
- ✅ Alerts sent when parameters need attention

**Advanced (Optional):**
- ✅ MCMC sampling for complex distributions
- ✅ Time series forecasting
- ✅ Automated prior updates (with approval workflow)
- ✅ Multi-armed bandit optimization

---

## Context Extensions (Future)

### Extensions Not in v1 Scope

#### Context Hierarchies
**Example:** `device > mobile > ios > iphone`
**Use case:** Different parameters for iPhone vs Android
**Effort:** 2 weeks

#### Dynamic Context Values
**Example:** New UTM sources added at runtime
**Use case:** Marketing teams adding campaigns
**Effort:** 1 week

#### Context Operators
**Example:** `browser_version >= 120`
**Use case:** "All modern browsers"
**Effort:** 1 week

#### Context in Case Parameters
**Example:** A/B test variants by channel
**Use case:** Different test results per context
**Effort:** 1 week

---

## Dependencies & Risks

### Dependencies
1. **Parameter loader** (Phase 0) - Must complete first
2. **YAML parsing library** - Already available
3. **UI framework** - React (already in use)

### Risks
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Performance issues with many contexts | Medium | High | Implement caching, lazy loading |
| Combinatorial explosion (too many params) | High | Medium | Coverage analysis, suggest only top combinations |
| User confusion (too complex) | Medium | Medium | Good UI, documentation, examples |
| Parameter conflicts (duplicate references) | Low | High | Validation, conflict detection |

---

## Success Metrics

### Phase 1-2 Success
- [ ] Can load contexts from registry
- [ ] References parse correctly
- [ ] Parameters resolve with contexts

### Phase 3-4 Success
- [ ] Users can filter contexts in UI
- [ ] Graph updates correctly
- [ ] Can create new context parameters

### Production Success (3 months post-launch)
- [ ] 80%+ parameter coverage for top contexts
- [ ] Users creating context parameters weekly
- [ ] What-if analysis used in decision-making
- [ ] No performance complaints

---

## Timeline Summary

### v1: Context Parameters (4 weeks)
```
Week 1: Phase 0 (Prerequisites) + Phase 1 (Core Infrastructure)
Week 2: Phase 2 (Resolution Logic)
Week 3: Phase 3 (UI Components)
Week 4: Phase 4 (Parameter Management) + Phase 5 (Polish)
```

**Total:** 4 weeks to production-ready context parameters

**Deliverables:**
- ✅ Graphs with context-aware parameters
- ✅ What-if analysis with context filtering
- ✅ Static parameter values from YAML/registry
- ✅ Basic monitoring (manual checks)

---

### v2: Data Pipeline Integration (3-4 weeks, future)
```
Week 1: External data sources + Data persistence
Week 2: Observation queries + Daily monitoring
Week 3: Bayesian updating + Model fit analysis
Week 4: RAG dashboard
```

**Total:** 3-4 weeks for full data pipeline

**Deliverables:**
- ✅ Parameters from external sources (Sheets, SQL, APIs)
- ✅ Data persistence (cache + history)
- ✅ Daily monitoring service
- ✅ Bayesian posterior updates
- ✅ Model fit detection
- ✅ RAG dashboard for parameter health

---

## Next Steps

### Immediate (This Evening)
1. Review design documents with team
2. Get approval on reference notation format
3. Decide on open questions (Q1-Q4 in design doc)
4. Prioritize: Start Phase 0 or jump to Phase 1?

### This Week
1. Complete Phase 0 (parameter loader) if not done
2. Start Phase 1 (context infrastructure)
3. Create initial context definitions
4. Build reference parser

### Next Week
1. Complete Phase 1-2
2. Test resolution logic thoroughly
3. Begin Phase 3 (UI)

---

## Open Questions for Decision

1. **Reference format approval:** Chainable `.visited().context()` vs alternatives?
2. **Context scope:** Start with just channel+device or include all contexts from day 1?
3. **UI placement:** What-if panel vs separate "Contexts" tab?
4. **Parameter creation:** UI-based or YAML-only for v1?
5. **Coverage targets:** What % coverage is "good enough"?

**Recommendation:** Make these decisions before starting implementation to avoid rework.

---

**Ready to proceed:** Awaiting design approval, then begin Phase 1 implementation.

