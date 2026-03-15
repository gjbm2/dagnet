# CFP Toolbar — Presentation Spec

## Problem statement

The chart/analysis toolbar has grown organically. Different sections use different patterns with no clear rules governing when to use which. The result: some groups have labels, some don't; some use inline pills, some use popovers, some use bespoke components; colour picking uses a different component in every context. This document defines the standard.

---

## 1. Standard UI element vocabulary

Every element in the toolbar MUST be one of these. No exceptions.

### 1.1 `cfp-pill` — atomic button

Small rounded button. Can contain an icon, text, or both. Has three visual states:

| State | Class | Appearance |
|---|---|---|
| Default | `cfp-pill` | Transparent bg, muted text, thin border |
| Hover | `:hover` | Subtle background fill |
| Active/selected | `cfp-pill.active` | Solid background, bold text, stronger border |
| Danger | `cfp-pill--danger` | Red text |

Can be tinted via `style={{ color }}` to reflect a semantic colour (e.g. overlay connector colour).

### 1.2 `cfp-pill-group` — visual grouping

Wraps related pills with a subtle background and tight gap. Contains:
1. A `cfp-group-label` (the group's name) — **shown by default**. May be hidden when the group's meaning is immediately obvious from its icon/context (e.g. "..." more-actions menu, analysis type selector). When toolbar space is tight, obvious labels hide first.
2. One or more `cfp-pill` buttons, `CfpPopover` triggers, or a `ModeTrack`

### 1.3 `cfp-group-label` — group title

Small muted text label. First child of every `cfp-pill-group`. Examples: "View", "Chart", "Display", "Overlay".

### 1.4 `CfpPopover` — hover-reveal dropdown

A `cfp-pill` trigger that reveals a dropdown on hover. The dropdown is portalled to `<body>` and positioned relative to the trigger. Props:

- `icon` — icon node shown in the pill trigger
- `label` — optional text shown next to icon in the pill
- `title` — tooltip
- `active` — whether pill shows active state
- `activeColour` — tints the pill icon/text
- `onClick` — click handler on the pill (separate from hover-open)
- `trigger` — replaces the default pill with a custom element (used by ModeTrack)
- `children` — dropdown content

### 1.5 `cfp-menu-item` — dropdown button

Button inside a `CfpPopover` dropdown. Full-width, left-aligned text. States: default, hover, `active`, `--danger`. Can contain icons and `cfp-menu-swatch` dots.

### 1.6 `cfp-menu-swatch` — colour dot in menu

10px coloured circle, used inline within a `cfp-menu-item` to show a colour next to a label. Reusable anywhere a colour needs to be shown in a menu context.

### 1.7 `cfp-sep` — separator

1px vertical line dividing major toolbar sections.

### 1.8 `cfp-select` — native dropdown

Standard `<select>` element for cases with many options (analysis types, subjects).

### 1.9 `ModeTrack` — tristate mode indicator

Custom component (90px fixed width) showing Live/Custom/Fixed as a shift-stick with dots and pills. Used as `CfpPopover.trigger` — fits visually within a `cfp-pill-group` at the same height as pills.

### 1.10 `cfp-toggle` — labelled on/off switch

Toggle switch with track, thumb, and label. Used inside popovers for display settings (e.g. "Show legend", "Cumulative").

---

## 2. Presentation rules

### 2.1 Every group of related controls MUST be in a `cfp-pill-group`

If controls are related, they are grouped. Groups have a label by default. Labels may be omitted when the group's purpose is unambiguous from context alone (e.g. a single "..." icon for more actions). When space is limited, labels on self-explanatory groups drop first; labels on ambiguous groups (Overlay, Display, Mode) stay.

### 2.2 Wide vs narrow — responsive collapsing

Some groups have two renderings:
- **Wide toolbar**: `cfp-pill-group` with inline `cfp-pill` buttons
- **Narrow toolbar**: `CfpPopover` with `cfp-menu-item` buttons in dropdown

The `wideToolbar` boolean controls this. Both renderings use the same data, just different containers.

### 2.3 Separators mark major section boundaries

`cfp-sep` goes between unrelated groups: analysis type | view+chart | display+connectors | actions.

### 2.4 Colour picking pattern

Wherever a colour can be changed in the toolbar:
- The trigger element is tinted with the current colour (via `style={{ color }}` or `activeColour` prop)
- The dropdown contains `cfp-menu-item` buttons, each with a `cfp-menu-swatch` + label
- The last item is "Custom..." which triggers a hidden `<input type="color">`
- The current colour's menu item has class `active`
- The colour value persists visually regardless of whether the feature is on/off

---

## 3. Toolbar sections — definitive layout

Left to right:

### 3.1 Analysis type (conditional)
- `cfp-select` native dropdown
- Shown when `showAnalysisTypeDropdown`

### 3.2 Separator (conditional)
- `cfp-sep` — only if analysis type or later groups visible

### 3.3 View mode (conditional)
- Shown when multiple view modes available
- `cfp-pill-group`:
  - `cfp-group-label`: "View"
  - `cfp-pill` per mode (icon only), `active` on current

### 3.4 Chart kind (conditional)
- Shown when `showChooser`
- **Wide**: `cfp-pill-group`: label "Chart" + text `cfp-pill` per kind, `active` on current
- **Narrow**: `CfpPopover` (BarChart3 icon + chevron, label = current kind) → `cfp-menu-item` per kind

### 3.5 Subject selector (conditional)
- `cfp-select` native dropdown
- Shown when multiple subjects

### 3.6 Separator
- `cfp-sep` — always present

### 3.7 Display settings (conditional)
- Shown when `toolbarSettings.length > 0`
- **Wide**: inline `cfp-toggle` switches via `renderTraySettings`
- **Narrow**: `CfpPopover` (Sliders icon, label "Display") → same toggles inside

### 3.8 Overlay connectors (conditional)
- Shown when `props.onOverlayToggle`
- `cfp-pill-group`:
  - `cfp-group-label`: "Overlay"
  - **Toggle pill**: `cfp-pill` (+`active` when on), Crosshair icon, `style={{ color: overlayColour }}` always. Click toggles on/off.
  - **Colour popover**: `CfpPopover`, trigger icon = `cfp-menu-swatch` in current colour. Dropdown:
    - `cfp-menu-item` per preset colour (swatch + name), `active` on current
    - `cfp-menu-item` "Custom..." → triggers hidden `<input type="color">`

### 3.9 Scenarios / Mode (conditional)
- Shown when `props.onModeCycle` or scenario layers exist
- `cfp-pill-group`:
  - `cfp-group-label`: "Mode" (when ModeTrack shown) or "Scenarios" (when only layers)
  - `CfpPopover` with `trigger={<ModeTrack>}` (when `onModeCycle`), or standard Layers icon pill (when no mode cycle)
  - Dropdown: ScenarioLayerList + "Add scenario" button

**Note**: Sections 3.8 and 3.9 are separate `cfp-pill-group`s, not merged. They are conceptually distinct: overlay connectors vs analysis mode/scenarios.

### 3.10 DSL badge (conditional, canvas only)
- `CfpPopover` (Code icon, `sticky` mode) → `QueryExpressionEditor` component for in-place DSL editing
- Popover uses `sticky` prop: clicking inside pins it open (closes on outside click or Escape), so the Monaco editor remains usable
- Falls back to `<pre>` display when `graph` / `onDslChange` props are not provided
- Uses `popoverClassName="cfp-popover--dsl"` for wider min-width (340px)
- Standalone (not in a pill-group) — it's a single informational/action pill
- No label needed — Code icon is universally understood

### 3.11 More actions
- `CfpPopover` (MoreHorizontal icon) → `cfp-menu-item` buttons:
  - Refresh, Open as Tab, Download CSV, Dump Debug JSON
  - Delete (`cfp-menu-item--danger`)
- Standalone (not in a pill-group) — it's a single action menu
- No label needed — "..." is universally understood

---

## 4. CSS classes to clean up

The following classes exist in `components-dark.css` but are unused or should be removed:

| Class | Line | Status |
|---|---|---|
| `.cfp-popover__colour-row` | 1944 | Orphaned — was a failed experiment. Remove. |
| `.cfp-popover__colour-dot` | 1947 | Orphaned — same. Remove. |
| `.cfp-colour-swatch` | 1581 | Check if still used anywhere. |
| `.cfp-colour-swatch--none` | 1595 | Check if still used anywhere. |

---

## 5. Components to NOT use in toolbar

| Component | Why not |
|---|---|
| `ColourSelector` (compact mode) | Renders its own swatch + portal popup — bespoke UI that doesn't match cfp-pill sizing or CfpPopover pattern |
| Raw `<div>` with inline styles | Everything must use cfp-* classes |
| Any new one-off CSS class | Use existing vocabulary above |
