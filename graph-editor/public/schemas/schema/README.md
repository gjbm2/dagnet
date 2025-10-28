# Conversion Funnel Graph Schema (v1.0.0)


This repository provides a JSON Schema (Draft 2020‑12) for versioned conversion‑funnel graphs modeled as DAGs with inlined parameters.


## Purpose & Scope
- **Strict structure** to prevent malformed graphs.
- **Flexible parameters** (probabilities, optional costs/time) with room for future uncertainty models.
- **No scenarios inside the graph**; scenario packs/overrides are handled externally by the analysis runner.


## Core Semantics (enforced by runner/editor)
- **DAG**: No cycles; one or more start nodes are allowed. Acyclicity is verified via toposort.
- **States & transitions**: Nodes are states; edges are conditional transitions.
- **Edge probabilities**: `p.mean` is `P(to | from)`. Outgoing edges from the same source form a partition.
- If `sum(p.mean) < 1`: residual is routed to `policies.default_outcome` unless overridden per node.
- If exactly one outgoing edge is unspecified: it is set to `1 - Σ specified`.
- If multiple are unspecified: they are filled uniformly or proportionally to `weight_default`.
- If `sum(p.mean) > 1`: apply `policies.overflow_policy` (default `error`).
- **Absorbing nodes**: `absorbing: true` (or zero outgoing edges) means terminal. Absorbing nodes must have **zero** outgoing edges; the runner rejects violations.
- **Merge semantics**: Node entry probability is the sum of inbound flows (disjoint path assumption).
- **Costs/time**: Optional, deterministic in v1; can live on node entry or edge traversal.
- **IDs & names**: Each node/edge has immutable `id` (UUID) and editable `slug`. References may use either; the runner canonicalizes to `id`.


## Files
- `conversion-graph-1.0.0.json`: The JSON Schema.
- `example-graph.json`: Minimal valid instance.
- `tests/`: Valid/invalid example instances.


## Validation
Use any Draft 2020‑12 validator. Example (Node.js):


```bash
npm i -D ajv ajv-formats
node -e "const Ajv=require('ajv');const add=require('ajv-formats').default;const fs=require('fs');const ajv=new Ajv({allErrors:true});add(ajv);const schema=JSON.parse(fs.readFileSync('conversion-graph-1.0.0.json'));const data=JSON.parse(fs.readFileSync('example-graph.json'));const validate=ajv.compile(schema);console.log(validate(data)?'OK':validate.errors);"
