# Share and Live Share System

How DagNet generates, consumes, and syncs share links for static snapshots, live graph access, chart shares, and bundles.

## Share Link Types

### Static share (`?mode=static` or `?data=`)

- Self-contained: graph data compressed via lz-string in URL
- Read-only: enforced via `ShareModeContext.isReadOnly`
- No GitHub dependency, works offline
- Optional identity metadata (`repo/branch/graph`) allows upgrade-to-live
- Soft URL limit: warns at ~1,800 characters (Notion embed limit ~2,000)

### Live share (`?mode=live`)

- Graph identity + secret for credential unlock
- Fetches fresh from GitHub on boot
- Full editing after credentials unlocked
- Maintains remote HEAD SHA for staleness detection
- Dashboard mode by default

### Live chart share (`?share=` with target=chart)

- Bundle payload carrying chart recipe metadata
- Scenarios stored as effective DSL (fully portable)
- Compressed `SharePayloadV1` in URL

### Live bundle share (`?share=` with target=bundle)

- Multiple tabs (graph + charts) in single share URL
- Shared scenarios applied across all bundle tabs
- Presentation hints (dashboard mode, active tab index)

## URL Parameters

| Param | Static | Live | Purpose |
|-------|--------|------|---------|
| `mode` | `static` | `live` | Share mode identifier |
| `data` | compressed graph | -- | Embedded graph data (static only) |
| `repo` | optional | required | Repository name |
| `branch` | optional | required | Branch name |
| `graph` | optional | required | Graph identifier |
| `secret` | -- | required | Credential unlock secret |
| `share` | -- | optional | Compressed SharePayloadV1 (chart/bundle) |
| `nonudge` | 1 | -- | Suppress staleness nudges |
| `dashboard` | 1 | 1 | Open in dashboard mode |
| `dbnonce` | optional | optional | IndexedDB cache-buster |

## Isolated Storage

Each share session uses its own IndexedDB scope:
- **Workspace**: `'DagNetGraphEditor'`
- **Live share**: `'DagNetGraphEditorShare:<prefix>-<hash>'`
- **Static share**: `'DagNetGraphEditorShareStatic:<prefix>-<hash>'`

Prevents cross-contamination with the user's workspace.

## Live Share Boot Lifecycle

### 1. Boot phase (`liveShareBootService.ts`)

Triggered on app load with `?mode=live`:

1. **Credential unlock**: load credentials matching repo name
2. **Tree fetch**: single GitHub Tree API call (recursive) to build path-to-blob map
3. **Graph fetch**: load and parse graph file via blob API
4. **Dependency closure**: extract all parameter IDs, event IDs, context keys from graph DSL and share payload scenarios
5. **Parallel fetch** (up to 10 concurrent): parameters, events, contexts, settings, connections, remote HEAD SHA
6. **Cache seeding**: all fetched files added to FileRegistry + share-scoped IDB

### 2. Hydration phase (`liveShareHydrationService.ts`)

Barrier before chart/bundle processing:
- Polls IDB at 75ms intervals (12s timeout) until all required dependent files exist
- Required: parameters, cases, nodes, events, connections (best-effort)
- Restores to FileRegistry with unprefixed IDs

### 3. Sync phase (`liveShareSyncService.ts`)

Manual refresh or staleness detection:
- Re-fetches entire bundle via `fetchLiveShareBundle()`
- Overwrite-seeds into share-scoped cache
- Records last-seen remote HEAD SHA in localStorage
- Dispatches `dagnet:liveShareRefreshed` custom event

## ShareModeContext

**Location**: `src/contexts/ShareModeContext.tsx`

Centralised share mode signal consumed by editors and panels:

- `mode`: `'none' | 'static' | 'live'`
- `isShareMode`: true if mode !== 'none'
- `isReadOnly`: true if mode === 'static'
- `identity`: `{ repo?, branch?, graph? }`

Resolved once at startup (immutable for session).

## Boot Config Resolution

**Location**: `src/lib/shareBootResolver.ts`

Runs **before** app init to determine database name:
1. Reads URL parameters once
2. Computes scoped `dbName` based on mode and identity
3. Returns `ShareBootConfig`

Mode detection priority: `?mode=live` + identity --> live; `?mode=static` or `?data=` --> static; otherwise normal.

## SharePayloadV1 Format

Version 1.0.0, compressed via lz-string:

```
{
  version: '1.0.0',
  target: 'chart' | 'bundle',
  graph_state?: { base_dsl?, current_query_dsl? },
  chart?: { kind, title?, chart_kind_override?, view_mode?, display? },
  analysis?: { query_dsl, analysis_type?, what_if_dsl? },
  scenarios?: { items[], current?, hide_current?, selected_scenario_dsl? },
  presentation?: { dashboardMode?, activeTabIndex? },
  tabs?: [{ type, title?, chart?, analysis? }]
}
```

## Key Design Decisions

1. **Isolated IDB scoping**: prevents cross-contamination between workspace and shares
2. **No workspace clone**: live share fetches only the graph and its dependencies, not the full workspace
3. **Stateless boot**: services return data; TabContext/components manage state
4. **Dependency closure**: all required files computed once at boot time
5. **Secret-based credential unlock**: resolved from URL param, then env vars

## Key Files

| File | Role |
|------|------|
| `src/services/shareLinkService.ts` | Share URL generation (static, live, chart, bundle) |
| `src/services/liveShareBootService.ts` | Boot orchestration (credential unlock, fetch, cache seeding) |
| `src/services/liveShareHydrationService.ts` | Race-condition barrier (wait for dependencies) |
| `src/services/liveShareSyncService.ts` | Refresh mechanism (re-fetch on staleness) |
| `src/contexts/ShareModeContext.tsx` | Centralised mode signal |
| `src/lib/shareBootResolver.ts` | Mode detection and DB name computation |
| `src/lib/sharePayload.ts` | LZ-string encode/decode for SharePayloadV1 |
| `src/lib/shareUrl.ts` | Legacy compress/decompress helpers |
| `src/hooks/useShareChartFromUrl.ts` | Chart share bootstrap |
| `src/hooks/useShareBundleFromUrl.ts` | Bundle share bootstrap |
