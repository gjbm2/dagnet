# Data Architecture Review - 10 Key Features

**Purpose:** High-level overview for colleague review  
**Date:** 2025-11-04

---

## 1. **Unified Parameter Type System** 
**Core Design Decision**

All parameter types (probability, cost_gbp, cost_time) share a common base type (`ParamValue`) with:
- Shared fields: `mean`, `stdev`, `n` (sample size), `distribution`, `parameter_id`, `locked`, `data_source`
- Type-specific constraints: probability [0,1], money can be negative (revenue!), duration with flexible units
- `parameter_id` lives **inside** param objects (not at edge level) - cleaner, self-contained
- `n` on graph for provenance, `k` derivable (k = p × n) - avoids redundancy

**Why it matters:** DRY principle, easy to add new param types, consistent schema across all parameter kinds.

---

## 2. **Dual-Pathway Data Retrieval**
**Default vs Override Pattern**

**Pathway A (Default, Versioned):** External Source → Param File → Graph
- All updates append to parameter file with time windows
- Full history preserved in Git
- Versioned, auditable

**Pathway B (Override/Fallback):** External Source → Graph (direct)
- For casual analysis, quick what-ifs
- Not versioned, ephemeral
- Useful when no param file exists yet

**Why it matters:** Flexibility for different use cases - formal analysis vs exploratory work.

---

## 3. **Graph as View, Param Files as Source of Truth**
**Data Ownership Principle**

- **Graph displays** current parameter values but doesn't own historical data
- **Param files** are canonical source with full history (n, k, time windows, contexts)
- Graph needs only: current p, stdev, distribution for rendering/basic analysis
- Full fidelity (n, k, time windows) lives in params; retrieved when needed

**Why it matters:** Clear separation of concerns, prevents data duplication, enables historical analysis.

---

## 4. **Time-Windowed Parameter Values with Explicit Ranges**
**Historical Data Support**

Parameters support time-windowed values:
- `window_from` + optional `window_to` for explicit date ranges
- Latest value selection based on query time
- Supports latency analysis (45-day journeys need historical params)
- Each retrieval creates new time window (preserves history)

**Why it matters:** Enables "as-at-time" analysis, supports long-running experiments, preserves data provenance.

---

## 5. **Events as First-Class Registry Objects**
**Following Cases Pattern**

Events follow same pattern as Cases:
- Registry index (`events-index.yaml`) with inline definitions (95% of cases)
- Optional detailed files for platform-specific mappings (5% of cases)
- Node schema has optional `event_id` field
- Cascade resolution: `graph.node → node.event_id → event.amplitude.event_type`

**Why it matters:** Consistency across registry types, enables analytics integration, prevents typos.

---

## 6. **Conditional Probabilities with Parameter Condition Storage**
**Complex Query Support**

Conditional probabilities (visited node conditions) require:
- `condition` field in parameter schema storing visited nodes
- Graph editor syncs condition from graph to param
- Amplitude connector uses condition to construct proper queries
- Parameter is self-contained (can query without graph context)

**Why it matters:** Enables Markov chain queries, supports complex conversion analysis, keeps param files queryable.

---

## 7. **Layered State Architecture**
**Three-Tier Persistence**

1. **Non-Durable (React State):** UI interactions, ReactFlow presentation
2. **Durable Client (IndexedDB):** Working state, unsaved changes, tab state
3. **Durable Remote (Git):** Source of truth, versioned, collaborative

**Per-File State:** Shared across tabs viewing same file  
**Per-Tab State:** Independent UI state (selections, panel visibility, what-if overrides)

**Why it matters:** Prevents state synchronization bugs, enables multi-tab editing, clear data flow boundaries.

---

## 8. **Multi-Dimensional Context Support**
**Cartesian Product Filtering**

Parameters support multi-dimensional contexts:
- Single dimension: `context_id: "device-mobile"`
- Multi-dimensional: `context_filters: { device: "mobile", utm_source: "google", segment: "premium" }`
- More specific (more dimensions) wins over less specific
- All specified dimensions must match active contexts

**Why it matters:** Enables sophisticated segmentation analysis, supports complex business questions.

---

## 9. **Human Oversight by Design**
**Interactive Operations with Review**

All data operations are:
- **Interactive:** User reviews before committing
- **Reviewable:** Batch operations produce log files
- **Non-Automatic:** No automated Git commits without explicit action
- **Fail-Gracefully:** Invalid data doesn't crash, warns user

**Why it matters:** Prevents bad data commits, gives users control, maintains data quality.

---

## 10. **Unified Credentials Architecture**
**Three-Tier Authentication**

1. **Public:** No credentials, read-only access
2. **User:** Browser-stored in IndexedDB (`credentials.yaml`), never in Git
3. **System:** Environment variables (serverless/API routes)

**Precedence:** URL params → System secrets → IndexedDB → Public

**Why it matters:** Secure credential management, supports team collaboration, enables automated operations.

---

## Architecture Patterns Summary

### Data Flow
```
External Source → Param File (versioned) → Graph (display)
     OR
External Source → Graph (direct, ephemeral)
```

### State Management
```
ReactFlow State ↔ GraphStore (Zustand) ↔ FileState (IndexedDB) ↔ Git Repository
```

### Registry System
```
Graph → Node → Event (cascade resolution)
Graph → Edge → Parameter (via parameter_id)
```

### Parameter Lifecycle
```
Manual Entry → Parameter File → Graph Display
External Source → Parameter File → Graph Display
Graph Edit → Parameter File (with time window)
```

---

## Key Design Principles

1. **Single Source of Truth:** Parameter files own historical data
2. **Immutability & Versioning:** All changes tracked in Git history
3. **Fail Gracefully:** System works even with weird data, warns user
4. **Inclusive Not Exclusive:** Schemas allow optional fields for extensibility
5. **Everything in Repo:** All param files, events, nodes, cases in Git (except credentials)
6. **Human Oversight:** Interactive operations with review before commits

---

## Implementation Status

- ✅ **Schema Design:** Complete (Phase 0)
- ✅ **State Architecture:** Complete (existing)
- ✅ **Credentials System:** Complete (existing)
- 🚧 **Data Connections:** Phase 1 (synchronous single-param operations)
- ⏳ **Batch Operations:** Phase 2 (asynchronous batch with logs)
- ⏳ **API Routes:** Phase 3 (future, automated)

---

**Next Steps for Review:**
1. Validate schema decisions align with business needs
2. Review data flow patterns for clarity
3. Confirm credential management approach
4. Assess time-windowed value semantics
5. Validate conditional probability query construction


