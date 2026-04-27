# Integrity Check Service

**File**: `graph-editor/src/services/integrityCheckService.ts` (4,177 LOC) — **the single largest TypeScript service in the codebase**.

Until this doc, the service was only addressed in passing: INTEGRITY_CHECK_ADDITIONS.md captures additions to specific Phase 4/5/9/10 checks but not the architecture; UI_COMPONENT_MAP/TASK_TYPE_READING_GUIDE/HASH_SIGNATURE_INFRASTRUCTURE name-drop it.

**See also**: [INTEGRITY_CHECK_ADDITIONS.md](INTEGRITY_CHECK_ADDITIONS.md) (specific checks added during synth-data work), [HASH_SIGNATURE_INFRASTRUCTURE.md](HASH_SIGNATURE_INFRASTRUCTURE.md) §"Integrity Checks" (hash-continuity Phase 9 + snapshot-coverage Phase 10), [SCHEMA_AND_TYPE_PARITY.md](SCHEMA_AND_TYPE_PARITY.md) (schema-validation pre-conditions).

---

## 1. What it is

A **cross-workspace forensic check** that validates every file in IndexedDB against the schema, against the references it makes to other files, against graph-structure invariants, and against the snapshot database. It produces a flat list of `IntegrityIssue` objects, each with `severity` (error/warning/info) and `category` (one of 19 enumerated kinds).

It is the only system-wide consistency check in the project. The Bayes regression suite catches model regressions; tests catch implementation bugs; this service catches the data-quality issues that arise from human edits, partial fetches, definition changes, and history.

## 2. Public surface

```typescript
class IntegrityCheckService {
  static async checkIntegrity(
    tabOperations: TabOperations,
    createLog: boolean = true,
    workspace?: { repository: string; branch: string },
    deep: boolean = false,
  ): Promise<IntegrityResult>

  // Helpers exposed for graphIssuesService:
  static extractGraphReferences(graphData: any): { ... }
  static extractGraphName(fileId: string): string
  // (and many private static helpers — getCanonicalFileId, dedupeWorkspacePrefixedVariants, …)
}
```

Two callers, both in the project:

- **[graphIssuesService.ts](../../graph-editor/src/services/graphIssuesService.ts)** — auto-debounced background checks (`deep: false`) plus triggered runs from the Graph Issues panel
- **[useIntegrityCheck.ts](../../graph-editor/src/hooks/useIntegrityCheck.ts)** — explicit "Check Integrity" trigger from File Menu (`deep: true`)

The two paths differ by the `deep` flag, which gates Phase 10 (snapshot DB coverage — Python-server-dependent and slow).

## 3. The 10 phases

The service runs in fixed phase order, populating one shared `issues[]` array. Each phase is a method (or block) that walks the file set, flags violations, and continues.

| # | Phase | What it validates | Severity bias | `deep`-only |
|---|---|---|---|---|
| 1 | **Build lookup maps** | Not a check — constructs the lookup maps used by later phases (`parameterFiles`, `caseFiles`, `contextFiles`, `nodeFiles`, `eventFiles`, `graphFiles`, `indexFiles`, `connectionNames`) | — | No |
| 2 | **Per-file validation** | Schema (required fields, types), ID format, value ranges (probabilities ∈ [0,1], costs ≥ 0), naming (`id` matches filename), metadata completeness | error/warning | No |
| 3 | **Registry/index file validation + content sync** | Each `*-index.yaml` matches actual files on disk, entries reference real files, no orphans in the index | warning | No |
| 4 | **Orphan detection** | Files (parameters, contexts, cases, nodes, events) never referenced by any graph | warning | No |
| 5 | **Duplicate detection** | Duplicate IDs or UUIDs across files | error | No |
| 6 | **Cross-graph consistency** | The same IDs used consistently across graphs (e.g. an event's `provider_event_names` doesn't differ between graphs) | warning | No |
| 7 | **Credentials validation** | Connections referenced by parameters have required credentials | warning | No |
| 8 | **Image validation** | Images referenced by nodes exist; orphan images detected | warning | No |
| 9 | **Hash continuity** | `hash-mappings.json` is structurally correct; the full hash chain is intact for every fetchable edge; reports breaks with severity by age | error / warning | No |
| 10 | **Snapshot DB coverage** | For each fetchable edge: snapshots exist in the DB under at least one plausible hash. Reports edges with zero coverage | warning | **Yes** |

Phase numbering is preserved across history — see [INTEGRITY_CHECK_ADDITIONS.md](INTEGRITY_CHECK_ADDITIONS.md) for the additions made during synth-data development.

## 4. The 19 issue categories

The category enum is the user-visible classification surface (each Graph Issues panel row groups by category):

| Category | What it covers |
|---|---|
| `schema` | Missing required fields, invalid types |
| `id-format` | Invalid ID format (characters, length, handle suffix conventions) |
| `reference` | Broken references to other files |
| `graph-structure` | Invalid graph topology (orphan nodes, absorbing nodes with outgoing edges, etc.) |
| `registry` | Registry/index file inconsistencies |
| `connection` | Data connection issues |
| `credentials` | Missing or invalid credentials |
| `value` | Invalid numeric values (probability out of range, etc.) |
| `semantic` | Semantic data issues — non-conservation, non-MECE overlaps, denominator mismatches |
| `orphan` | Unreferenced files |
| `duplicate` | Duplicate IDs/UUIDs |
| `naming` | Naming inconsistencies |
| `metadata` | Metadata issues |
| `sync` | Registry vs file content mismatch |
| `operational` | Operational health (retrieval staleness, Bayes quality) |
| `image` | Image file issues (missing, orphaned) |
| `face-alignment` | Handle/face validity, direction consistency, geometric plausibility |
| `hash-continuity` | Snapshot hash mapping issues (stale signatures, missing mappings) |
| `snapshot-coverage` | Snapshot DB coverage gaps (Phase 10 only) |

## 5. Workspace deduplication

A subtle bit of this file: IndexedDB stores **both** workspace-prefixed and unprefixed variants of every file (see [INDEXEDDB_PERSISTENCE_LAYER.md](INDEXEDDB_PERSISTENCE_LAYER.md) §"Workspace Prefix Contract"). Without dedup, every check would fire twice and the Graph Issues panel would show duplicate rows for every issue.

`dedupeWorkspacePrefixedVariants(allFiles)` collapses each `(repository, branch, type, canonicalFileId)` group to a single representative file, **preferring the workspace-prefixed variant** when both exist. Read this method once before modifying any phase — almost every per-file check is built on top of it.

## 6. `deep` vs auto-debounced

| Mode | Trigger | Phases run | Cost | UI |
|---|---|---|---|---|
| **Auto-debounced** | File save → 2s debounce → `graphIssuesService` runs | 1–9 | ~milliseconds, in-browser only | Updates Graph Issues panel badges silently |
| **Deep (manual)** | File menu → "Check Integrity", or Graph Issues "Refresh" | 1–10 | Phase 10 hits the Python server; can be seconds depending on edge count | Surfaces explicit "Phase 10" rows + a freshness toast |

Phase 10 requires the Python server. If unreachable, an info-level note is added and the phase skips cleanly.

## 7. Result shape

```typescript
interface IntegrityResult {
  success: boolean;
  totalFiles: number;
  issues: IntegrityIssue[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    byCategory: Record<IssueCategory, number>;
  };
  stats: {
    graphs: number;
    parameters: number;
    // … other type counts
  };
}

interface IntegrityIssue {
  fileId: string;
  type: ObjectType | 'system';
  severity: 'error' | 'warning' | 'info';
  category: IssueCategory;
  message: string;
  field?: string;
  suggestion?: string;
  details?: string;
  // Deep-linking from the Issues panel:
  nodeUuid?: string;
  edgeUuid?: string;
}
```

The `nodeUuid`/`edgeUuid` fields enable deep-linking from the Graph Issues panel to the offending element on the canvas.

## 8. Performance

- **All checks run in-memory** against the deduped IDB snapshot. Phases 1–9 do not touch the network.
- **Phase 10** issues a single batched `getBatchRetrievals` call across all fetchable edges, with per-edge `hash_groups` arrays. This is the only network call in the entire service.
- **No streaming** — the full file set is loaded at the start of every run. For workspaces with thousands of files, the phase-1 lookup-map construction is the dominant cost.

## 9. Logging

When `createLog: true` (the default), the service writes a `LogFileService` entry summarising the run: total files, total issues, issues by category, and the time taken. This feeds the dev-only run-log surface; no user-visible toast unless the panel is open.

## 10. Maintenance signposts

- **Adding a new check** → identify the right phase by what it walks (per-file → Phase 2; cross-graph → Phase 6; registry → Phase 3; hash → Phase 9; DB → Phase 10). Follow the existing pattern: emit an `IntegrityIssue` with explicit `severity`, `category`, `message`, `suggestion`, and `nodeUuid`/`edgeUuid` if applicable.
- **New issue category** → add to the `IssueCategory` union AND the `byCategory` count initialiser AND any UI that displays a category icon. Missing the count initialiser produces zero-counts even when issues exist.
- **Performance regression** → almost always the new check is calling `db.files.get()` per-iteration instead of using the lookup maps from Phase 1. Restructure to walk an in-memory map.
- **Phase 10 false positives** → typically the new check forgot to expand equivalent hashes (`hashMappingsService.getClosureSet()`). The closure expansion lives at the top of `validateSnapshotCoverage`; reuse it.
- **Issue not surfacing** → ensure `severity` is one of the three enum values (typo will silently bucket-miss). Ensure the file isn't being deduped out — `getCanonicalFileId` and `dedupeWorkspacePrefixedVariants` decide which representative survives.

## 11. What this service does *not* do

- **Schema validation at edit time** — that's `lib/schema.ts` Ajv at write boundaries. This service catches drift but does not prevent it.
- **Type parity** — `schemaParityAutomated.test.ts` and `test_schema_parity.py` cover that. See [SCHEMA_AND_TYPE_PARITY.md](SCHEMA_AND_TYPE_PARITY.md).
- **Bayes-fit quality** — that's the operations-toast / quality-tier surface, not an integrity issue.
- **Cross-workspace consistency** — checks are per-workspace by default. Pass `workspace: undefined` (the default for the auto-debounced path) to run across all workspaces, but most categories are still per-graph or per-file.
