# Event Mapping System Implementation

## Overview

Implemented a robust event mapping system that allows provider-specific event names to be resolved from canonical event IDs. This enables the graph to use human-readable event IDs internally while supporting different naming conventions across analytics providers (Amplitude, Segment, Mixpanel, etc.).

## What Was Implemented

### 1. Event Schema Update ✅

**File:** `/graph-editor/public/param-schemas/event-schema.yaml`

Added `provider_event_names` field to event schema:

```yaml
provider_event_names:
  type: object
  description: "Provider-specific event name mappings (flat key-value pairs)"
  additionalProperties:
    type: string
  examples:
    - amplitude: "ServiceLineManagement Confirmed"
      segment: "ServiceLineManagement Confirmed"
      mixpanel: "service_line_management_confirmed"
```

**Usage:** Event files can now specify provider-specific event names alongside the canonical event ID.

### 2. Event Loader ✅

**File:** `/graph-editor/src/services/paramRegistryService.ts`

Added two new functions:
- `loadEventsIndex()`: Loads `events-index.yaml`
- `loadEvent(eventId)`: Loads individual event definitions with fallback logic

**Features:**
- Checks index first, then falls back to direct file loading
- Supports `.yaml`, `.yml`, and `.json` extensions
- Returns minimal event object if file not found (graceful degradation)
- Follows same pattern as existing `loadNode()` function

### 3. buildDslFromEdge Function ✅

**File:** `/graph-editor/src/lib/das/buildDslFromEdge.ts`

New function that builds DSL execution objects from graph edges with provider-specific event name mapping.

**Function Signature:**
```typescript
async function buildDslFromEdge(
  edge: any,
  graph: any,
  connectionProvider?: string,
  eventLoader?: EventLoader
): Promise<DslObject>
```

**Key Features:**
- Resolves node IDs to event IDs
- Maps event IDs to provider-specific event names
- Supports all DSL constructs: `from`, `to`, `visited`, `exclude`, `visitedAny`, `context`, `case`
- Graceful fallback: uses event_id as-is if no mapping exists
- Comprehensive error messages with actionable guidance

**Event Name Resolution Flow:**
```
node.event_id → loadEvent() → provider_event_names[provider] → final event name
                                        ↓ (if missing)
                                    event_id (fallback)
```

### 4. Integration with DASRunner ✅

**File:** `/graph-editor/src/services/dataOperationsService.ts`

Updated `getFromSourceDirect()` to:
1. Extract connection provider from connection definition
2. Build DSL from edge using `buildDslFromEdge()`
3. Pass provider-specific event names to DAS Runner

**Code Flow:**
```typescript
// 1. Load connection to get provider
const connection = await connectionProvider.getConnection(connectionName);
const provider = connection.provider; // e.g., "amplitude"

// 2. Build DSL with event mapping
const dsl = await buildDslFromEdge(
  targetEdge,
  graph,
  provider,
  (eventId) => paramRegistryService.loadEvent(eventId)
);

// 3. Execute with mapped event names
const result = await runner.execute(connectionName, dsl, options);
```

### 5. Type System Updates ✅

**File:** `/graph-editor/src/types/index.ts`

Added `query` field to `ProbabilityParam` interface:

```typescript
export interface ProbabilityParam {
  // ... existing fields ...
  query?: any; // Query object for data retrieval (DSL query: from/to/visited/etc)
  evidence?: Evidence;
}
```

## How It Works

### Example Workflow

1. **User creates event files** in `/events/` directory:

```yaml
# events/checkout_started.yaml
id: checkout_started
name: "Checkout Started"
description: "User initiates checkout process"
provider_event_names:
  amplitude: "Checkout Started"
  segment: "checkout_started"
  mixpanel: "checkout:start"
```

2. **Graph nodes reference event IDs**:

```json
{
  "id": "checkout-node",
  "label": "Checkout",
  "event_id": "checkout_started"
}
```

3. **Edge queries use node IDs**:

```json
{
  "from": "start-node",
  "to": "checkout-node",
  "p": {
    "query": {
      "from": "start-node",
      "to": "checkout-node"
    },
    "connection": "amplitude-prod"
  }
}
```

4. **When fetching data** (Lightning Menu → Get from Source):
   - System loads connection: `provider = "amplitude"`
   - Looks up nodes: `checkout-node.event_id = "checkout_started"`
   - Loads event file: `events/checkout_started.yaml`
   - Resolves event name: `provider_event_names.amplitude = "Checkout Started"`
   - Sends to Amplitude API: `"Checkout Started"` ✅

### Fallback Behavior

If any step fails, the system falls back gracefully:

- **No event file?** → Use `event_id` as-is
- **No provider mapping?** → Use `event_id` as-is
- **No event loader?** → Use `event_id` as-is
- **No provider specified?** → Use `event_id` as-is

This ensures the system works even without event files (for simple cases) while supporting sophisticated provider-specific mappings when needed.

## Testing Checklist

### Manual Testing Steps

1. **Create Event Files**
   ```bash
   # Create events directory
   mkdir -p events
   
   # Create sample event file
   cat > events/checkout_started.yaml << 'EOF'
   id: checkout_started
   name: "Checkout Started"
   description: "User initiates checkout process"
   category: user_action
   tags: ["checkout", "conversion"]
   provider_event_names:
     amplitude: "Checkout Started"
     segment: "checkout_started"
   EOF
   ```

2. **Create Events Index**
   ```bash
   cat > events-index.yaml << 'EOF'
   version: "1.0.0"
   events:
     - id: checkout_started
       name: "Checkout Started"
       file_path: "events/checkout_started.yaml"
       tags: ["checkout", "conversion"]
   EOF
   ```

3. **Update Graph Nodes**
   - Open graph in editor
   - Add `event_id` field to nodes
   - Set value to canonical event ID (e.g., `checkout_started`)

4. **Add Amplitude Connection**
   - File → Credentials
   - Add Amplitude credentials:
     ```yaml
     providers:
       amplitude:
         api_key: "your-api-key"
         secret_key: "your-secret-key"
     ```

5. **Test Data Fetch**
   - Click Lightning Menu (⚡) on parameter/edge
   - Select "Get from Source (Direct)"
   - Check console logs for event mapping:
     ```
     Mapped event_id "checkout_started" → "Checkout Started" for provider "amplitude"
     Built DSL from edge with event mapping: { from: "Checkout Started", to: "..." }
     ```

### Expected Console Output

```
📦 WorkspaceService: Loading workspace...
Trying to load event from: events/checkout_started.yaml
✓ Loaded event: checkout_started
Connection loaded: { name: "amplitude-prod", provider: "amplitude" }
Mapped event_id "checkout_started" → "Checkout Started" for provider "amplitude"
Built DSL from edge with event mapping: {
  from: "Checkout Started",
  to: "Purchase Complete",
  visited: ["Cart Updated"]
}
[DASRunner] Executing adapter for Amplitude...
```

## Architecture Benefits

1. **Separation of Concerns**
   - Graph uses canonical event IDs
   - Provider adapters use provider-specific names
   - Mapping layer bridges the two

2. **Flexibility**
   - Support multiple providers without changing graph
   - Override event names per provider
   - Add new providers without modifying existing mappings

3. **Graceful Degradation**
   - Works without event files (uses event_id as-is)
   - Works without provider mappings (uses event_id as-is)
   - Clear error messages guide users to fix issues

4. **Type Safety**
   - TypeScript interfaces for event definitions
   - Schema validation for event files
   - Linter-friendly implementation

## Next Steps

### Remaining TODOs

1. **Add Amplitude Credentials** (Manual)
   - File → Credentials → Add API key + secret

2. **Create Test Graph** (Manual)
   - Add `event_id` fields to nodes
   - Configure edge queries
   - Set up connections

3. **Test CORS** (Testing)
   - Verify Amplitude API requests work from browser
   - Check CORS headers if needed

4. **End-to-End Test** (Testing)
   - Full workflow: Graph → Lightning Menu → Get from Source → Graph Update
   - Verify event mapping in network logs

5. **Window Selector UI** (Future Enhancement)
   - Time-windowed queries (e.g., "last 30 days")
   - Optional: implement if needed for Amplitude queries

### Future Enhancements

1. **Event Registry UI**
   - Browse/search events in Navigator
   - Create/edit event files through UI
   - Validate provider mappings

2. **Provider Templates**
   - Pre-configured mappings for common events
   - Import/export event libraries
   - Share across projects

3. **Mapping Validation**
   - Check if mapped event names exist in provider
   - Warn about missing mappings
   - Suggest mappings based on event_id

4. **Batch Operations**
   - Map multiple events at once
   - Bulk import from provider
   - Sync event names from Amplitude/Segment

## Files Modified

1. `/graph-editor/public/param-schemas/event-schema.yaml` - Added `provider_event_names` field
2. `/graph-editor/src/services/paramRegistryService.ts` - Added event loading functions
3. `/graph-editor/src/lib/das/buildDslFromEdge.ts` - New file with DSL builder
4. `/graph-editor/src/services/dataOperationsService.ts` - Integrated event mapping
5. `/graph-editor/src/types/index.ts` - Added `query` field to `ProbabilityParam`

## Summary

✅ **Event mapping system fully implemented and ready for testing**

The system now:
- ✅ Loads event definitions from `events/` directory
- ✅ Maps canonical event IDs to provider-specific names
- ✅ Integrates with DAS Runner for data fetching
- ✅ Falls back gracefully when mappings don't exist
- ✅ Provides clear error messages for debugging

**Ready for:** Manual testing with real Amplitude data and end-to-end integration tests.

