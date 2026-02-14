# Amplitude Funnel Popup — Design & Status

**Status**: Fully implemented and roundtrip-tested
**Created**: 14-Feb-26
**Last updated**: 14-Feb-26

## Goal

From selected nodes on a DagNet graph, open the equivalent funnel in Amplitude's web UI — pre-constructed with the same events, filters, segments, and constraints — for the user to interactively explore.

## What works today (14-Feb-26)

The full pipeline is implemented, tested, and proven via live roundtrip tests against Amplitude:

1. User selects node(s) on the graph (Cmd+click)
2. "Amplitude" button appears in Analytics panel header
3. User clicks it
4. DagNet resolves the Amplitude connection from the graph's edges (prod vs staging auto-detected)
5. Funnel builder maps selected nodes → Amplitude events (via event definitions), topologically sorted
6. All DSL constraints are translated: `context()` → segment property filters, `visited()` / `exclude()` → behavioural segments, `case()` → activeGates, `asat()` → stripped with warning
7. Dates from `window()` or `cohort()` DSL → absolute epoch-second dates with correct start/end-of-day handling
8. Conversion window derived from graph latency (`path_t95`/`t95`), not hardcoded
9. Cohort exclusions applied from connection config
10. Extension creates and opens the chart in Amplitude via the user's browser session

**Roundtrip-tested**: a 13-test matrix verifies that the DAS adapter and the funnel builder produce identical `{n, k}` against live Amplitude, covering window/cohort, with/without context, 2-node/3-node, adjacent/non-adjacent, and prod/staging.

## Architecture

```
User clicks "Amplitude" button (Analytics panel header)
        │
        ▼
DagNet builds chart definition from selected nodes + queryDSL
(graph topology → funnel steps, DAS constraints → segments)
        │
        ▼
DagNet sends definition to Chrome extension
(chrome.runtime.sendMessage to fixed extension ID)
        │
        ▼
Extension injects code into an amplitude.com tab
(chrome.scripting.executeScript, world: MAIN)
        │
        ▼
Code runs same-origin on amplitude.com
(user's session cookies, correct Origin header)
        │
        ├── POST /d/config/{orgId}/data/edit → returns editId
        └── CreateOrUpdateChartDraft GraphQL mutation
        │
        ▼
Draft URL returned to DagNet → opened in new tab
https://app.amplitude.com/analytics/{orgSlug}/chart/new/{editId}
```

### Why a Chrome extension?

Amplitude's draft creation endpoints require session cookies (HttpOnly, `.amplitude.com` domain). These cookies cannot be read or forwarded by JavaScript on a different domain. The extension is the only way to make same-origin API calls to amplitude.com from a web app on a different origin. It injects code directly into an amplitude.com tab where it runs with the page's cookies and correct Origin header.

### Why drafts, not saved charts?

Amplitude drafts persist across browser sessions without needing to be "saved". A draft URL works in any browser session where the user is logged into Amplitude. This eliminates the need for a chart-save API entirely.

### Authentication

The extension uses the user's existing Amplitude browser session — no cookies are extracted, stored, or proxied. If the user is logged into Amplitude, it works. If not, DagNet detects the 401 and prompts them to log in.

Session cookies last **30 days**. Amplitude uses Google OAuth (SSO) for login — typically a single click for users already signed into Google.

Google Service Account auth was investigated and ruled out: Amplitude requires the actual user's Google identity, and a SA cannot produce an `id_token` with both the user's email and Amplitude's client ID.

## Extension: install & upgrade

### First-time install

The extension is not yet on the Chrome Web Store. For now it's loaded in developer mode:

1. Click the **Amplitude** button in DagNet — if the extension is not detected, a step-by-step install modal appears
2. **Download** the extension zip from the link in the modal
3. **Unzip** it to a folder (e.g. Desktop or Downloads)
4. Open **`chrome://extensions`** in Chrome (type it in the address bar)
5. Enable **Developer mode** (toggle in top-right)
6. Click **Load unpacked** and select the unzipped folder
7. Return to DagNet — the modal auto-detects the extension (polls every 5s) and proceeds

### Upgrading

When DagNet ships a new extension version:

1. **Download** the new zip from DagNet (same link as install, filename includes version)
2. **Replace** the old folder contents with the new unzipped files
3. Go to **`chrome://extensions`** and click the **reload** icon on the DagNet Amplitude Bridge card
4. Done — DagNet detects the new version automatically

### Future: Chrome Web Store

An unlisted Chrome Web Store listing ($5 one-time, 1-3 day review) would replace the developer mode flow with:

1. Click install link
2. Click "Add to Chrome"
3. Done. Auto-updates silently.

## Amplitude front-end chart definition schema (confirmed 14-Feb-26)

All schemas below are **confirmed working** via programmatic draft creation and visual verification in Amplitude's UI.

### Event filters (`events[].filters`)

Same schema as the DAS REST API `e=` parameter, plus `group_type` and `subfilters`:

```json
{
  "subprop_type": "event",           // "event" for event props, "user" for user props
  "subprop_key": "flowId",           // property name (gp: prefix for custom user props)
  "subprop_op": "is",                // operator
  "subprop_value": ["energy-switch"], // values array
  "group_type": "User",              // always "User"
  "subfilters": []                   // nested filters (empty)
}
```

**Mapping from DAS adapter**: identical fields. Just add `group_type: "User"` and `subfilters: []`.

### Segment conditions (`segments[].conditions`)

Two condition types, both confirmed:

**Property conditions** (cohort exclusions, user properties, context filters):

```json
{
  "type": "property",
  "prop_type": "user",
  "prop": "userdata_cohort",          // property name (no gp: prefix for built-ins)
  "op": "is not",                     // operator
  "values": ["9z057h6i"],             // values array
  "group_type": "User"
}
```

**Behavioural conditions** (visited/excludes — "user performed event N times"):

```json
{
  "type": "event",
  "event_type": "Household Created",  // Amplitude event name
  "filters": [],                      // per-event filters (same schema as above)
  "op": ">=",                         // ">=" for visited (at least), "=" for excludes (exactly 0)
  "value": 1,                         // 1 for visited, 0 for excludes
  "time_type": "rolling",
  "time_value": 366,                  // lookback window in days
  "group_type": "User"
}
```

### Mapping from DAS adapter segments

The DAS adapter builds a flat `s=` array for the REST API. The front-end wraps these in `segments[].conditions`. The mapping is:

| DAS adapter `s=` field | Front-end condition field | Notes |
|---|---|---|
| `prop` | `prop` | Identical |
| `op` | `op` | Identical |
| `values` | `values` | Identical |
| (none) | `type: "property"` | Add for property conditions |
| (none) | `prop_type: "user"` | Add for property conditions |
| `type: "event"` | `type: "event"` | Identical |
| `event_type` | `event_type` | Identical |
| `op`, `value` | `op`, `value` | Identical |
| `time_type`, `time_value` | `time_type`, `time_value` | Identical |
| (none) | `group_type: "User"` | Add to all conditions |

### Date range (`params.range` or `params.start`/`params.end`)

- Relative: `"range": "Last 30 Days"`
- Absolute: `"start": 1768608000, "end": 1769212799` (Unix epoch seconds)

### Conversion window

`"conversionSeconds": 86400` (1 day = 86400s, 30 days = 2592000s)

## Graph → Amplitude funnel logic

This is the most subtle part. DagNet queries per-edge; Amplitude funnels are multi-step. The semantics are different and we must reason through each carefully.

### Issue 1: Multi-step funnels vs pairwise edges

**DagNet model**: the graph is queried per-edge. `from(A).to(B)` is one query, `from(B).to(C)` is another. Each edge query produces n/k/p for that transition. The `from(B).to(C)` query's denominator is "users who did B" — it doesn't care whether they came from A.

**Amplitude funnel**: `A → B → C` is a single construct. Step 2 (B) is implicitly constrained to users who completed step 1 (A). Step 3 (C) is constrained to users who completed steps 1 and 2. The funnel handles ordering natively.

**Resolution**: when the user selects nodes A, B, C on the graph, construct a **single Amplitude funnel** with steps in topological order. This is the natural mapping — the user is saying "show me this journey through these stages".

The per-edge DAS queries (n-query denominators, pairwise `from`/`to`) are irrelevant here. We are not reproducing the DAS edge-level computation. We are constructing an Amplitude funnel that shows the same journey the user is analysing in DagNet. The Amplitude funnel is inherently richer — it shows absolute conversion at each step, drop-off between steps, and lets the user slice/dice interactively.

**Concretely**: selected nodes are topologically sorted using the graph's edges (already implemented in `dslConstruction.ts:topologicalSort()`). Each node's `event_id` is resolved to the Amplitude event name. The sorted events become funnel steps. No `visited()` constraints are needed between steps — the funnel handles sequencing implicitly.

### Issue 2: What about `visited()` and `exclude()` from the queryDSL?

The analytics panel's queryDSL may contain `visited()` and `exclude()` clauses. These come from two sources:

**(a) Auto-generated from node selection** (`dslConstruction.ts`): when the user selects nodes A, B, C where A is a start and C is an end, the DSL becomes `from(A).to(C).visited(B)`. The `visited(B)` here is saying "the path goes through B". In the Amplitude funnel, B is already a step — so this `visited()` is **redundant** and should be dropped.

**Rule**: any `visited()` node that is also a funnel step is implicit. Drop it.

**(b) From the effective scenario DSL** (window selector, scenario layers): the composited DSL may carry `exclude(X)` or `visited(Y)` where X and Y are nodes NOT in the user's selection. These are genuine constraints:

- `exclude(X)` → segment condition: `{ type: "event", event_type: X's Amplitude name, op: "=", value: 0, time_type: "rolling", time_value: 366 }`
- `visited(Y)` where Y is NOT a funnel step → segment condition: `{ type: "event", event_type: Y's Amplitude name, op: ">=", value: 1, time_type: "rolling", time_value: 366 }`
- `visited(Y)` where Y IS a funnel step → **drop** (implicit)

### Issue 3: `window()` vs `cohort()` date handling

The effective DSL carries either a `window()` or `cohort()` clause (or neither). These have different Amplitude semantics:

**Window mode** (`window(2025-01-01, 2025-03-31)`):
- Dates are when the events occurred (X-anchored)
- Map to chart definition: `"start": toEpochSeconds("2025-01-01"), "end": toEpochSeconds("2025-03-31")`
- Conversion window: use a sensible default (30 days = 2592000 seconds)
- This is the common case

**Cohort mode** (`cohort(anchor-node, 2025-01-01, 2025-03-31)`):
- Dates are when users entered the anchor cohort (A-anchored)
- The anchor node may or may not be in the user's selection
- If anchor is NOT in the selection → prepend it as step 0 (so Amplitude measures from cohort entry)
- If anchor IS already the first step → no change needed
- Map dates to: `"start": toEpochSeconds("2025-01-01"), "end": toEpochSeconds("2025-03-31")`
- Conversion window: use `conversion_window_days` from the cohort config → `conversionSeconds = days * 86400`
- This is the latency-tracked edge case — less common but must be handled

**No dates in DSL**:
- Use relative range: `"range": "Last 30 Days"` (Amplitude default)

### Issue 4: Context and case from the effective DSL

The effective DSL (composited from base + scenario layers) may contain:

**`context(field:value)`** → segment property condition:
```json
{ "type": "property", "prop_type": "user", "prop": "gp:{field}", "op": "is", "values": ["{value}"], "group_type": "User" }
```
Note: built-in user properties (`country`, `platform`, `device_type`, etc.) do NOT get the `gp:` prefix. Custom properties do. The DAS adapter has a `BUILT_IN_USER_PROPS` set for this — we need the same list.

**`case(gate-id:variant)`** → segment property condition:
```json
{ "type": "property", "prop_type": "user", "prop": "activeGates.{gate_id_underscored}", "op": "is", "values": ["{bool}"], "group_type": "User" }
```
Where `gate_id_underscored` = `gate-id.replace(/-/g, '_')` and `bool` = `dasHelpers.resolveVariantToBool(variant)` → `"true"` or `"false"`.

**Cohort exclusions** (from connection defaults, not DSL):
```json
{ "type": "property", "prop_type": "user", "prop": "userdata_cohort", "op": "is not", "values": ["{cohortId}"], "group_type": "User" }
```
The `excluded_cohorts` array comes from the amplitude-prod connection's `defaults.excluded_cohorts` (currently `["9z057h6i"]`). This should always be applied unless explicitly disabled via `context.excludeTestAccounts: false`.

### Decision: build direct, not via DAS adapter

**Recommendation: Option (A) — build the funnel definition directly.**

Reasoning:
1. The DAS adapter is designed for **per-edge queries** to the REST API. A multi-step funnel is a fundamentally different construct. Shoehorning a funnel into the adapter's from/to/visited model adds complexity for no gain.
2. The segment construction is straightforward — we now have the exact schema confirmed. The mapping from DSL clauses to front-end conditions is a thin, well-defined translation.
3. The event resolution is already working (node → event_id → Amplitude name + filters).
4. The "risk of divergence" is low — the constraint types (context, case, cohort exclusion, exclude, visited) are stable. If a new constraint type is added to the DAS adapter, it would also need to be added to the funnel builder, but this is a conscious addition, not an accidental omission.
5. The adapter's complexity (super-funnel vs native segments, segmentation endpoint selection, n/k extraction indices) is irrelevant for funnel construction. Reusing it would mean carrying dead weight.

**What the funnel builder needs to do** (complete list):
1. Topologically sort selected nodes
2. Resolve each node → event_id → Amplitude event name + amplitude_filters
3. Parse the effective DSL (`parseDSL()`)
4. From parsed DSL, build segment conditions:
   - `exclude()` nodes (not in selection) → behavioural `= 0` conditions
   - `visited()` nodes NOT in selection → behavioural `>= 1` conditions
   - `visited()` nodes IN selection → drop (implicit in funnel)
   - `context()` → property conditions (with gp: prefix logic)
   - `case()` → activeGates property conditions
   - `excluded_cohorts` from connection → cohort exclusion conditions
5. From parsed DSL, set date range:
   - `window()` → absolute start/end epoch seconds
   - `cohort()` → absolute start/end + anchor node prepended if needed + conversion window
   - Neither → `"range": "Last 30 Days"`
6. Assemble the chart definition and send to extension

## Conformance tests

Since the funnel builder is a separate code path from the DAS adapter, conformance tests verify that both produce the same Amplitude output for each constraint type.

**Test file**: `graph-editor/src/services/__tests__/amplitudeFunnelBuilder.conformance.test.ts`

**Coverage** (18 tests, all passing):

| Constraint type | What's tested |
|---|---|
| Event resolution | event_id → Amplitude provider name via FileRegistry |
| Event fallback | Missing event file → falls back to event_id (matches DAS) |
| Event filters | `amplitude_filters` mapped with operator normalisation (is any of → is, etc.) |
| Property normalisation | Built-in props pass through; custom props get `gp:` prefix |
| Cohort exclusion | `excluded_cohorts` → `userdata_cohort is not` condition |
| `exclude()` | Behavioural condition: `performed X = 0 times` |
| `visited()` external | Behavioural condition: `performed X >= 1 time` |
| `visited()` internal | Dropped (implicit in funnel step ordering) |
| `context()` custom prop | Property condition with `gp:` prefix |
| `context()` built-in prop | Property condition without prefix |
| `case()` treatment | `activeGates.{gate_id} is "true"` |
| `case()` control | `activeGates.{gate_id} is "false"` |
| Topological sort | Nodes sorted by graph edge topology |
| Missing event_id | Skipped with warning |
| `window()` dates | UK dates → absolute epoch seconds |
| No dates | Falls back to `"Last 30 Days"` |

## Remaining TODOs

1. **Configuration**: `appId`, `orgId`, `orgSlug`, `excluded_cohorts` are hardcoded. Should resolve from the Amplitude connection in `connections.yaml`.
2. **Caching**: structural hash → editId mapping in IndexedDB to avoid duplicate drafts.
3. **Chrome Web Store**: unlisted listing for smoother install ($5 one-time).
4. **`contextAny()` patterns**: regex pattern extraction for context filters (implemented but not yet tested against DAS adapter output for regex patterns).
5. **Cohort mode**: `conversion_window_days` is not available from `parseDSL` — needs to be sourced from edge/cohort config.

## Files

| Path | Purpose |
|---|---|
| `extensions/amplitude-bridge/manifest.json` | Extension manifest (MV3, fixed ID via `key`) |
| `extensions/amplitude-bridge/background.js` | Service worker — message handler + draft creation |
| `extensions/amplitude-bridge/icons/` | Extension icons (16, 48, 128px) |
| `extensions/amplitude-bridge/test.html` | Standalone test page (dev only, serve via HTTP) |
| `graph-editor/public/downloads/dagnet-amplitude-bridge-*.zip` | Packaged extension for user download |
| `graph-editor/src/services/amplitudeBridgeService.ts` | DagNet client — detection, versioning, messaging |
| `graph-editor/src/services/amplitudeFunnelBuilderService.ts` | Funnel definition builder (events, segments, dates) |
| `graph-editor/src/services/__tests__/amplitudeFunnelBuilder.conformance.test.ts` | DAS adapter conformance tests (18 tests) |
| `graph-editor/src/components/modals/AmplitudeBridgeInstallModal.tsx` | Step-by-step install guide with polling |
| `graph-editor/src/components/panels/AnalyticsPanel.tsx` | "Amplitude" button + handler in Analytics header |
| `scripts/spike-amplitude-funnel-api.sh` | HAR capture for API discovery |
| `scripts/analyse-funnel-har.py` | HAR analysis and API call extraction |
| `scripts/test-amplitude-draft-creation.mjs` | CLI test for draft creation (session cookies) |
| `scripts/test-amplitude-draft-with-segments.mjs` | CLI test for draft with all segment types |
