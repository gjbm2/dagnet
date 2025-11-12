# PROJECT_CONNECT Document Review

**Date:** 2025-11-05  
**Purpose:** Identify which documents are current, which are superseded, and which should be archived

---

## 🟢 CURRENT - Use These (Nov 5, 2025)

### Core Implementation Docs
| Document | Status | Notes |
|----------|--------|-------|
| **DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md** | ✅ CURRENT | Master plan, updated today with all Phase 0 tasks including sample files |
| **PHASE_0_READINESS_CHECK.md** | ✅ CURRENT | Complete pre-flight checklist with all finalized decisions |
| **OVERRIDE_PATTERN_DESIGN.md** | ✅ CURRENT | Override pattern + UpdateManager architecture, finalized today |
| **MAPPING_TYPES.md** | ✅ CURRENT | Hierarchical mapping architecture (5 handlers, 18 configs), finalized today |
| **SCHEMA_MAPPING_COMPATIBILITY_REVIEW.md** | ✅ CURRENT | Complete schema compatibility review with all 4 new decisions from today |
| **SCHEMA_FIELD_MAPPINGS.md** | ✅ CURRENT | The "switchboard" - field-by-field mappings |
| **DATA_CONNECTIONS_SCHEMA_VALIDATION.md** | ✅ CURRENT | Core design principles (8 principles) |

### Query System Docs
| Document | Status | Notes |
|----------|--------|-------|
| **QUERY_EXPRESSION_SYSTEM.md** | ✅ CURRENT | Query DSL, MSMDC algorithm (Nov 4) |
| **QUERY_SELECTOR_DESIGN.md** | ✅ CURRENT | QueryExpressionEditor UI design (Nov 4) |

---

## 🟡 REFERENCE ONLY - Superseded but Contains Context

### Specification & Overview Docs
| Document | Date | Status | Notes |
|----------|------|--------|-------|
| **DATA_CONNECTIONS.md** | Nov 4 | 🟡 REFERENCE | Original spec - mostly superseded by IMPLEMENTATION_PLAN but contains background |
| **DATA_CONNECTIONS_README.md** | Nov 4 | 🟡 REFERENCE | High-level overview - mostly superseded |

### Early Design Discussions
| Document | Date | Status | Notes |
|----------|------|--------|-------|
| **DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md** | Nov 4 | 🟡 SUPERSEDED | Early schema decisions - **CONFLICTS with current design** (says k is derived from p×n, but we now store n/k in evidence blob) |

### Review Docs (Working Papers)
| Document | Date | Status | Notes |
|----------|------|--------|-------|
| **SCHEMA_FIELD_MAPPINGS_REVIEW.md** | Nov 5 | 🟡 SUPERSEDED | Initial review that led to SCHEMA_MAPPING_COMPATIBILITY_REVIEW.md - useful for context but superseded |
| **MAPPING_MATRIX.md** | Nov 5 | 🟡 SUPERSEDED | Earlier mapping analysis - superseded by MAPPING_TYPES.md |

---

## 🔴 ARCHIVE - Stale (October 2025)

### Old Registry Docs (Pre-Redesign)
| Document | Date | Notes |
|----------|------|-------|
| **PARAMETER_REGISTRY_STATUS.md** | Oct 28 | Implementation status from October - completely stale |
| **PARAMETER_REGISTRY_SPEC.md** | Oct 16 | Old spec - superseded by current schema design |
| **PARAMETER_REGISTRY_ARCHITECTURE_ANALYSIS.md** | Oct 16 | Old analysis - redesigned since |
| **PARAMETER_REGISTRY_SUMMARY.md** | Oct 16 | Old summary - no longer relevant |
| **CASE_PARAMETER_REGISTRY_DESIGN.md** | Oct 21 | Old registry design - redesigned in current schemas |
| **NODES_REGISTRY_DESIGN.md** | Oct 29 | Old node registry - redesigned with event_id and overrides |
| **FILE_TYPE_REGISTRY.md** | Oct 28 | Old file type patterns - superseded |
| **REGISTRY_DEPLOYMENT_STRATEGY.md** | Oct 28 | Old deployment strategy - superseded |
| **REGISTRY_SYNC.md** | Oct 29 | Old sync patterns - superseded by UpdateManager design |

---

## 📋 Recommended Actions

### KEEP (10 docs)
Move to `/PROJECT_CONNECT/CURRENT/`:
1. DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md ⭐
2. PHASE_0_READINESS_CHECK.md ⭐
3. OVERRIDE_PATTERN_DESIGN.md ⭐
4. MAPPING_TYPES.md ⭐
5. SCHEMA_MAPPING_COMPATIBILITY_REVIEW.md
6. SCHEMA_FIELD_MAPPINGS.md
7. DATA_CONNECTIONS_SCHEMA_VALIDATION.md
8. QUERY_EXPRESSION_SYSTEM.md
9. QUERY_SELECTOR_DESIGN.md
10. README.md

### REFERENCE (5 docs)
Move to `/PROJECT_CONNECT/REFERENCE/` (useful context but superseded):
1. DATA_CONNECTIONS.md
2. DATA_CONNECTIONS_README.md
3. DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md ⚠️ **Has conflicts with current design**
4. SCHEMA_FIELD_MAPPINGS_REVIEW.md
5. MAPPING_MATRIX.md

### ARCHIVE (9 docs)
Move to `/PROJECT_CONNECT/ARCHIVE/` (October docs, completely superseded):
1. PARAMETER_REGISTRY_STATUS.md
2. PARAMETER_REGISTRY_SPEC.md
3. PARAMETER_REGISTRY_ARCHITECTURE_ANALYSIS.md
4. PARAMETER_REGISTRY_SUMMARY.md
5. CASE_PARAMETER_REGISTRY_DESIGN.md
6. NODES_REGISTRY_DESIGN.md
7. FILE_TYPE_REGISTRY.md
8. REGISTRY_DEPLOYMENT_STRATEGY.md
9. REGISTRY_SYNC.md

---

## ⚠️ Critical Conflicts to Note

### DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md Conflicts:

**Old design (Nov 4):**
- Says `k` is **derived** from `p × n` (not stored)
- `parameter_id` lives inside param objects
- No mention of override pattern
- No mention of evidence blob

**Current design (Nov 5):**
- `p.mean` is **primary** (what user edits)
- `n` and `k` are **stored** in `evidence` blob (observations, not derived)
- `parameter_id` confirmed inside param objects ✅ (this matches)
- Override pattern with `_overridden` flags throughout
- Evidence blob: `{n, k, window_from, window_to, retrieved_at, source, query}`

**Recommendation:** Add note to DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md that it's superseded by OVERRIDE_PATTERN_DESIGN.md and SCHEMA_MAPPING_COMPATIBILITY_REVIEW.md for p/n/k decisions.

---

## 🎯 Clean Directory Structure

```
PROJECT_CONNECT/
├── README.md                          ✅ Index to current docs
│
├── CURRENT/                           ✅ Use these for implementation
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
├── REFERENCE/                         📚 Background context
│   ├── DATA_CONNECTIONS.md
│   ├── DATA_CONNECTIONS_README.md
│   ├── DATA_CONNECTION_SCHEMA_DATA_DISCUSSION.md  ⚠️ Conflicts
│   ├── SCHEMA_FIELD_MAPPINGS_REVIEW.md
│   └── MAPPING_MATRIX.md
│
└── ARCHIVE/                           🗄️ Historical (October 2025)
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

## Summary

**10 current docs** - Use for Phase 0 implementation  
**5 reference docs** - Useful context but superseded  
**9 archive docs** - October work, completely stale  

**Key takeaway:** Focus on the 10 CURRENT docs. The rest are noise and can cause confusion. The 4 starred (⭐) docs are absolutely critical for implementation.

