# Amplitude Funnel Export — Developer Reference

## Overview

The "Create as chart in Amplitude" feature constructs an Amplitude funnel chart from selected DagNet graph nodes and opens it in the user's browser. This doc covers the architecture, code locations, and testing for developers working on this feature.

## Code path

```
AnalyticsPanel.tsx (handleOpenInAmplitude)
  │
  ├─ Resolve connection: scan edge.p.connection fields → load from IndexedDBConnectionProvider
  │   → app_id, org_id, org_slug, excluded_cohorts
  │
  ├─ Build chart: amplitudeFunnelBuilderService.ts (buildAmplitudeFunnelDefinition)
  │   ├─ Topological sort of selected nodes
  │   ├─ Event resolution via fileRegistry (event_id → Amplitude name + filters)
  │   ├─ DSL parsing (parseDSL) → context, visited, exclude, case, window, cohort
  │   ├─ Context filters via shared buildContextFilters() from buildDslFromEdge.ts
  │   ├─ Date handling: toStartOfDayEpoch / toEndOfDayEpoch + datePresetId: -1
  │   ├─ Conversion window: computeCohortConversionSeconds (from graph edge latency)
  │   └─ Assembly into AmplitudeChartDefinition JSON
  │
  └─ Create draft: amplitudeBridgeService.ts (createAmplitudeDraft)
      └─ Chrome extension message → background.js → inject into amplitude.com tab
          ├─ POST /d/config/{orgId}/data/edit → editId
          ├─ GraphQL CreateOrUpdateChartDraft → draft registered
          └─ Return draft URL → opened in new tab
```

## Key files

| File | Purpose |
|------|---------|
| `src/services/amplitudeFunnelBuilderService.ts` | Builds chart definition from nodes + DSL |
| `src/services/amplitudeBridgeService.ts` | Communicates with the Chrome extension |
| `src/components/panels/AnalyticsPanel.tsx` | UI entry point (`handleOpenInAmplitude`) |
| `extensions/amplitude-bridge/background.js` | Chrome extension service worker |
| `src/lib/das/buildDslFromEdge.ts` | Shared resolution functions (context, dates) |
| `src/constants/latency.ts` | `DEFAULT_T95_DAYS`, `COHORT_CONVERSION_WINDOW_MAX_DAYS` |

## Connection resolution

The funnel builder does NOT hardcode Amplitude project identifiers. It resolves them from `connections.yaml`:

1. Scan edges touching selected nodes for `edge.p.connection`
2. Fall back to `graph.defaultConnection`
3. Load the connection via `IndexedDBConnectionProvider`
4. Read `defaults.app_id`, `defaults.org_id`, `defaults.org_slug`, `defaults.excluded_cohorts`

Warnings are emitted for: non-Amplitude nodes, mixed connections (prod + staging), missing project config.

## Date format (critical)

Amplitude's front-end chart API requires a very specific date format for absolute dates. Getting this wrong produces silent failures (empty chart, no error message).

| Field | Value | Required |
|-------|-------|----------|
| `start` | Epoch seconds, start of day (00:00:00 UTC) | Yes |
| `end` | Epoch seconds, **end of day** (23:59:59 UTC) | Yes |
| `datePresetId` | `-1` | Yes |
| `timezone` | `"UTC"` | Yes |
| `range` | Must be **omitted** | Must not be present |

For relative ranges, use `range: "Last 30 Days"` (or similar preset) and omit `start`/`end`/`datePresetId`.

See `amplitude-api-deep-reference.md` in the data repo's `graph-ops/amplitude/` directory for full API documentation.

## Conversion window

Cohort mode conversion window (`conversionSeconds`) is computed from graph edge latency:

```
cs_days = ceil(max(path_t95 | t95 across all graph edges))
capped at COHORT_CONVERSION_WINDOW_MAX_DAYS (90)
fallback: DEFAULT_T95_DAYS (30)
```

This matches the DAS adapter logic in `buildDslFromEdge.ts`.

## Testing

### Conformance tests (fast, no API calls)

```bash
npm test -- --run src/services/__tests__/amplitudeFunnelBuilder.conformance.test.ts
```

31 tests covering event resolution, normalizeProp, segment conditions, date handling, cohort cs computation, and the chart-to-REST-params converter.

### Roundtrip E2E tests (live Amplitude API)

```bash
AMPLITUDE_E2E=1 source .env.amplitude.local && \
  npm test -- --run tests/phase4-e2e/amplitude-funnel-roundtrip.test.ts
```

Requires: `AMPLITUDE_API_KEY`, `AMPLITUDE_SECRET_KEY`, `AMPLITUDE_TEST_SPACE_ID` env vars, and `/tmp/amp-session-state.json` (session cookies from Playwright HAR capture).

These tests run both the DAS adapter (`buildDslFromEdge` → REST API) and the funnel builder (`buildAmplitudeFunnelDefinition` → create chart → query CSV) against live Amplitude and assert `{n, k}` match.

Excluded from the standard test suite — only run with `AMPLITUDE_E2E=1`.

## Session logging

The full export flow is logged via `sessionLogService` under the `amplitude` category:

```
AMP_FUNNEL_EXPORT → AMP_BRIDGE_OK → AMP_CONN_RESOLVED → AMP_DSL_COMPOSED
  → AMP_FUNNEL_BUILT → [AMP_FUNNEL_WARN...] → AMP_DRAFT_CREATING → success/error
```
