# Contexts: Implementation Documentation

**Status**: Implementation specification — DRAFT  
**Target**: v1 contexts support  
**Last Updated**: 2025-11-24

---

## Overview

This directory contains the complete implementation design for contexts support in Dagnet. The design has been decomposed into focused documents covering different aspects of the system.

---

## Document Structure

### 1. [CONTEXTS_ARCHITECTURE.md](./CONTEXTS_ARCHITECTURE.md)
**Core architecture, data model, and terminology**

- Terminology and naming conventions (sliceDSL, dataInterestsDSL, currentQueryDSL)
- Data model and schema changes
- Query signatures vs slice keys (separation of concerns)
- Data query signature service
- DSL parsing infrastructure
- Component reuse strategy

**Read this first** to understand the foundational architecture.

### 2. [CONTEXTS_REGISTRY.md](./CONTEXTS_REGISTRY.md)
**Context definitions, otherPolicy, and MECE detection**

- Context registry structure (index + definition files)
- Context definition schema (otherPolicy, source mappings)
- Regex pattern support for high-cardinality mappings
- otherPolicy impact matrix (null, computed, explicit, undefined)
- MECE detection algorithm
- Graph-level validation

**Read this** to understand how contexts are defined and validated.

### 3. [CONTEXTS_AGGREGATION.md](./CONTEXTS_AGGREGATION.md)
**Window aggregation logic and 2D grid model**

- Data lookup pattern (MANDATORY for all operations)
- The 2D grid model (context × date)
- Source policy (daily vs non-daily)
- Daily grid aggregation (step-by-step)
- MECE aggregation across context keys
- Subquery generation and batching
- Performance considerations

**Read this** to understand how data is aggregated across contexts and time windows.

### 4. [CONTEXTS_ADAPTERS.md](./CONTEXTS_ADAPTERS.md)
**Data source integrations and nightly runner**

- Amplitude Dashboard REST API research
- Amplitude adapter extensions (context filters, regex patterns)
- Sheets adapter extensions (context HRNs, fallback policy)
- Nightly runner integration (DSL explosion, scheduling)

**Read this** to understand how adapters fetch and store contexted data.

### 5. [CONTEXTS_TESTING_ROLLOUT.md](./CONTEXTS_TESTING_ROLLOUT.md)
**Testing strategy, validation, and deployment**

- Comprehensive testing strategy
- Unit test requirements (DSL, registry, MECE, aggregation)
- Integration test scenarios
- Performance test targets (<1s latency)
- Rollout phases (5 phases over 5+ weeks)
- Monitoring metrics and success criteria

**Read this** to understand test coverage requirements and rollout plan.

### 6. [CONTEXTS_UI_DESIGN.md](./CONTEXTS_UI_DESIGN.md)
**Visual design and user interaction patterns**

- WindowSelector toolbar integration (context chips with dynamic width)
- Per-chip value dropdown (Apply/Cancel pattern)
- Add Context dropdown (accordion sections, auto-uncheck behavior)
- Unrolled state (full DSL editor + Pinned Query modal)
- 10 detailed user flows
- Component hierarchy and implementation notes

**Read this** for complete visual design and UX specifications.

---

## Quick Start Guide

### For Implementers

1. **Start with architecture** → Read `CONTEXTS_ARCHITECTURE.md` to understand the data model
2. **Understand contexts** → Read `CONTEXTS_REGISTRY.md` to learn about otherPolicy and MECE
3. **Implement aggregation** → Follow `CONTEXTS_AGGREGATION.md` for the 2D grid logic
4. **Extend adapters** → Use `CONTEXTS_ADAPTERS.md` to build query filters
5. **Build UI components** → Follow `CONTEXTS_UI_DESIGN.md` for visual design and UX patterns
6. **Test thoroughly** → Follow `CONTEXTS_TESTING_ROLLOUT.md` for comprehensive coverage

### For Reviewers

**Critical sections to review**:
- `CONTEXTS_ARCHITECTURE.md` → Query Signatures vs Slice Keys (separation of concerns)
- `CONTEXTS_REGISTRY.md` → otherPolicy Impact Matrix (affects multiple systems)
- `CONTEXTS_AGGREGATION.md` → MECE Aggregation Across Context Keys (edge cases)
- `CONTEXTS_ADAPTERS.md` → Sheets Fallback Policy (pragmatic vs strict)
- `CONTEXTS_UI_DESIGN.md` → Auto-uncheck Behavior (nudges toward single-key selections)
- `CONTEXTS_TESTING_ROLLOUT.md` → Phase 2: Data Operations Refactoring (highest risk)

---

## Key Design Decisions

### Resolved

1. ✓ **Terminology**: `dataInterestsDSL` (graph) vs `sliceDSL` (window) vs `currentQueryDSL` (UI state)
2. ✓ **Data model**: `sliceDSL` only (no redundant metadata); `d-MMM-yy` date format everywhere
3. ✓ **Stored slices are atomic**: No `contextAny(...)` in persisted `sliceDSL`
4. ✓ **DSL parsing**: Extend existing ParamPackDSLService; extract to shared `constraintParser.ts`
5. ✓ **otherPolicy**: 4 variants (null, computed, explicit, undefined) fully specified
6. ✓ **Regex patterns**: For collapsing high-cardinality source values; in `SourceMapping.pattern`
7. ✓ **MECE detection**: Respects otherPolicy; sets `canAggregate` flag
8. ✓ **Mixed MECE keys**: Aggregate across MECE key only; ignore non-MECE keys
9. ✓ **Daily grid model**: 2D (context × date); reuse existing daily points; incremental fetch
10. ✓ **Window aggregation**: 7 scenarios documented; always aggregate what user asked for
11. ✓ **Amplitude adapter**: Property filters + regex; context → filter mapping via registry
12. ✓ **Sheets fallback**: Fallback to uncontexted with warning
13. ✓ **UI design**: See `CONTEXTS_UI_DESIGN.md` for complete visual spec
14. ✓ **Performance**: In-memory index per variable (lazy build); target <1s aggregation latency
15. ✓ **Error policy**: Never hard fail; graceful degradation with toasts/warnings

### Critical Paths

**Highest risk / most complex**:
1. ⚠️ **Data operations refactoring** — Replace query_signature indexing with sliceDSL
2. ⚠️ **MECE aggregation** — Handle mixed otherPolicy correctly
3. ⚠️ **Amplitude adapter** — Verify API syntax for filters and regex

---

## Related Documentation

- **UI Design**: Integrated as `CONTEXTS_UI_DESIGN.md` (see Document Structure above)
- **High-Level Spec**: See `CONTEXTS.md` for original requirements
- **Implementation Progress**: See `../SCENARIOS_IMPLEMENTATION_PROGRESS.md` for overall project status
- **Archive**: Original 3937-line `CONTEXTS_IMPLEMENTATION.md` preserved with pointer to new structure

---

## Feedback & Questions

For questions or clarifications:
1. Check the specific document for detailed information
2. Review the "Critical Paths" and "Design Decisions" sections
3. See `CONTEXTS_TESTING_ROLLOUT.md` for test coverage requirements

---

## Document Cross-References

### Architecture ↔ Other Docs

- **Architecture** → **Registry**: Context definitions structure
- **Architecture** → **Aggregation**: How sliceDSL is used for lookup
- **Architecture** → **Adapters**: Query signature service usage
- **Architecture** → **Testing**: Slice isolation test requirements

### Registry ↔ Other Docs

- **Registry** → **Aggregation**: MECE detection algorithm usage
- **Registry** → **Adapters**: Source mapping usage in queries
- **Registry** → **Testing**: otherPolicy test coverage matrix

### Aggregation ↔ Other Docs

- **Aggregation** → **Architecture**: Data lookup pattern (mandatory)
- **Aggregation** → **Registry**: MECE detection calls
- **Aggregation** → **Adapters**: Subquery execution
- **Aggregation** → **Testing**: Daily grid test scenarios

### Adapters ↔ Other Docs

- **Adapters** → **Architecture**: Query signature generation
- **Adapters** → **Registry**: Source mapping resolution
- **Adapters** → **Aggregation**: Daily data merging
- **Adapters** → **Testing**: Adapter test requirements

### Testing ↔ Other Docs

- **Testing** → All other docs: Comprehensive coverage requirements
- **Testing** → **Architecture**: Critical path priorities
- **Testing** → **Aggregation**: All 7 scenarios + 4 otherPolicy variants
- **Testing** → **UI Design**: Phase 3 component testing requirements

### UI Design ↔ Other Docs

- **UI Design** → **Architecture**: Terminology alignment (currentQueryDSL, dataInterestsDSL, sliceDSL)
- **UI Design** → **Registry**: otherPolicy impact on dropdowns (show/hide "other")
- **UI Design** → **Aggregation**: AggregationResult status → UI feedback (badges, toasts, Fetch button)
- **UI Design** → **Adapters**: How Fetch button triggers query execution
- **UI Design** → **Testing**: UI component testing in Phase 3

---

## Implementation Phases

1. **Phase 1: Core Infrastructure** (1-2 weeks)
   - Schema updates, DSL parsing, context registry
   - See: `CONTEXTS_ARCHITECTURE.md`, `CONTEXTS_REGISTRY.md`

2. **Phase 2: Data Operations** (2-3 weeks) ⚠️ **CRITICAL**
   - Refactor signature/indexing separation
   - Implement window aggregation with MECE
   - See: `CONTEXTS_AGGREGATION.md`

3. **Phase 3: UI Components** (2 weeks)
   - Context chips with dynamic width (60-450px)
   - Per-chip value dropdowns (Apply/Cancel pattern)
   - Add Context dropdown with accordion sections
   - Unrolled state + Pinned Query modal
   - See: `CONTEXTS_UI_DESIGN.md` for complete visual design

4. **Phase 4: Nightly Runner** (1 week)
   - DSL explosion, scheduling, deduplication
   - See: `CONTEXTS_ADAPTERS.md`

5. **Phase 5: Validation & Polish** (1-2 weeks)
   - Testing, performance tuning, rollout
   - See: `CONTEXTS_TESTING_ROLLOUT.md`

**Total estimated time**: 8-10 weeks

---

## Success Criteria

- All unit tests passing (DSL, registry, MECE, aggregation)
- All integration tests passing (end-to-end flows)
- Query latency <1s (p95)
- Amplitude API usage within budget
- 10+ graphs using contexts within first month
- Zero data corruption incidents
- User feedback predominantly positive

---

**Next**: Start with [CONTEXTS_ARCHITECTURE.md](./CONTEXTS_ARCHITECTURE.md) to understand the foundational design.

