# Case Parameters & Registry Integration Design

## Overview
Design for how Case nodes integrate with the parameter registry system, with future support for external experiment platforms like Statsig.

---

## 1. Parameter Registry Structure for Cases

### 1.1 Case Parameter Files
Location: `param-registry/parameters/cases/`

```yaml
# param-registry/parameters/cases/checkout-flow-test.yaml
parameter_id: case-checkout-flow-001
parameter_type: case
name: Checkout Flow A/B Test
description: Testing new streamlined checkout vs original flow

# Case metadata
case:
  id: case_001
  slug: checkout-flow-test
  status: active
  created_at: 2025-01-15T10:00:00Z
  updated_at: 2025-01-20T14:30:00Z
  
  # Experiment platform integration
  platform:
    type: statsig  # or 'manual', 'optimizely', 'launchdarkly'
    experiment_id: exp_checkout_streamline
    project_id: <private-repo>
    api_key_ref: STATSIG_API_KEY  # Reference to environment variable
  
  # Variants and their allocations
  variants:
    - name: control
      weight: 0.5
      description: Original checkout flow
      statsig_variant_id: control
      
    - name: treatment
      weight: 0.5
      description: New streamlined checkout
      statsig_variant_id: treatment
  
  # Time-based configurations
  schedules:
    - start_date: 2025-01-15T00:00:00Z
      end_date: 2025-02-15T23:59:59Z
      variants:
        control: 0.5
        treatment: 0.5
      
    - start_date: 2025-02-16T00:00:00Z
      end_date: 2025-03-15T23:59:59Z
      variants:
        control: 0.2
        treatment: 0.8
      note: Increased treatment after positive results

# Historical data (for analysis)
history:
  - date: 2025-01-15
    status: active
    variants:
      control: 0.5
      treatment: 0.5
    
  - date: 2025-02-16
    status: active
    variants:
      control: 0.2
      treatment: 0.8

# Applicable nodes (which nodes in which graphs use this case)
applies_to:
  - graph: conversion-base
    node_id: case_checkout_001
    node_slug: case-checkout
  
  - graph: conversion-mobile
    node_id: case_checkout_mobile_001
    node_slug: case-checkout-mobile

# Tags for organization
tags:
  - checkout
  - conversion
  - ui-test
  - high-priority

# Ownership
owner: product-team
contacts:
  - email: product@example.com
    role: owner
  - email: data@example.com
    role: analyst
```

### 1.2 Registry Index for Cases
Location: `param-registry/registry.yaml`

```yaml
parameters:
  # ... existing probability parameters ...
  # ... existing cost parameters ...
  # ... existing time parameters ...
  
  # Case parameters
  cases:
    - id: case-checkout-flow-001
      name: Checkout Flow A/B Test
      file: parameters/cases/checkout-flow-test.yaml
      status: active
      platform: statsig
      
    - id: case-pricing-test-001
      name: Pricing Strategy Test
      file: parameters/cases/pricing-test.yaml
      status: completed
      platform: manual
      
    - id: case-onboarding-flow-001
      name: Onboarding Flow Test
      file: parameters/cases/onboarding-test.yaml
      status: paused
      platform: statsig
```

---

## 2. Statsig Integration Design

### 2.1 Statsig Data Model Mapping

**Statsig Experiment → Case Parameter:**
```
Statsig Experiment
├── experiment_id → case.platform.experiment_id
├── status (active/paused/completed) → case.status
├── variants[]
│   ├── name → case.variants[].name
│   ├── allocation → case.variants[].weight
│   └── variant_id → case.variants[].statsig_variant_id
└── rules[] → case.schedules[]
```

### 2.2 Statsig API Integration

**Fetch Function:**
```javascript
/**
 * Fetch case parameters from Statsig
 * @param {string} experimentId - Statsig experiment ID
 * @param {string} apiKey - Statsig API key
 * @returns {Object} Case parameter data
 */
async function fetchStatsigCase(experimentId, apiKey) {
  const response = await fetch(
    `https://statsigapi.net/v1/experiments/${experimentId}`,
    {
      headers: {
        'STATSIG-API-KEY': apiKey,
        'Content-Type': 'application/json'
      }
    }
  );
  
  const experiment = await response.json();
  
  return {
    case_id: experiment.id,
    status: mapStatsigStatus(experiment.status),
    variants: experiment.allocation.map(variant => ({
      name: variant.name,
      weight: variant.percentage / 100,
      statsig_variant_id: variant.id
    })),
    updated_at: experiment.lastModifiedTime
  };
}

/**
 * Map Statsig status to case status
 */
function mapStatsigStatus(statsigStatus) {
  const mapping = {
    'active': 'active',
    'paused': 'paused',
    'completed': 'completed',
    'archived': 'completed'
  };
  return mapping[statsigStatus] || 'paused';
}
```

### 2.3 Time-Based Parameter Resolution

**For a specific date, resolve case parameters:**
```javascript
/**
 * Resolve case parameters for a specific date
 * @param {Object} caseParam - Case parameter object
 * @param {Date} date - Date to resolve for
 * @returns {Object} Resolved variant weights
 */
function resolveCaseForDate(caseParam, date) {
  // Find the applicable schedule
  const schedule = caseParam.case.schedules.find(s => {
    const start = new Date(s.start_date);
    const end = new Date(s.end_date);
    return date >= start && date <= end;
  });
  
  if (!schedule) {
    // Use current variant weights if no schedule matches
    return caseParam.case.variants.reduce((acc, v) => {
      acc[v.name] = v.weight;
      return acc;
    }, {});
  }
  
  return schedule.variants;
}
```

---

## 3. Apps Script Integration

### 3.1 New Function: dagGetCaseParams

```javascript
/**
 * Get case parameters from registry
 * @param {string} caseId - Case parameter ID
 * @param {Date} [asOfDate] - Date to resolve parameters for (default: today)
 * @returns {Object} Case parameters
 * @customfunction
 */
function dagGetCaseParams(caseId, asOfDate) {
  const date = asOfDate ? new Date(asOfDate) : new Date();
  
  // Fetch from parameter registry
  const caseParam = fetchCaseParameter(caseId);
  
  if (!caseParam) {
    return `Error: Case parameter ${caseId} not found`;
  }
  
  // Resolve for specific date
  const variants = resolveCaseForDate(caseParam, date);
  
  return {
    case_id: caseParam.parameter_id,
    name: caseParam.name,
    status: caseParam.case.status,
    platform: caseParam.case.platform?.type || 'manual',
    variants: variants,
    as_of_date: date.toISOString()
  };
}
```

### 3.2 Enhanced: dagCalc with Registry

```javascript
/**
 * Calculate with automatic parameter registry lookup
 * @param {string} input - Graph JSON
 * @param {string} operation - DG_PROBABILITY, DG_COST, DG_TIME
 * @param {string} startNode - Start node
 * @param {string} endNode - End node
 * @param {string} [customParams] - Override parameters (optional)
 * @param {Date} [asOfDate] - Date for parameter resolution
 * @returns {number} Calculated result
 * @customfunction
 */
function dagCalc(input, operation, startNode, endNode, customParams, asOfDate) {
  const graph = parseGraphInput(input);
  const date = asOfDate ? new Date(asOfDate) : new Date();
  
  // Automatically resolve case parameters from registry
  const caseParams = resolveCaseParametersFromRegistry(graph, date);
  
  // Apply registry-resolved parameters
  applyCaseOverrides(graph, caseParams);
  
  // Apply custom overrides (if provided - these take precedence)
  if (customParams) {
    const params = JSON.parse(customParams);
    if (params.cases) {
      applyCaseOverrides(graph, params.cases);
    }
    if (params.edges) {
      applyEdgeOverrides(graph, params.edges);
    }
  }
  
  return calculateResult(graph, operation, startNode, endNode);
}

/**
 * Resolve case parameters from registry for all case nodes
 */
function resolveCaseParametersFromRegistry(graph, date) {
  const caseParams = {};
  
  // Find all case nodes
  const caseNodes = graph.nodes.filter(node => node.type === 'case');
  
  caseNodes.forEach(node => {
    // Look up parameter ID from node metadata
    const paramId = node.case?.parameter_id;
    if (!paramId) return;
    
    // Fetch and resolve from registry
    const caseParam = fetchCaseParameter(paramId);
    if (!caseParam) return;
    
    const variants = resolveCaseForDate(caseParam, date);
    caseParams[node.case.id] = variants;
  });
  
  return caseParams;
}
```

### 3.3 New Function: dagSyncStatsig

```javascript
/**
 * Sync case parameters from Statsig
 * @param {string} caseId - Case parameter ID
 * @returns {Object} Updated case parameters
 * @customfunction
 */
function dagSyncStatsig(caseId) {
  const caseParam = fetchCaseParameter(caseId);
  
  if (!caseParam || caseParam.case.platform?.type !== 'statsig') {
    return 'Error: Not a Statsig case or case not found';
  }
  
  // Fetch from Statsig
  const statsigData = fetchStatsigCase(
    caseParam.case.platform.experiment_id,
    getApiKey(caseParam.case.platform.api_key_ref)
  );
  
  // Update parameter file
  updateCaseParameter(caseId, {
    case: {
      ...caseParam.case,
      status: statsigData.status,
      variants: caseParam.case.variants.map(v => {
        const statsigVariant = statsigData.variants.find(
          sv => sv.name === v.name
        );
        return {
          ...v,
          weight: statsigVariant ? statsigVariant.weight : v.weight
        };
      }),
      updated_at: statsigData.updated_at
    }
  });
  
  return {
    success: true,
    case_id: caseId,
    synced_at: new Date().toISOString(),
    variants: statsigData.variants
  };
}
```

---

## 4. Graph Schema Integration

### 4.1 Node Schema with Parameter Reference

```json
{
  "id": "case_checkout_001",
  "type": "case",
  "label": "Checkout Flow Case",
  "case": {
    "id": "case_001",
    "parameter_id": "case-checkout-flow-001",  // NEW: Reference to registry
    "status": "active",
    "variants": [
      {
        "name": "control",
        "weight": 0.5,
        "description": "Original flow"
      },
      {
        "name": "treatment",
        "weight": 0.5,
        "description": "New flow"
      }
    ]
  }
}
```

**Key Addition:** `parameter_id` links the node to the parameter registry.

### 4.2 Edge Schema with Parameter Reference

```json
{
  "id": "edge_001",
  "from": "case_checkout_001",
  "to": "checkout_success",
  "p": {
    "mean": 0.5,
    "parameter_id": "case-checkout-flow-001"  // NEW: Link to case param
  },
  "case_variant": "control",
  "case_id": "case_001"
}
```

---

## 5. UI Integration

### 5.1 Properties Panel - Parameter Registry Connection

```
┌─ Case Node Properties ─────────────────┐
│                                         │
│ Parameter Registry:                     │
│ [✓] Use Parameter Registry              │
│                                         │
│ Parameter ID: [case-checkout-flow-001▼] │
│                                         │
│ ┌─ Registry Info ────────────────────┐ │
│ │ Name: Checkout Flow A/B Test       │ │
│ │ Status: ● Active                    │ │
│ │ Platform: Statsig                   │ │
│ │ Last Synced: 2025-01-20 14:30:00   │ │
│ │ [↻ Sync from Statsig]              │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ Variants (from registry) ─────────┐ │
│ │ Control: 50% (0.5)                  │ │
│ │ Treatment: 50% (0.5)                │ │
│ │                                     │ │
│ │ [Override Locally]                  │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ OR                                      │
│                                         │
│ [ ] Manual Configuration                │
│ (Configure variants manually)           │
│                                         │
└─────────────────────────────────────────┘
```

### 5.2 Case Parameter Browser

New panel in the UI to browse and manage case parameters:

```
┌─ Case Parameters ─────────────────────┐
│                                       │
│ [Search parameters...]                │
│                                       │
│ Active Cases:                         │
│ ├─ Checkout Flow Test                │
│ │  Status: ● Active (Statsig)        │
│ │  Variants: 50/50                   │
│ │  [Edit] [Sync] [View History]     │
│ │                                    │
│ ├─ Pricing Strategy Test             │
│ │  Status: ● Active (Manual)         │
│ │  Variants: 30/70                   │
│ │  [Edit] [View History]            │
│ │                                    │
│ └─ Onboarding Flow Test              │
│    Status: ○ Paused (Statsig)        │
│    Variants: 50/50                   │
│    [Edit] [Sync] [Resume]           │
│                                       │
│ Completed Cases:                      │
│ └─ Homepage Banner Test              │
│    Status: ○ Completed (Manual)      │
│    Ran: 2024-12-01 to 2025-01-10    │
│    [View Results]                    │
│                                       │
│ [+ New Case Parameter]                │
│                                       │
└───────────────────────────────────────┘
```

---

## 6. Statsig Webhook Integration (Future)

### 6.1 Webhook Endpoint
Create an endpoint that Statsig can call when experiments change:

```javascript
// API endpoint: POST /api/webhooks/statsig
async function handleStatsigWebhook(request) {
  const payload = await request.json();
  
  // Validate webhook signature
  if (!validateStatsigSignature(request.headers, payload)) {
    return { status: 401, error: 'Invalid signature' };
  }
  
  // Update parameter registry
  const result = await updateCaseParameterFromStatsig(
    payload.experiment_id,
    payload.data
  );
  
  return {
    status: 200,
    message: 'Case parameter updated',
    case_id: result.case_id
  };
}
```

### 6.2 Webhook Events to Handle
- `experiment.started` - Activate case
- `experiment.paused` - Pause case
- `experiment.completed` - Mark case as completed
- `experiment.allocation_changed` - Update variant weights
- `experiment.deleted` - Archive case

---

## 7. Time-Series Analysis Support

### 7.1 Historical Parameter Query

```javascript
/**
 * Get case parameters for a date range
 * @param {string} caseId - Case parameter ID
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Array} Daily case parameters
 * @customfunction
 */
function dagGetCaseHistory(caseId, startDate, endDate) {
  const caseParam = fetchCaseParameter(caseId);
  const history = [];
  
  let currentDate = new Date(startDate);
  while (currentDate <= endDate) {
    const variants = resolveCaseForDate(caseParam, currentDate);
    history.push({
      date: currentDate.toISOString().split('T')[0],
      status: caseParam.case.status,
      variants: variants
    });
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return history;
}
```

### 7.2 Bulk Calculation Across Time

```javascript
/**
 * Calculate metric across date range
 * @param {string} input - Graph JSON
 * @param {string} operation - DG_PROBABILITY, DG_COST, DG_TIME
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Array} Daily results
 * @customfunction
 */
function dagCalcTimeSeries(input, operation, startDate, endDate) {
  const results = [];
  
  let currentDate = new Date(startDate);
  while (currentDate <= endDate) {
    const result = dagCalc(
      input,
      operation,
      null, // startNode
      null, // endNode
      null, // customParams
      currentDate // asOfDate
    );
    
    results.push({
      date: currentDate.toISOString().split('T')[0],
      value: result
    });
    
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return results;
}
```

---

## 8. Parameter Registry Schema Extensions

### 8.1 Case Parameter Schema
Location: `param-registry/schemas/case-parameter-schema.yaml`

```yaml
$schema: http://json-schema.org/draft-07/schema#
title: Case Parameter Schema
description: Schema for case/experiment parameters

type: object
required:
  - parameter_id
  - parameter_type
  - name
  - case

properties:
  parameter_id:
    type: string
    pattern: ^case-[a-z0-9-]+$
    
  parameter_type:
    type: string
    const: case
    
  name:
    type: string
    minLength: 1
    
  description:
    type: string
    
  case:
    type: object
    required:
      - id
      - status
      - variants
    properties:
      id:
        type: string
        
      slug:
        type: string
        
      status:
        type: string
        enum: [active, paused, completed]
        
      platform:
        type: object
        properties:
          type:
            type: string
            enum: [manual, statsig, optimizely, launchdarkly]
          experiment_id:
            type: string
          project_id:
            type: string
          api_key_ref:
            type: string
            
      variants:
        type: array
        minItems: 2
        items:
          type: object
          required:
            - name
            - weight
          properties:
            name:
              type: string
            weight:
              type: number
              minimum: 0
              maximum: 1
            description:
              type: string
            statsig_variant_id:
              type: string
              
      schedules:
        type: array
        items:
          type: object
          required:
            - start_date
            - end_date
            - variants
          properties:
            start_date:
              type: string
              format: date-time
            end_date:
              type: string
              format: date-time
            variants:
              type: object
            note:
              type: string
              
  history:
    type: array
    items:
      type: object
      
  applies_to:
    type: array
    items:
      type: object
      properties:
        graph:
          type: string
        node_id:
          type: string
        node_slug:
          type: string
          
  tags:
    type: array
    items:
      type: string
      
  owner:
    type: string
    
  contacts:
    type: array
    items:
      type: object
      properties:
        email:
          type: string
          format: email
        role:
          type: string
```

---

## 9. Implementation Phases

### Phase 1: Basic Parameter Registry (Immediate)
- Create case parameter file structure
- Add parameter_id to case nodes
- Manual parameter management in UI
- Registry lookup in Apps Script

### Phase 2: Time-Based Resolution (Near-term)
- Add schedules to case parameters
- Implement date-based resolution
- Historical parameter queries
- Time-series calculations

### Phase 3: Statsig Integration (Mid-term)
- Statsig API integration
- Sync function in Apps Script
- Auto-update from Statsig
- UI sync button

### Phase 4: Real-time Sync (Long-term)
- Statsig webhook integration
- Real-time parameter updates
- Automated sync scheduling
- Conflict resolution

---

## 10. Example Workflows

### 10.1 Create Case with Registry

1. **Define Parameter:**
   - Create `checkout-flow-test.yaml` in registry
   - Define variants and schedules
   - Commit to repository

2. **Create Node:**
   - Add case node in graph editor
   - Select parameter from dropdown
   - Node syncs variants from registry

3. **Connect to Statsig:**
   - Add Statsig experiment ID
   - Click "Sync from Statsig"
   - Variants update automatically

### 10.2 Historical Analysis

1. **Query Past Performance:**
   ```
   =dagCalc(A1, "probability", "start", "success", "", "2025-01-15")
   ```

2. **Time-Series Analysis:**
   ```
   =dagCalcTimeSeries(A1, "cost", "2025-01-01", "2025-01-31")
   ```

3. **Compare Variants:**
   ```
   =dagCalc(A1, "probability", "start", "success",
     '{"cases": {"case_001": {"control": 1.0, "treatment": 0.0}}}')
   
   =dagCalc(A1, "probability", "start", "success",
     '{"cases": {"case_001": {"control": 0.0, "treatment": 1.0}}}')
   ```

---

## Success Criteria

✅ Case parameters stored in registry with version control
✅ Time-based parameter resolution works correctly
✅ Apps Script can fetch and apply case parameters
✅ UI shows registry-connected case nodes
✅ Statsig sync updates case parameters
✅ Historical analysis works across date ranges
✅ Parameter changes tracked in history
✅ Multiple graphs can reference same case parameter

---

## End of Design Document


