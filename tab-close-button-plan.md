## Tab Close Button Refactor – Implementation Proposal

### 1. Background & Current State (and why recent attempts failed)

The workspace currently relies on rc-dock to render tab chrome for two distinct docking contexts:

- **Main application tabs** (`group: 'main-content'`) created through `TabContext`. These live in the top-level `AppShell` rc-dock instance.
- **GraphEditor sidebar tabs** (What-If, Properties, Tools, etc.) created in `graphSidebarLayout.ts` and manipulated within `GraphEditor.tsx`. These exist inside a nested rc-dock instance (`.graph-editor-dock-container`) whose “home” container is the panel with id `graph-sidebar-panel`.

Recent iterations attempted to control close-button visibility using CSS overrides (`dock-tab-close-btn` etc.). This led to:

1. Duplicate close buttons (rc-dock’s native button + custom button).
2. Inconsistent padding, because CSS attempted to compensate independent of rc-dock’s own layout logic.
3. Lack of differentiation between tabs in their home slot versus tabs that were floated or re-docked elsewhere.
4. **Root cause recap (last 20 minutes):** while experimenting we repeatedly:
   - Hid rc-dock’s native close button globally, unintentionally removing the only close button for main app tabs.
   - Added custom close buttons and padding purely through CSS, ignoring rc-dock’s `closable` flag and DOM structure described in `graph-editor/src/docs/SIDEBAR_AND_PANELS_ARCHITECTURE.md`.
   - Failed to scope CSS by docking context (top-level vs `.graph-editor-dock-container`), producing padding and visibility bugs for non-closable tabs.
   - Ignored the panel lifecycle mechanics documented in *SIDEBAR_AND_PANELS_ARCHITECTURE.md* (e.g. expectations around floating panels and `floatingPanels` bookkeeping), hence the layout logic never flipped `closable` and CSS hacks were used instead.
   - Worked without a full mental model of the nested rc-dock instances; every change fought the framework instead of using the existing state machinery.

### 2. Target Behaviour

| Context | Desired Close Button | Padding | Notes |
| --- | --- | --- | --- |
| **Main app tabs** (top-level) | Always visible | Provide extra right padding so the built-in rc-dock button has breathing room | No custom button; rely on rc-dock’s native close control |
| **GraphEditor sidebar – home slot** (`graph-sidebar-panel` within `.graph-editor-dock-container`) | **No** close button | Tight padding (no space reserved for a button) | Tabs should not be closable in-place, as per UX |
| **GraphEditor sidebar – anywhere else** (floated or re-docked outside home panel) | Close button visible | Same padding + styling as main app tabs | Tabs become closable once removed from their home panel |

### 3. Proposed Delta From Current Code

1. **Remove CSS-based suppression/creation of close buttons**
   - Delete custom `.dock-tab-close-btn` overrides and the auxiliary `tab-close-btn` stylings currently used to fake the control.
   - Let rc-dock render (or not render) its native close button purely via the `closable` flag.
   - Re-align with the architectural rule from `SIDEBAR_AND_PANELS_ARCHITECTURE.md`: “Close buttons (✕) should be hidden when tabs are in their home position, visible elsewhere.”

2. **Authoritative control via tab metadata**
   - Sidebar tabs should be created with `closable: false` (already true in the layout definitions, but needs to stay consistent for dynamic additions in `GraphEditor.tsx`).
   - Introduce runtime logic that inspects layout changes and toggles `closable` to `true` when a sidebar tab leaves its home slot, and back to `false` when it returns.
   - This honours the persisted state design described under “Panel ID Tracking” and “Close Button Visibility” in `SIDEBAR_AND_PANELS_ARCHITECTURE.md`.

3. **Scoped styling updates**
   - Adjust CSS so that:
     - `.dock-tab.closable-true` (or equivalent selector) receives the additional right padding and button styling.
     - Tabs with `closable: false` keep tight padding.
     - rc-dock’s native close button (`.dock-tab-close`) receives explicit sizing/colour for visibility.
   - All styles remain context-aware: selector chains should differentiate main app tabs vs. GraphEditor sidebar tabs.
   - Tie selectors to stable identifiers highlighted in the architecture doc (`data-dockid="graph-sidebar-panel"`, `.graph-editor-dock-container`) instead of brittle structural guesses.

4. **Layout-change observer enhancements**
   - The existing `handleLayoutChange` in `GraphEditor.tsx` already fires on structural changes. Extend it to:
     - Iterate over known sidebar tab IDs (What-If, Properties, Tools, plus any dynamic additions).
     - Use `dockLayoutRef.current.find(tabId)` to locate each tab and determine whether its containing panel is the home panel (`graph-sidebar-panel` within the GraphEditor dock container).
     - Call `dockLayoutRef.current.updateTab(tabId, { closable: boolean })` if the value needs to switch. Guard with a memo map to avoid churn.
   - Ensure updates run after rc-dock settles (setTimeout 0 or microtask) to avoid race conditions.
   - Sync this logic with the `floatingPanels` bookkeeping already described in `SIDEBAR_AND_PANELS_ARCHITECTURE.md` so state persistence remains consistent.

5. **Migration / cleanup tasks**
   - Remove legacy global listeners or CSS hacks (`:has`, negative margins, etc.) introduced during the quick fixes.
   - Re-run visual QA to confirm there is exactly one close button per closable tab, aligned with rc-dock’s expected padding.
   - Document the resulting behavior in `SIDEBAR_AND_PANELS_ARCHITECTURE.md` so future contributors follow the authoritative approach rather than re-introducing CSS-based overrides.

### 3a. Lessons Learned (why the previous approach failed)

- **Misunderstood rc-dock cascade:** rc-dock already adds/removes its close button based on `closable`. Overriding the DOM directly caused duplicates and broken padding.
- **Ignored architecture contract:** The architecture doc specifies that sidebar close visibility depends on location. The CSS-only approach bypassed the business logic that tracks floating panels.
- **Brittle selectors:** Global selectors (`.dock-tab-close-btn`, negative margins) caught unrelated tabs (navigator, menu), causing padding despite non-closable configuration.
- **Lack of state synchronisation:** Without toggling `closable` when tabs moved, CSS couldn’t determine intent, leading to contradictory states.
- **No consistent mental model:** Skipping the layout lifecycle (initial render, component reinjection, `floatingPanels` updates) meant each patch contradicted rc-dock’s own behaviour.

The new proposal resolves these by centering on rc-dock’s intended control surface (`closable`) plus the layout/state mechanisms already present in the sidebar architecture.

### 4. Implementation Outline

1. **CSS Reset**
   - Purge `.dock-tab-close-btn` custom definitions and revert to rc-dock’s `.dock-tab-close` element (style size, colour, hover).
   - Add selectors for `closable=true` states:
     ```css
     .dock-tab.closable-true .dock-tab-btn { padding-right: 32px; }
     .dock-tab.closable-true .dock-tab-close { display: flex; width: 18px; height: 18px; }
     ```
     (Exact values to be tuned.)
   - For sidebar-home tabs:
     ```css
     .graph-editor-dock-container .dock-panel[data-dockid="graph-sidebar-panel"] .dock-tab-btn {
       padding-right: 12px; /* default */
     }
     ```

2. **GraphEditor Tab Lifecycle**
   - Ensure every sidebar tab created (static layout + dynamic) starts with `closable: false`.
   - Maintain a `const SIDEBAR_TAB_IDS = new Set([...])` to facilitate lookups.
   - Add helper `isSidebarTabAtHome(tabNode: TabData): boolean` that checks the docking context.

3. **Layout Change Handling**
   - Inside `handleLayoutChange`:
     - After existing persistence logic, traverse `SIDEBAR_TAB_IDS`.
     - For each tab, compute desired closable state.
     - If mismatch, call `dockLayoutRef.current.updateTab(tabId, { closable: desired })`.
     - Optionally add logging in dev builds when toggles happen for easier debugging.

4. **Floating Windows**
   - rc-dock’s floatboxes sit under `.dock-fbox`. Ensure `isSidebarTabAtHome` returns `false` for any tab whose closest ancestor `.dock-panel` isn’t `graph-sidebar-panel`.

5. **Verification Plan**
   - Manual QA scenarios:
     1. Launch app, confirm main tabs show close button with padding.
     2. Sidebar tabs in home slot show no close button, padding tight.
     3. Drag sidebar tab to main tab strip → close button appears.
     4. Float sidebar tab → close button appears.
     5. Return tab home → close button disappears.
   - Optional: add a Jest test for a pure helper function (`deriveSidebarClosableState(layout)`), using layout fixtures saved from real states.

### 5. Summary of Delta

| Area | Current Approach | Proposed Change |
| --- | --- | --- |
| Close button visibility | Controlled via CSS overrides, leading to duplicates | Controlled strictly via rc-dock’s `closable` flag per tab |
| Padding | Global CSS attempting to detect presence (`:has`, negative margins) | Determined by context-aware selectors based on `closable` state |
| Sidebar home vs. away | No reliable differentiation | Runtime toggling of `closable` during layout change inspection |
| Styling | Custom div-based `dock-tab-close-btn` | rc-dock native button styled consistently |
| Maintainability | Ad-hoc, hard to reason | Declarative mapping: tab location → `closable` flag → consistent CSS |

This proposal keeps the logic centralized, removes CSS hacks, and ensures the three required behaviours (main tabs closable, sidebar home non-closable, sidebar-away closable) are satisfied by design.

