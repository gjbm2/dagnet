# Flexible signatures (`flexi_sigs`) — resilient archival identity for snapshots

**Status**: Implemented (10-Feb-26). Backend complete. Frontend feature-complete (functional but FE signature matching code in `dataOperationsService.ts` needs refactor — duplicated across window/cohort paths). UI complete (`SignatureLinksViewer`). Test hardening outstanding: Tier A golden corpus thin (~30%), Tier F Playwright 0%. Neither gap is a functional risk.  
**Date**: 4-Feb-26 (design) · 8-Feb-26 (status update) · 10-Feb-26 (status review)  
**Scope**: Snapshot DB write/read identity + operator override for "trivial" signature drift  

---

### Implementation status (8-Feb-26)

**Backend (Python)** — complete:

| Area | Status | Location |
|---|---|---|
| DB tables (`signature_registry`, `signature_equivalence`) | Done | `snapshot_service.py` `_ensure_flexi_sig_tables()` |
| `short_core_hash_from_canonical_signature()` | Done → transitioning to frontend | `snapshot_service.py` (backend, retained as fallback/test); `coreHashService.ts` `computeShortCoreHash()` (frontend, now sole producer). See `hash-fixes.md`. |
| Write path (append + registry insert + validation) | Done | `snapshot_service.py` `append_snapshots()` |
| New API routes (`/api/sigs/*`) | Done | `api_handlers.py` + `dev-server.py` / `python-api.py` |
| Equivalence resolution (recursive CTE) | Done | `resolve_equivalent_hashes()` + inline in virtual/retrievals |
| Inventory V2 (families, `overall_all_families`, `current` match) | Done | `get_batch_inventory_v2()` |
| `/api/snapshots/query-virtual` with `include_equivalents` | Done | `handle_snapshots_query_virtual()` |
| `/api/snapshots/retrievals` with `include_equivalents` | Done | `handle_snapshots_retrievals()` |
| `/api/snapshots/query-full` with `include_equivalents` | Done | `handle_snapshots_query_full()` + `query_snapshots()` |

**Frontend (TypeScript)** — feature-complete, but signature matching is a disaster:

| Area | Status | Location |
|---|---|---|
| Canonical `query_signature` computation | Done | `dataOperationsService.ts` `computeQuerySignature()` |
| Append sends `canonical_signature`, `inputs_json`, `sig_algo`, `core_hash` | Done | `snapshotWriteService.ts` `appendSnapshots()` — frontend now computes and sends `core_hash` (see `hash-fixes.md`) |
| `inputs_json` builder (same service as signature) | Done | `dataOperationsService.ts` (inline, schema `flexi_sigs.inputs_json.v1`) |
| Inventory V2 client (`getBatchInventoryV2()`) | Done | `snapshotWriteService.ts` |
| `useSnapshotsMenu.ts` uses backend `current` field | Done | Uses `matched_family_id`, falls back to `overall_all_families` |
| `useDeleteSnapshots.ts` uses `overall_all_families` | Done | Via legacy wrapper |
| `useEdgeSnapshotInventory.ts` uses `overall_all_families` | Done | Direct access |
| Signature Links operator tab | Done | `SignatureLinksViewer.tsx` + `signatureLinksTabService.ts` |

> **WARNING — Frontend signature matching implementation**
>
> The frontend implementation of signature matching (the code in `dataOperationsService.ts` that computes `query_signature` and builds `inputs_json`) is an unusual mess and a complete disaster. It will need to be completely rethought and redone. The current code is sprawling, duplicated across window/cohort paths, and fragile. This is a known debt item, not a "polish later" issue — it is structurally unsound and must be redesigned before it can be trusted or maintained.

**Test coverage** — significant gaps against the §9 test strategy:

| Tier | Status | Notes |
|---|---|---|
| A — Deterministic hashing (golden cases) | Partial (~30%) | Basic tests exist; missing golden corpus, permutation/canonicalisation invariance, negative cases |
| B — Signature-input completeness | Partial (~70%) | SI-001–SI-005 cover core cases; missing all-call-site sweep and deliberate-failure regression |
| B.1 — Stability contract | Partial (~40%) | Indirectly tested; no explicit "contract law" golden corpus |
| C — Backend contract (validation 4xx) | Done | C-001–C-008: missing fields → ValueError, idempotent registry, link create/deactivate/idempotent, self-link rejected |
| D — Equivalence resolution correctness | Done | D-001–D-006: symmetry, multi-hop, deactivation, cycles, self-only, cross-param isolation |
| E — End-to-end "no disappearance" | Done | E-001: full scenario — old sig → new sig → strict miss → link → all 3 read paths + inventory recover data |
| F — UI workflow (Playwright e2e) | Missing (0%) | Components exist but no Playwright tests |

---

## 1. Problem statement (why strict hashes are brittle)

The snapshot DB is intended to be **archival**: the cost of "losing" historical data (by failing to match it) is high.

Today we rely on a strict signature match (a single value, stored in `snapshots.core_hash`). This provides integrity, but is structurally brittle:

- Small, non-substantive changes (graph structure churn, incidental normalisation differences, load-order/hydration differences) can produce a new signature.
- The result is catastrophic UX: **100 days of snapshots appear to disappear instantly**, despite no meaningful semantic change.

We want a mechanism that:

- Preserves strict integrity (we never silently mix semantically different queries),
- Preserves resilience (trivial changes should be recoverable),
- Keeps writes safe (archival writes must never "make up" signatures silently),
- Keeps storage cheap (avoid storing large signature payloads on every row).

---

## 2. The pattern: brittle hash + signature registry + explicit equivalence links

This proposal implements **content-addressed identity with aliasing**:

- A **brittle signature** remains a strict fingerprint (good for integrity).
- A **signature registry** stores the brittle signature **once** (per unique signature) together with the **raw inputs** used to compute it.
- An **equivalence link table** allows an operator/user to declare that two brittle signatures are *equivalent* for retrieval, when differences are judged trivial.

This splits the concerns:

- **Fingerprint**: machine-computed, strict, deterministic.
- **Resilience**: user-governed equivalence, explicit, audited, reversible.

---

## 3. Storage goal: one short signature in `snapshots`, everything else once in registry

### 3.1 Keep `snapshots` as the archival fact table (breaking change accepted)

We continue writing the time-series rows into `snapshots` (append-only). The only change in spirit is:

- `snapshots.core_hash` becomes a **short content-address** of the canonical signature (a compact opaque string), not a large structured JSON blob.
- `snapshots.context_def_hashes` can remain nullable and typically unused in V1 of this proposal.
 
**Compatibility stance**: we do not care about backward compatibility here. This is a deliberate breaking change and we treat it as the **last** time we break the snapshot-signature feature.

### 3.2 Signature registry: insert-once (skip if already present)

We add a signature registry table. **One row per unique signature** (per `param_id`):

- Typical initial graph: \(10\) params × \(6\) contexts = \(60\) signatures → ~60 registry rows.
- If one param changes meaningfully, only that param produces ~6 new signatures → ~6 new registry rows.

This is achieved with `ON CONFLICT DO NOTHING` (no pre-read required).

---

## 4. Signature computation: one deterministic short ID

### 4.1 Define the canonical signature (single concept)

To avoid "two distinct signature concepts", this proposal defines:

- **Canonical signature**: the existing frontend-computed `query_signature` **string** (the compact `{c,x}` JSON produced by the current signature machinery).

This remains the only semantic signature definition. Everything else is derived from it.

This proposal additionally stores an **evidence blob** (`inputs_json`) once per unique signature in a registry table, for diffing and audit, but that blob is not "the signature".

### 4.2 Compute the short DB key as a content-address of the canonical signature

We compute a digest over the **canonical signature string** and encode a short ID:

- Hash: SHA-256 over UTF-8 bytes of the canonical signature string.
- Truncate: first **128 bits** (16 bytes).
- Encode: **base64url** (22 chars, no padding) or base32 (26 chars).

Rationale:

- 128-bit IDs have vanishing collision probability for expected volumes (archival-grade in practice).
- The ID is short enough to store/index cheaply and to show in UI.
- We preserve exactly one semantic signature concept (the canonical string); the short ID is just an index key.

If we want belt-and-braces collision paranoia without bloating the `snapshots` table:

- Store the full 256-bit digest **only in the registry** (optional) and treat mismatches as impossible/bug.

### 4.3 `inputs_json` (specific proposal)

`inputs_json` exists to make signatures inspectable and linkable by a human. It must contain the **actual semantically relevant inputs** (not just hashes), and it must be deterministic so diffs are meaningful.

**Schema (V1)** — top-level object:

- **`schema`**: `"flexi_sigs.inputs_json.v1"`
- **`workspace`**: `{ "repository": string, "branch": string }`
- **`param_id`**: string (workspace-prefixed; redundant but convenient for UI export)
- **`generated_at`**: ISO datetime string (audit only; NOT used for hashing anything)
- **`canonical_signature`**: the exact `query_signature` string that was hashed into `snapshots.core_hash` (repeat it here so a single registry row is self-contained)
- **`canonical_signature_parts`**: parsed `{ "core": string, "context_def_hashes": Record<string,string> }`
  - This is for UI convenience; the backend does not parse it.
- **`query_identity`** (semantic intent, provider-independent):
  - `mode`: `"window" | "cohort"`
  - `from_event_id`: string
  - `to_event_id`: string
  - `visited_event_ids`: string[] (sorted)
  - `exclude_event_ids`: string[] (sorted)
  - `cohort_anchor_event_id`: string | null
  - `normalised_query`: string (the normalised query representation used by signature machinery; stable)
- **`provider`** (provider-facing inputs that affect results):
  - `connection_name`: string (as used in current signature machinery)
  - `events` (map keyed by event_id):
    - `provider_event_names`: object (sorted by key)
    - `amplitude_filters`: array (canonicalised; stable ordering)
- **`contexts`** (context definitions used):
  - `keys`: string[] (sorted)
  - `definitions` (map keyed by context key):
    - minimal normalised definition fields needed to explain changes (id, type, otherPolicy, values with ids/aliases/sources)

**Canonicalisation rules (mandatory):**

- All object keys are serialised in sorted order.
- Arrays that are semantically sets are sorted (`event_ids`, context keys, provider_event_names keys, aliases arrays, etc.).
- Any "human text" fields that are not semantic should be excluded (to avoid churn).
- `generated_at` is explicitly excluded from any hashing/canonical signature.

**Derivation rule:**

- `inputs_json` must be built by the same single frontend service that produces `canonical_signature`.
- There must not be multiple competing "inputs_json builders".

---

## 5. New DB tables (2)

### 5.1 `signature_registry`

Stores the brittle signature and the raw inputs used to compute it.

```sql
CREATE TABLE signature_registry (
  param_id           TEXT NOT NULL,
  core_hash          TEXT NOT NULL,     -- short content-address of canonical_signature
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Canonical semantic signature (single source of truth)
  canonical_signature TEXT NOT NULL,    -- the frontend `query_signature` string (compact JSON {c,x})

  -- Evidence for audit + diff UI (optional but strongly recommended)
  inputs_json         JSONB NOT NULL,

  -- Optional collision paranoia / audit metadata
  canonical_sig_hash_full TEXT,         -- optional: full SHA-256 hex of canonical_signature
  sig_algo            TEXT NOT NULL,     -- e.g. "sig_v1_sha256_trunc128_b64url"

  PRIMARY KEY (param_id, core_hash)
);

CREATE INDEX idx_sigreg_param_created
  ON signature_registry (param_id, created_at DESC);
```

**Insert behaviour** (Python):

```sql
INSERT INTO signature_registry (param_id, core_hash, canonical_signature, inputs_json, canonical_sig_hash_full, sig_algo)
VALUES (%s, %s, %s, %s::jsonb, %s, %s)
ON CONFLICT (param_id, core_hash) DO NOTHING;
```

### 5.2 `signature_equivalence`

Stores explicit equivalence declarations (audited).

```sql
CREATE TABLE signature_equivalence (
  param_id       TEXT NOT NULL,
  core_hash      TEXT NOT NULL,
  equivalent_to  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     TEXT NOT NULL,
  reason         TEXT NOT NULL,
  active         BOOLEAN NOT NULL DEFAULT true,

  PRIMARY KEY (param_id, core_hash, equivalent_to)
);

CREATE INDEX idx_sigeq_param_core
  ON signature_equivalence (param_id, core_hash);

CREATE INDEX idx_sigeq_param_equiv
  ON signature_equivalence (param_id, equivalent_to);
```

Notes:

- Treat equivalence edges as **undirected** (either store both directions, or treat the graph as undirected during traversal).
- Prefer append-only semantics; "deleting" a link can be implemented as `active=false` (audit preserved).

---

## 6. Python changes (snapshot_service.py + api_handlers.py)

### 6.1 Write path: register signature once, then append snapshots

Current: `/api/snapshots/append` writes rows keyed by `core_hash`.

Proposed modifications:

- Request includes:
  - `param_id`
  - `canonical_signature` (the frontend `query_signature` string; the only semantic signature)
  - `core_hash` (frontend-computed content-address of `canonical_signature`; see `hash-fixes.md`)
  - `inputs_json` (evidence blob: canonical signature inputs used for audit/diff)
  - `sig_algo` (string)
  - (optional) `canonical_sig_hash_full`
  - `slice_key`, `retrieved_at`, `rows` (unchanged)
- Handler behaviour:
  1. Use frontend-provided `core_hash` directly (opaque DB key). During transition, fall back to `short_hash(canonical_signature)` if `core_hash` is absent; see `hash-fixes.md` Phase 3/5.
  2. `INSERT ... ON CONFLICT DO NOTHING` into `signature_registry` (store core_hash + canonical_signature + inputs_json).
  3. `INSERT` snapshot rows into `snapshots` keyed by the short `core_hash` (existing behaviour; `context_def_hashes` can be omitted/null).

**Invariant**: Archival writes must never silently invent a signature.

- If the request omits `canonical_signature` or `inputs_json`, the handler returns a **hard error** (4xx/5xx). This forces the issue to surface and prevents archival corruption.
- The handler must **never** attempt to "repair" missing signature inputs by synthesising defaults, falling back to empty event definitions, or generating time-based placeholders.

### 6.2 Read path: resolve equivalence class before querying snapshots

All snapshot read queries that currently filter by `core_hash = %s` can become:

- Expand: `core_hashes = resolve_equivalent_hashes(param_id, core_hash, include_equivalents: bool)`
- Query: `WHERE core_hash = ANY(%s)`

Implementation strategy (Postgres): recursive CTE over `signature_equivalence` (active edges only).

Sketch:

```sql
WITH RECURSIVE eq AS (
  SELECT %s::text AS core_hash
  UNION
  SELECT CASE
           WHEN e.core_hash = eq.core_hash THEN e.equivalent_to
           ELSE e.core_hash
         END AS core_hash
  FROM signature_equivalence e
  JOIN eq ON (e.core_hash = eq.core_hash OR e.equivalent_to = eq.core_hash)
  WHERE e.param_id = %s AND e.active = true
)
SELECT DISTINCT core_hash FROM eq;
```

Then the snapshot query uses those hashes.

### 6.3 Inventory + retrievals move signature matching to the backend

This proposal requires a subtle but important shift:

- The frontend can only reliably supply `param_id`, `slice_key` (if applicable), and **optionally** a "current" signature for the *current* graph definition.
- The backend must therefore handle the signature-equivalence expansion and inventory grouping, because it is the only place that can consult the equivalence tables.

Concretely, the backend must support these patterns:

- **Calendar retrievals** (Phase 2 `@` UI): frontend supplies `{ param_id, core_hash?: current_sig }`.
  - Backend expands `core_hash` via equivalence links (if provided).
  - If `core_hash` is omitted, backend may either:
    - return retrievals for **all** signatures for that `param_id`, grouped by signature family (best UX for discovery), or
    - require `core_hash` for precision (stricter; more brittle UX).  
  The recommended default is: allow omission, but return results annotated with which signature families they came from.

- **Inventory**: frontend supplies `{ param_ids: [...] }` and (optionally) a mapping of `{ param_id -> current_sig }`.
  - Backend returns inventory grouped by **signature families** (see §6.3.2) and slice keys.
  - This enables a robust UI: "you have data, but it's under these signature families; current signature matches family X (or none)".

#### 6.3.1 Signature family concept (what inventory groups by)

To keep the UI simple without introducing heuristics, define a "signature family" as the **equivalence closure** under active links for a given `param_id`.

- If there are no links, every signature is its own family (trivial).
- If the user links new signatures to prior ones, they become one family (resilience).

#### 6.3.2 What "equivalence" means (no hidden semantics)

Equivalence is deliberately simple:

- Users create explicit links: `A equivalent_to B`.
- Active links define an undirected graph over hashes for a given `param_id`.
- A **signature family** is the connected component (equivalence closure).

There is no weighting, no "partial" equivalence, no heuristics, and no backend judgement: it is an explicit operator decision recorded with `created_by` + `reason`.

### 6.3 New API routes (minimal set)

Add routes to support the operator workflow:

- **List signatures** for a parameter:
  - `POST /api/sigs/list`
  - body: `{ "param_id": "repo-branch-param", "limit": 200 }`
  - returns: registry rows (core_hash, created_at, inputs_json)

- **List equivalence links**:
  - `POST /api/sigs/links/list`
  - body: `{ "param_id": "...", "core_hash": "optional" }`
  - returns: edges (active + inactive), with audit fields

- **Create link**:
  - `POST /api/sigs/links/create`
  - body: `{ "param_id": "...", "core_hash": "...", "equivalent_to": "...", "created_by": "...", "reason": "..." }`

- **Deactivate link** (audit-friendly "delete"):
  - `POST /api/sigs/links/deactivate`
  - body: `{ "param_id": "...", "core_hash": "...", "equivalent_to": "...", "created_by": "...", "reason": "..." }`
  - sets `active=false` (or inserts a tombstone row, depending on preference)

Optionally: a debug route to show the resolved equivalence set:

- `POST /api/sigs/resolve`
  - body: `{ "param_id": "...", "core_hash": "...", "include_equivalents": true }`

### 6.4 Modify existing snapshot routes (small)

For:

- `/api/snapshots/query-virtual`
- `/api/snapshots/query-full`
- `/api/snapshots/retrievals`

Add parameter:

- `include_equivalents: boolean` (default `true` for resilience, `false` for strict validation/debug)

Return metadata:

- `matched_core_hashes`: list of hashes used
- `match_mode`: `"strict"` if only the requested hash matched; `"equivalent"` if additional hashes were included

This keeps integrity transparent: callers can surface a warning when equivalence was used.

---

## 7. Frontend impact (minimal)

"Frontend doesn't change much" is the right mental model.

Primary changes:

- Keep computing the canonical `query_signature` string exactly as today (single choke-point).
- Send `canonical_signature` (`query_signature`), `inputs_json`, and `sig_algo` alongside snapshot append requests.
- Add a simple operator UI:
  - filter by `param_id`
  - show "new signatures since X" (using `created_at`)
  - show diffs between two `inputs_json` blobs
  - create/deactivate equivalence links

No other UI paths must change immediately; read queries can become resilient server-side via equivalence expansion.

---

## 8. `/api/snapshots/inventory` — full design spec (V2: signature families)

### 8.1 Purpose

`/api/snapshots/inventory` is the backend's **index/summary** endpoint:

- It tells the UI what snapshot history exists for a set of `param_id`s.
- Under `flexi_sigs`, it must also reveal **signature-family structure** so data does not "disappear" when strict signatures drift.

This endpoint is **not** a data retrieval endpoint; it does not return snapshot rows.

### 8.2 Core requirements

- **R1**: Return inventory grouped by `param_id`, then by **signature family**, then by `slice_key`.
- **R2**: Support UI that only knows:
  - `param_id` (required)
  - optionally `current_core_hash` for that param (computed from the *current* graph)
  - optionally a subset of slice keys (for narrowed UI panels)
- **R3**: Never require the frontend to understand equivalence closure logic.
- **R4**: Stable grouping: the same DB state yields the same family IDs (no flapping).
- **R5**: Provide enough metadata for UI to surface:
  - "there are new signatures since your change"
  - "your current signature matches family X (or none)"
  - "these families have history"
- **R6**: Do not silently invent identities; if `current_core_hash` is missing, still return inventory for all families.

### 8.3 Request shape

Route: `POST /api/snapshots/inventory`

```json
{
  "param_ids": ["repo-branch-paramA", "repo-branch-paramB"],

  "current_signatures": {
    "repo-branch-paramA": "{\"c\":\"...\",\"x\":{...}}",
    "repo-branch-paramB": "{\"c\":\"...\",\"x\":{...}}"
  },

  "slice_keys": {
    "repo-branch-paramA": ["context(channel:google)", ""]
  },

  "include_equivalents": true,
  "limit_families_per_param": 50,
  "limit_slices_per_family": 200
}
```

Field semantics:

- **`param_ids`** (required): list of exact workspace-prefixed parameter IDs.
- **`current_signatures`** (optional): map `param_id -> canonical_signature` (`query_signature` string) for the current graph definition.
  - Used only to annotate which family is "current".
  - Inventory must remain correct if omitted or partially provided.
- **`current_core_hashes`** (optional): map `param_id -> core_hash` (frontend-computed content-addresses of the corresponding `current_signatures` entries; see `hash-fixes.md`).
  - When provided, the backend uses these directly instead of deriving from `current_signatures`.
  - When absent, the backend falls back to deriving `core_hash` from `current_signatures` (transition path).
- **`slice_keys`** (optional): map `param_id -> list[slice_key]` as a filter.
  - If omitted, include all slice keys.
  - If provided for a param, only include those slice keys for that param.
- **`include_equivalents`** (optional; default `true`):
  - If `true`, group by equivalence families (connected components under active links).
  - If `false`, treat each `core_hash` as its own family (legacy strict grouping).
- **`limit_*`**: safety caps to keep responses bounded.

### 8.4 Response shape (V2)

```json
{
  "success": true,
  "inventory_version": 2,
  "inventory": {
    "repo-branch-paramA": {
      "param_id": "repo-branch-paramA",

      "overall_all_families": {
        "row_count": 1234,
        "unique_anchor_days": 100,
        "unique_retrievals": 180,
        "unique_retrieved_days": 180,
        "earliest_anchor_day": "2025-10-01",
        "latest_anchor_day": "2026-02-03",
        "earliest_retrieved_at": "2025-10-02T01:02:03Z",
        "latest_retrieved_at": "2026-02-04T01:02:03Z"
      },

      "current": {
        "provided_signature": "{\"c\":\"...\",\"x\":{...}}",
        "provided_core_hash": "SigCurrentA",
        "matched_family_id": "FamilyRoot1",
        "match_mode": "strict",
        "matched_core_hashes": ["SigCurrentA"]
      },

      "families": [
        {
          "family_id": "FamilyRoot1",
          "family_size": 2,
          "member_core_hashes": ["SigOldA", "SigCurrentA"],

          "created_at_min": "2026-02-01T10:20:00Z",
          "created_at_max": "2026-02-04T09:11:00Z",

          "overall": {
            "row_count": 1234,
            "unique_anchor_days": 100,
            "unique_retrievals": 180,
            "unique_retrieved_days": 180,
            "earliest_anchor_day": "2025-10-01",
            "latest_anchor_day": "2026-02-03",
            "earliest_retrieved_at": "2025-10-02T01:02:03Z",
            "latest_retrieved_at": "2026-02-04T01:02:03Z"
          },

          "by_slice_key": [
            {
              "slice_key": "",
              "row_count": 200,
              "unique_anchor_days": 100,
              "unique_retrievals": 40,
              "unique_retrieved_days": 40,
              "earliest_anchor_day": "2025-10-01",
              "latest_anchor_day": "2026-02-03",
              "earliest_retrieved_at": "2025-10-02T01:02:03Z",
              "latest_retrieved_at": "2026-02-04T01:02:03Z"
            }
          ]
        }
      ],

      "unlinked_core_hashes": ["SigBrandNewA"],
      "warnings": []
    }
  }
}
```

Notes:

- The response intentionally includes **both**:
  - The family grouping (resilience), and
  - The "current signature mapping" (so the UI can highlight when current doesn't match any family).
- `overall_all_families` exists because multiple frontend call sites need a cheap "total snapshots exist?" answer regardless of signature matching (e.g. deletion, tooltips). This prevents each client from having to re-sum families.
- Timestamps are returned as ISO (API boundary). Any UI display must format as `d-MMM-yy`.

### 8.5 Family ID selection (stability rule)

To avoid flapping, `family_id` must be a deterministic representative of the component.

Rule:

- `family_id` is the member whose `created_at` is earliest in the component.
- Tie-breaker: lexicographically smallest `core_hash`.

This ensures family IDs remain stable across queries and across server restarts.

### 8.6 Computing families (backend algorithm)

Given a set of `param_ids`:

1. Load **inventory aggregates by (param_id, core_hash, slice_key)** from `snapshots`.
2. Load all active equivalence edges for these `param_ids` from `signature_equivalence`.
3. For each `param_id`, compute connected components over the graph of hashes (union-find is simplest).
4. For each component:
   - pick a `family_id` using §8.5
   - aggregate per-slice and overall metrics across all member hashes
5. If `current_signatures[param_id]` is provided:
   - use `provided_core_hash` from `current_core_hashes[param_id]` if available; otherwise fall back to `short_hash(current_signatures[param_id])` (see `hash-fixes.md`)
   - compute its equivalence closure (under active links) and find the matching component (if any)
   - set `current.match_mode`:
     - `"strict"` if provided hash is a member of the family directly
     - `"equivalent"` if it matches only via other linked members (rare but possible with asymmetric links; still show explicitly)
     - `"none"` if it matches no family

### 8.7 What counts should be returned (definitions)

For a given group (family overall or slice):

- **`row_count`**: total snapshot rows (duplicates already prevented by PK in `snapshots`).
- **`unique_anchor_days`**: count of distinct `anchor_day`.
- **`unique_retrievals`**: count of distinct `retrieved_at` timestamps.
- **`unique_retrieved_days`**: count of distinct UTC dates of `retrieved_at`.
- **`earliest_anchor_day` / `latest_anchor_day`**: min/max anchor day.
- **`earliest_retrieved_at` / `latest_retrieved_at`**: min/max retrieval timestamp.

These metrics are sufficient for:

- calendar highlighting (via `/retrievals`, but inventory can show "has snapshots"),
- "how much history do we have?",
- and operator triage after a signature drift.

### 8.8 Frontend call sites that must be updated (and what to pass)

This is part of the project scope. All `/inventory` call sites must be updated to:

- call the V2 endpoint shape,
- pass `current_signatures` where the call site can cheaply obtain it,
- and rely on backend grouping/matching rather than client-side "pick a signature" logic.

#### 8.8.1 `graph-editor/src/services/snapshotWriteService.ts`

This service is the single frontend wrapper around `/api/snapshots/inventory`.

Required changes (design intent):

- Update `getBatchInventory(...)` and `getBatchInventoryRich(...)` to send:
  - `param_ids`
  - `current_signatures` (optional; provided by caller)
  - `slice_keys` (optional; provided by caller)
  - `include_equivalents` (default `true`)
- Update return types so callers can access:
  - `overall_all_families`
  - `current` match info
  - families list (for the Signature Links tab and advanced UI)

#### 8.8.2 `graph-editor/src/hooks/useSnapshotsMenu.ts` (counts in menus)

Current behaviour:

- fetches rich inventory
- tries to match expected signature client-side (by comparing to `by_core_hash`)
- shows 0 when signature exists but does not match (brittle)

V2 behaviour (intelligent, resilient):

- Pass `current_signatures` for each `param_id`:
  - source: parameter file `values[].query_signature` (already read today in this hook).
- Use backend `current` field:
  - if `current.match_mode != "none"`: use the matched family's `overall.unique_retrieved_days` for "snapshot counts"
  - if `"none"` but `overall_all_families.unique_retrieved_days > 0`: show count from `overall_all_families` and surface a "needs linking" indicator (menu badge or tooltip). Do not show 0.

This is the core "no disappearance" guarantee for menu-level UX.

#### 8.8.3 `graph-editor/src/hooks/useDeleteSnapshots.ts` (delete confirmation counts)

Deletion is not signature-specific: it deletes all snapshots for the param.

- Do **not** pass `current_signatures` (optional).
- Use `overall_all_families.unique_retrievals` (or unique_retrieved_days, whichever UX intends) as the count shown in confirmation.

#### 8.8.4 `graph-editor/src/hooks/useEdgeSnapshotInventory.ts` (edge tooltips)

Tooltips need a fast "does this edge have snapshots?" answer.

- Optional: pass `current_signatures` for the edge param if available from parameter file (nice-to-have).
- Minimum: omit `current_signatures` and use `overall_all_families.row_count` / `unique_retrieved_days` for display.

#### 8.8.5 Tests to update

Any test that asserts the old inventory shape must be updated, including:

- `graph-editor/src/hooks/__tests__/useSnapshotsMenu.test.ts`
- `graph-editor/src/hooks/__tests__/useSnapshotsMenu.test.ts` (expects signature matching; must use backend `current`)
- `graph-editor/src/services/__tests__/snapshotWritePath.fixture.test.ts` (if it inspects inventory)
- `graph-editor/src/services/__tests__/cohortAxy.meceSum.vsAmplitude.local.e2e.test.ts` helper inventory query

### 8.8 "Unlinked signatures" reporting

Inventory should help the "I changed a graph and 6 buckets broke" workflow.

We define:

- a hash is "unlinked" if it has **no active equivalence edges** in either direction for that `param_id`.

Inventory can compute:

- `unlinked_core_hashes` for each param (possibly capped for size).

This gives the UI a very direct "action list": signatures that need review/linking.

### 8.9 Backward compatibility and rollout

We do not prioritise backward compatibility. This is intended to be the final breaking change to snapshot signature identity and matching.

### 8.10 Performance invariants

Inventory must remain cheap:

- Target: **O(N)** in number of `(param_id, core_hash, slice_key)` groups returned, not in raw snapshot rows.
- DB work: a single `GROUP BY` aggregate over indexed columns, plus a small edge fetch from `signature_equivalence`.
- Avoid per-param recursive SQL in the hot path; do component computation in Python.

This keeps `/inventory` responsive even as the snapshots table grows.

---

## 9. Robustness and determinism: multi-layer test strategy (required)

Flexible signatures are an integrity feature. The system needs tests at multiple layers to ensure:

- the signature is **always produced**,
- signature generation never silently degrades,
- archival writes never occur with missing/invalid signature evidence,
- equivalence expansion behaves predictably and is auditably correct,
- UI workflows surface new signatures and enable linking without foot-guns.

### 9.1 Tier A — "pure" deterministic hashing tests (frontend)

Goal: prove that the short `core_hash` is a pure function of canonicalised `inputs_json`.

Tests:

- **Golden cases**: fixed canonical inputs → fixed hash string.
  - Cover: window vs cohort; contexted vs uncontexted; visited/exclude; provider filters present/absent.
  - The golden corpus must live in-repo and be reviewed like an API contract.

- **Permutation invariance**: shuffling semantically unordered fields does not change the hash.
  - Example: reorder arrays that should be treated as sets.

- **Canonicalisation invariance**: equivalent DSL spellings (whitespace, ordering of constraints where order-indifferent) produce identical canonical inputs.

- **Negative cases**: substantive changes (event id, provider filter, mode change) must change the hash.

Failure policy:

- Any failure in the hashing unit suite blocks merges; these tests are "signature contract law".

### 9.2 Tier B — signature-input completeness tests (frontend)

Goal: prove we never reach "append snapshots" without a signature.

Tests:

- For each call site that performs archival writes, assert:
  - canonical inputs are built,
  - hashing succeeds,
  - and the append request includes `{ core_hash, inputs_json, sig_algo }`.

- Explicit regression test: a deliberate signature failure must surface as a loud error (UI/session log) and must not proceed to archival write.

Important: "loud error" is not "console warn and carry on"; it must be a surfaced, diagnosable failure mode.

### 9.2.1 Stability contract tests (this is the last break)

The following must be locked by tests and treated as "contract law":

- `canonical_signature` format is stable (the `{c,x}` JSON string produced by the single frontend choke-point).
- `core_hash` derivation from `canonical_signature` is stable (hash algo + truncation + encoding).
- `inputs_json` schema is stable (field names + canonicalisation rules).

Any intentional change to any of the above requires:

- explicit update of `sig_algo`,
- explicit doc update in this file,
- and updating the golden corpus.

### 9.3 Tier C — backend contract tests (Python handlers)

Goal: ensure the backend enforces invariants (no silent acceptance of bad writes).

Tests:

- `/api/snapshots/append`:
  - missing `core_hash` → 4xx
  - missing `inputs_json` → 4xx
  - malformed `inputs_json` (not JSON object) → 4xx
  - repeated signature registry insert is idempotent (no duplicates)

- `/api/sigs/links/create`:
  - creates an active link
  - duplicate create is idempotent (or errors clearly; pick one and lock it in)
  - deactivate flips the link off (and is auditable)

### 9.4 Tier D — equivalence resolution correctness tests (SQL-level / service-level)

Goal: ensure equivalence closure is correct, deterministic, and bounded.

Tests:

- Symmetry handling (if undirected): linking A↔B implies resolution contains both regardless of query direction.
- Multi-hop closure: A↔B, B↔C resolves A to {A,B,C}.
- Deactivation: inactive edges are ignored.
- Cycle robustness: cycles do not hang; results are deduped and stable.
- Bounded traversal: impose a sane safety cap (e.g. max nodes/edges per resolution) and test cap behaviour (returns error vs truncation; must be explicit).

### 9.5 Tier E — end-to-end "no disappearance" tests (integration)

Goal: prove the user story:

- Start with snapshots under old signature.
- Introduce a change producing a new signature.
- Without equivalence, strict lookup shows "mismatch" (expected).
- After adding an equivalence link, retrievals/inventory and as-at reads include the historical data again (with explicit match_mode metadata).

This is the structural-resilience guarantee you actually care about.

### 9.6 Tier F — UI workflow tests (frontend e2e)

Goal: ensure linking workflow is usable and safe.

Tests:

- "New signatures appear" after a change.
- Selecting a new signature shows candidate relatives (via filters and/or grouping).
- Creating a link updates the UI state and immediately affects retrieval/inventory responses.
- Deactivating a link reverts the effect.

---

## 10. UI design: "Signature Links" tab (operator workflow)

This UI must make "brittle hash + override" safe, fast, and easy. It is an **operator tool**: it exists to restore continuity when strict signatures drift for trivial reasons, without weakening integrity.

### 10.1 Design principles

- **P1: Fast path first**: the default view should surface "what just broke" (new + unlinked) in one click.
- **P2: Progressive disclosure**: show summaries for scanning; fetch/render full JSON only on selection.
- **P3: Diff-first, not blob-first**: users should compare signatures via a structured diff view, with raw JSON as a fallback.
- **P4: Faceted narrowing beats wizardry**: Graph/Param filters + chips + free-text; no mandatory step-by-step flow.
- **P5: Deterministic suggestions**: "likely relatives" must be simple and predictable, not opaque heuristics.
- **P6: Explicitness over magic**: linking is never automatic; every link is an explicit act.
- **P7: Auditability is non-negotiable**: create/deactivate requires `created_by` + free-text reason; history remains inspectable.
- **P8: Safety banners**: whenever equivalence affects reads, the UI must say so clearly and persistently.
- **P9: Debug escape hatch**: strict-only mode must be available to suppress equivalence for diagnosis.
- **P10: Boundedness**: list views must remain responsive with caps and pagination; no "render 10k JSON blobs".

### 10.2 Concrete proposal (what we will build first)

#### 10.2.1 Entry point + navigation model

- Add a new **tab type**: **Signature Links** (or **Signature Registry**).
- Add a Data menu entry: **Data → Signature Links…** which opens the tab.
  - Menu is an access point only: opening/refreshing calls a single service/hook (no logic in the menu component).

#### 10.2.2 Layout: faceted search + master–detail

**Top filter bar (progressive narrowing):**

- **Graph** dropdown (optional; default "All graphs").
- **Param** dropdown (optional; dependent on Graph; type-ahead by id/name).
- **Chips**:
  - `New` (created in last N hours/days; N user-configurable)
  - `Unlinked` (no active links)
  - `Linked` (has active links)
  - `StrictOnly` (suppresses equivalence usage in the tab's preview queries)
- **Free-text search**:
  - searches across `param_id`, `core_hash`, plus selected summary fields derived from `inputs_json`.

**Left pane (results list):**

- Collapsible grouping headers: Graph → Param → Signature family.
- Within a family: signatures sorted by `created_at` descending.
- Each row shows:
  - short `core_hash` (first 8–10 chars),
  - `created_at` (UK date in UI),
  - one-line summary (mode, from/to, slice key, key filter presence),
  - badges: `New`, `Unlinked`.

Default state on open:

- chips `New` + `Unlinked` on
- graph/param unset
- result list shows "what just appeared" immediately.

**Right pane (detail + compare + actions):**

- Two-up compare:
  - A = selected signature
  - B = comparator signature (preselected by deterministic rule; user can change)
- Three layers:
  1. **Diff summary** (sections + counts of changed fields)
  2. **Structured diff** (field-level; collapse unchanged)
  3. **Raw JSON tree** (collapsible) for A and B with "jump to next change"

#### 10.2.3 Comparator suggestion (deterministic)

- Default comparator: "most recent other signature for the same `param_id`".
- Optional refinement: prefer same `slice_key` / mode if present in `inputs_json`.

#### 10.2.4 Link management UX (audited, reversible)

- **Link as equivalent**:
  - requires comparator selection, `created_by`, and reason
  - on success: refresh inventory state and show "equivalence now active" banner
- **Deactivate link**:
  - requires reason (audit-preserving)
  - allow "show inactive links" toggle for provenance

#### 10.2.5 Backend support required (for responsiveness)

- list signatures for graph/param scope (return small summaries; full `inputs_json` via a "get details" call)
- list links for scope
- resolve family membership for a signature
- inventory V2 (families + unlinked) for immediate "what broke" default view

---

## 11. Why this is structurally resilient

- A brittle signature can change for trivial reasons.
- But history does not "disappear"; it becomes **unlinked** until a link is created.
- Links are explicit, audited, and reversible.
- Storage cost is controlled: large evidence is stored once per unique signature, not per snapshot row.

This is an architectural mechanism that makes "integrity vs resilience" an explicit, operator-governed policy rather than an accidental property of a single hash.

---

## 12. Data cost estimates (typical nightly "Retrieve all")

These are rough order-of-magnitude estimates for **roundtrip payload** (frontend→backend and backend→DB), assuming:

- 10 params
- both `window()` and `cohort()` are retrieved (2 modes)
- 4 context slices per param (4 `slice_key`s per mode)
- 20 anchor-days of data per slice
- canonical signature is stable across context **values** (same `query_signature` reused across the 4 slices per mode; only `slice_key` differs)
- `inputs_json` is the **minimal** proposal (summary + def-hash maps + provenance), not full context definitions
- no HTTP compression assumed (real deployments usually compress JSON; that would reduce sizes materially)

Derived counts:

- Append calls: \(10 \times 2 \times 4 = 80\) `/snapshots/append` requests
- Snapshot rows written: \(10 \times 2 \times 4 \times 20 = 1{,}600\) rows
- Unique signatures per nightly run (typical): \(10 \times 2 = 20\) registry keys (per param×mode), each reused across 4 slices

| Item | Count | Per-unit payload (rough) | Total payload (rough) | Notes |
|---|---:|---:|---:|---|
| FE → BE `/snapshots/append` request | 80 | 5–10 KB | 0.4–0.8 MB | Envelope + 20 rows JSON + canonical_signature + minimal inputs_json |
| FE ← BE `/snapshots/append` response | 80 | 0.2–0.6 KB | 16–48 KB | Inserted counts + diagnostics when enabled |
| BE → DB snapshot row inserts | 1,600 rows | 150–300 B/row | 0.24–0.48 MB | Dominated by repeated text fields (param_id, core_hash, slice_key, timestamps) |
| BE → DB signature_registry inserts | ~20 rows | 1–3 KB/row | 20–60 KB | Insert-once per novel signature; stores canonical_signature + minimal inputs_json |

**Sensitivity note**:

- If `inputs_json` includes full context definitions/values (large catalogues), the request size can jump from **single-digit KB** to **tens of KB** per append call.
