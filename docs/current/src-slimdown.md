## Src Slimdown Plan (Large File Modularisation)

**Created:** 15-Dec-25  
**Status:** Draft — implementation plan only (no code changes included)

---

### Purpose

Several files under `graph-editor/src/` have grown beyond a maintainable size and now mix multiple responsibilities. This plan proposes a safe, testable approach to split those files into smaller, modular blocks **without creating duplicate code paths** and while preserving DagNet’s architectural constraints (services own logic; UI owns composition).

---

### Goals (What “Good” Looks Like)

- **Maintainability**: Each module has a single, clearly named responsibility and is small enough to be navigable.
- **Stable public surface**: Callers keep importing from the same entry file (where practical), while internals move behind it.
- **No behavioural change**: The refactor is structural; behaviour should remain identical unless explicitly approved later.
- **No duplicate code paths**: We extract and centralise; we do not re-implement logic in multiple places.
- **Tests as proof**: Existing relevant tests remain green throughout (run per-file, not the full suite).

---

### Non‑Negotiables (Repo Rules to Preserve)

- **No logic in UI/menu files**: UI components and menus remain access points only; business logic stays in services/hooks.
- **IndexedDB is source of truth for git/data ops**: Avoid introducing new in-memory “truths” while moving code around.
- **Session logging**: External/data operations must keep `sessionLogService` coverage; do not lose log events during extraction.
- **UK date format**: Internal/UI/logging stays `d-MMM-yy` unless at an external API boundary.
- **Minimise surface area**: Don’t add compatibility shims; prefer clean moves with updated imports.

---

### Inventory: Primary Targets (by size / risk)

Highest leverage first (approx line counts at time of writing):

- **Services**
  - `graph-editor/src/services/dataOperationsService.ts` (~6.9k)
  - `graph-editor/src/services/UpdateManager.ts` (~4.7k)
  - `graph-editor/src/services/statisticalEnhancementService.ts` (~2.7k)
  - `graph-editor/src/services/integrityCheckService.ts` (~2.5k)
- **UI**
  - `graph-editor/src/components/GraphCanvas.tsx` (~5.3k)
  - `graph-editor/src/components/edges/ConversionEdge.tsx` (~3.0k)
  - `graph-editor/src/components/PropertiesPanel.tsx` (~2.8k)

Secondary candidates (only after the above are stable):

- `graph-editor/src/contexts/TabContext.tsx` (~2.3k)
- `graph-editor/src/components/editors/GraphEditor.tsx` (~2.2k)
- `graph-editor/src/components/QueryExpressionEditor.tsx` (~2.1k)

---

### Strategy: How We Split Without Breaking Things

This refactor should be executed as a sequence of small, reversible steps:

- **Keep the original file as the “facade” initially**
  - The top-level file becomes an entry point that re-exports and orchestrates.
  - Internals move into sibling modules under a dedicated directory.
  - This reduces churn in callers while we stabilise.

- **Extract by dependency direction**
  - Start by extracting **pure utilities/types** (no imports from app state or UI).
  - Then extract **domain logic** (pure-ish functions and deterministic transforms).
  - Finally extract **orchestration** (calls to services, DB, network, toasts, logging).

- **Prefer “one-way” module dependencies**
  - Avoid cross-imports between new modules that used to be “free” inside one giant file.
  - If two parts truly need each other, introduce a small shared module (types/utilities) rather than circular imports.

- **Don’t expand public APIs during refactor**
  - Only move code and adjust imports. Avoid adding new options, new behaviours, or new entry points until after the split is complete.

---

### Proposed Module Boundaries (Per Large File)

#### 1) `dataOperationsService.ts` → `services/dataOperations/…`

Observed issues:

- Mixes orchestration (network + DB + UpdateManager) with UI concerns (toasts), caching (DAS runner), and feature flags/batch mode.
- Contains long “deprecated but keep” sections which inflate cognitive load.

Proposed split (directory: `graph-editor/src/services/dataOperations/`):

- **Entry/facade**
  - `index.ts`: re-export the public service API and types.
  - Keep existing import path compatibility by having `dataOperationsService.ts` delegate to `services/dataOperations/index.ts` until callers are migrated.

- **External integration**
  - Module for DAS runner creation and caching (connection lookups).
  - Module for ISO boundary conversion (UK internal ↔ ISO for adapters).

- **Batching and UX adapters**
  - Module for batch mode state (enable/disable + “should suppress” query).
  - Module for notifications as an injected dependency (so the service does not hard-depend on a specific toast library).

- **Extraction/parsing helpers**
  - Modules for “extract update payload” behaviour (e.g. Sheets edge payload extraction).
  - Keep these helpers pure and testable; avoid importing UI or global state.

- **Core orchestration**
  - Modules grouped by operation type (for example: “Get”, “Put”, “Append history”, “Fetch planning”), each keeping session logging intact.

Key guardrails:

- Any UI feedback remains driven through callbacks/hooks rather than embedded business logic inside components.
- Keep `sessionLogService` calls co-located with orchestration boundaries so logging remains complete.

#### 2) `UpdateManager.ts` → `services/updateManager/…`

Observed issues:

- Contains types, mapping configuration, conflict strategy, audit trail, and complex graph operations (including rebalancing) in one file.

Proposed split (directory: `graph-editor/src/services/updateManager/`):

- **Types and contracts**
  - Module containing UpdateManager public types (directions, operations, results, conflict types).
  - Module containing internal helper types (mapping keys, normalised mapping descriptors).

- **Mapping configuration**
  - Module solely responsible for declaring mapping configurations (data-only shape plus transforms).
  - Module that validates mapping configuration integrity at startup (optional, but useful once stable).

- **Apply/update engine**
  - Module implementing the “apply mapping to target” logic (override gating, transforms, change tracking).
  - Module implementing conflict detection and resolution policy (interactive vs non-interactive).

- **Graph-specific sub-systems**
  - Rebalancing logic extracted into a dedicated module (edge sibling rebalance, conditional rebalance).
  - Any topology/lookup helpers extracted to avoid ad-hoc scanning across modules.

- **Audit and logging**
  - Module for audit record construction + redaction rules.
  - Module for structured session logging events (so logging remains consistent).

Key guardrails:

- Maintain the rule that there is a **single code path** for rebalancing and other graph mutations (avoid new parallel implementations).
- Keep “override behaviour” central; do not allow each caller to implement its own override gating.

#### 3) `GraphCanvas.tsx` → `components/canvas/…` (UI-only orchestration)

Observed issues:

- Mixes ReactFlow wiring, interaction state (panning/zooming/dragging), layout engines (dagre + sankey), debug instrumentation, and graph mutation orchestration.

Proposed split (directory: `graph-editor/src/components/canvas/`):

- **Canvas composition**
  - A small top-level `GraphCanvas` component focused on composing subcomponents and passing callbacks.

- **Hooks for interaction state**
  - Hook to manage panning/zooming suppression state.
  - Hook to manage node dragging suppression state.
  - Hook to manage viewport persistence in tab state (read/write minimal deltas).

- **Graph mutation bridge**
  - A thin hook that delegates graph update operations to the existing service layer (for example: graph mutation service).
  - Keep business logic in services; the hook handles UI-to-service wiring only.

- **Layout**
  - Separate modules for dagre layout and sankey layout orchestration.
  - Layout code should not reach into toasts/session logging; it should output a layout result that the canvas applies.

- **Diagnostics**
  - Consolidate console logging behind a single “diagnostics” toggle module so it can be disabled or redirected consistently.

Key guardrails:

- Do not migrate business logic into the canvas; it should remain an access point.
- Be cautious around render loops and state synchronisation; small incremental extractions are safer than “big-bang” rewrites.

#### 4) `PropertiesPanel.tsx` → `components/properties/…` (UI-only, with service/hook boundaries)

Observed issues:

- Contains validation utilities, formatting helpers, tab navigation, local form state management, and multiple sub-editors in one file.

Proposed split (directory: `graph-editor/src/components/properties/`):

- **Validation & formatting helpers**
  - Move ID validation, uniqueness checks, and tooltip formatting into small utility modules.
  - Any non-UI rules that become shared across the app should be promoted to an appropriate service or `lib/` module.

- **Panel sections**
  - Extract major UI sections into dedicated components (node details, edge details, variants, conditional probabilities, images, connections, evidence/forecast display).

- **State coordination hooks**
  - Hook(s) to manage “local edit buffer” and “commit on blur/apply” behaviour.
  - Hook(s) to coordinate tab-level what-if state read/write.

Key guardrails:

- If any of the extracted logic is used by multiple menus or components, promote it to a service or hook rather than duplicating it.

#### 5) `ConversionEdge.tsx` → `components/edges/conversion/…`

Observed issues:

- Edge rendering, label computations, beads/overlays, and interaction handlers tend to accumulate; splitting makes visual features safer to evolve.

Proposed split (directory: `graph-editor/src/components/edges/conversion/`):

- **Geometry and rendering primitives**
  - Path/geometry calculations and constants.
  - Pure render subcomponents for labels and decorations.

- **Data derivation**
  - Separate module for deriving display data from edge props (kept deterministic).

- **Interaction handlers**
  - Small module for event handlers that delegate to existing context menu logic and services (no business rules).

---

### Execution Plan (Phased, Safe, and Test-Guided)

#### Phase 0 — Baseline and Guardrails

- Record the current “largest files” list and identify their primary public entry points (imports used by other modules).
- Identify the most critical integration tests for each target area (by file path), so we can keep feedback fast.
- Decide the migration order (recommended below) and keep it stable to avoid parallel refactors colliding.

Recommended order (high leverage, lower UI churn first):

- `UpdateManager.ts`
- `dataOperationsService.ts`
- `statisticalEnhancementService.ts`
- `GraphCanvas.tsx`
- `PropertiesPanel.tsx`
- `ConversionEdge.tsx`

#### Phase 1 — Extract “Pure” Modules (Low Risk)

For each target file:

- Extract constants, types, and pure helper functions into a new directory module.
- Ensure no behavioural change by keeping the original call sites intact.
- Keep imports one-directional (entry file imports helpers; helpers do not import entry file).

Success criteria:

- The original file size drops noticeably.
- No call site changes required yet (facade pattern).

#### Phase 2 — Extract Subsystems (Medium Risk)

- Move coherent clusters (for example: mapping config, conflict resolution, layout orchestration, payload extraction) into dedicated modules.
- Keep orchestration in the entry file until the end of the phase, then progressively move it too.

Success criteria:

- Each module reads as a single story (“this module only does X”).
- No new circular dependencies introduced.

#### Phase 3 — Normalise Public APIs (Churn Containment)

- Where safe, keep existing imports by re-exporting from the original file.
- Where the original file was an anti-pattern (too many exports, unclear ownership), create a clear `index.ts` entry and migrate call sites in a single sweep per domain.

Success criteria:

- Call sites have consistent imports per domain.
- No “temporary alias exports” remain after migration (minimise code surface area).

#### Phase 4 — Clean-up and Documentation

- Delete dead code discovered during extraction (only if it is clearly unused and covered by tests).
- Add module-level documentation comments describing responsibilities and constraints.
- Update any developer docs if module locations change in a way that affects onboarding.

Success criteria:

- The top-level “former mega files” are now thin facades or gone entirely.
- New directory structure is discoverable and consistent.

---

### Testing Plan (Relevant Tests Only)

Testing should be run per affected domain to maintain fast feedback:

- **UpdateManager refactor**
  - Run the existing UpdateManager-focused tests (for example: `graph-editor/src/services/UpdateManager.test.ts` and any `UpdateManager.*.test.ts` files).
- **Data operations refactor**
  - Run the data operations service tests (for example: `graph-editor/src/services/__tests__/dataOperationsService.*.test.ts` and the most relevant end-to-end integration tests that cover fetch/put flows).
- **GraphCanvas / edge rendering refactor**
  - Run canvas/edge tests under `graph-editor/src/components/**/__tests__/` that cover scenario edges, beads, and selection interactions.
- **PropertiesPanel refactor**
  - Run the PropertiesPanel-related component tests and any integration tests that validate field editing and persistence behaviours.

Important:

- Keep refactor steps small enough that a failure points clearly to the last extraction.
- If a test failure reveals a previously untested coupling, add a test only with explicit approval (per repo rules).

---

### Risk Register (What Can Go Wrong and How We Avoid It)

- **Circular dependencies after splitting**
  - Mitigation: extract shared types/utilities into dedicated modules; avoid cross-imports between “peer” subsystems.

- **Accidental behavioural change due to moved initialisation order**
  - Mitigation: keep entry file orchestration until late; avoid re-ordering side-effectful initialisation.

- **Lost session logging coverage**
  - Mitigation: treat logging calls as part of the orchestration boundary; keep them in modules that still sit at the “operation” edge.

- **UI performance regressions (GraphCanvas)**
  - Mitigation: extract hooks without changing state ownership; avoid new state layers; preserve memoisation boundaries.

- **Unintended API churn**
  - Mitigation: facade-first approach, then controlled call-site migrations, then removal of aliases.

---

### Definition of Done

This modularisation effort is “done” when:

- Each primary target file is reduced to a maintainable size, or replaced by a thin facade.
- Each new module has a single responsibility and a clear name.
- No duplicate code paths exist for the same operation (especially in update/rebalance/data ops).
- Relevant existing tests for the touched domains pass.
- Session logging for external/data operations remains intact.


