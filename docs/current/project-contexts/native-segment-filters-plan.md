# Native Segment Filters for visited() and minus() - Implementation Plan

**Date**: 4-Dec-25  
**Status**: Ready for implementation  
**Priority**: High - significant simplification opportunity

## Discovery Summary

We discovered that Amplitude's Dashboard REST API supports **inline behavioral cohort definitions** in the segment (`s=`) parameter. This allows us to implement `visited()` and `minus()` queries **natively** without the complex workarounds we built.

### The Magic Format

```json
s=[
  {
    "type": "event",
    "event_type": "EVENT_NAME",
    "filters": [/* optional event property filters */],
    "op": ">=",   // or "=" for exclude
    "value": 1,   // or 0 for exclude
    "time_type": "rolling",
    "time_value": 366
  }
]
```

### Verified Capabilities

| Query Pattern | Segment Filter |
|--------------|----------------|
| `visited(X)` | `{"type":"event","event_type":"X","op":">=","value":1,...}` |
| `minus(X)` | `{"type":"event","event_type":"X","op":"=","value":0,...}` |
| Multiple conditions | Array of filters (AND logic) |
| With event filters | Add `"filters":[...]` to the segment object |

### Why This Is Better

1. **Correct date anchoring**: Window anchors on funnel steps, not filter events
2. **No dual queries**: Single query returns correct n and k
3. **Simpler code**: No super-funnel construction, no n/k recombination
4. **Consistent results**: Matches Amplitude UI exactly

## Implementation Phases

### Phase 1: Update Amplitude Adapter (connections.yaml)

**File**: `graph-editor/public/defaults/connections.yaml`

In the `pre_request` script for the amplitude provider, add segment filter construction for visited/minus:

```javascript
// AFTER existing segment construction (cohort exclusions, context filters, case filters)

// Native visited() support - add segment filters for upstream visited nodes
// This replaces the super-funnel approach with simpler segment filters
if (queryPayload.visited_upstream && queryPayload.visited_upstream.length > 0) {
  console.log('[Amplitude Adapter] Using NATIVE segment filters for visited_upstream:', queryPayload.visited_upstream);
  for (const eventId of queryPayload.visited_upstream) {
    const eventDef = buildEventStepFromId(eventId);
    segments.push({
      type: "event",
      event_type: eventDef.event_type,
      filters: eventDef.filters || [],
      op: ">=",
      value: 1,
      time_type: "rolling",
      time_value: 366  // Look back ~1 year
    });
  }
  // Clear visited_upstream so we don't ALSO build a super-funnel
  queryPayload.visited_upstream = [];
}

// Native minus() support - add segment filters for excluded nodes
if (queryPayload.excludes && queryPayload.excludes.length > 0) {
  console.log('[Amplitude Adapter] Using NATIVE segment filters for excludes:', queryPayload.excludes);
  for (const eventId of queryPayload.excludes) {
    const eventDef = buildEventStepFromId(eventId);
    segments.push({
      type: "event",
      event_type: eventDef.event_type,
      filters: eventDef.filters || [],
      op: "=",
      value: 0,
      time_type: "rolling",
      time_value: 366
    });
  }
  // Clear excludes so downstream code doesn't try composite query handling
  queryPayload.excludes = [];
}
```

### Phase 2: Simplify dataOperationsService.ts

**File**: `graph-editor/src/services/dataOperationsService.ts`

Mark the following code blocks as **DEPRECATED** with clear comments:

#### 2a. Super-funnel dual-query logic (~lines 3040-3065)

```typescript
// ═══════════════════════════════════════════════════════════════════════
// DEPRECATED: Super-funnel dual-query approach
// This code built super-funnels for visited() queries and ran dual queries
// to recombine n and k values. Replaced by native segment filters in the
// Amplitude adapter (connections.yaml).
// 
// DO NOT DELETE until native segment filters are confirmed working in production.
// Target deletion: After 2 weeks of production validation.
// ═══════════════════════════════════════════════════════════════════════
```

#### 2b. Composite query detection and handling (~lines 3320-3380)

```typescript
// ═══════════════════════════════════════════════════════════════════════
// DEPRECATED: Composite query detection for minus()/plus()
// This code detected minus() and plus() terms in queries and handled them
// via composite query logic. Replaced by native segment filters in the
// Amplitude adapter (connections.yaml).
// 
// DO NOT DELETE until native segment filters are confirmed working in production.
// Target deletion: After 2 weeks of production validation.
// ═══════════════════════════════════════════════════════════════════════
```

#### 2c. Dual-query n/k recombination (~lines 3590-3700)

```typescript
// ═══════════════════════════════════════════════════════════════════════
// DEPRECATED: Dual-query n/k recombination
// This code combined results from base and conditioned queries to compute
// conditional probabilities. Replaced by native segment filters which
// return correct n and k in a single query.
// 
// DO NOT DELETE until native segment filters are confirmed working in production.
// Target deletion: After 2 weeks of production validation.
// ═══════════════════════════════════════════════════════════════════════
```

### Phase 3: Update buildDslFromEdge.ts

**File**: `graph-editor/src/services/buildDslFromEdge.ts`

The `visited_upstream` and `excludes` arrays should still be populated from the query DSL, but they will now be consumed by the adapter's segment filter construction rather than by super-funnel logic.

No changes needed to the DSL parsing - only ensure the fields are passed through to the adapter.

### Phase 4: Remove Conditional Logic Bypass

**File**: `graph-editor/src/services/dataOperationsService.ts`

The early return that was added to fix conditional probability n values:

```typescript
// For conditional probability with visited_upstream:
// - n = users at 'from' who ALSO visited the upstream condition node(s)
// - k = users who visited upstream, reached 'from', and converted to 'to'
const combinedN = explicitNQuery ? (baseN ?? 0) : (condRaw?.n ?? 0);
```

This logic becomes unnecessary with native segment filters since the single query returns correct values. Mark as deprecated alongside the dual-query code.

## Testing Plan

### Manual Testing

1. **Simple visited()**: `from(A).to(B).visited(C)`
   - Compare results with Amplitude UI using same filter
   - Verify n and k match

2. **Simple minus()**: `from(A).to(B).minus(C)`
   - Compare results with Amplitude UI using exclude filter
   - Verify n and k match

3. **Multiple conditions**: `from(A).to(B).visited(C).minus(D)`
   - Verify AND logic works correctly
   - Compare with manual UI configuration

4. **With event filters**: Visited node with property filters (e.g., context=ONBOARDING)
   - Verify event filters are included in segment

5. **Time series**: Ensure daily breakdown still works correctly

### Automated Testing

Add tests to `graph-editor/src/services/__tests__/` that verify:
- Segment filter construction in adapter
- Correct n/k values returned
- Multiple conditions combine correctly

## Rollback Plan

If issues are discovered:

1. In `connections.yaml`, comment out the new segment filter code
2. The legacy super-funnel and composite query code remains in place
3. Queries will fall back to the old approach automatically

## Success Criteria

- [ ] visited() queries return same results as Amplitude UI
- [ ] minus() queries return same results as Amplitude UI
- [ ] Multiple conditions work with AND logic
- [ ] Time series data is correct
- [ ] No regression in existing functionality
- [ ] Performance is equal or better (fewer API calls)

## Future Work (After Validation)

After 2 weeks of production validation:

1. Delete deprecated super-funnel code in dataOperationsService.ts
2. Delete deprecated composite query handling
3. Delete deprecated dual-query recombination
4. Simplify buildDslFromEdge.ts if any code becomes unused
5. Update documentation to reflect simplified architecture

## Reference: Curl Commands for Testing

```bash
# visited() - include users who did event
curl -s -G -H "Authorization: Basic $AUTH" \
  --data-urlencode 'e={"event_type":"FROM_EVENT"}' \
  --data-urlencode 'e={"event_type":"TO_EVENT"}' \
  --data-urlencode 'start=20251109' \
  --data-urlencode 'end=20251115' \
  --data-urlencode 's=[{"type":"event","event_type":"VISITED_EVENT","op":">=","value":1,"time_type":"rolling","time_value":366}]' \
  "https://amplitude.com/api/2/funnels"

# minus() - exclude users who did event
curl -s -G -H "Authorization: Basic $AUTH" \
  --data-urlencode 'e={"event_type":"FROM_EVENT"}' \
  --data-urlencode 'e={"event_type":"TO_EVENT"}' \
  --data-urlencode 'start=20251109' \
  --data-urlencode 'end=20251115' \
  --data-urlencode 's=[{"type":"event","event_type":"EXCLUDED_EVENT","op":"=","value":0,"time_type":"rolling","time_value":366}]' \
  "https://amplitude.com/api/2/funnels"
```

## Appendix: Test Results from Discovery

| Query | n | k | Notes |
|-------|---|---|-------|
| Baseline | 635 | 122 | No filters |
| visited(gave-bds) | 176 | 62 | Single include |
| minus(gave-bds) | 459 | 60 | Single exclude (635-176=459 ✓) |
| visited(gave-bds).visited(coffee) | 160 | 52 | Multiple includes (AND) |
| visited(gave-bds).minus(coffee) | 16 | 10 | Include + exclude (176-160=16 ✓) |
| minus(gave-bds).minus(coffee) | 312 | 54 | Multiple excludes (AND) |

