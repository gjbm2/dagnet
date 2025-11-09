# External Data System - Design Complete Summary

**Date:** 2025-11-09  
**Status:** ✅ Design 100% Complete - Ready for Implementation  
**Total Time Investment:** ~8 hours of design work

---

## What We Accomplished

### From One Beast to Seven Focused Documents

**Original:** Single 5082-line monolithic design document  
**Result:** 7 focused, maintainable documents with 100% coverage

### Document Set (3,815 lines + archive)

**High-Level (2 docs):**
1. ✅ `ARCHITECTURE.md` (521 lines) - System design & decisions
2. ✅ `IMPLEMENTATION_PLAN.md` (732 lines) - 6-phase plan with detailed tasks

**Detailed Design (5 docs):**
3. ✅ `DETAILED_DESIGN/DAS_RUNNER.md` (640 lines) - Core execution engine
4. ✅ `DETAILED_DESIGN/CONNECTIONS_SPEC.md` (498 lines) - connections.yaml full spec
5. ✅ `DETAILED_DESIGN/SCHEMAS.md` (385 lines) - All schema updates
6. ✅ `DETAILED_DESIGN/UI_COMPONENTS.md` (565 lines) - UI widgets & components
7. ✅ `DETAILED_DESIGN/DATA_FLOW.md` (474 lines) - End-to-end flow & node resolution

**Reference:**
8. ✅ `COVERAGE_REPORT.md` - Validates 100% coverage
9. ✅ `ARCHIVE/EXTERNAL_DATA_SYSTEM_DESIGN.md` - Original for deep dives

---

## Key Design Decisions

### 1. Portable DAS Runner (Option C)
- ✅ Works in browser AND Node.js
- ✅ Dependency injection for HttpExecutor, ConnectionProvider
- ✅ Reuses existing CredentialsManager
- ✅ Seamless server migration (3-4 hours when needed)

### 2. Simplified Schema (2-Field Model)
- ✅ `connection` (string, de facto foreign key)
- ✅ `connection_string` (JSON blob, provider-specific)
- ✅ `query` (node references: from/to/visited/excluded)
- ✅ `evidence` (system-generated provenance)

### 3. Single connections.yaml
- ✅ Git-committable, shareable
- ✅ Adapter specs integrated (not separate files)
- ✅ Connection defaults + param-specific overrides
- ✅ connection_string_schema drives dynamic UI

### 4. Graph-Level Selectors
- ✅ Window selector (floating date picker)
- ✅ Context selector (stubbed for v1)
- ✅ Synced across tabs viewing same graph
- ✅ NOT persisted (runtime state)

### 5. Comprehensive Testing
- ✅ Unit tests (4-6 hours)
- ✅ Integration tests (3-4 hours)
- ✅ Contract tests (3-4 hours)
- ✅ 80% code coverage goal

---

## What's Included

### Schemas
- ✅ connections-schema.json spec (with discriminated unions)
- ✅ Graph schema updates (connection, evidence)
- ✅ Parameter schema updates (connection, connection_string, query, evidence)
- ✅ Case schema updates (connection, evidence)
- ✅ Node schema (event_id documented)

### DAS Runner
- ✅ HttpExecutor interface (browser + Node)
- ✅ ConnectionProvider interface (IndexedDB + filesystem)
- ✅ Mustache template engine (with filters)
- ✅ JMESPath extraction
- ✅ JSONata transformation
- ✅ UpdateManager integration
- ✅ Error handling with user guidance

### UI Components
- ✅ MonacoWidget (code editor for YAML/JSON/JS)
- ✅ TabbedArrayWidget (sub-tabbed connections)
- ✅ WindowSelector (floating date picker)
- ✅ ConnectionSelector (dropdown in param/case editors)
- ✅ EvidenceDisplay (provenance tracking)
- ✅ Complete UI schema for connections.yaml

### Adapters
- ✅ Amplitude (with pre_request transformation for funnels)
- ✅ PostgreSQL (parameterized SQL)
- ✅ Google Sheets (OAuth + Service Account)
- ✅ Statsig (variant allocation)
- ✅ Multi-environment pattern

### Data Flow
- ✅ 7 data inputs identified
- ✅ 8-step execution pipeline detailed
- ✅ buildDslFromEdge() complete implementation
- ✅ Node ID → event ID resolution
- ✅ Graceful error handling

---

## Implementation Estimate

**Total: 59-77 hours** (revised from initial 19-25 hours)

| Phase | Description | Estimate |
|-------|-------------|----------|
| 0 | Schema Lock (BLOCKER) | 2-4 hrs |
| 1 | Foundation + UI | 10-14 hrs |
| 2a | Abstraction Layer | 3 hrs |
| 2b | DAS Core | 10-12 hrs |
| 3 | UI Integration | 10-12 hrs |
| 4 | First Adapter | 8-10 hrs |
| 5 | Polish | 4-6 hrs |
| 6 | Testing | 10-14 hrs |

**Why Increased?**
- Original estimate lacked UI widgets (MonacoWidget, TabbedArrayWidget)
- Original estimate lacked Window Selector
- Original estimate lacked comprehensive testing
- Original estimate lacked buildDslFromEdge implementation
- New estimate includes USABLE UI and complete test coverage

---

## Ready to Start

### Phase 0 (BLOCKER - Start Here)

**Must complete before any implementation:**

1. Write `connections-schema.json` (1.5 hrs)
2. Update `graph-schema.json` (30 min)
3. Update `parameter-schema.json` (30 min)
4. Update `case-schema.json` (30 min)
5. Document Mustache templating (1 hr)
6. Write 2 example connections (30 min)

**Gate:** All schemas validate, examples parse correctly

### Next Steps

1. Read `IMPLEMENTATION_PLAN.md` (in this directory) for detailed Phase 0 tasks
2. Review `ARCHITECTURE.md` (in this directory) for system understanding
3. Reference other docs in `DAS_DETAILED_DESIGN/` as needed during implementation
4. Use `COVERAGE_REPORT.md` to find original design details if needed

---

## Coverage Validation

✅ **100% of material content preserved**

Missing ~1,500 lines are:
- Redundant examples (same adapter shown 3 times)
- Verbose explanations (now distilled)
- API research deep-dives (can reference archive)

All critical content captured in new document set.

---

## Files Updated

### Created (9 new files in `DAS_DETAILED_DESIGN/`)
1. `DAS_DETAILED_DESIGN/ARCHITECTURE.md`
2. `DAS_DETAILED_DESIGN/IMPLEMENTATION_PLAN.md`
3. `DAS_DETAILED_DESIGN/DAS_RUNNER.md`
4. `DAS_DETAILED_DESIGN/CONNECTIONS_SPEC.md`
5. `DAS_DETAILED_DESIGN/SCHEMAS.md`
6. `DAS_DETAILED_DESIGN/UI_COMPONENTS.md`
7. `DAS_DETAILED_DESIGN/DATA_FLOW.md`
8. `DAS_DETAILED_DESIGN/COVERAGE_REPORT.md`
9. `DAS_DETAILED_DESIGN/SUMMARY.md` (this file)

### Moved (1 file)
- `CURRENT/EXTERNAL_DATA_SYSTEM_DESIGN.md` → `ARCHIVE/`

### Updated (1 file)
- `README.md` - Added DAS_DETAILED_DESIGN/ section, updated estimates

---

## What's NOT Included (Deferred to v2)

- ❌ Pre-request JavaScript sandbox (v2)
- ❌ TypeScript adapter escape hatch (v2)
- ❌ Advanced secrets masking (v2)
- ❌ CORS proxy / OAuth proxy (v2)
- ❌ Caching & rate limiting (v2)
- ❌ Pagination support (v2)
- ❌ CLI validator (v2)

**v1 Focus:** Core DAS Runner + basic Amplitude adapter + usable UI

---

## Success Criteria

**Design Phase:** ✅ COMPLETE
- All concepts documented
- All implementation tasks identified
- All schemas specified
- All UI components designed
- All error cases handled

**Implementation Phase:** ⏳ READY TO START
- Phase 0: Schema Lock (2-4 hours)
- Then proceed phase by phase per IMPLEMENTATION_PLAN.md

---

## Questions Answered

### "Will this scale to server-side later?"
✅ Yes - Portable DAS Runner (Option C) designed for easy migration

### "How do we handle complex transformations like Amplitude funnels?"
✅ Pre_request phase in adapters (detailed in CONNECTIONS_SPEC.md)

### "What about SQL complexity?"
✅ 3-tier approach: simple declarative → configurable schema → TypeScript escape hatch (v2)

### "How do users edit connections?"
✅ FormEditor with MonacoWidget + TabbedArrayWidget + UI schema

### "Where does window/context state live?"
✅ GraphContext (runtime state), synced across tabs, NOT persisted in graph

### "What if event_id is missing?"
✅ Graceful failure with clear error message and fix instructions

### "How do we test this?"
✅ Comprehensive testing strategy: unit + integration + contract tests (10-14 hours)

---

## Confidence Level

**Architecture:** 🟢 High
- Portable design proven
- Reuses existing CredentialsManager & UpdateManager
- Clear separation of concerns

**Implementation:** 🟢 High
- All tasks identified and estimated
- No unknowns in critical path
- Clear error handling strategy

**Testing:** 🟢 High
- Comprehensive test strategy
- Contract tests ensure adapter correctness
- 80% coverage goal

**Timeline:** 🟡 Medium
- 59-77 hours is realistic for production-quality v1
- Could be faster with shortcuts (but lower quality)
- Testing adds 10-14 hours but ensures reliability

---

## Next Action

**👉 Start Phase 0: Schema Lock**

Read: `IMPLEMENTATION_PLAN.md` Section "Phase 0"  
Time: 2-4 hours  
Output: 5 schemas + 2 example connections

Then proceed to Phase 1: Foundation + UI

---

**Design Complete:** ✅  
**Ready for Implementation:** ✅  
**100% Coverage:** ✅  

**Let's build this! 🚀**

