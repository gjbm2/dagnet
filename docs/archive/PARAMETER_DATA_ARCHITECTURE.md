# Parameter Data Architecture - Ontology and Data Flow

**Purpose:** Clarify the distinction between parameter definitions, parameter values, and external data sources

---

## The Ontology - Four Distinct Concepts

### 1. **Graphs** (Clear ✓)
**What:** Conversion graph structures  
**Storage:** `graphs/my-graph.json`  
**Contains:** Nodes, edges, structure  
**References:** Parameters by ID, cases by ID

---

### 2. **Contexts** (Clear ✓)
**What:** External variable definitions (channel, device, etc.)  
**Storage:** `contexts.yaml`  
**Contains:** Context types and valid values  
**Purpose:** Canonical definitions for filtering parameters

---

### 3. **Cases** (Clear ✓)
**What:** A/B test variant definitions  
**Storage:** `parameters/cases/my-test.yaml`  
**Contains:** Variant names, weights, metadata  
**Integration:** Statsig, Optimizely, etc. (future)  
**Purpose:** Define experiment configurations

---

### 4. **Parameters** vs **Parameter Registry** (Needs Clarification!)

This is where confusion arises. Let me break it down:

#### **Parameter Definition** (YAML file)
**What:** Metadata ABOUT a parameter  
**Storage:** `parameters/probability/signup-google.yaml`

**Contains:**
- ✅ What it is (name, description, type)
- ✅ Where to get current value (data source config)
- ✅ How to interpret it (constraints, distribution)
- ✅ When to refresh (refresh frequency)
- ✅ How to filter it (context filters, visited nodes)
- ❌ NOT the current value itself (unless static)

**Example:**
```yaml
id: signup-google-mobile
name: "Signup Conversion - Google Mobile"
type: probability

# WHERE to get the current value
data_source:
  type: sheets
  url: "https://docs.google.com/spreadsheets/d/abc123/edit#gid=0"
  range: "Parameters!B2"
  refresh_frequency: "1h"
  authentication:
    type: oauth
    
# OR from a webhook
data_source:
  type: webhook
  url: "https://analytics.example.com/api/params/signup-google-mobile"
  refresh_frequency: "15m"
  authentication:
    type: token
    token: "${ANALYTICS_API_KEY}"

# OR from SQL
data_source:
  type: sql
  query: "SELECT mean, stdev FROM conversion_params WHERE param_id = 'signup-google-mobile'"
  connection: "analytics_db"
  refresh_frequency: "30m"

# Fallback/default value (used if source unavailable)
value:
  mean: 0.32
  stdev: 0.06

context_filter:
  channel: google
  device: mobile
```

#### **Parameter Registry** (registry.yaml)
**What:** INDEX of all parameter definitions  
**Storage:** `registry.yaml`

**Purpose:**
- ✅ Discover what parameters exist
- ✅ Find parameter definition by ID
- ✅ Quick metadata (tags, status) without loading full file
- ✅ Dependency tracking

**Example:**
```yaml
parameters:
  - id: signup-google-mobile
    path: parameters/probability/signup-google-mobile.yaml
    type: probability
    tags: [conversion, signup, google, mobile]
    status: active
    last_updated: "2025-10-15T10:00:00Z"
    
  - id: checkout-returning
    path: parameters/probability/checkout-returning.yaml
    type: probability
    tags: [conversion, checkout, returning]
    status: active
    last_updated: "2025-10-10T08:30:00Z"
```

---

## The Data Flow

### Conceptual Model

```
┌─────────────────────────────────────────────────────────────────┐
│                     EXTERNAL DATA SOURCES                        │
│  (The source of truth for current parameter values)             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  • Google Sheets                                                 │
│  • SQL Database (Analytics)                                      │
│  • Webhooks (Real-time APIs)                                     │
│  • Statsig (A/B test configs)                                    │
│  • Static YAML (for stable parameters)                           │
│                                                                  │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ Fetch current values
                         │ (respecting refresh_frequency)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PARAMETER DEFINITIONS                         │
│  (Metadata: what params are, where to get them)                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  parameters/probability/signup-google-mobile.yaml               │
│  ├── Describes: "Signup conversion for Google mobile users"     │
│  ├── Data Source: Sheets URL + range                            │
│  ├── Refresh: Every 1 hour                                       │
│  ├── Fallback: 0.32 ± 0.06                                      │
│  └── Context: channel=google, device=mobile                      │
│                                                                  │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ Indexed by
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PARAMETER REGISTRY                            │
│  (Index: catalog of all parameter definitions)                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  registry.yaml                                                   │
│  ├── List of all parameter IDs                                  │
│  ├── Paths to definition files                                  │
│  ├── Quick metadata (tags, status)                              │
│  └── Dependency graph                                            │
│                                                                  │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ Used by
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                         GRAPHS                                   │
│  (References parameters by ID)                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  my-checkout-flow.json                                           │
│  └── edge: signup                                                │
│      ├── p.parameter_id: "signup-google-mobile"                 │
│      └── (graph doesn't store the value, just the reference)    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Complete Data Flow Example

### Scenario: Load graph and run simulation

#### Step 1: Graph References Parameter
```json
{
  "edges": [
    {
      "id": "e1",
      "slug": "signup",
      "p": {
        "parameter_id": "signup-google-mobile"
      }
    }
  ]
}
```

#### Step 2: Resolve Parameter Reference
```typescript
// 1. Look up in registry
const registry = await loadRegistry();
const paramDef = registry.parameters.find(p => p.id === "signup-google-mobile");

// 2. Load parameter definition
const definition = await loadParameterDefinition(paramDef.path);
// → loads parameters/probability/signup-google-mobile.yaml
```

#### Step 3: Fetch Current Value from Data Source
```typescript
// 3. Check data source type
if (definition.data_source.type === 'sheets') {
  // Fetch from Google Sheets
  const currentValue = await fetchFromSheets(
    definition.data_source.url,
    definition.data_source.range
  );
  // → Returns: { mean: 0.34, stdev: 0.05, lastUpdated: "2025-10-21T14:30:00Z" }
  
} else if (definition.data_source.type === 'webhook') {
  // Fetch from API
  const currentValue = await fetchFromWebhook(
    definition.data_source.url,
    definition.data_source.authentication
  );
  
} else {
  // Use static value from YAML
  const currentValue = definition.value;
}
```

#### Step 4: Cache Value
```typescript
// 4. Cache the value (respect refresh_frequency)
parameterCache.set(
  "signup-google-mobile",
  currentValue,
  definition.data_source.refresh_frequency // e.g., "1h"
);
```

#### Step 5: Use in Simulation
```typescript
// 5. Apply to graph
edge.p.mean = currentValue.mean;  // 0.34 (from live source)
edge.p.stdev = currentValue.stdev; // 0.05

// 6. Run simulation
runMonteCarloSimulation(graph);
```

---

## Parameter Value Sources

### Source Type 1: Static (YAML)
**Use case:** Stable parameters that rarely change

```yaml
id: email-cost-per-send
type: monetary_cost

# No data_source = static value
value:
  mean: 0.001
  currency: GBP

metadata:
  description: "Cost per email send (AWS SES)"
```

### Source Type 2: Google Sheets
**Use case:** Business team maintains values in spreadsheet

```yaml
id: signup-google-mobile
type: probability

data_source:
  type: sheets
  url: "https://docs.google.com/spreadsheets/d/1abc123/edit"
  range: "ConversionRates!B2:C2"  # B2=mean, C2=stdev
  refresh_frequency: "1h"
  authentication:
    type: oauth
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]

value:
  mean: 0.32  # Fallback if Sheets unavailable
  stdev: 0.06
```

### Source Type 3: Webhook / REST API
**Use case:** Real-time values from analytics platform

```yaml
id: checkout-conversion-live
type: probability

data_source:
  type: webhook
  url: "https://analytics.example.com/api/v1/metrics/checkout-conversion"
  method: GET
  headers:
    Accept: application/json
  refresh_frequency: "15m"
  authentication:
    type: bearer
    token: "${ANALYTICS_API_TOKEN}"
  response_mapping:
    mean: "$.data.conversion_rate"
    stdev: "$.data.std_deviation"

value:
  mean: 0.45  # Fallback
  stdev: 0.08
```

### Source Type 4: SQL Query
**Use case:** Parameter computed from data warehouse

```yaml
id: checkout-conversion-by-cohort
type: probability

data_source:
  type: sql
  connection: "analytics_warehouse"  # Defined in config
  query: |
    SELECT 
      AVG(converted::float) as mean,
      STDDEV(converted::float) as stdev
    FROM user_journeys
    WHERE created_at >= NOW() - INTERVAL '7 days'
      AND channel = 'google'
      AND device = 'mobile'
  refresh_frequency: "1h"
  
value:
  mean: 0.35  # Fallback
  stdev: 0.06
```

### Source Type 5: Statsig / Feature Flag Platform
**Use case:** A/B test parameters managed by experimentation platform

```yaml
id: button-colour-test
type: case

data_source:
  type: statsig
  experiment_id: "button_colour_ab_test"
  refresh_frequency: "5m"
  authentication:
    type: api_key
    key: "${STATSIG_API_KEY}"

case:
  variants: [blue, green, red]
  weights: [0.5, 0.3, 0.2]  # Fallback weights
```

---

## Posterior Monitoring & Model Fit

### Problem Statement
You want to:
1. **Fetch priors** from external sources (e.g., Sheets, API)
2. **Monitor posteriors** as real data comes in
3. **Check model fit** against latest data
4. **Update parameters** based on observed data

### Solution: Bidirectional Data Flow

```
External Source (Sheets)
        ↕
Parameter Definition (YAML)
        ↕
Graph (Simulation)
        ↕
Observed Data (Reality)
        ↕
Model Fit Analysis
        ↕
Update External Source (or flag for review)
```

### Implementation

#### 1. Parameter Definition with Monitoring Config

```yaml
id: signup-google-mobile
type: probability

# PRIOR SOURCE (where we get expected values)
data_source:
  type: sheets
  url: "https://docs.google.com/spreadsheets/d/1abc123/edit"
  range: "Priors!B2:C2"
  refresh_frequency: "1h"

# POSTERIOR MONITORING (where we send observed values)
monitoring:
  type: sheets
  url: "https://docs.google.com/spreadsheets/d/1abc123/edit"
  range: "Posteriors!A:E"  # Append mode
  frequency: "1d"  # How often to write observations
  
  # OR webhook for real-time
  # type: webhook
  # url: "https://analytics.example.com/api/observations"

# MODEL FIT CHECKING
analytics:
  bayesian_prior:
    alpha: 8.0
    beta: 17.0
  
  model_fit:
    # Where to get observed data for comparison
    observed_data_source:
      type: sql
      query: |
        SELECT 
          COUNT(CASE WHEN converted THEN 1 END)::float / COUNT(*) as observed_rate,
          COUNT(*) as sample_size
        FROM user_journeys
        WHERE event = 'signup'
          AND channel = 'google'
          AND device = 'mobile'
          AND created_at >= NOW() - INTERVAL '7 days'
    
    # Thresholds for alerts
    thresholds:
      divergence_threshold: 0.05  # Alert if |prior - observed| > 5%
      min_sample_size: 100         # Need 100+ samples to compare
      confidence_level: 0.95

value:
  mean: 0.32
  stdev: 0.06
```

#### 2. Monitoring Service

```typescript
// Service that runs periodically
export class ParameterMonitoringService {
  
  async monitorParameter(paramId: string) {
    // 1. Load parameter definition
    const param = await loadParameter(paramId);
    
    // 2. Get prior (expected value from data source)
    const prior = await fetchFromDataSource(param.data_source);
    
    // 3. Get observed data
    const observed = await fetchObservedData(
      param.analytics.model_fit.observed_data_source
    );
    
    // 4. Compare
    const divergence = Math.abs(prior.mean - observed.observed_rate);
    const sampleSize = observed.sample_size;
    
    // 5. Check thresholds
    if (sampleSize >= param.analytics.model_fit.thresholds.min_sample_size) {
      if (divergence > param.analytics.model_fit.thresholds.divergence_threshold) {
        // Alert: Model diverges from reality!
        await sendAlert({
          paramId,
          prior: prior.mean,
          observed: observed.observed_rate,
          divergence,
          sampleSize
        });
      }
    }
    
    // 6. Write posterior to monitoring destination
    if (param.monitoring) {
      await writeToMonitoring(param.monitoring, {
        timestamp: new Date(),
        paramId,
        prior: prior.mean,
        observed: observed.observed_rate,
        sampleSize,
        divergence
      });
    }
  }
}
```

---

## Updated Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    EXTERNAL DATA SOURCES                          │
│  (Source of truth for current values)                            │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Google Sheets      SQL Database      REST APIs      Statsig     │
│  [Priors Tab]       [Analytics]       [Real-time]   [A/B Tests]  │
│                                                                   │
└─────────┬──────────────────────────────────────────────┬─────────┘
          │                                              │
          │ Fetch priors                    Write posteriors
          ▼                                              ▼
┌──────────────────────────────────────────────────────────────────┐
│              PARAMETER DEFINITIONS (YAML Files)                   │
│  • What the parameter is                                         │
│  • Where to fetch current values (priors)                        │
│  • Where to write observed values (posteriors)                   │
│  • How to check model fit                                        │
│  • Fallback values                                               │
└─────────┬────────────────────────────────────────────────────────┘
          │
          │ Indexed by
          ▼
┌──────────────────────────────────────────────────────────────────┐
│                   PARAMETER REGISTRY (registry.yaml)              │
│  • Catalog of all parameter definitions                          │
│  • Quick lookup by ID                                            │
│  • Dependency tracking                                           │
└─────────┬────────────────────────────────────────────────────────┘
          │
          │ Referenced by
          ▼
┌──────────────────────────────────────────────────────────────────┐
│                        GRAPHS (JSON)                              │
│  • Nodes, edges, structure                                       │
│  • References parameters by ID (not values!)                     │
└─────────┬────────────────────────────────────────────────────────┘
          │
          │ Used by
          ▼
┌──────────────────────────────────────────────────────────────────┐
│                    SIMULATION ENGINE                              │
│  1. Resolve parameter IDs → definitions                          │
│  2. Fetch current values from external sources                   │
│  3. Cache values (respect refresh_frequency)                     │
│  4. Run Monte Carlo simulation                                   │
│  5. Monitor posteriors vs priors                                 │
│  6. Alert on divergence                                          │
└──────────────────────────────────────────────────────────────────┘
```

---

## Summary: The Four-Layer Model

### Layer 1: **External Data Sources**
- Google Sheets, SQL, APIs, Statsig
- The **source of truth** for current parameter values
- Both **read** (priors) and **write** (posteriors)

### Layer 2: **Parameter Definitions** (YAML files)
- Metadata: what the parameter is, how to interpret it
- **Pointers to data sources**: where to fetch/write
- Configuration: refresh frequency, thresholds
- Fallback values (if source unavailable)
- **NOT the current value** (unless static)

### Layer 3: **Parameter Registry** (registry.yaml)
- **Index/catalog** of all parameter definitions
- Quick lookup without loading full YAML
- Dependency tracking
- Change history

### Layer 4: **Graphs** (JSON files)
- Structure: nodes, edges, paths
- **References** parameters by ID
- Does **not store** parameter values directly

---

## Key Insight

**The parameter definition is a CONFIG FILE, not a DATA FILE.**

It tells the system:
- ✅ Where to GET the current value (data source)
- ✅ Where to WRITE observed values (monitoring)
- ✅ How to CHECK model fit (analytics config)
- ✅ What to do if source is unavailable (fallback)

The **actual current value** lives in the external source (Sheets, DB, API).

The **parameter registry** is just an index to find these config files quickly.

---

## Next Steps

1. **Extend parameter schema** to include:
   - `monitoring` config (where to write posteriors)
   - `model_fit` config (how to check divergence)
   
2. **Build data source adapters**:
   - Google Sheets adapter
   - SQL adapter
   - Webhook adapter
   - Statsig adapter
   
3. **Build monitoring service**:
   - Fetch priors
   - Compare to observed
   - Write posteriors
   - Alert on divergence

4. **Add to roadmap** as "Phase 5: External Data Integration"

Does this clarify the architecture?



