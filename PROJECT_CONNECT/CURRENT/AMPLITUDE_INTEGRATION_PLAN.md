# Amplitude Integration Plan

**Date:** 2025-11-10  
**Status:** 🟡 Ready to implement  
**Priority:** HIGH  
**Estimated Time:** 6-10 hours

---

## Current Status

### ✅ What's Working
- **Google Sheets integration**: End-to-end DAS pipeline tested and working (Nov 9, 2025)
- **DASRunner core**: 10-phase execution engine fully functional
- **Infrastructure**: HttpExecutor, ConnectionProvider, CredentialsManager all working
- **Mustache templating**: Working for URL paths, headers, body
- **JMESPath extraction**: Working for data extraction
- **JSONata transformation**: Working for calculations
- **UpdateManager integration**: Graph updates working via DataOperationsService

### ⚠️ What's Missing for Amplitude

**CRITICAL BLOCKER**: Pre-request script execution is currently **SKIPPED**

```typescript
// Line 143-145 of DASRunner.ts
if (adapter.pre_request) {
  this.log('pre_request', 'Skipping pre_request scripts (v2 feature)');
}
```

Amplitude adapter **REQUIRES** pre_request to:
1. Build full funnel array from visited → from → to events
2. Calculate `target_step_index` for extraction
3. Format dates to Amplitude's YYYYMMDD format

### 📋 Amplitude Adapter Already Defined

Location: `/graph-editor/public/defaults/connections.yaml` (lines 1-80)

```yaml
- name: amplitude-prod
  provider: amplitude
  kind: http
  description: "Production Amplitude analytics for conversion funnel data"
  enabled: true
  credsRef: amplitude
  adapter:
    pre_request:
      script: |
        const events = [];
        if (dsl.visited_event_ids && dsl.visited_event_ids.length > 0) {
          events.push(...dsl.visited_event_ids.map(id => ({ event_type: id })));
        }
        events.push({ event_type: dsl.from_event_id });
        events.push({ event_type: dsl.to_event_id });
        
        // Convert window to Amplitude date format (YYYYMMDD)
        const formatDate = (iso) => iso.split('T')[0].replace(/-/g, '');
        dsl.start_date = formatDate(window.start);
        dsl.end_date = formatDate(window.end);
        dsl.funnel_events = events;
        dsl.target_step_index = events.length - 2;
        
        return dsl;
```

**Issues with this adapter**:
1. **Pre-request not implemented** in DASRunner
2. **Extraction bug**: Lines 68-70 extract same index twice (should be `target_step_index` and `target_step_index + 1`)
3. **Authentication**: Uses Basic auth with `credentials.basic_auth_b64`

---

## Implementation Plan

### Phase 1: Pre-Request Script Execution (3-4 hours)

#### Task 1.1: Implement JavaScript Execution Engine (2-3 hrs)

**File:** `/graph-editor/src/lib/das/DASRunner.ts`

**Approach A - Safe Eval (Recommended)**:
```typescript
private executePreRequestScript(
  script: string,
  context: ExecutionContext
): Record<string, unknown> {
  this.log('pre_request', 'Executing pre-request transformation');
  
  try {
    // Create safe execution environment
    const safeContext = {
      dsl: { ...context.dsl },
      window: { ...context.window },
      connection_string: { ...context.connection_string },
      console: {
        log: (...args: unknown[]) => this.log('pre_request_script', 'Script log', args)
      }
    };
    
    // Execute script with Function constructor
    const fn = new Function(
      'dsl',
      'window',
      'connection_string',
      'console',
      script
    );
    
    const result = fn(
      safeContext.dsl,
      safeContext.window,
      safeContext.connection_string,
      safeContext.console
    );
    
    // Merge changes back into dsl (script mutates dsl directly)
    Object.assign(context.dsl, safeContext.dsl);
    
    if (result !== undefined) {
      this.log('pre_request', 'Script returned value', result);
    }
    
    return context.dsl as Record<string, unknown>;
  } catch (error) {
    throw new TemplateError(
      `Pre-request script failed: ${error instanceof Error ? error.message : String(error)}`,
      { script, error }
    );
  }
}
```

**Update `executeAdapter` method**:
```typescript
private async executeAdapter(adapter: AdapterSpec, context: ExecutionContext): Promise<ExecutionResult> {
  // Phase 1: Pre-request scripts
  if (adapter.pre_request && adapter.pre_request.script) {
    this.executePreRequestScript(adapter.pre_request.script, context);
    this.log('pre_request', 'Pre-request transformation complete', {
      dslKeys: Object.keys(context.dsl)
    });
  }
  
  // ... rest of method unchanged
}
```

**Safety considerations**:
- ✅ No access to DOM/fetch/imports (Function constructor is sandboxed)
- ✅ No access to credentials (not in scope)
- ✅ Scripts can only mutate dsl/window/connection_string
- ⚠️ Can still do infinite loops (timeout protection deferred to v2)

#### Task 1.2: Update TypeScript Types (30 min)

**File:** `/graph-editor/src/lib/das/types.ts`

Current:
```typescript
export interface PreRequestScript {
  name?: string;
  script: string;
}

export interface AdapterSpec {
  pre_request?: PreRequestScript[];
  // ...
}
```

**Issue**: Schema shows `pre_request.script` (string), but type shows array of scripts.

**Fix**: Align with actual schema in connections.yaml:
```typescript
export interface PreRequestScript {
  script: string;
}

export interface AdapterSpec {
  pre_request?: PreRequestScript;  // Single script, not array
  // ...
}
```

#### Task 1.3: Test Pre-Request Execution (30 min)

**File:** `/graph-editor/src/lib/das/__tests__/DASRunner.preRequest.test.ts` (new)

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { DASRunner } from '../DASRunner';
import { MockHttpExecutor, MockConnectionProvider, MockCredentialsManager } from './mocks';

describe('DASRunner - Pre-Request Scripts', () => {
  let runner: DASRunner;
  
  beforeEach(() => {
    runner = new DASRunner(
      new MockHttpExecutor(),
      new MockCredentialsManager(),
      new MockConnectionProvider()
    );
  });
  
  it('should execute pre-request script and mutate dsl', async () => {
    const mockConnection = {
      name: 'test',
      provider: 'test',
      kind: 'http' as const,
      enabled: true,
      adapter: {
        pre_request: {
          script: `
            dsl.calculated_value = dsl.from_event_id + '_' + dsl.to_event_id;
            dsl.array_value = [1, 2, 3];
          `
        },
        request: {
          url_template: 'http://test.com/{{calculated_value}}',
          method: 'GET' as const,
          headers: {}
        },
        response: {
          extract: [{ name: 'result', jmes: 'data' }]
        },
        upsert: {
          mode: 'replace' as const,
          writes: []
        }
      }
    };
    
    // ... test implementation
  });
  
  it('should handle script errors gracefully', async () => {
    // Test error handling
  });
  
  it('should support Amplitude funnel transformation', async () => {
    const script = `
      const events = [];
      if (dsl.visited_event_ids && dsl.visited_event_ids.length > 0) {
        events.push(...dsl.visited_event_ids.map(id => ({ event_type: id })));
      }
      events.push({ event_type: dsl.from_event_id });
      events.push({ event_type: dsl.to_event_id });
      dsl.funnel_events = events;
      dsl.target_step_index = events.length - 2;
    `;
    
    // Test with visited events
    // Verify funnel_events array structure
    // Verify target_step_index calculation
  });
});
```

---

### Phase 2: Fix Amplitude Adapter Definition (30 min)

#### Task 2.1: Fix Extraction Bug

**File:** `/graph-editor/public/defaults/connections.yaml`

**Current (WRONG)**:
```yaml
response:
  extract:
    - name: from_count
      jmes: "data.steps[{{target_step_index}}].count"
    - name: to_count
      jmes: "data.steps[{{target_step_index}}].count"  # ❌ SAME INDEX!
```

**Fixed**:
```yaml
response:
  extract:
    - name: from_count
      jmes: "data.steps[{{target_step_index}}].count"
    - name: to_count
      jmes: "data.steps[`{{target_step_index}} + 1`].count"  # ✅ Next step
```

**Wait** - JMESPath doesn't support arithmetic. Need to add calculated field in pre-request:

```yaml
pre_request:
  script: |
    const events = [];
    if (dsl.visited_event_ids && dsl.visited_event_ids.length > 0) {
      events.push(...dsl.visited_event_ids.map(id => ({ event_type: id })));
    }
    events.push({ event_type: dsl.from_event_id });
    events.push({ event_type: dsl.to_event_id });
    
    const formatDate = (iso) => iso.split('T')[0].replace(/-/g, '');
    dsl.start_date = formatDate(window.start);
    dsl.end_date = formatDate(window.end);
    dsl.funnel_events = events;
    dsl.from_step_index = events.length - 2;
    dsl.to_step_index = events.length - 1;  // ✅ Add this
    
    return dsl;

response:
  extract:
    - name: from_count
      jmes: "data.steps[{{from_step_index}}].count"
    - name: to_count
      jmes: "data.steps[{{to_step_index}}].count"  # ✅ Use calculated index
```

#### Task 2.2: Verify Amplitude API Details

**Research needed**:
1. ✅ Amplitude Dashboard REST API endpoint: `https://amplitude.com/api/2/funnels`
2. ✅ Authentication: HTTP Basic Auth with `apiKey:secretKey` base64 encoded
3. ⚠️ **CORS**: May need proxy (test in browser first)
4. ⚠️ Request body format verification

**Docs**: https://developers.amplitude.com/docs/dashboard-rest-api

---

### Phase 3: Credentials Setup (30 min)

#### Task 3.1: Create Amplitude Credentials Entry

**File:** Open in app via File > Credentials

```yaml
amplitude:
  api_key: "YOUR_AMPLITUDE_API_KEY"
  secret_key: "YOUR_AMPLITUDE_SECRET_KEY"
  # DASRunner will generate basic_auth_b64 automatically
```

**OR** - Update DASRunner to auto-generate basic auth:

**File:** `/graph-editor/src/lib/das/DASRunner.ts`

Add after line 83:
```typescript
// Auto-generate basic auth for Amplitude
if (connection.provider === 'amplitude' && credentials.api_key && credentials.secret_key) {
  const basicAuth = btoa(`${credentials.api_key}:${credentials.secret_key}`);
  credentials = { ...credentials, basic_auth_b64: basicAuth };
  this.log('load_credentials', 'Generated Basic Auth token for Amplitude');
}
```

---

### Phase 4: Test Graph Setup (1 hour)

#### Task 4.1: Create Test Graph with Event IDs

**Requirements**:
- Nodes must have `event_id` field set
- Edge must have `query` object with from/to/visited
- Edge must have `connection` set to "amplitude-prod"

**Example graph**:
```json
{
  "nodes": [
    {
      "id": "node-view",
      "uuid": "node-abc-123",
      "event_id": "product_view",
      "label": "Product View"
    },
    {
      "id": "node-addtocart",
      "uuid": "node-def-456",
      "event_id": "add_to_cart",
      "label": "Add to Cart"
    },
    {
      "id": "node-checkout",
      "uuid": "node-ghi-789",
      "event_id": "checkout",
      "label": "Checkout"
    }
  ],
  "edges": [
    {
      "id": "edge-1",
      "source": "node-addtocart",
      "target": "node-checkout",
      "p": {
        "connection": "amplitude-prod",
        "query": {
          "from": "node-addtocart",
          "to": "node-checkout",
          "visited": ["node-view"]
        }
      }
    }
  ]
}
```

#### Task 4.2: Window Selector

**Status**: Not yet implemented (Phase 3 of implementation plan)

**Workaround for testing**: Pass window in code:
```typescript
const window = {
  start: '2025-10-01T00:00:00Z',
  end: '2025-10-31T23:59:59Z'
};

dataOperationsService.getFromSourceDirect(edgeId, window);
```

---

### Phase 5: Integration Testing (2-3 hours)

#### Task 5.1: CORS Testing

**Test**: Call Amplitude API from browser
```typescript
fetch('https://amplitude.com/api/2/funnels', {
  method: 'POST',
  headers: {
    'Authorization': 'Basic ' + btoa('apiKey:secretKey'),
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    e: [
      { event_type: 'product_view' },
      { event_type: 'add_to_cart' },
      { event_type: 'checkout' }
    ],
    start: '20251001',
    end: '20251031',
    m: 'uniques',
    i: 1
  })
})
```

**If CORS blocked** → Implement proxy (1-2 hrs):

**File:** `/graph-editor/src/lib/das/corsProxy.ts`
```typescript
export async function proxiedFetch(url: string, init: RequestInit): Promise<Response> {
  // Option A: Use cors-anywhere proxy
  // Option B: Implement /api/proxy endpoint in Vercel
  // Option C: Use Amplitude's CORS-friendly endpoint (if exists)
}
```

#### Task 5.2: End-to-End Test

1. Open test graph
2. Click edge with Amplitude connection
3. Lightning Menu → "Get from Source"
4. Verify:
   - Pre-request script executes
   - Funnel array built correctly
   - API request succeeds
   - Data extracted correctly
   - UpdateManager applies changes
   - Graph updates with new values

#### Task 5.3: Debug Logging

Monitor DASRunner logs:
```typescript
// Look for these log entries:
- 'pre_request': Pre-request transformation complete
- 'build_request': HTTP request built
- 'execute_request': Response received with status 200
- 'extract_data': Extracted N variables
- 'transform_data': Transformed data
- 'build_updates': Generated N updates
```

---

## Success Criteria

### Must Have
- ✅ Pre-request script execution working
- ✅ Amplitude funnel transformation working
- ✅ API authentication working
- ✅ Data extraction working
- ✅ Graph updates working
- ✅ End-to-end test passing

### Nice to Have
- ⏳ CORS proxy (if needed)
- ⏳ Window selector UI component
- ⏳ Evidence display (last fetched, n/k/window)
- ⏳ Error handling polish
- ⏳ Loading states

---

## Technical Debt

### Created by This Work
1. **Pre-request security**: No timeout protection (infinite loop possible)
2. **CORS workaround**: May need proxy (adds latency)
3. **Field name translation**: Still using workaround in DataOperationsService

### Already Exists (from Nov 9 session)
1. **UpdateManager field names**: Uses external API terminology (probability/sample_size/successes) instead of schema names (mean/n/k)
2. **Debug logging**: Needs production polish and credential masking

---

## Risk Assessment

### High Risk
- **CORS blocking**: May not be able to call Amplitude API from browser
  - **Mitigation**: Test early, implement proxy if needed
- **Amplitude API changes**: Docs may be outdated
  - **Mitigation**: Verify with latest Amplitude docs

### Medium Risk
- **Pre-request script bugs**: JavaScript execution in sandbox may have edge cases
  - **Mitigation**: Comprehensive unit tests
- **Authentication issues**: Basic auth format may vary
  - **Mitigation**: Test with real credentials early

### Low Risk
- **Template interpolation**: Already working for Google Sheets
- **JMESPath extraction**: Already working
- **UpdateManager integration**: Already working

---

## Timeline

| Task | Estimate | Priority |
|------|----------|----------|
| Pre-request execution | 3-4 hrs | 🔴 Critical |
| Fix Amplitude adapter | 30 min | 🔴 Critical |
| Credentials setup | 30 min | 🟡 High |
| Test graph setup | 1 hr | 🟡 High |
| CORS testing | 1 hr | 🟡 High |
| Integration testing | 2-3 hrs | 🟡 High |
| **Total** | **8-11 hrs** | |

**Best case**: 6 hours (no CORS issues, no debugging needed)  
**Realistic**: 8-10 hours (some debugging, CORS works)  
**Worst case**: 12-14 hours (CORS proxy needed, API issues)

---

## Next Steps

### Immediate (Start Here)
1. ✅ Review this document
2. ⏳ Implement pre-request script execution in DASRunner
3. ⏳ Write unit tests for pre-request
4. ⏳ Fix Amplitude adapter in connections.yaml

### Short Term
5. ⏳ Test CORS with Amplitude API
6. ⏳ Set up Amplitude credentials
7. ⏳ Create test graph with event_ids
8. ⏳ End-to-end integration test

### Follow-Up
9. ⏳ Window selector UI (Phase 3)
10. ⏳ Evidence display (Phase 3)
11. ⏳ Production logging polish (Phase 5)

---

## References

### Documentation
- `/PROJECT_CONNECT/CURRENT/DAS_DETAILED_DESIGN/SUMMARY.md` - Overview
- `/PROJECT_CONNECT/CURRENT/DAS_DETAILED_DESIGN/SESSION_2025-11-09.md` - Nov 9 progress
- `/PROJECT_CONNECT/CURRENT/DAS_DETAILED_DESIGN/IMPLEMENTATION_PLAN.md` - Full plan
- `/PROJECT_CONNECT/CURRENT/DAS_DETAILED_DESIGN/CONNECTIONS_SPEC.md` - Adapter spec

### Code
- `/graph-editor/src/lib/das/DASRunner.ts` - Core engine (476 lines)
- `/graph-editor/public/defaults/connections.yaml` - Amplitude adapter definition
- `/graph-editor/src/services/dataOperationsService.ts` - Integration point

### External
- [Amplitude Dashboard REST API Docs](https://developers.amplitude.com/docs/dashboard-rest-api)
- [Amplitude Funnels API](https://developers.amplitude.com/docs/dashboard-rest-api#funnels)

---

**Created:** 2025-11-10  
**Last Updated:** 2025-11-10  
**Status:** Ready for implementation 🚀

