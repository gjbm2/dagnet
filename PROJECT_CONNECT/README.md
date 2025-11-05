# PROJECT CONNECT: Data Connections System

**Phase:** 0.3 (Phase 0.0 & 0.1 Complete, Ready for UpdateManager)  
**Start Date:** 2025-11-05  
**Status:** 🟢 Phase 0.0 & 0.1 ✅ COMPLETE

This directory contains all design documentation for the Data Connections system implementation.

**📁 Directory Structure:**
- `/CURRENT/` - Active docs for Phase 0 implementation (use these!)
- `/REFERENCE/` - Background context, superseded but useful
- `/ARCHIVE/` - October 2025 docs, completely stale

**⚠️ IMPORTANT:** Focus on `/CURRENT/` docs only. The others can cause confusion.

---

## 🎯 Current Status

**Phase 0.0 Complete (Nov 5, 2025):**
- ✅ ID/Slug standardization refactor complete
- ✅ All TypeScript errors fixed (0 errors)
- ✅ Migration script created
- ✅ Documentation: `PHASE_0.0_COMPLETE.md`
- ✅ "slug" completely purged from codebase

**Phase 0.1 Complete (Nov 5, 2025):**
- ✅ Gate 1: All schemas updated (7 schema files)
- ✅ Gate 2: Field mappings validated (8 critical fixes)
- ✅ Conditional probability design documented
- ✅ Test files migrated to new schema
- ✅ Documentation: `PHASE_0.1_COMPLETE.md` and `GATE_2_VALIDATION_RESULTS.md`

**Next:** Phase 0.3 - UpdateManager Implementation

---

## 📋 Core Documents (READ THESE FIRST)

All paths relative to `/PROJECT_CONNECT/CURRENT/`:

### 1. **DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md** ⭐ START HERE
The master plan. Complete phase breakdown, timelines, acceptance criteria. **Updated with Phase 0.0 completion.**

### 2. **PHASE_0_READINESS_CHECK.md** ⭐ PRE-FLIGHT CHECKLIST
Complete readiness summary. All design decisions finalized, all gates defined.

### 3. **MAPPING_TYPES.md** ⭐ ARCHITECTURE
Hierarchical mapping architecture (5 handlers, 18 configs, 13 flows). Critical for UpdateManager implementation.

### 4. **OVERRIDE_PATTERN_DESIGN.md** ⭐ CORE PATTERN
The override pattern for auto-calculated fields. Includes UpdateManager class design, conflict resolution, UI patterns.

### 5. **PHASE_0.0_COMPLETE.md** ✅ COMPLETION REPORT
Full report on Phase 0.0 ID/Slug Standardization refactor. Statistics, changes made, technical decisions, files affected.

### 6. **PHASE_0.1_COMPLETE.md** ✅ COMPLETION REPORT
Full report on Phase 0.1 Schema Updates & Field Mapping Validation. 7 schemas updated, 8 critical field name mismatches fixed.

### 7. **GATE_2_VALIDATION_RESULTS.md** ✅ VALIDATION REPORT
Systematic validation results for all field mappings. Documents all mismatches found and fixed.

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

