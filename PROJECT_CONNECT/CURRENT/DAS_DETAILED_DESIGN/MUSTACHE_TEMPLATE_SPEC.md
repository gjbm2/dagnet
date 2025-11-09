# Mustache Template Specification for DAS

## Overview

This document specifies the Mustache template syntax, available variables, and custom filters used in DAS adapter templates (URL templates, header templates, body templates).

## Core Mustache Syntax

DAS uses [Mustache.js](https://github.com/janl/mustache.js/) for template rendering.

### Basic Variable Interpolation

```mustache
{{variable}}           → Value of variable
{{object.field}}       → Nested field access
{{array.0}}            → Array index access
{{{raw_html}}}         → Unescaped output (use with caution)
```

### Conditionals

```mustache
{{#variable}}
  Content shown if variable is truthy
{{/variable}}

{{^variable}}
  Content shown if variable is falsy
{{/variable}}
```

### Iteration

```mustache
{{#array}}
  {{name}} - {{value}}
{{/array}}
```

### Comments

```mustache
{{! This is a comment }}
```

## Template Context Variables

The DAS runner provides the following variables in the template context:

### 1. `dsl` - Query DSL Object

Contains the parsed query from the graph edge or parameter.

```typescript
{
  from_event_id: string;        // Source event ID
  to_event_id: string;          // Target event ID
  visited_event_ids?: string[]; // Events that must occur before
  excluded_event_ids?: string[]; // Events that must not occur
  
  // Computed/transformed fields (added by pre_request)
  [key: string]: any;           // Additional fields from pre_request script
}
```

**Example:**
```mustache
{
  "events": [
    {"event_type": "{{dsl.from_event_id}}"},
    {"event_type": "{{dsl.to_event_id}}"}
  ]
}
```

### 2. `credentials` - Provider Credentials

Contains credentials from `credentials.yaml` for the specified `credsRef`, plus auto-computed derived values.

```typescript
{
  // Original fields from credentials.yaml
  [key: string]: any;
  
  // Auto-computed fields
  basic_auth_b64?: string;      // If api_key + secret_key present
  [decoded_field]?: any;        // Decoded *_b64 fields
}
```

**Example:**
```mustache
Authorization: "Bearer {{credentials.api_key}}"
Authorization: "Basic {{credentials.basic_auth_b64}}"
Authorization: "Api-Key {{credentials.api_key}}:{{credentials.secret_key}}"
```

### 3. `window` - Time Window

Contains the time range for the query.

```typescript
{
  start: string;  // ISO 8601 datetime (e.g., "2024-01-01T00:00:00Z")
  end: string;    // ISO 8601 datetime
}
```

**Example:**
```mustache
{
  "start": "{{window.start}}",
  "end": "{{window.end}}"
}
```

**Note:** Date format transformation should be done in `pre_request` if needed:
```javascript
// pre_request script
const formatDate = (iso) => iso.split('T')[0].replace(/-/g, '');
dsl.start_date = formatDate(window.start);  // "20240101"
dsl.end_date = formatDate(window.end);
return dsl;
```

### 4. `context` - Filter Context

Contains user-defined context filters (e.g., device type, user segment).

```typescript
{
  [key: string]: any;  // Arbitrary key-value pairs
}
```

**Example:**
```mustache
{{#context.device}}
  "device": "{{context.device}}",
{{/context.device}}
{{#context.segment}}
  "segment": "{{context.segment}}",
{{/context.segment}}
```

**Note:** Context structure and usage is still under design (see TODO).

### 5. `defaults` - Connection Defaults

Contains default values from `connections.yaml` for the connection.

```typescript
{
  [key: string]: any;  // Connection-specific defaults
}
```

**Example:**
```mustache
https://api.example.com/{{defaults.api_version}}/data
```

### 6. `connection_string` - Parameter Connection String

Contains parameter-specific connection overrides from the graph edge/parameter.

```typescript
{
  [key: string]: any;  // Parameter-specific overrides
}
```

**Example:**
```mustache
https://sheets.googleapis.com/v4/spreadsheets/{{connection_string.spreadsheet_id}}/values/{{connection_string.range}}
```

### 7. Graph Context Variables (for upsert)

Available during the `upsert` phase:

```typescript
{
  edgeId: string;     // Edge UUID being updated
  nodeId: string;     // Node UUID being updated (for case nodes)
  paramId: string;    // Parameter UUID being updated
}
```

**Example:**
```mustache
{
  "to": "/edges/{{edgeId}}/p/mean"
}
```

## Template Variable Summary Table

| Variable | Type | Available In | Description |
|----------|------|--------------|-------------|
| `dsl.*` | object | request, response | Query parameters (from/to/visited/excluded) |
| `credentials.*` | object | request | Provider credentials + auto-computed fields |
| `window.*` | object | request | Time range (start/end ISO 8601) |
| `context.*` | object | request | User-defined filters |
| `defaults.*` | object | request, response | Connection defaults |
| `connection_string.*` | object | request, response | Parameter-specific overrides |
| `edgeId` | string | upsert | Edge UUID for graph updates |
| `nodeId` | string | upsert | Node UUID for graph updates |
| `paramId` | string | upsert | Parameter UUID for graph updates |

## Special Handling: JSON Serialization

### Problem: Arrays and Objects in Mustache

Mustache doesn't automatically serialize objects/arrays to JSON. This causes issues:

```mustache
BAD:
{
  "events": {{dsl.funnel_events}}
}
→ Outputs: { "events": [object Object] }
```

### Solution 1: Pre-serialize in `pre_request`

```javascript
// pre_request script
dsl.funnel_events_json = JSON.stringify(dsl.funnel_events);
return dsl;
```

```mustache
{
  "events": {{{dsl.funnel_events_json}}}
}
```

### Solution 2: Custom Mustache Helper (Future)

```mustache
{
  "events": {{json dsl.funnel_events}}
}
```

**Decision for v1:** Use pre_request serialization (Solution 1). Custom helpers can be added in v2.

## Common Template Patterns

### Pattern 1: Basic Auth Header

```yaml
headers:
  Authorization: "Basic {{credentials.basic_auth_b64}}"
```

### Pattern 2: Bearer Token

```yaml
headers:
  Authorization: "Bearer {{credentials.access_token}}"
```

### Pattern 3: Custom API Key Header

```yaml
headers:
  X-API-Key: "{{credentials.api_key}}"
```

### Pattern 4: Conditional Request Body Fields

```mustache
{
  "required_field": "value",
  {{#connection_string.optional_field}}
  "optional_field": "{{connection_string.optional_field}}",
  {{/connection_string.optional_field}}
  "end": true
}
```

**Note:** Watch for trailing commas! Mustache doesn't handle JSON syntax, so conditional fields at the end of objects can create invalid JSON.

**Better Pattern:**
```javascript
// pre_request script - build entire body as object
const body = {
  required_field: "value",
  end: true
};
if (connection_string.optional_field) {
  body.optional_field = connection_string.optional_field;
}
dsl.body_json = JSON.stringify(body);
return dsl;
```

```mustache
{{{dsl.body_json}}}
```

### Pattern 5: URL Query Parameters

```mustache
https://api.example.com/data?api_key={{credentials.api_key}}&start={{window.start}}&end={{window.end}}
```

**Note:** URL encoding should be handled in `pre_request` for special characters.

### Pattern 6: Dynamic Array in Request Body

```javascript
// pre_request script
const events = [];
if (dsl.visited_event_ids && dsl.visited_event_ids.length > 0) {
  events.push(...dsl.visited_event_ids.map(id => ({ event_type: id })));
}
events.push({ event_type: dsl.from_event_id });
events.push({ event_type: dsl.to_event_id });

dsl.events_json = JSON.stringify(events);
return dsl;
```

```mustache
{
  "e": {{{dsl.events_json}}},
  "start": "{{dsl.start_date}}"
}
```

## Escaping and Security

### HTML/XML Escaping

By default, Mustache HTML-escapes values:
- `&` → `&amp;`
- `<` → `&lt;`
- `>` → `&gt;`
- `"` → `&quot;`
- `'` → `&#39;`

Use triple braces `{{{variable}}}` to skip escaping.

### JSON Context

For JSON templates, **always use triple braces** for pre-serialized JSON:

```mustache
GOOD: {{{dsl.body_json}}}
BAD:  {{dsl.body_json}}  → Will double-escape quotes
```

### Credential Masking

When logging templates, mask credential values:

```typescript
function maskTemplate(template: string): string {
  return template
    .replace(/{{credentials\.[^}]+}}/g, '{{credentials.***}}')
    .replace(/"[a-zA-Z0-9_-]{20,}"/g, '"***REDACTED***"');
}
```

## Error Handling

### Missing Variables

Mustache silently ignores missing variables (renders as empty string).

**DAS should validate** that required variables exist before rendering:

```typescript
function validateTemplate(template: string, context: any): string[] {
  const requiredVars = extractMustacheVars(template);
  const missingVars = requiredVars.filter(varPath => {
    return !getNestedValue(context, varPath);
  });
  return missingVars;
}
```

**Error message:**
```
Failed to render template for connection 'amplitude-prod':
  Missing required variables:
    - credentials.secret_key
    - dsl.from_event_id
  
Check your credentials.yaml and graph query definition.
```

## Testing Templates

### Test Context Example

```typescript
const testContext = {
  dsl: {
    from_event_id: "page_view",
    to_event_id: "purchase",
    visited_event_ids: ["add_to_cart"],
    start_date: "20240101",
    end_date: "20240131"
  },
  credentials: {
    api_key: "test_key",
    secret_key: "test_secret",
    basic_auth_b64: "dGVzdF9rZXk6dGVzdF9zZWNyZXQ="
  },
  window: {
    start: "2024-01-01T00:00:00Z",
    end: "2024-01-31T23:59:59Z"
  },
  context: {},
  defaults: {
    api_version: "v2",
    project_id: "12345"
  },
  connection_string: {}
};

const rendered = Mustache.render(template, testContext);
```

## Implementation Checklist

- [ ] Install mustache.js: `npm install mustache @types/mustache`
- [ ] Implement `TemplateRenderer` class with context building
- [ ] Add validation for required variables
- [ ] Add credential masking in logs
- [ ] Handle JSON serialization edge cases
- [ ] Add comprehensive template tests
- [ ] Document common patterns in adapter examples

## Future Enhancements (v2)

### Custom Filters/Helpers

```mustache
{{value | json}}           → JSON.stringify(value)
{{value | url_encode}}     → encodeURIComponent(value)
{{value | base64}}         → btoa(value)
{{value | base64_decode}}  → atob(value)
{{date | format_yyyymmdd}} → Date formatting
```

### Template Validation

- JSON schema validation for body templates
- URL syntax validation for URL templates
- Header name/value validation

### Template Debugging

- Dry-run mode showing rendered templates without executing
- Template playground in UI for testing

## Examples from Real Adapters

### Amplitude Funnel Request

```mustache
{
  "e": {{{dsl.events_json}}},
  "start": "{{dsl.start_date}}",
  "end": "{{dsl.end_date}}",
  "m": "uniques",
  "i": 1,
  {{#connection_string.segment_id}}
  "s": [{"prop": "gp:segment_id", "op": "is", "values": ["{{connection_string.segment_id}}"]}],
  {{/connection_string.segment_id}}
  "g": "{{defaults.project_id}}"
}
```

### Google Sheets URL

```mustache
https://sheets.googleapis.com/v4/spreadsheets/{{connection_string.spreadsheet_id}}/values/{{connection_string.range}}
```

### Statsig Console API

```mustache
{{defaults.base_url}}/gates/{{case_id}}
```

### Generic SQL Query

```mustache
SELECT COUNT(*) as n, SUM(CASE WHEN converted = true THEN 1 ELSE 0 END) as k 
FROM {{defaults.schema}}.{{connection_string.table}} 
WHERE event_from = '{{dsl.from_event_id}}' 
  AND event_to = '{{dsl.to_event_id}}' 
  AND timestamp BETWEEN '{{window.start}}' AND '{{window.end}}'
```

## Reference

- [Mustache.js Documentation](https://github.com/janl/mustache.js/)
- [Mustache Manual](https://mustache.github.io/mustache.5.html)
- [JSON Template Best Practices](https://jsonapi.org/)

