# Event Property Filters for Amplitude Queries

## Overview

Extended the event mapping system to support property-based filtering for Amplitude funnel queries. This allows events to specify property value filters that must be applied when constructing Amplitude API queries.

## Problem

Some events like "ServiceLevel Confirmed" need to be filtered by property values:
- Event name: `"ServiceLevel Confirmed"`
- Property filter: `value IN ["DO_MOST_OF_IT_FOR_ME", "DO_ALL_OF_IT_FOR_ME"]`

Without this filtering, the funnel would count ALL "ServiceLevel Confirmed" events, not just the ones where the household selected delegation options.

## Solution

### 1. Event Schema Extended

**File:** `/graph-editor/public/param-schemas/event-schema.yaml`

Added `amplitude_filters` field:

```yaml
amplitude_filters:
  type: array
  description: "Property filters to apply when querying this event in Amplitude"
  items:
    type: object
    properties:
      property:
        type: string
        description: "Property name to filter on"
      operator:
        type: string
        enum: ["is", "is not", "is any of", "is not any of", "contains", "does not contain"]
      values:
        type: array
        items:
          type: string
```

### 2. Event Files

**Example:** `/param-registry/test/events/delegation-completed.yaml`

```yaml
id: delegation-completed
name: Delegation Completed
description: Household has completed delegation step

provider_event_names:
  amplitude: "ServiceLevel Confirmed"

amplitude_filters:
  - property: "value"
    operator: "is any of"
    values: ["DO_MOST_OF_IT_FOR_ME", "DO_ALL_OF_IT_FOR_ME"]
```

### 3. buildDslFromEdge

**File:** `/graph-editor/src/lib/das/buildDslFromEdge.ts`

Updated to collect event filters while resolving event names:

```typescript
interface DslObject {
  from: string;
  to: string;
  // ... other fields ...
  event_filters?: Record<string, EventFilter[]>; // event_name -> filters
}

// When resolving events:
if (connectionProvider === 'amplitude' && eventDef.amplitude_filters) {
  eventFilters[providerEventName] = eventDef.amplitude_filters;
}
```

**Output Example:**

```json
{
  "from": "Household Created",
  "to": "ServiceLevel Confirmed",
  "event_filters": {
    "ServiceLevel Confirmed": [
      {
        "property": "value",
        "operator": "is any of",
        "values": ["DO_MOST_OF_IT_FOR_ME", "DO_ALL_OF_IT_FOR_ME"]
      }
    ]
  }
}
```

## Next Steps: Amplitude Adapter Implementation

The Amplitude adapter needs to be updated to use `event_filters` when constructing funnel queries.

### Amplitude Funnel API Structure

When constructing an Amplitude funnel query step, filters are applied like this:

```json
{
  "event_type": "ServiceLevel Confirmed",
  "filters": [
    {
      "subprop_type": "event",
      "subprop_key": "value",
      "subprop_op": "is",
      "subprop_value": ["DO_MOST_OF_IT_FOR_ME", "DO_ALL_OF_IT_FOR_ME"]
    }
  ]
}
```

### Required Adapter Changes

**File:** Amplitude adapter (YAML or code)

1. **Parse `event_filters` from DSL**:
   ```typescript
   const dsl = context.dsl; // From buildDslFromEdge
   const eventFilters = dsl.event_filters || {};
   ```

2. **For each funnel step, check for filters**:
   ```typescript
   const stepEventName = dsl.from; // or dsl.to, etc.
   const filters = eventFilters[stepEventName];
   
   if (filters) {
     // Apply filters to this step
   }
   ```

3. **Convert filter format**:
   ```typescript
   function convertFilters(filters: EventFilter[]): AmplitudeFilter[] {
     return filters.map(f => ({
       subprop_type: "event",
       subprop_key: f.property,
       subprop_op: mapOperator(f.operator), // "is any of" -> "is"
       subprop_value: f.values
     }));
   }
   
   function mapOperator(op: string): string {
     const mapping = {
       "is": "is",
       "is not": "is not",
       "is any of": "is",
       "is not any of": "is not",
       "contains": "contains",
       "does not contain": "does not contain"
     };
     return mapping[op] || "is";
   }
   ```

4. **Inject into funnel step definition**:
   ```typescript
   const funnelSteps = [
     {
       event_type: dsl.from,
       filters: eventFilters[dsl.from] 
         ? convertFilters(eventFilters[dsl.from]) 
         : []
     },
     {
       event_type: dsl.to,
       filters: eventFilters[dsl.to]
         ? convertFilters(eventFilters[dsl.to])
         : []
     }
   ];
   ```

### Testing

1. **Create test event** with `amplitude_filters`
2. **Create graph** with nodes using that event_id
3. **Execute query** via Lightning Menu → Get from Source
4. **Verify console output** shows:
   ```
   Mapped event_id "delegation-completed" → "ServiceLevel Confirmed" for provider "amplitude"
   Added filters for "ServiceLevel Confirmed": [...]
   DSL with event filters: { "ServiceLevel Confirmed": [...] }
   ```
5. **Check Amplitude API request** in Network tab - should include property filters

## Summary

✅ **Schema extended** - `amplitude_filters` field added to event schema
✅ **Event files updated** - Real events with property filters
✅ **buildDslFromEdge updated** - Collects and passes filters in DSL
⏳ **Amplitude adapter** - Needs to consume `event_filters` from DSL

**Next:** Update Amplitude adapter to use `dsl.event_filters` when constructing funnel API requests.

