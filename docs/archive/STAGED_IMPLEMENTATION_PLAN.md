# Staged Implementation Plan - From Basic to Advanced

**Purpose:** Show how the system evolves from basic static parameters to full Bayesian monitoring

---

## Implementation Stages

```
v1 (4 weeks)          v2 (3-4 weeks, future)
┌─────────────┐       ┌──────────────────────┐
│  Basic      │  ──>  │  Data Pipeline       │
│  Context    │       │  Integration         │
│  Parameters │       └──────────────────────┘
└─────────────┘
```

---

## Stage 1: Basic Context Parameters (v1)

**Duration:** 4 weeks  
**Status:** Current focus

### What We Build

1. **Context Definitions**
   - Canonical context types (channel, device, utm_source, browser)
   - Context values defined in YAML
   - Loaded from registry

2. **Context-Aware Parameters**
   - Parameters with context filters: `{channel: google, device: mobile}`
   - Parameters with visited filters: `{visited: [homepage, pricing]}`
   - Both combined: visited + context

3. **Reference Notation**
   - `e.signup.context(channel='google').p.mean`
   - `e.signup.visited(pricing).context(channel='google').p.mean`
   - Fallback hierarchy (exact → context → visited → base)

4. **What-If Analysis UI**
   - Context selector (checkboxes for each context value)
   - Graph recalculates when contexts change
   - See impact of different channel/device mixes

5. **Static Parameter Values**
   - Parameters stored in YAML files
   - Manual value entry
   - Version controlled via Git

### What We Don't Have Yet

- ❌ External data sources (parameters still in YAML)
- ❌ Automatic monitoring
- ❌ Bayesian updating
- ❌ Model fit detection
- ❌ RAG dashboard

### Example Workflow (v1)

```
1. Data team creates parameter:
   signup-google-mobile.yaml
   ├── context_filter: {channel: google, device: mobile}
   ├── value: {mean: 0.32, stdev: 0.06}
   └── (value is manually entered)

2. Graph references parameter:
   edge.p.parameter_id = "signup-google-mobile"

3. User does what-if analysis:
   • Check [Google] and [Facebook] in context selector
   • Graph shows conversion with just those channels
   • Can adjust parameter values manually to see impact

4. Monitoring:
   • Manual: Data team checks analytics periodically
   • Manual: Updates YAML files if values drift
   • Manual: Commits changes to Git
```

**Benefits:**
- ✅ Context-aware modeling (different rates by channel/device)
- ✅ What-if analysis (explore scenarios)
- ✅ Version control (Git history of parameter changes)
- ✅ No infrastructure required (just YAML files)

**Limitations:**
- ⚠️ Manual parameter updates (no automation)
- ⚠️ No alerting when reality drifts
- ⚠️ No historical tracking (beyond Git)

---

## Stage 2: Data Pipeline Integration (v2)

**Duration:** 3-4 weeks  
**Status:** Design complete, implementation future

### What We Add

#### 2.1 External Data Sources (Week 1)

**Feature:** Parameters fetch values from external systems

**Example:**
```yaml
id: signup-google-mobile

# NEW: Read from Google Sheets
prior_source:
  type: sheets
  url: "https://docs.google.com/spreadsheets/d/abc/edit"
  range: "Priors!B2:C2"
  refresh_frequency: "1h"

# Fallback if Sheets unavailable
fallback_value:
  mean: 0.32
  stdev: 0.06
```

**Benefit:** Centralized parameter management (Sheets), no code changes needed

---

#### 2.2 Data Persistence (Week 1)

**Feature:** Store parameter history in database

**Schema:**
```sql
CREATE TABLE parameter_values (
  param_id VARCHAR,
  timestamp TIMESTAMP,
  mean FLOAT,
  stdev FLOAT,
  source VARCHAR  -- 'sheets', 'sql', 'manual'
);
```

**Benefit:** Track parameter changes over time, audit trail

---

#### 2.3 Observation Queries (Week 2)

**Feature:** Query raw event data from data lake

**Example:**
```yaml
observation_source:
  type: sql
  connection: "analytics_datalake"
  query: |
    -- Query with context filtering
    SELECT 
      COUNT(*) as trials,
      SUM(converted) as successes
    FROM user_journeys
    WHERE 
      channel = 'google'
      AND device = 'mobile'
      AND edge_slug = 'signup'
      AND created_at >= NOW() - INTERVAL '7 days'
```

**With conditional filtering (visited nodes):**
```sql
WITH visited_users AS (
  -- Filter for users who visited specific nodes
  SELECT user_id, session_id
  FROM events
  WHERE node_slug IN ('homepage', 'pricing')
  GROUP BY user_id, session_id
  HAVING COUNT(DISTINCT node_slug) = 2
)
SELECT 
  COUNT(*) as trials,
  SUM(converted) as successes
FROM user_journeys j
INNER JOIN visited_users v USING (user_id, session_id)
WHERE j.edge_slug = 'signup'
```

**Benefit:** Connect parameters to real data, no manual counting

---

#### 2.4 Daily Monitoring Service (Week 2)

**Feature:** Automated daily health checks

**What it does:**
```typescript
// Runs every day at 6am
async function dailyMonitoring() {
  for (const param of allParameters) {
    // 1. Fetch prior from Sheets
    const prior = await fetchPrior(param);
    
    // 2. Query observations from data lake
    const obs = await queryObservations(param);
    
    // 3. Basic checks
    if (obs.trials < 100) {
      alert('Low sample size: ' + param.id);
    }
    
    // 4. Write to dashboard
    await writeToDashboard({
      param_id: param.id,
      prior: prior.mean,
      observed: obs.successes / obs.trials,
      sample_size: obs.trials
    });
  }
}
```

**Benefit:** Know if parameters have enough data, basic health monitoring

---

#### 2.5 Bayesian Updating (Week 3)

**Feature:** Update priors based on observed data

**Algorithm:**
```typescript
// Prior: Beta(α=8, β=17) ≈ mean=0.32
// Observations: 150 trials, 52 successes (34.7%)

// Posterior: Beta(α'=60, β'=115)
const posterior = {
  alpha: 8 + 52,      // α' = α + successes
  beta: 17 + 98,      // β' = β + failures
  mean: 60/175        // ≈ 0.34
};

// Write posterior back to Sheets
await writeToSheets(posterior);
```

**Benefit:** Priors automatically update as data comes in

---

#### 2.6 Model Fit Analysis (Week 3)

**Feature:** Detect when priors diverge from reality

**Calculation:**
```typescript
// Prior says: 32% ± 6%
// Observed: 52 successes / 150 trials = 34.7%

// Divergence: 2.7% difference
// Standard errors: 0.9σ away (not significant)
// Status: 🟢 GREEN (healthy)

// If observed was 45% (13pp difference):
// Standard errors: 3.2σ away
// Status: 🔴 RED (critical - needs attention)
```

**Benefit:** Automated alerts when model doesn't match reality

---

#### 2.7 RAG Dashboard (Week 4)

**Feature:** Visual health dashboard in graph editor

**UI:**
```
┌─ Graph Editor (Dashboard Mode) ────────────────────┐
│                                                     │
│  [Node]────●────[Node]────●────[Node]              │
│          🟢            🔴                          │
│        signup      checkout                        │
│                                                     │
│  🔴 CRITICAL (1)                                   │
│  • checkout.p.mean: Expected 55%, Observed 42%    │
│    Divergence: 3.2σ | Sample: 892                 │
│    [View Details] [Update Prior]                   │
│                                                     │
│  🟢 HEALTHY (7)                                    │
│  • signup.p.mean: Expected 32%, Observed 33% ✓   │
└─────────────────────────────────────────────────────┘
```

**Indicators:**
- 🟢 Green: Prior aligns with observations (< 2σ)
- 🟡 Amber: Moderate divergence (2-3σ)
- 🔴 Red: Significant divergence (> 3σ)

**Benefit:** At-a-glance parameter health, proactive monitoring

---

### Complete Workflow (v2)

```
1. Data team creates parameter with data source:
   signup-google-mobile.yaml
   ├── prior_source: {type: sheets, url: "...", range: "B2:C2"}
   ├── observation_source: {type: sql, query: "SELECT..."}
   └── bayesian_update: {prior: {alpha: 8, beta: 17}}

2. Daily monitoring service runs:
   ├── Fetches prior from Sheets (cached 1h)
   ├── Queries observations from data lake
   ├── Calculates divergence
   └── Updates dashboard

3. Weekly Bayesian update runs:
   ├── Prior: α=8, β=17 (mean=0.32)
   ├── Observations: 150 trials, 52 successes
   ├── Posterior: α'=60, β'=115 (mean=0.34)
   └── Writes back to Sheets (becomes new prior)

4. User opens graph editor:
   ├── Sees RAG indicators on edges
   ├── 🟢 Most parameters healthy
   ├── 🔴 One parameter flagged red
   └── Drills down to see details

5. Automatic alert sent:
   "checkout.p.mean diverging: Expected 55%, Observed 42% (3.2σ)"
   → Slack notification to #model-monitoring

6. Data team reviews:
   ├── Investigates why checkout dropped
   ├── Discovers UX bug introduced last week
   ├── Fixes bug
   ├── Monitors for recovery
```

---

## Comparison: v1 vs v2

| Feature | v1 (Basic) | v2 (Data Pipeline) |
|---------|------------|-------------------|
| **Context-aware parameters** | ✅ Yes | ✅ Yes |
| **What-if analysis** | ✅ Yes | ✅ Yes |
| **Parameter source** | 📄 YAML files | 🔗 Sheets/SQL/APIs |
| **Parameter updates** | ✋ Manual | 🤖 Automatic |
| **Observation data** | ❌ None | 📊 From data lake |
| **Monitoring** | ✋ Manual checks | 🤖 Daily automated |
| **Divergence detection** | ❌ No | ✅ Yes (with alerts) |
| **Bayesian updating** | ❌ No | ✅ Yes |
| **Historical tracking** | 📝 Git only | 💾 Database + Git |
| **Visual health status** | ❌ No | 🟢🟡🔴 RAG dashboard |
| **Alerting** | ❌ No | ✅ Slack/email |

---

## Migration Path: v1 → v2

### No Breaking Changes!

v2 is fully backward compatible:

**v1 Parameter (still works in v2):**
```yaml
id: signup-google-mobile
context_filter: {channel: google, device: mobile}
value: {mean: 0.32, stdev: 0.06}
```

**v2 Parameter (extended):**
```yaml
id: signup-google-mobile
context_filter: {channel: google, device: mobile}

# NEW: External sources
prior_source: {type: sheets, url: "..."}
observation_source: {type: sql, query: "..."}
bayesian_update: {prior: {alpha: 8, beta: 17}}

# Still have fallback
fallback_value: {mean: 0.32, stdev: 0.06}
```

**Migration strategy:**
1. Deploy v2 code (supports both formats)
2. Continue using v1 parameters (static YAML)
3. Gradually migrate parameters to external sources
4. Enable monitoring for migrated parameters
5. Enable Bayesian updating (opt-in per parameter)

No big-bang migration needed!

---

## When to Move to v2?

### Stay on v1 if:
- ✅ Small number of parameters (< 20)
- ✅ Parameters rarely change (monthly)
- ✅ Manual monitoring acceptable
- ✅ No data lake/warehouse available yet

### Move to v2 when:
- ✅ Many parameters (> 20)
- ✅ Parameters change frequently (weekly)
- ✅ Need automated monitoring
- ✅ Have data lake with event stream
- ✅ Want proactive alerting
- ✅ Need historical tracking beyond Git

---

## Summary

### v1: Foundation (Implement Now)
- ✅ Context-aware parameters
- ✅ What-if analysis
- ✅ Static values (YAML)
- ✅ Manual monitoring

**Time:** 4 weeks  
**Effort:** Medium  
**Value:** High (enables context modeling)

---

### v2: Automation (Implement Later)
- ✅ External data sources
- ✅ Data persistence
- ✅ Observation queries
- ✅ Daily monitoring
- ✅ Bayesian updating
- ✅ Model fit detection
- ✅ RAG dashboard

**Time:** 3-4 weeks  
**Effort:** High (requires data infrastructure)  
**Value:** Very High (fully automated monitoring)

**Prerequisites for v2:**
- Data lake or warehouse available
- Event stream with user journeys
- Google Sheets API access (or alternative)
- Database for persistence
- Scheduled job infrastructure (cron)

---

**Recommendation:** 
1. Implement v1 now (4 weeks)
2. Use in production, gather feedback
3. Build data infrastructure in parallel
4. Implement v2 when ready (3-4 weeks later)

Total time to full system: ~8 weeks (but v1 delivers value after 4 weeks!)



