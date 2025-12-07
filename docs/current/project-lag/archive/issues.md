# Project LAG: Open Issues

**Status:** Active
**Related:** `design.md`, `implementation.md`

---

## Issue 1: Cohort/Window Mode UI Distinction

**Severity:** Medium (UX risk)
**Phase:** C4 (UI & Rendering)
**Related section:** `implementation.md §4.6`, `design.md §7.5`

**Status:** ✅ RESOLVED

### Problem

The current UI spec for cohort/window mode switching is minimal:
- Dropdown selector
- Timer/TimerOff icons
- Default to Cohort mode

Users may not understand why the same date range produces different numbers in each mode. The distinction is conceptually important but not self-explanatory.

### The Distinction

| Mode | Question Answered | Date Range Meaning |
|------|-------------------|-------------------|
| **Cohort** | "Of users who *started* in this period, what % converted?" | Entry dates (when users entered the funnel) |
| **Window** | "Of conversions that *happened* in this period, what was the rate?" | Event dates (when conversions occurred) |

### Decision (5-Dec-25)

Use an explicit, labelled toggle switch (not a dropdown) at the left of the date selector. This makes the mode visually prominent and self-explanatory.

Design updated in `design.md §7.5`.

---

## Issue 2: Amplitude Rate Limits for Per-Cohort Queries

**Severity:** High (feasibility risk)
**Phase:** C2/C3
**Related section:** `design.md §12.1`

### Problem

Per-cohort queries over 90-day windows may hit Amplitude rate limits. Unknown whether current fetching approach is sustainable.

### Mitigation Options

1. **Batching:** Aggregate multiple cohort days into fewer API calls
2. **Retention endpoint:** May be more efficient than funnel API
3. **Caching:** Aggressive caching of mature cohort data (immutable once past maturity threshold)

### Decision

**Status:** Monitor during implementation. Add batching if limits hit.

---

## Issue 3: Error Handling for Missing Window Data

**Severity:** Low
**Phase:** C3
**Related section:** `implementation.md §Open Questions`

### Problem

If user requests `window()` on a latency edge but only `cohort_data` exists, what error message is appropriate?

### Current Decision

Return error: "Window data not available. Fetch with window() or switch to cohort mode."

Convolution fallback is deferred to Phase 1+.

### Open Question

Is "switch to cohort mode" the right guidance? Or should we auto-switch and show a toast?

**Status:** Pending review

---

