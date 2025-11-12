# Mapping Types: Complete Matrix

| ORIGIN | SUB-ORIGIN | DESTINATION | SUB-DESTINATION | MAPPING TYPE | EXAMPLES |
|--------|-----------|-------------|-----------------|--------------|----------|
| Graph | - | Graph | - | `graph_internal` | MSMDC updates edge.query; copy/paste nodes; cascade label changes |
| Graph | Edge | File | Parameter | `graph_to_parameter` | User clicks "Save to Param File"; snapshot edge state; export for reuse |
| Graph | Case Node | File | Case | `graph_to_case` | User clicks "Save to Case File"; snapshot case weights; export experiment config |
| File | Parameter | Graph | Edge | `parameter_to_graph` | User clicks "Pull from Param"; sync param file values to edge; auto-update on file change |
| File | Case | Graph | Case Node | `case_to_graph` | User clicks "Pull from Case"; sync case file schedules to node; auto-update on file change |
| File | Node Registry | Graph | Node | `registry_to_graph` | User creates node linked to registry; auto-update label/description when registry changes |
| External | Amplitude, Sheets, API | Graph | Edge | `external_to_graph` | Direct connection: Amplitude → edge.p; Sheets → edge.p; no param file intermediary |
| External | Statsig, Optimizely | Graph | Case Node | `external_to_graph_case` | Direct connection: Statsig → case node weights; no case file intermediary |
| External | Amplitude, Sheets, API | File | Parameter | `external_to_parameter` | Retrieve from Amplitude → append to param file values[]; scheduled data refresh |
| External | Statsig, Optimizely | File | Case | `external_to_case` | Retrieve from Statsig → append to case file schedules[]; scheduled experiment sync |

**Total: 10 Mapping Types**

---

## Key Observations

1. **Node Registry is ONE-WAY:** File (node registry) → Graph only. Graph does NOT push back to node registry.

2. **External is ONE-WAY:** External → Graph/Files only. We don't push back to Amplitude/Statsig.

3. **Graph ↔ Files is BIDIRECTIONAL:** 
   - Graph → Files (push/save/export)
   - Files → Graph (pull/sync/import)

4. **SUB-ORIGIN/SUB-DESTINATION are EXAMPLES, not separate mappings:**
   - `external_to_graph` handles Amplitude, Sheets, any API
   - `external_to_parameter` handles Amplitude, Sheets, any API
   - Connection config determines which connector to use

---

## Naming Convention

Following pattern: `{origin}_to_{destination}`

Where origin/destination can be:
- `graph` (with context: edge, node, case node)
- `parameter` (parameter file)
- `case` (case file)
- `registry` (node registry)
- `external` (any external source)
- `graph_case` (specifically case nodes, to avoid ambiguity)

---

## Implementation Note

Each mapping type handles multiple sub-types via **connector configuration**, not separate mapping types.

Example:
```typescript
// Same mapping type, different connectors
await updateManager.updateEntity(
  amplitudeResult,
  edge.p,
  'external_to_graph',
  { connector: 'amplitude' }  // ← Connector determines source
);

await updateManager.updateEntity(
  sheetsResult,
  edge.p,
  'external_to_graph',
  { connector: 'sheets' }  // ← Same mapping, different connector
);
```

