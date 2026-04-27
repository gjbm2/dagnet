# Hooks Inventory (`graph-editor/src/hooks/`)

**93 files, 20,730 LOC** — comparable in mass to `lib/runner/`. Until this doc, the existing reference (`TEST_COVERAGE_SURVEY.md`) cited a stale "51 hooks" figure and 9 of the 20 largest hooks had zero codebase-doc references.

This inventory is **categorical, not exhaustive**: hooks are grouped by what they do, with one-line summaries, LOC, and pointers to deeper docs. For implementation detail, read the source.

---

## How to find the right hook

| You want to… | Look at |
|---|---|
| Trigger a Bayes fit and apply the result | `useBayesTrigger` |
| Compute a canvas analysis | `useCanvasAnalysisCompute` |
| Reaggregate after DSL change | `useDSLReaggregation` |
| Watch the snapshot DB for an edge | `useEdgeSnapshotInventory`, `useEdgeSnapshotRetrievals`, `useDeleteSnapshots` |
| Boot a share link | `useShareChartFromUrl`, `useShareBundleFromUrl`, `useEnterLiveMode` |
| Drive a long-running operation with countdown UI | `useOperationCountdown` |
| Run the daily retrieve-all queue from URL | `useURLDailyRetrieveAllQueue` |
| Watch staleness and surface nudges | `useStalenessNudges`, `useAppUpdateAvailable` |

---

## Compute / analysis hooks

| Hook | LOC | Role |
|---|---|---|
| `useCanvasAnalysisCompute` | 885 | Orchestrator for canvas analysis computation. Three-level cache (transient / container / per-content-item), dependency gating, 2000ms debounce, scenario hydration wait. Single largest hook in the codebase. |
| `useAnalysisBootCoordinator` | 337 | Coordinates analysis-needs-snapshot routing during boot. Tracks which charts/canvas analyses need snapshot data and signals readiness. Mirrors `analysisBootCoordinatorService.ts` per-tab. |
| `useDSLReaggregation` | 219 | Graph-level reactive re-aggregation when current query DSL changes. Drives `fetchDataService.fetchItems({ mode: 'from-file' })` for the current scenario. |
| `useFetchData` | 252 | Wraps `fetchDataService` with toast / progress integration for user-triggered fetches. |
| `useDataDepthScores` | 411 | Async distribution of data-depth scores to edge components. See `DATA_DEPTH_SCORING.md`. |
| `useLagHorizons` | 58 | Triggers `lagHorizonsService` recompute when graph changes. |
| `useScenarioRendering` | 99 | Computes per-scenario edge widths/colours for the canvas overlay. |

## Bayes hooks

| Hook | LOC | Role |
|---|---|---|
| `useBayesTrigger` | 704 | Full Bayes roundtrip: submit → poll → webhook detection → pull → apply patch → cascade. The browser side of the Bayes inference loop. See `PYTHON_BACKEND_ARCHITECTURE.md` §Bayesian. |

## Snapshot DB / signature hooks

| Hook | LOC | Role |
|---|---|---|
| `useSnapshotsMenu` | 770 | The Snapshots @ menu — plausible-hash enumeration, batch retrieval listing, per-batch actions. |
| `useEdgeSnapshotInventory` | 178 | Per-edge inventory query for tooltips and badge counts. |
| `useEdgeSnapshotRetrievals` | 93 | Per-edge retrievals query for the calendar view. |
| `useDeleteSnapshots` | 158 | Delete-snapshots flow with confirmation. |
| `useManageSnapshots` | 65 | Open Snapshot Manager pointed at a specific edge / parameter. |
| `useOpenSnapshotManagerForEdge` | 62 | Convenience wrapper for the right-click → Manage flow. |
| `useParamSigBrowser` | 299 | One half of the Snapshot Manager — parameter list, signature timeline, signature selection state. |

## Share / live-share hooks

| Hook | LOC | Role |
|---|---|---|
| `useShareChartFromUrl` | 807 | Live chart share boot: bundle hydration → recompute → render. See `SHARE_AND_LIVE_SHARE.md`. |
| `useShareBundleFromUrl` | 547 | Multi-tab bundle share boot — opens graph + chart tabs from a single URL. |
| `useShareLink` | 291 | Share-link generation UI plumbing. |
| `useScenarioShareLink` | 123 | Scenario-specific share-link variant. |
| `useEnterLiveMode` | 107 | Promote a static share to live mode (credential unlock + workspace switch). |
| `useCopyCredsShareLink` | 41 | Copy a credentials-bearing share URL (dev/explore use). |

## File / git operation hooks

| Hook | LOC | Role |
|---|---|---|
| `useFileAudit` | 400 | Per-file audit panel (history, blame, diff). |
| `useClearDataFile` | 374 | Clear-data-file flow: removes evidence, resets dirty flags. |
| `useRemoveOverrides` | 395 | Bulk override-flag clearing across edges/nodes. |
| `usePullAll` | 345 | Pull-all-latest with countdown UI and conflict handling. |
| `useViewHistory` | 309 | Open historical version of a file at a past commit. |
| `useOpenHistorical` | 207 | Open file `.asat(date)` — calendar picker → tab. |
| `useRollbackRepository` | 184 | Repository-level rollback (point HEAD at a past commit). |
| `useRenameFile` | 129 | Rename-file flow with index sync. |
| `useCommitHandler` | 86 | Commit dialog + workflow. |
| `useOpenFile` | 88 | Generic file-open helper. |
| `usePullFile` | 62 | Single-file pull. |

## Boot / lifecycle hooks

| Hook | LOC | Role |
|---|---|---|
| `useBootProgress` | 102 | Boot progress reporting; signals `jobSchedulerService.signalBootComplete()`. See `JOB_SCHEDULER.md`. |
| `useStalenessNudges` | 298 | Global staleness nudge bridge between React context and scheduler jobs. |
| `useAppUpdateAvailable` | 71 | "Newer client deployed?" signal for UI chrome. |
| `useURLScenarios` | 316 | Boot scenarios from URL parameters. |
| `useURLDailyRetrieveAllQueue` | 136 | `?retrieveall` queue handling. |
| `useRetrieveAllSlices` | 129 | Manual retrieve-all entry point. |
| `useRetrieveAllSlicesRequestListener` | 24 | Listens for retrieve-all custom events from menus/toolbars. |

## Canvas / interaction hooks

| Hook | LOC | Role |
|---|---|---|
| `useSnapToGuides` | 318 | Snap-to-guide rendering during drag (alignment lines). |
| `useAlignSelection` | 299 | Multi-select alignment, distribution, equal-size commands. |
| `useCopyPaste` | 301 | Clipboard / drag-from-Navigator paste flows. |
| `useSnapToSlider` | 168 | Slider snap-to-tick behaviour. |
| `useElementSize` | 62 | ResizeObserver wrapper for measured layout. |
| `useSelectAll` | 58 | Cmd+A selection across the canvas. |
| `useCtrlKeyState` | 93 | Global Ctrl-key tracking for modifier-aware interactions. |
| `useAnimateFlow` | 23 | Edge-flow animation toggle. |

## Sidebar / panel hooks

| Hook | LOC | Role |
|---|---|---|
| `useSidebarState` | 366 | Sidebar mode/width/active-panel state with IDB persistence. See `SIDEBAR_AND_PANELS_ARCHITECTURE.md`. |
| `useContextDropdown` | 191 | Shared context-filter dropdown state (used by WindowSelector + evidence tab). |
| `useItemFiltering` | 216 | Generic Navigator filtering / sorting / grouping. |
| `useScenarioRendering` | 99 | Scenario-aware rendering for the legend. |

## Scenario hooks

| Hook | LOC | Role |
|---|---|---|
| `useBulkScenarioCreation` | 306 | Bulk-create-scenarios flow with progress operation wrapping. |
| `useCanvasAnalysisScenarioCallbacks` | 202 | Per-content-item scenario mutations with auto-promotion. See `CANVAS_ANALYSIS_FEATURE.md`. |
| `usePutToBaseRequestListener` | 35 | Listens for `put-to-base` requests (flatten Current into Base). |
| `useCopyAllScenarioParamPacks` | 106 | Bulk export of scenario param packs. |

## Operations / progress hooks

| Hook | LOC | Role |
|---|---|---|
| `useOperationCountdown` | 147 | Wires `countdownService` + `operationRegistryService` for a UI countdown widget. |
| `useCountdown` | 11 | Thin countdown subscriber. |
| `useOperations` | 22 | Subscribe to operation registry. |
| `useBanners` | 11 | Subscribe to `bannerManagerService`. |

## Auth / connection hooks

| Hook | LOC | Role |
|---|---|---|
| `useGitHubOAuthChip` | 91 | Menu-bar OAuth status chip with one-click reconnect. |
| `useHealthStatus` | 113 | BE health check polling for the chip indicator. |
| `useConsoleMirrorControls` | 60 | Dev controls for console-mirror toggle. |

## View / display preference hooks

| Hook | LOC | Role |
|---|---|---|
| `useDataValuesView` | 37 | `BeadDisplayMode` access — see `BEAD_DISPLAY_MODE.md`. |
| `useSankeyView` | 38 | Sankey-mode toggle. |
| `useNodeImageView` | 37 | Node image visibility toggle. |
| `useViewOverlayMode` | 45 | Forecast quality overlay vs default. |
| `useAutoUpdateCharts` | 45 | Auto-update charts toggle. |
| `useDashboardMode` | 11 | Read `DashboardModeContext`. |
| `useKeyboardShortcuts` | 122 | Keyboard-shortcut registration. |

## Diagnostic / dev hooks

| Hook | LOC | Role |
|---|---|---|
| `useOpsDemoMode` | 375 | Dev-only operations-demo mode (synthetic operations for UI testing). |
| `useIntegrityCheck` | 75 | Trigger `integrityCheckService` and surface results. See INTEGRITY_CHECK_SERVICE.md. |
| `useWhereUsed` | 69 | "Where is this parameter / event / context used?" reverse-lookup. |
| `useActiveGraphTracking` | 30 | Tracks the currently-active graph tab for global services. |
| `useQuerySelectionUuids` | 30 | Reads node UUIDs from current query for menu visibility. |

---

## Coverage gaps

Of the 20 largest hooks, **9 have zero references** in any other codebase doc as of 27-Apr-26 (now they have one — this file):

`useDataDepthScores`, `useFileAudit`, `useRemoveOverrides`, `useOpsDemoMode`, `useClearDataFile`, `useAnalysisBootCoordinator`, `useSnapToGuides`, `useViewHistory`, `useParamSigBrowser`, `useAlignSelection`.

If you discover non-obvious behaviour while modifying any of these, prefer extending this inventory or the hook's category section over creating a new dedicated doc — the file count is high enough that per-hook docs would create more navigation overhead than they relieve.
