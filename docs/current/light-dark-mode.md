# Light / Dark Mode Toggle

**Created:** 13-Feb-26
**Status:** Implemented (Phases 0–6)

---

## Goal

Add a user-controlled light/dark mode toggle to DagNet. The toggle appears in two places:

1. **MenuBar** — a Sun/Moon icon button in `.dagnet-right-controls`, immediately left of `.dagnet-brand` (the logo).
2. **View menu** — a toggle item (using the existing `✓ ` prefix pattern), labelled "Dark Mode".

Both entry points call the same centralised hook; neither contains any logic (per the "no logic in UI files" rule).

---

## Current State

### What already exists

- **15 CSS files** already have `@media (prefers-color-scheme: dark)` overrides. These cover: MenuBar, Navigator, Modal, Dialog, CommitDialog, TabBar, SelectorModal, ScenarioLegend, LightningMenu, LoadingSpinner, ErrorBoundary, AutomatableField, HistoricalCalendarPicker, RawView, and file-state-indicators.
- The View menu (`ViewMenu.tsx`) already has several toggle-style items (Auto Re-route, Sankey View, Animate Flow, Show Node Images, Dashboard mode) using the `✓ ` prefix convention.

### What does not exist

- No `ThemeContext`, no theme provider, no `localStorage` persistence.
- No centralised CSS variable definitions at `:root` — colours are hardcoded across ~150+ files.
- No dark variants for: dock-theme, dashboard-mode, active-tab-highlight, AppShell inline styles, PropertiesPanel, AnalyticsPanel, ScenariosPanel, ToolsPanel, WhatIfPanel, GraphEditor, SessionLogViewer, MarkdownViewer, GraphIssuesViewer, SidebarIconBar, ProgressToast, ParameterSection, QueryExpressionEditor, SignatureLinksViewer, DateRangePicker, EnhancedSelector, ConnectionSelector, ColourSelector, Accordion, and many more.
- No dark palette for `objectTypeTheme.ts` (20 object types, each with light-only `lightColour` / `accentColour`).
- No MUI `ThemeProvider` wiring (MUI is used in a handful of components).

---

## Architecture

### Theme state

A `ThemeContext` providing `{ theme: 'light' | 'dark', toggleTheme: () => void }`.

- Persisted in `localStorage` under a key like `dagnet-theme`.
- On load, if no stored preference, default to the OS preference via `window.matchMedia('(prefers-color-scheme: dark)')`.
- The provider sets a `data-theme="light"` or `data-theme="dark"` attribute on `document.documentElement`.

### CSS variable strategy

Define a token set at `:root` (light defaults) and override under `[data-theme="dark"]`. Tokens cover the foundational palette: background, surface, text, text-secondary, border, accent, danger, success, etc.

The existing `@media (prefers-color-scheme: dark)` rules in 15 files will be migrated to `[data-theme="dark"]` selectors so they respond to the user toggle rather than only the OS preference. This is largely mechanical find-and-replace.

### Toggle hook

A `useTheme` hook (or direct `useContext(ThemeContext)`) consumed by both the MenuBar icon button and the View menu item. No logic in either UI file — just read `theme` and call `toggleTheme`.

### MUI integration

Wrap the app in MUI's `ThemeProvider` with `palette.mode` driven by the theme context. This covers the handful of MUI components (Base64Encoder, TabbedArrayWidget, AccordionObjectFieldTemplate, MonacoWidget).

---

## Phased Implementation

### Phase 0 — Foundation (toggle + context + CSS tokens)

**Effort:** ~0.5 day

- Create `ThemeContext` with provider, `localStorage` persistence, and `data-theme` attribute on `document.documentElement`.
- Create a `useTheme` hook that wraps the context.
- Define a root CSS token file with `:root` (light) and `[data-theme="dark"]` (dark) colour tokens for the core palette (~15–20 variables: background, surface, elevated-surface, text-primary, text-secondary, text-muted, border, border-subtle, accent, accent-hover, danger, success, warning, shadow, overlay).
- Add the toggle icon button to `MenuBar.tsx` in `.dagnet-right-controls`, immediately before `.dagnet-brand`. Uses Lucide `Sun` / `Moon` icons.
- Add a "Dark Mode" toggle item to `ViewMenu.tsx` using the existing `✓ ` prefix pattern.
- Wire both through `useTheme` — no inline logic.

**Result:** Toggle works and switches the `data-theme` attribute. The app does not yet look correct in dark mode — that comes in subsequent phases.

### Phase 1 — Migrate existing dark CSS (15 files)

**Effort:** ~0.5 day

Convert the existing `@media (prefers-color-scheme: dark)` blocks in all 15 files to `[data-theme="dark"]` selectors. Where possible, replace hardcoded colours within those blocks with the CSS tokens defined in Phase 0.

Files:
- MenuBar.css
- Navigator.css
- Modal.css
- Dialog.css
- CommitDialog.css
- TabBar.css
- SelectorModal.css
- ScenarioLegend.css
- LightningMenu.css
- LoadingSpinner.css
- ErrorBoundary.css
- AutomatableField.css
- HistoricalCalendarPicker.css
- RawView.css
- file-state-indicators.css

**Result:** The 15 components that already had OS-level dark mode now respond to the user toggle.

### Phase 2 — Core shell and layout

**Effort:** ~1–1.5 days

This phase covers the structural chrome that dominates the visual impression:

- **AppShell.tsx** — replace ~30+ inline hardcoded colour values with CSS tokens. This is the single highest-impact file.
- **dock-theme.css** (~250 lines) — add dark overrides for rc-dock panels, tab bars, dividers, content backgrounds, drop zones.
- **active-tab-highlight.css** — add dark variants for the coloured tab tinting.
- **dashboard-mode.css** — add dark overrides.
- **SidebarIconBar.css** — dark overrides for the left icon rail.

**Result:** The main application shell, panels, and tab system look correct in dark mode.

### Phase 3 — Panels and editors

**Effort:** ~1–1.5 days

Dark overrides for the content areas:

- PropertiesPanel.css, PropertiesPanelWrapper.css
- AnalyticsPanel.css, ScenariosPanel.css, ToolsPanel.css, WhatIfPanel.css
- GraphEditor.css (the canvas/SVG area — may need special treatment for graph backgrounds and edge colours)
- SessionLogViewer.css, MarkdownViewer.css, GraphIssuesViewer.css
- SignatureLinksViewer.css
- ParameterSection.css
- QueryExpressionEditor.css

**Result:** All editor and panel views have dark variants.

### Phase 4 — Modals, dialogs, and secondary UI

**Effort:** ~1 day

- MergeConflictModal.css (already has `var()` stubs — define the variables)
- ShareLinkModal.css, ScenarioEditorModal.css, ConnectionSettingsModal.css
- ProgressToast.css (already has `var()` stubs)
- DateRangePicker.css, EnhancedSelector.css, ConnectionSelector.css, ColourSelector.css
- ContextValueSelector.css, EdgeScalingControl.css
- CollapsibleSection.css, Accordion.css
- ConditionalProbabilityEditor.css
- ShareModeBanner.css
- SidebarHoverPreview.css
- NavigatorControls.css, CalendarGrid.css, WindowSelector.css

**Result:** All modal/dialog/picker UI has dark variants.

### Phase 5 — Theme-aware JS colours and MUI

**Effort:** ~0.5–1 day

- **objectTypeTheme.ts** — add a dark palette for all 20 object types. Provide a theme-aware getter that returns the appropriate palette based on the current theme. This affects tab colours, navigator icons, and type badges throughout the app.
- **colourAssignment.ts** and **conditionalColours.ts** — assess whether data visualisation colours need dark variants (they may be fine as-is if they're used on graph canvases with their own backgrounds).
- **MUI ThemeProvider** — wrap the app-level provider with `createTheme({ palette: { mode } })` so the handful of MUI components (Base64Encoder, TabbedArrayWidget, AccordionObjectFieldTemplate, MonacoWidget) pick up the correct palette.

**Result:** JS-driven colours and MUI components are theme-aware.

### Phase 6 — Polish and edge cases

**Effort:** ~0.5 day

- Verify Monaco editor instances respect the theme (Monaco has built-in light/dark themes — switch via the theme context).
- Verify Toaster (hot-toast) styling in dark mode.
- Verify graph SVG rendering (node fills, edge strokes, labels) in dark mode.
- Check that share-mode / read-only views work in both themes.
- Test the transition between themes (no flash-of-wrong-theme on page load — apply `data-theme` before first paint, ideally via a blocking script in `index.html`).
- Accessibility check: ensure sufficient contrast ratios in both themes.

---

## File Inventory

### New files

| File | Purpose |
|------|---------|
| `src/contexts/ThemeContext.tsx` | Theme provider, `useTheme` hook, `localStorage` persistence |
| `src/styles/theme-tokens.css` | `:root` and `[data-theme="dark"]` CSS variable definitions |

### Modified files

| File | Change |
|------|--------|
| `src/components/MenuBar/MenuBar.tsx` | Add theme toggle icon button in `.dagnet-right-controls` |
| `src/components/MenuBar/ViewMenu.tsx` | Add "Dark Mode" toggle item |
| `src/components/MenuBar/MenuBar.css` | Style for toggle button; migrate `prefers-color-scheme` to `data-theme` |
| `src/AppShell.tsx` | Wrap in `ThemeProvider`; replace inline colours with CSS tokens |
| `src/main.tsx` (or equivalent entry) | Wrap app in `ThemeContext.Provider` |
| `src/theme/objectTypeTheme.ts` | Add dark palette, theme-aware getter |
| `src/styles/dock-theme.css` | Add `[data-theme="dark"]` overrides |
| `src/styles/active-tab-highlight.css` | Add dark overrides |
| `src/styles/dashboard-mode.css` | Add dark overrides |
| `src/styles/file-state-indicators.css` | Migrate `prefers-color-scheme` to `data-theme` |
| 14 component CSS files (Phase 1) | Migrate `prefers-color-scheme` to `data-theme` |
| ~30 component CSS files (Phases 3–4) | Add new `[data-theme="dark"]` rules |
| `index.html` | Add blocking script to set `data-theme` before first paint (no FOUC) |

### Test coverage

- Integration test for `ThemeContext`: verify toggle switches `data-theme` attribute, persists to `localStorage`, and defaults to OS preference when no stored value.
- Verify `useTheme` hook returns correct values in both modes.
- Verify `objectTypeTheme` returns correct palette for each theme.
- Existing visual regression tests (if any) should be run in both themes.

---

## Total Effort Estimate

| Phase | Effort |
|-------|--------|
| Phase 0 — Foundation | 0.5 day |
| Phase 1 — Migrate existing dark CSS | 0.5 day |
| Phase 2 — Core shell and layout | 1–1.5 days |
| Phase 3 — Panels and editors | 1–1.5 days |
| Phase 4 — Modals and secondary UI | 1 day |
| Phase 5 — JS colours and MUI | 0.5–1 day |
| Phase 6 — Polish | 0.5 day |
| **Total** | **4.5–6.5 days** |

Phases 0–2 deliver a usable dark mode for the main shell. Phases 3–6 are progressive completeness that can be done incrementally without blocking other work.

---

## Design Decisions

1. **`data-theme` attribute over CSS class** — attribute selectors are idiomatic for theme switching and avoid class-name collisions.
2. **CSS variables over Tailwind migration** — the codebase uses plain CSS; introducing Tailwind would be a larger change with no clear benefit for this feature alone.
3. **User preference overrides OS preference** — once the user clicks the toggle, their choice is stored and honoured. Clearing `localStorage` reverts to OS preference.
4. **No "auto" third option initially** — keep it simple with a binary toggle. If users want to follow OS preference, they can clear their stored preference (or we add a third option later).
5. **Blocking script in index.html** — prevents flash of light theme when the user has selected dark mode, without waiting for React to hydrate.
