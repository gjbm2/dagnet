# PROJECT CONNECT: Data Connections System

**Phase:** 1B (Phase 0 Complete, Phase 1 UI in progress)  
**Start Date:** 2025-11-05  
**Status:** 🟡 Phase 1 - 70% Complete (UI done, wiring pending)

This directory contains all design documentation for the Data Connections system implementation.

**📁 Directory Structure:**
- `/CURRENT/` - Active docs for Phase 1 implementation (use these!)
- `/REFERENCE/` - Background context, superseded but useful
- `/ARCHIVE/` - October 2025 docs, completely stale

**⚠️ IMPORTANT:** Focus on `/CURRENT/` docs only. The others can cause confusion.

---

## 🎯 Current Status

**Phase 0 Complete (Nov 5, 2025):** ✅
- ID/Slug standardization refactor
- All schemas updated & validated
- UpdateManager built & tested (960+ lines, 20/20 tests passing)
- Fresh sample files created (19 files)
- Events infrastructure added

**Phase 1A Complete (Nov 5, 2025):** ✅
- Events implementation (Navigator, EnhancedSelector, file operations)
- Yellow Calendar icon theme
- 0 linter errors

**Phase 1B In Progress (Nov 6, 2025):** 🟡
- ✅ Lightning Menu component (React Portal, z-index fixed)
- ✅ Node & Edge Context Menus extracted (submenu pattern)
- ✅ DataOperationsService created (centralized orchestration)
- ✅ Toast notifications integrated (bottom-center)
- ✅ Fixed hide/show node (UUID mismatch)
- ✅ Fixed delete node from context menu
- ⏳ **NEXT:** Wire services to UpdateManager (3-4 hrs)

**Remaining Phase 1 Work:** ~12-15 hours
- 1B: Wire services to UpdateManager
- 1C: Top Menu "Data" (batch operations)
- 1D: Properties Panel updates (event_id, override indicators, evidence display)
- 1E: Connection Settings UI (needs design)

---

## 📋 Core Documents (START HERE)

All paths relative to `/PROJECT_CONNECT/CURRENT/`:

### 1. **DATA_CONNECTIONS_IMPLEMENTATION_PLAN_V2.md** ⭐ **CURRENT PLAN**
**Updated 2025-11-06.** Clean, forward-looking implementation plan. Focuses on remaining work, correct phase ordering (Phase 2: External Connectors, Phase 3: Batch, Phase 4: API/Async). Time estimates, acceptance criteria.

**Old plan:** `DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md` (deprecated, historical reference only)

### 2. **MAPPING_TYPES.md** ⭐ ARCHITECTURE
Hierarchical mapping architecture (5 handlers, 18 configs, 13 flows). Critical for UpdateManager implementation.

### 3. **OVERRIDE_PATTERN_DESIGN.md** ⭐ CORE PATTERN
The override pattern for auto-calculated fields. Includes UpdateManager class design, conflict resolution, UI patterns.

### 4. **PHASE_1B_LIGHTNING_MENU.md** ⭐ UI DESIGN
Complete UI design for Lightning Menu and Context Menus. Iconography, pathway visualizations, submenu patterns.

### 5. **UUID_PRIMARY_KEY_REFACTOR.md** ⚠️ TECHNICAL DEBT
Documents UUID vs human-readable ID inconsistency. Fix after Phase 1 complete (~2-3 hrs).

---

## 📚 Phase Completion Reports

### Phase 0:
- `PHASE_0.0_COMPLETE.md` - ID/Slug standardization
- `PHASE_0.1_COMPLETE.md` - Schema updates & validation
- `PHASE_0.3_COMPLETE.md` - UpdateManager & testing infrastructure
- `GATE_2_VALIDATION_RESULTS.md` - Field mapping validation

### Phase 1:
- `PHASE_1_EVENTS_COMPLETE.md` - Events implementation
- `PHASE_1B_LIGHTNING_MENU.md` - Lightning Menu & Context Menus (UI design)

---

## 📚 All Current Documents

### In `/CURRENT/` (Use these for implementation):

**Core Implementation:**
1. `DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md` - Master plan
2. `PHASE_0_READINESS_CHECK.md` - Pre-flight checklist
3. `OVERRIDE_PATTERN_DESIGN.md` - Override pattern + UpdateManager
4. `MAPPING_TYPES.md` - Data flow architecture

**Schema & Mappings:**
5. `DATA_CONNECTIONS_SCHEMA_VALIDATION.md` - 8 core design principles
6. `SCHEMA_MAPPING_COMPATIBILITY_REVIEW.md` - Complete compatibility review
7. `SCHEMA_FIELD_MAPPINGS.md` - The "switchboard" for field mappings
8. `GATE_2_VALIDATION_RESULTS.md` - Field mapping validation results

**Query System & Conditional Probabilities:**
9. `QUERY_EXPRESSION_SYSTEM.md` - Query DSL, MSMDC algorithm
10. `QUERY_SELECTOR_DESIGN.md` - QueryExpressionEditor UI
11. `CONDITIONAL_PROBABILITY_DESIGN.md` - Conditional probability approach

### In `/REFERENCE/` (Background context only):

⚠️ These docs are superseded but may provide useful historical context:
- `DATA_CONNECTIONS.md` - Original spec (Nov 4)
- `DATA_CONNECTIONS_README.md` - High-level overview (Nov 4)
- `DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md` - Early decisions (**conflicts with current design**)
- `SCHEMA_FIELD_MAPPINGS_REVIEW.md` - Initial review (led to compatibility review)
- `MAPPING_MATRIX.md` - Early mapping analysis (superseded by MAPPING_TYPES.md)

### In `/ARCHIVE/` (Historical - October 2025):

🗄️ These docs are completely stale and should NOT be referenced:
- 9 old registry design docs from October
- All superseded by current schema design

---

## 🚀 Implementation Phases

### Phase 0: Schemas & Foundation (4-5 days)
**4 Critical Gates:**
- ✅ **Gate 0:** ID/Slug standardization (0.5 days) — COMPLETE
- ✅ **Gate 1:** All schemas updated + fresh sample files (2 days) — COMPLETE
- ✅ **Gate 2:** Field mappings validated (0.5 days) — COMPLETE
- 🚧 **Gate 3:** UpdateManager tests passing (1.5 days) — **CURRENT**

**Key Decisions:**
1. ✅ ID/slug standardization (`object.uuid`, `object.id`, `object.foreign_id`)
2. ✅ Override pattern (suffix flags: `field_overridden`)
3. ✅ Edge label auto-derivation with override
4. ✅ `p` as primary, `n/k` as evidence (in `evidence` blob)
5. ✅ Keep `edge.p.mean` (not `.p.p`)
6. ✅ Case schedule naming (`window_from`/`window_to`)
7. ✅ NOT backward compatible (fresh start)

### Phase 1: Synchronous Operations (10-14 days) - **NEXT**
Single-parameter operations, UI completion, basic connectors.

### Phase 2: Asynchronous Batch Operations (7-9 days)
Batch processing, progress UI, optimization.

### Phase 3: API Routes & Automation (FUTURE)
Out of current scope.

---

## 📁 Actual Directory Structure

```
PROJECT_CONNECT/
├── README.md                    ⭐ This file - start here
├── DOCUMENT_REVIEW.md           📋 Detailed review of all docs
├── PHASE_0.0_COMPLETE.md        ✅ Phase 0.0 completion report
├── PHASE_0.1_COMPLETE.md        ✅ Phase 0.1 completion report
│
├── CURRENT/                     ✅ Use these (12 docs)
│   ├── DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md
│   ├── PHASE_0_READINESS_CHECK.md
│   ├── OVERRIDE_PATTERN_DESIGN.md
│   ├── MAPPING_TYPES.md
│   ├── SCHEMA_MAPPING_COMPATIBILITY_REVIEW.md
│   ├── SCHEMA_FIELD_MAPPINGS.md
│   ├── DATA_CONNECTIONS_SCHEMA_VALIDATION.md
│   ├── QUERY_EXPRESSION_SYSTEM.md
│   └── QUERY_SELECTOR_DESIGN.md
│
├── REFERENCE/                   📚 Background (5 docs)
│   ├── DATA_CONNECTIONS.md
│   ├── DATA_CONNECTIONS_README.md
│   ├── DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md  ⚠️ Has conflicts
│   ├── SCHEMA_FIELD_MAPPINGS_REVIEW.md
│   └── MAPPING_MATRIX.md
│
└── ARCHIVE/                     🗄️ October 2025 (9 docs - stale)
    ├── PARAMETER_REGISTRY_STATUS.md
    ├── PARAMETER_REGISTRY_SPEC.md
    ├── PARAMETER_REGISTRY_ARCHITECTURE_ANALYSIS.md
    ├── PARAMETER_REGISTRY_SUMMARY.md
    ├── CASE_PARAMETER_REGISTRY_DESIGN.md
    ├── NODES_REGISTRY_DESIGN.md
    ├── FILE_TYPE_REGISTRY.md
    ├── REGISTRY_DEPLOYMENT_STRATEGY.md
    └── REGISTRY_SYNC.md
```

---

## 🎯 Quick Start for Implementation

1. **Read** `CURRENT/DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md` (master plan)
2. **Review** `CURRENT/PHASE_0_READINESS_CHECK.md` (all decisions finalized)
3. **Study** `CURRENT/MAPPING_TYPES.md` (understand data flow architecture)
4. **Study** `CURRENT/OVERRIDE_PATTERN_DESIGN.md` (understand UpdateManager design)
5. **Begin** Phase 0.0: ID/Slug Standardization Refactor

**Only use docs in `/CURRENT/` - ignore the rest during implementation!**

---

## ✅ Design Status: 100% Complete

All design decisions finalized 2025-11-05:
- ✅ Naming standardization pattern defined
- ✅ All 18 mapping configurations defined
- ✅ UpdateManager architecture finalized
- ✅ Override pattern across all schemas
- ✅ Edge label auto-derivation with override
- ✅ Case schedule field naming standardized
- ✅ Evidence structure for `n`/`k` observations
- ✅ Fresh sample files scope defined

**Ready to commence implementation.**

---

## 📞 Key Design Principles

1. **Flexible Data Location** - Data can live in graph OR files (user's choice)
2. **Override Respect** - Auto-updates disabled when user manually edits
3. **Single Source of Truth** - UpdateManager is the switchboard for all mappings
4. **Hierarchical Architecture** - 3 levels: direction, operation, sub-destination
5. **Evidence Not Overridable** - Observations (n/k) are facts, not priors
6. **NOT Backward Compatible** - Fresh start, clean schemas
7. **Interactive + Batch Modes** - UpdateManager works in UI and API contexts
8. **Test-Driven Validation** - Schemas proven by UpdateManager tests

---

**Last Updated:** 2025-11-05  
**Phase 0.0 & 0.1:** ✅ COMPLETE  
**Next Milestone:** Phase 0.3 Implementation (UpdateManager)

