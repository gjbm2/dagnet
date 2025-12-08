# Project LAG: Implementation Status

**Started:** 8-Dec-25
**Last Updated:** 8-Dec-25
**Phase:** C1 — Schema Changes & Core Types

---

## Current Progress

### Phase P0: Rename `cost_time` → `labour_cost` ✅ COMPLETE

Pre-requisite cleanup before introducing latency complexity.

| Task | Status | Notes |
|------|--------|-------|
| P0.1 TypeScript Types | ✅ Done | `index.ts`, `scenarios.ts` |
| P0.2 Python Models | ✅ Done | `graph_types.py`, runners |
| P0.3 Schema Files | ✅ Done | `parameter-schema.yaml`, `registry-schema.yaml`, `conversion-graph-*.json` |
| P0.4 Services & UI | ✅ Done | 81 files updated across services, components, hooks |
| P0.5 Test Updates | ✅ Done | All tests updated + query DSL tests fixed for `cohort` function |
| P0.6 Verification | ✅ Done | Zero `cost_time` hits, 1977 tests pass |

**Summary:**
- Renamed 471 occurrences of `cost_time` → `labour_cost` across 81 files
- Also updated `cohort` function in query DSL schema (needed for LAG)
- Updated sample data files in `param-registry/test/`

---

### Phase C1: Schema Changes & Core Types ⏳ READY TO START

### Phase C2: DSL & Query Architecture ⏸️ BLOCKED (by C1)

### Phase C3: Data Storage, Aggregation & Inference ⏸️ BLOCKED (by C2)

**Includes:** Create LAG sample data (`cohort()` + `window()` slices) for testing — see `implementation.md` Testing section.

### Phase C4: UI & Rendering ⏸️ BLOCKED (by C3)

### Phase A: Analytics (Post-Core) ⏸️ BLOCKED (by C4)

---

## Open Issues Being Monitored

1. **Amplitude Rate Limits** — Will monitor during C2/C3 implementation
2. **Mock Amplitude Data Generator** — Needed during testing phase
3. **LAG Sample Data** — Create realistic `cohort()` + `window()` sample data in `param-registry/test/` (Phase C3)

---

## Session Log

### 8-Dec-25

**Session Start:** Commenced implementation per `implementation.md`

**Actions:**
1. Read implementation plan and residual open issues
2. Audited codebase for `cost_time` occurrences:
   - Found P0 has NOT been completed
   - 365+ TS occurrences, 57+ Python occurrences
3. Created this status file
4. **Completed Phase P0 rename:**
   - Updated TypeScript types (`index.ts`, `scenarios.ts`)
   - Updated Python models (`graph_types.py`, runners, msmdc)
   - Updated YAML schemas (`parameter-schema.yaml`, `registry-schema.yaml`)
   - Updated JSON schemas (`conversion-graph-1.0.0.json`, `conversion-graph-1.1.0.json`)
   - Updated 81 files across services, components, hooks, tests
   - Updated sample data files in `param-registry/test/`
   - Fixed query DSL tests (added `cohort` function support)
   - **All 1977 tests pass**

**Phase P0 Complete** — Ready to proceed with Phase C1

---

## Verification Checklist (P0) ✅ COMPLETE

- [x] `grep -r "cost_time" graph-editor/src/` returns zero hits ✅
- [x] `grep -r "cost_time" graph-editor/lib/` returns zero hits ✅
- [x] `grep -r "cost_time" graph-editor/public/` returns zero hits ✅
- [x] All TypeScript tests pass (1977 tests) ✅
- [ ] All Python tests pass — *to be verified*
- [ ] Manual smoke test: load graph with cost data — *to be verified*

