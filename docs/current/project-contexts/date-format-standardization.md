# Date Format Standardization

## Status: COMPLETED (Phase 1-4)

## Requirement

**All dates MUST use `d-mmm-yy` format (e.g., `1-Dec-25`)** everywhere:
- UI display
- YAML files (parameter files, graph files)
- DSL strings
- Internal storage

**Exception**: ISO format (`2025-12-01`) only when:
- Calling external APIs (Amplitude, Statsig, Sheets)
- Converting from external API responses

## Rationale

- Zero ambiguity (no US/UK confusion)
- Human-readable
- Consistent across codebase

## Current State

We have utilities in `src/lib/dateFormat.ts`:
- `formatDateUK(date)` → `d-mmm-yy`
- `parseUKDate(dateStr)` → Date object

However, many places still use ISO format internally.

## Impact Areas

### 1. Service Layer (HIGH)

| File | Issue |
|------|-------|
| `windowAggregationService.ts` | Uses ISO in `normalizeDate()`, date comparisons |
| `dataOperationsService.ts` | Stores dates as ISO in parameter files |
| `paramRegistryService.ts` | Date handling |

### 2. Parameter Files (HIGH)

Currently stored as:
```yaml
values:
  - dates: ["2025-12-01", "2025-12-02"]  # ISO
    n_daily: [100, 120]
```

Should be:
```yaml
values:
  - dates: ["1-Dec-25", "2-Dec-25"]  # d-mmm-yy
    n_daily: [100, 120]
```

### 3. Graph Files (MEDIUM)

Evidence fields store window dates:
```yaml
edge:
  p:
    evidence:
      window_from: "2025-12-01"  # Should be "1-Dec-25"
      window_to: "2025-12-07"    # Should be "7-Dec-25"
```

### 4. UI Components (MEDIUM)

| Component | Issue |
|-----------|-------|
| `DateRangePicker.tsx` | May use ISO internally |
| `WindowSelector.tsx` | Date state management |
| `PropertiesPanel.tsx` | Evidence display |

### 5. Test Fixtures (LOW)

60+ test files have ISO dates in fixtures. These need updating but are low priority.

### 6. External API Integration (EXCEPTION)

These must CONVERT to/from ISO at the boundary:
- `src/lib/das/` - API runners
- API response handlers

## Implementation Plan

### Phase 1: Core Utilities
1. Add `toISO(ukDate: string): string` for API calls
2. Add `fromISO(isoDate: string): string` for API responses
3. Update `normalizeDate()` to use UK format

### Phase 2: Storage Layer
1. Update `windowAggregationService.ts` to use UK dates
2. Update `dataOperationsService.ts` file writing
3. Migrate existing parameter files (or add auto-conversion on load)

### Phase 3: Graph Files
1. Update evidence field storage
2. Add migration for existing graphs

### Phase 4: UI
1. Ensure DateRangePicker uses UK format
2. Update WindowSelector state
3. Update PropertiesPanel display

### Phase 5: Tests
1. Update test fixtures
2. Run full test suite

## Migration Strategy

Option A: **Auto-convert on load** (recommended)
- Detect ISO dates and convert to UK format
- Save back in UK format
- Gradual migration as files are touched

Option B: **Batch migration**
- Script to convert all files at once
- Risky if format detection fails

## Acceptance Criteria

- [ ] No ISO dates in UI
- [ ] No ISO dates in saved files (except API boundary)
- [ ] All tests pass with UK date format
- [ ] formatDateUK/parseUKDate used consistently

