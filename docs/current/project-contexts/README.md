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

### 7. [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) ⭐
**Task-oriented implementation roadmap**

- 5 implementation phases with detailed tasks
- Task breakdown with owners, durations, and dependencies
- Acceptance criteria for each task
- Risk mitigation strategies
- Testing and rollout plan
- Success criteria and monitoring metrics

**Start here** when ready to begin implementation. References all design docs without duplicating content.

---

## Quick Start Guide

### For Implementers

**📋 Start with [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)** — Task-by-task roadmap with owners, durations, and dependencies.

Then consult design docs as needed:
1. **Architecture** → `CONTEXTS_ARCHITECTURE.md` — Data model, terminology, query signatures
2. **Registry** → `CONTEXTS_REGISTRY.md` — Context definitions, otherPolicy, MECE detection
3. **Aggregation** → `CONTEXTS_AGGREGATION.md` — 2D grid logic, window aggregation algorithms
4. **Adapters** → `CONTEXTS_ADAPTERS.md` — Amplitude/Sheets extensions, nightly runner
5. **UI Design** → `CONTEXTS_UI_DESIGN.md` — Visual design, components, user flows
6. **Testing** → `CONTEXTS_TESTING_ROLLOUT.md` — Test requirements, rollout phases

### For Reviewers

**Critical sections to review**:
- `CONTEXTS_ARCHITECTURE.md` → Query Signatures vs Slice Keys (separation of concerns)
- `CONTEXTS_REGISTRY.md` → otherPolicy Impact Matrix (affects multiple systems)
- `CONTEXTS_AGGREGATION.md` → MECE Aggregation Across Context Keys (edge cases)
- `CONTEXTS_ADAPTERS.md` → Sheets Fallback Policy (pragmatic vs strict)
- `CONTEXTS_UI_DESIGN.md` → Auto-uncheck Behavior (nudges toward single-key selections)
- `CONTEXTS_TESTING_ROLLOUT.md` → Phase 2: Data Operations Refactoring (highest risk)

---

## What Already Exists vs What's New

### Already Implemented ✓
- Context schemas (`contexts-index-schema.yaml`, `context-definition-schema.yaml`)
- `context(key:value)` parsing in `queryDSL.ts`
- `paramRegistryService.loadContext()` and `loadContextsIndex()`
- Navigator section for contexts
- WindowSelector Context button with dropdown placeholder

### What This Design Adds
1. **Data layer**: `sliceDSL` field on ParameterValue for multi-slice support
2. **Graph config**: `dataInterestsDSL` and `currentQueryDSL` fields
3. **Schema extensions**: `otherPolicy` and `sources` in context definitions
4. **DSL extensions**: `contextAny(...)` and `window(...)` parsing
5. **Aggregation logic**: 2D grid model, MECE detection, window overlap handling
6. **UI implementation**: Replace "Coming soon" with actual context selection dropdowns
7. **Adapter integration**: Wire contexts into Amplitude/Sheets queries
8. **Nightly runner**: Explode `dataInterestsDSL` into atomic slices

### Key Design Decisions

1. ✓ **Terminology**: `dataInterestsDSL` (graph) vs `sliceDSL` (window) vs `currentQueryDSL` (UI state)
2. ✓ **Data model**: `sliceDSL` as primary key (not query_signature); `d-MMM-yy` date format
3. ✓ **otherPolicy**: 4 variants (null, computed, explicit, undefined) fully specified
4. ✓ **MECE detection**: Respects otherPolicy; handles mixed MECE/non-MECE keys
5. ✓ **Daily grid model**: 2D (context × date); reuse existing daily points; incremental fetch
6. ✓ **Sheets fallback**: Fallback to uncontexted with warning

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

