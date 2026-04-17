# Phase 4: Adapter Extensions - Architecture Summary

**Date**: 2025-11-24  
**Status**: Complete  

---

## Architecture Decision: TypeScript Orchestrator

### Core Principle

**TypeScript handles ALL business logic and orchestration**
**Python handles ONLY compute-heavy algorithms**

### Why This Architecture?

1. **Business logic already in TypeScript**:
   - Context registry
   - DSL parsing and explosion
   - otherPolicy logic
   - File operations (git, IndexedDB)
   - Parameter packs
   - Query signatures
   - Amplitude adapter

2. **Python strengths**:
   - Graph algorithms (NetworkX)
   - MSMDC generation
   - Statistical compute (MCMC, Bayesian)
   - Heavy numerical processing

3. **Avoid duplication**:
   - No need to rewrite business logic in Python
   - Single source of truth
   - Easier maintenance

---

## Data Flow: Nightly Runner

```
TypeScript Orchestrator (Vercel Cron)
  ↓
  ├─ Load graph from git (TS)
  ├─ Check dataInterestsDSL (TS)
  ├─ Explode DSL → atomic slices (TS: dslExplosion.ts)
  ├─ Load context registry (TS)
  ├─ Apply otherPolicy (TS)
  ├─ Build Amplitude queries (TS: buildDslFromEdge.ts)
  ├─ Call Amplitude API (TS)
  ├─ [Optional] Call Python for MSMDC (Python: /api/generate-all-parameters)
  ├─ [Optional] Call Python for stats enhancement (Python: /api/stats-enhance)
  └─ Store results to git (TS)
```

---

## Python Endpoints (Compute Only)

### Current Python API

**`POST /api/generate-all-parameters`**
- **Purpose**: Generate MSMDC queries for all graph parameters
- **Input**: Complete graph object (from TS)
- **Output**: Query strings for each parameter
- **Used by**: Query regeneration service

**`POST /api/stats-enhance`**
- **Purpose**: Statistical enhancement (MCMC, Bayesian, trend-aware)
- **Input**: Raw aggregation data (from TS)
- **Output**: Enhanced statistical parameters
- **Used by**: Statistical enhancement service

**`POST /api/parse-query`** (optional)
- **Purpose**: Parse DSL query (testing/debugging)
- **Input**: Query string
- **Output**: Parsed components

---

## Phase 4 Implementation Summary

### Task 4.1: Amplitude Adapter ✅

**Files Modified**:
- `buildDslFromEdge.ts` - Extended with constraints parameter
- `buildDataQuerySpec.ts` - Query signature generation

**Functionality**:
- Context filter generation from ParsedConstraints
- Regex pattern support for context mappings
- otherPolicy support (null, computed, explicit, undefined)
- Window date resolution (absolute and relative)

### Task 4.2: Sheets Adapter ✅

**Files Modified**:
- `ParamPackDSLService.ts` - Extended HRN regex
- `sheetsContextFallback.ts` - Fallback policy logic

**Functionality**:
- Context HRN parsing (contextAny, window support)
- Fallback from contexted → uncontexted with warnings

### Task 4.3: Nightly Runner ✅ (Architecture)

**Decision**: TypeScript orchestrator, not Python

**Why**:
- Reuses all existing TS business logic
- Python only for compute (MSMDC, stats)
- No duplication risk
- Simpler architecture

**Implementation** (Future Phase):
- `nightlyRunnerService.ts` - TS orchestrator
- Uses existing: `dslExplosion.ts`, `buildDslFromEdge.ts`, `contextRegistry.ts`
- Calls Python only for: MSMDC, stats enhancement

---

## What Python Does NOT Do

- ❌ DSL explosion (TS handles this)
- ❌ Context registry management (TS)
- ❌ File operations (TS)
- ❌ Git operations (TS)
- ❌ otherPolicy logic (TS)
- ❌ Data retrieval orchestration (TS)

---

## Future Considerations

### When TS Needs to Pass Data to Python

**Current Pattern** (works well):
```typescript
// TS passes complete context to Python
const result = await graphComputeClient.generateAllParameters(
  graph,           // Complete graph object
  downstreamOf,    // Filter criteria
  literalWeights   // Algorithm parameters
);
```

**If Python needs window aggregation for MCMC**:
- Option A: TS aggregates data, passes to Python (keeps orchestration in TS)
- Option B: Python receives raw daily data points (TS loads, Python computes)
- **Decision**: Defer until needed (not Phase 4 scope)

---

## Key Insight

> "Python is a compute service, not an orchestrator. TypeScript knows the business logic, Python knows the algorithms."

This keeps:
- Business logic in one place (TS)
- Algorithm implementation in one place (Python)
- Clear separation of concerns
- No duplication

---

## Files in Final State

### TypeScript (Orchestration)
- `dslExplosion.ts` - DSL explosion (canonical)
- `buildDslFromEdge.ts` - Amplitude query building
- `buildDataQuerySpec.ts` - Query signature generation
- `ParamPackDSLService.ts` - Sheets HRN parsing
- `sheetsContextFallback.ts` - Sheets fallback policy
- `contextRegistry.ts` - Context management
- `querySignatureService.ts` - Query signatures

### Python (Compute)
- `msmdc.py` - MSMDC generation
- `stats_enhancement.py` - Statistical methods
- `query_dsl.py` - DSL parsing (for Python-side validation only)

### Tests
- `dslExplosion.test.ts` - TS DSL explosion tests (10 tests)
- TS integration tests for services
- Python tests for algorithms

---

## Summary

Phase 4 clarified architecture:
- **TypeScript**: All orchestration, business logic, data operations
- **Python**: Pure compute (MSMDC, stats, graph algorithms)
- **No duplication**: Each language does what it's best at
- **Clean separation**: TS knows "what", Python knows "how"

This decision simplifies implementation and reduces maintenance burden.


