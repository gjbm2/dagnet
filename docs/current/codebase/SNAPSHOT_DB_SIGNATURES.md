# Flexible Signatures — Resilient Archival Identity for Snapshots

**Source**: `docs/current/project-db/flexi_sigs.md`
**Status**: Implemented (10-Feb-26)
**Last reviewed**: 17-Mar-26

---

## 1. Problem Statement

The snapshot DB is archival: the cost of "losing" historical data by failing to match it is high. Strict hash-based signature matching is structurally brittle — small, non-substantive changes (graph structure churn, normalisation differences, load-order variations) produce a new signature, causing **100 days of snapshots to appear to disappear instantly**.

---

## 2. Core Pattern: Brittle Hash + Signature Registry + Explicit Equivalence Links

Content-addressed identity with aliasing:

- A **brittle signature** remains a strict fingerprint (integrity)
- A **signature registry** stores the brittle signature **once** with raw inputs used to compute it
- An **equivalence link table** allows an operator to declare two signatures as equivalent for retrieval

This splits concerns: **fingerprint** (machine-computed, strict) vs **resilience** (user-governed, explicit, audited, reversible).

---

## 3. Signature Computation

### Canonical signature

The frontend-computed `query_signature` string (compact `{c,x}` JSON). This is the **only** semantic signature definition.

### Short DB key (`core_hash`)

- SHA-256 over UTF-8 bytes of the canonical signature string
- Truncate to first 128 bits (16 bytes)
- Encode as base64url (22 chars)

Frontend computes and sends `core_hash` to the backend. See `coreHashService.ts` `computeShortCoreHash()`.

### `inputs_json`

Evidence blob stored once per unique signature for audit/diff. Schema `flexi_sigs.inputs_json.v1`:

- `schema`, `workspace`, `param_id`, `generated_at`
- `canonical_signature` (repeated for self-containedness)
- `canonical_signature_parts` (parsed `{ core, context_def_hashes }`)
- `query_identity` (mode, from/to event IDs, visited/exclude, normalised query)
- `provider` (connection name, events with provider names and filters)
- `contexts` (keys and definitions)

All keys sorted, set-like arrays sorted. `generated_at` excluded from hashing.

---

## 4. DB Tables

### `signature_registry`

One row per unique signature per `param_id`. `INSERT ... ON CONFLICT DO NOTHING`.

```
PK: (param_id, core_hash)
Fields: canonical_signature, inputs_json (JSONB), sig_algo, created_at
```

### `signature_equivalence`

Explicit equivalence declarations (audited, reversible).

```
PK: (param_id, core_hash, equivalent_to)
Fields: created_at, created_by, reason, active (boolean)
```

Treated as undirected graph. "Delete" = set `active=false`.

---

## 5. Read Path: Equivalence Resolution

All snapshot read queries expand `core_hash` via recursive CTE over `signature_equivalence` (active edges only):

```sql
WITH RECURSIVE eq AS (
  SELECT %s::text AS core_hash
  UNION
  SELECT CASE WHEN e.core_hash = eq.core_hash THEN e.equivalent_to ELSE e.core_hash END
  FROM signature_equivalence e
  JOIN eq ON (e.core_hash = eq.core_hash OR e.equivalent_to = eq.core_hash)
  WHERE e.param_id = %s AND e.active = true
)
SELECT DISTINCT core_hash FROM eq;
```

Then: `WHERE core_hash = ANY(%s)`.

All snapshot read routes support `include_equivalents: boolean` (default `true`).

---

## 6. Inventory V2 (Signature Families)

**Signature family** = connected component in the equivalence graph for a `param_id`.

- `family_id` = member with earliest `created_at` (stable, deterministic)
- Inventory grouped by: `param_id` → signature family → `slice_key`
- `overall_all_families` provides cheap "total snapshots exist?" answer
- `current` block shows whether the frontend's current signature matches any family

### Frontend call sites

| Call site | What to pass |
|-----------|-------------|
| `useSnapshotsMenu.ts` (menu counts) | `current_signatures` for each param → use backend `current.matched_family_id` |
| `useDeleteSnapshots.ts` (delete confirmation) | No `current_signatures` needed → use `overall_all_families` |
| `useEdgeSnapshotInventory.ts` (edge tooltips) | Optional `current_signatures` → fallback to `overall_all_families` |

---

## 7. Write Path Invariant

Archival writes must **never** silently invent a signature. If the request omits `canonical_signature` or `inputs_json`, the handler returns a **hard error**. The handler must never attempt to "repair" missing inputs.

---

## 8. Stability Contract

The following are locked by tests and treated as "contract law":

- `canonical_signature` format is stable
- `core_hash` derivation from `canonical_signature` is stable
- `inputs_json` schema is stable

Any intentional change requires updating `sig_algo`, this doc, and the golden test corpus.

---

## 9. Key Source Locations

- `graph-editor/src/services/coreHashService.ts` — `computeShortCoreHash()`
- `graph-editor/src/services/dataOperationsService.ts` — `computeQuerySignature()`, `inputs_json` builder
- `graph-editor/src/services/snapshotWriteService.ts` — `appendSnapshots()`, `getBatchInventoryV2()`
- `graph-editor/lib/snapshot_service.py` — backend write/read/inventory/equivalence
- `graph-editor/src/components/SignatureLinksViewer.tsx` — operator UI for managing equivalence links
