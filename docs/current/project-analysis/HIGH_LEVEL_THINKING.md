Below is a **detailed, structured summary** of the entire discussion and the **design implications** for building a declarative analytics layer into your conversion-funnel DAG application.

---

# **1. Core Insight: Analytics Must Be Declarative, Not Procedural**

From our exploration, the ideal analytics system for your DAG-based conversion framework is:

* **schema-driven**,
* **declaratively defined**,
* **modular**,
* **data-requirement aware**, and
* **capable of reasoning about topology + evidence + prior/posterior models**.

The takeaway is that **analysis types (Ds)** must be defined as objects describing:

1. **What query shapes they apply to**
2. **What structural conditions must hold**
3. **What external data must be fetched**
4. **How forecasting/uncertainty works**
5. **What outputs they produce**
6. **How the UI should render those outputs**

This makes analytics plug-and-play and breaks all coupling between UI, graph, data storage, and analysis execution.

---

# **2. Standardising B→C: From User Selection to Typed Query Shapes**

User selection (B) and DSL (C) must normalise to a **small algebra** of `QueryShape` types:

### **Core `QueryShape` Kinds**

* `span` (from node → to node)
* `terminal_mix` (set of absorbing nodes)
* `node_focus` (single node)
* `path` (ordered node list)
* `subgraph` (arbitrary selection)

These shapes include:

* **structural fields** (`from`, `to`, `nodes[]`)
* **constraints** (e.g., `visited(x)`, `excluded(y)`, cohort windows, scenario filters)

This gives analytics a **known semantic input** independent of UI interactions.

---

# **3. Declarative Analysis Definitions (“Ds”)**

An **AnalysisDefinition** (D) is a JSON-serializable object specifying:

## **3.1. Scope**

```ts
scope: {
  allowed_query_kinds: [...],
  predicates: [... structural predicates ...],
  scenario: {
    min: number,
    max: number | null,
    supports_delta: boolean
  },
  requires: {
    edge_probabilities?: boolean,
    event_timestamps?: boolean,
    absorbing_only?: boolean,
    // etc.
  }
}
```

### Predicates include:

* `unique_start`
* `unique_end`
* `end_absorbing`
* `nodes_all_absorbing`
* `forms_simple_path`
* `allows_constraints`
* etc.

This lets the system determine **which Ds are applicable** for the user’s current selection.

---

# **4. Declarative Data Requirements (Critical New Component)**

Ds must specify what external data they require:

```ts
data_requirements: {
  sources: [
    { id: "graph", kind: "graph_topology" },
    {
      id: "edge_evidence",
      kind: "cohort_lag_timeseries",
      needs_full_history: true,
      lag_range: { min: 0, max: 90 },
      needed_fields: ["n", "k", "posterior_mean_p", "posterior_std_p"]
    }
  ],
  join_keys: { ... }
}
```

Implications:

* Ds can **force fetching** of “full cohort-lag k/n history”.
* Evidence remains **outside the graph**, but Ds specify how to bind it.
* The fetch layer becomes a **planner**:
  “Given D + QueryShape, fetch exactly the required evidence.”

This prevents polluting the graph JSON and keeps the system modular.

---

# **5. Evidence Model: Actual vs Posterior-Only vs None**

To support partial cohorts and forecasting, evidence must distinguish:

| Evidence State     | Meaning                                      |
| ------------------ | -------------------------------------------- |
| `"actual"`         | we observed k/n in that window               |
| `"posterior_only"` | no direct data, but model learnt a posterior |
| `"none"`           | no information at all                        |

This lives in the evidence store:

```ts
interface EdgeLagEvidence {
  edge_id: string;
  cohort_id: string;
  lag_day: number;
  n: number;
  k: number;
  state: "actual" | "posterior_only" | "none";
  posterior_mean_p: number;
  posterior_std_p: number;
}
```

This is essential for splitting **observed vs forecast** segments.

---

# **6. Forecasting + Uncertainty Bands (Fan Charts)**

We defined a sophisticated D:

### `cohort_progress_fan` (Cohort maturity fan chart)

Key features:

* Requires **start → success span**
* Requires **event timestamps**
* Requires **full lag-timeseries evidence**
* Allows **forecasting** beyond observable ages
* Uses **posterior mean & std** for projection
* Produces **fan charts** with upper/lower bounds

Declarative `forecast` and `uncertainty` blocks:

```jsonc
"forecast": {
  "enabled": true,
  "max_horizon": { "unit": "days", "value": 90 },
  "requires": { "posterior_edge_params": true },
  "uses": "posterior_mean_and_std"
},
"uncertainty": {
  "mode": "band_from_variance",
  "output_metrics": ["completion_mean", "completion_p05", "completion_p95"]
}
```

This makes partial cohort forecasting a **first-class capability**.

---

# **7. Runner Responsibilities Become Simple**

Once Ds declare their requirements, the “runner” only needs to:

1. Determine **which D is enabled** for the current QueryShape.
2. Use `data_requirements` to build a **fetch plan**.
3. Run analytic logic (e.g., build CDF, forecast tail).
4. Emit structured results with labels:

   * `"observed"` vs `"forecast"`
   * `mean`, `p05`, `p95`
5. Pass results + D’s `semantics` to display layer (E).

This massively simplifies the backend.

---

# **8. Display Layer (E) Becomes Purely Declarative**

Ds specify how charting works:

```jsonc
"semantics": {
  "primary_dimension": "time_since_start",
  "metrics": ["completion_mean", "completion_p05", "completion_p95"],
  "default_chart": "line",
  "styling_hints": {
    "fan_chart": true,
    "observed_vs_forecast_split": "by_time"
  }
}
```

The charting engine becomes a renderer of:

* the **data schema** emitted by the runner
* the **styling hints** given by D

UI never needs to know “how to compute a fan chart”.

---

# **9. Architectural Implications**

## **9.1. The analytics system becomes declarative + pluggable**

Every new analysis is:

* a JSON block,
* plus a small runner function,
* no UI work required,
* no graph schema changes,
* no backend rewiring.

## **9.2. You formalise an analytics “contract”**

The system enforces:

```
QueryShape + ScenarioSet → check D.scope → 
D.data_requirements → fetch → run → produce D.semantics output.
```

Predictable, testable, and extensible.

## **9.3. Modular evidence stores**

Evidence can live anywhere (SQL, BigQuery, parquet files, Postgres), as long as the fetch layer can fulfil requirements.

Graph stays clean.

## **9.4. Strong separation of concerns**

| Layer      | Responsibility                                   |
| ---------- | ------------------------------------------------ |
| UI         | only creates node/edge selections → DSL          |
| DSL        | only maps selections → QueryShape                |
| D Registry | declares analytic capabilities & constraints     |
| Fetcher    | retrieves exactly the required data blocks       |
| Runner     | computes analytics output from QueryShape + data |
| Charts     | render based on semantics & styling hints        |

---

# **10. System Strengths Gained**

With this design, your app gains:

### **1. Expressive power**

Complex analyses (cohort maturity + forecasting + confidence bands) are declaratively specified.

### **2. Flexibility**

Adding a new analysis = adding a JSON file, not rewriting code.

### **3. Predictability**

The system knows:

* What the user selected
* What analytics are allowed
* What data is needed
* How to run and render the analysis

### **4. Separation of graph + evidence**

Graph stays a pure DAG with node/edge metadata; all statistical evidence and posteriors live elsewhere.

### **5. Fully generalisable**

You can add:

* Bayesian forecasting
* Markov chain lifetime value modelling
* Scenario deltas
* Bridge charts
* Survival curves
* Funnel decomposition
  simply by defining new Ds.

---

# **11. Final Conclusion**

The discussion confirms that the **declarative architecture is not only viable but ideal**, and robust enough to support:

* arbitrarily sophisticated analytics,
* partial-cohort modelling,
* uncertainty propagation,
* multi-scenario comparison,
* a live registry of analysis types,
* and automatic UI gating.

This gives your application a **general analytics engine** rather than a bundle of special-case logic 