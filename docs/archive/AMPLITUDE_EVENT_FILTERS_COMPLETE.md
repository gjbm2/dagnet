# Amplitude Event Filters - Complete Implementation

## ✅ What Was Implemented

### 1. Event Schema (`/graph-editor/public/param-schemas/event-schema.yaml`)

Added `amplitude_filters` field to event definitions:

```yaml
amplitude_filters:
  - property: "value"
    operator: "is any of"
    values: ["DO_MOST_OF_IT_FOR_ME", "DO_ALL_OF_IT_FOR_ME"]
```

**Supported Operators:**
- `is`
- `is not`
- `is any of`
- `is not any of`
- `contains`
- `does not contain`

### 2. Test Event Files

**Created:**
- `/param-registry/test/events/household-created.yaml` - Simple event, no filters
- `/param-registry/test/events/delegation-completed.yaml` - With property filters on `value` field

**Example with filters:**

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

### 3. buildDslFromEdge (`/graph-editor/src/lib/das/buildDslFromEdge.ts`)

**Extended interfaces:**

```typescript
export interface EventFilter {
  property: string;
  operator: string;
  values: string[];
}

export interface DslObject {
  from: string;
  to: string;
  visited?: string[];
  exclude?: string[];
  visitedAny?: string[][];
  event_filters?: Record<string, EventFilter[]>; // NEW
}
```

**Collects filters during event resolution:**

```typescript
// When resolving event names
if (connectionProvider === 'amplitude' && eventDef.amplitude_filters) {
  eventFilters[providerEventName] = eventDef.amplitude_filters;
}
```

**Output DSL example:**

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

### 4. Amplitude Adapter (`/graph-editor/public/defaults/connections.yaml`)

**Updated pre_request script to:**

1. **Read event_filters from DSL:**
   ```javascript
   const eventFilters = dsl.event_filters || {};
   ```

2. **Build funnel steps with filters:**
   ```javascript
   const buildEventStep = (eventName, filters) => {
     const step = { event_type: eventName };
     
     if (filters && filters.length > 0) {
       step.filters = filters.map(f => ({
         subprop_type: "event",
         subprop_key: f.property,
         subprop_op: mapOperator(f.operator),
         subprop_value: f.values
       }));
     }
     
     return step;
   };
   ```

3. **Apply filters to all funnel steps:**
   ```javascript
   events.push(buildEventStep(dsl.from, eventFilters[dsl.from]));
   events.push(buildEventStep(dsl.to, eventFilters[dsl.to]));
   ```

**Resulting Amplitude API request body:**

```json
{
  "e": [
    {
      "event_type": "Household Created"
    },
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
  ],
  "start": "20250101",
  "end": "20250110",
  "m": "uniques",
  "i": 1
}
```

## 🔄 Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Graph Node                                                   │
│    event_id: "delegation-completed"                             │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│ 2. Event File                                                   │
│    /events/delegation-completed.yaml                            │
│    provider_event_names:                                        │
│      amplitude: "ServiceLevel Confirmed"                        │
│    amplitude_filters:                                           │
│      - property: "value"                                        │
│        operator: "is any of"                                    │
│        values: ["DO_MOST_OF_IT_FOR_ME", ...]                   │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│ 3. buildDslFromEdge()                                           │
│    Resolves: "delegation-completed" → "ServiceLevel Confirmed"  │
│    Collects filters and adds to DSL                             │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│ 4. DSL Object                                                   │
│    {                                                            │
│      from: "Household Created",                                 │
│      to: "ServiceLevel Confirmed",                              │
│      event_filters: {                                           │
│        "ServiceLevel Confirmed": [...]                          │
│      }                                                           │
│    }                                                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│ 5. DAS Runner                                                   │
│    Passes DSL to Amplitude adapter                              │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│ 6. Amplitude Adapter (pre_request script)                      │
│    Reads dsl.event_filters                                      │
│    Builds funnel steps with property filters                    │
│    Converts to Amplitude API format                             │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│ 7. Amplitude API Request                                        │
│    POST /funnels                                                │
│    {                                                            │
│      "e": [                                                     │
│        { "event_type": "Household Created" },                   │
│        {                                                        │
│          "event_type": "ServiceLevel Confirmed",                │
│          "filters": [{                                          │
│            "subprop_type": "event",                             │
│            "subprop_key": "value",                              │
│            "subprop_op": "is",                                  │
│            "subprop_value": ["DO_MOST_OF_IT_FOR_ME", ...]      │
│          }]                                                     │
│        }                                                        │
│      ],                                                         │
│      "start": "20250101",                                       │
│      "end": "20250110"                                          │
│    }                                                            │
└─────────────────────────────────────────────────────────────────┘
```

## 🧪 Testing Instructions

### Step 1: Create Test Graph

1. **Create or open a graph in the editor**

2. **Add nodes with event_id fields:**

   Node 1 - Household Created:
   ```json
   {
     "id": "household-node",
     "label": "Household Created",
     "event_id": "household-created"
   }
   ```

   Node 2 - Delegation Completed:
   ```json
   {
     "id": "delegation-node", 
     "label": "Delegation",
     "event_id": "delegation-completed"
   }
   ```

3. **Create edge between nodes with query:**

   ```json
   {
     "from": "household-node",
     "to": "delegation-node",
     "p": {
       "connection": "amplitude-prod",
       "query": {
         "from": "household-node",
         "to": "delegation-node"
       }
     }
   }
   ```

### Step 2: Add Amplitude Credentials

1. Open app → **File > Credentials**
2. Add Amplitude section:

```yaml
providers:
  amplitude:
    api_key: "your-amplitude-api-key"
    secret_key: "your-amplitude-secret-key"
```

3. Save credentials

### Step 3: Test Event Mapping

1. Click the edge between Household Created and Delegation
2. Open **Lightning Menu** (⚡ button)
3. Select **"Get from Source (Direct)"**
4. Watch browser console for logs

### Step 4: Verify Console Output

You should see:

```
Mapped event_id "household-created" → "Household Created" for provider "amplitude"
Mapped event_id "delegation-completed" → "ServiceLevel Confirmed" for provider "amplitude"
Added filters for "ServiceLevel Confirmed": [{property: "value", operator: "is any of", ...}]
DSL with event filters: { "ServiceLevel Confirmed": [...] }
Built DSL from edge with event mapping: { from: "Household Created", to: "ServiceLevel Confirmed", ... }
[Amplitude Adapter] Built funnel: { events: [...], from_index: 0, to_index: 1 }
```

### Step 5: Verify Network Request

1. Open browser **DevTools > Network** tab
2. Find the POST request to `amplitude.com/api/2/funnels`
3. Check the **Request Payload:**

```json
{
  "e": [
    {
      "event_type": "Household Created"
    },
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
  ],
  "start": "20250101",
  "end": "20250110",
  "m": "uniques",
  "i": 1
}
```

✅ If you see the `filters` array in the second event step, the implementation is working!

### Step 6: Verify Response

1. Check the **Response** data from Amplitude
2. Should return funnel conversion data:
   - `data.steps[0].count` = number of "Household Created" events
   - `data.steps[1].count` = number of "ServiceLevel Confirmed" events WITH the filter applied
3. The graph should update with the calculated probability

## 📊 Expected Results

### Without Filters (old behavior)
Would count ALL "ServiceLevel Confirmed" events, including:
- DO_MOST_OF_IT_FOR_ME
- DO_ALL_OF_IT_FOR_ME
- DO_SOME_OF_IT_FOR_ME
- DO_NONE_OF_IT_FOR_ME

### With Filters (new behavior)
Only counts "ServiceLevel Confirmed" events where:
- value = DO_MOST_OF_IT_FOR_ME **OR**
- value = DO_ALL_OF_IT_FOR_ME

This gives you the correct conversion rate for households choosing delegation options.

## 🐛 Troubleshooting

### Issue: "event_filters undefined"

**Problem:** `dsl.event_filters` is undefined in adapter
**Solution:** Check that:
1. Event file has `amplitude_filters` field
2. Event file is loaded successfully (check console)
3. `buildDslFromEdge` is being called with `connectionProvider = 'amplitude'`

### Issue: "Filters not appearing in Amplitude request"

**Problem:** Request body doesn't include filters
**Solution:** Check:
1. Browser console for `[Amplitude Adapter] Built funnel:` log
2. Verify `dsl.funnel_events` includes `filters` property
3. Check that pre_request script executed (look for console logs)

### Issue: "Property name wrong in Amplitude"

**Problem:** Amplitude doesn't recognize the property name
**Solution:** 
1. Verify property name in your Amplitude dashboard
2. Update `amplitude_filters.property` in event file to match
3. Common property names in Amplitude: `value`, `user_property`, `event_property`

## 🎉 Summary

✅ **Event schema extended** - `amplitude_filters` field  
✅ **Test events created** - Real events from production  
✅ **buildDslFromEdge updated** - Collects and passes filters  
✅ **Amplitude adapter updated** - Applies filters to funnel steps  
✅ **Complete data flow** - From graph nodes to Amplitude API

**Status:** Ready for production testing with real Amplitude data!

The system now supports property-based filtering for any Amplitude event, allowing you to construct precise funnels that match specific user behaviors.

