# Graph Editor Sidebar Redesign - Implementation Status

**Date**: 2025-10-30  
**Status**: Phase 4 In Progress (70% Complete)

## ✅ Completed Components

### Phase 1: Icon Bar Foundation (DONE)
- **`useSidebarState.ts`** - Per-tab state management hook
  - Tracks minimized/maximized mode
  - Active panel selection
  - Floating panels state
  - Smart auto-open tracking
  - Persists to `TabContext.editorState.sidebarState`

- **`SidebarIconBar.tsx + .css`** - 48px vertical icon bar
  - Three icons: What-If, Properties, Tools
  - Hover states and active indicators
  - Floating panel badges (orange dot)
  - Click to maximize, hover for preview

- **`SidebarHoverPreview.tsx + .css`** - Hover overlay system
  - 300px preview panel on hover
  - Renders actual panel content
  - Mouse enter/leave handling for stable interaction

- **Integration into `GraphEditor.tsx`**
  - Icon bar renders when `sidebarState.mode === 'minimized'`
  - Smart auto-open on first node/edge selection
  - State synchronization with old sidebar (for transition)

### Phase 2: rc-dock Panels (DONE)
- **`graphSidebarLayout.ts`** - Default layout configuration
  - Vertical dockbox with 3 tabs
  - Panel-to-tab-ID mapping
  - Ready for drag/float operations

- **`WhatIfPanel.tsx + .css`** - Wrapper for What-If Analysis
  - Integrates existing `WhatIfAnalysisControl`
  - Matches rc-dock panel structure

- **`PropertiesPanelWrapper.tsx + .css`** - Dynamic title wrapper
  - Shows "Graph Properties", "Node Properties", or "Edge Properties"
  - Passes through all props to actual `PropertiesPanel`

- **`ToolsPanel.tsx + .css`** - Canvas tools panel
  - Auto-layout button
  - Force reroute button
  - Mass generosity slider
  - Uniform scaling toggle
  - Hide/Show controls (stub)

- **rc-dock Integration in `GraphEditor.tsx`**
  - Renders when `sidebarState.mode === 'maximized'`
  - Dynamic layout injection with React components
  - Minimize button (circular, left edge)
  - 300px width panel

### Phase 3: Accordion Styling (DONE)
- **Enhanced `CollapsibleSection.tsx + .css`**
  - Smooth CSS transitions (0.3s ease)
  - Dynamic height measurement via `useRef`
  - Multiple sections can be open simultaneously
  - Icon and badge support
  - Hover states and clean styling

### Phase 4: Core Connection Components (IN PROGRESS)

#### ✅ **`EnhancedSelector.tsx + .css`** - Universal selector component
**Features:**
- **Type-specific pastel borders** (5px → 6px when connected)
  - Nodes: Light/dark blue (#DBEAFE → #93C5FD)
  - Parameters: Light/dark green (#D1FAE5 → #6EE7B7)
  - Cases: Light/dark pink (#FCE7F3 → #F9A8D4)
  - Contexts: Light/dark yellow (#FEF3C7 → #FDE68A)
- **Plug icon** (⚪ grey = disconnected, 🔌 black = connected)
- **Clear 'x' button** to reset selection
- **Sync menu '[⋮]' button** with dropdown:
  - ⬇ Pull from Registry
  - ⬆ Push to Registry
  - 🔄 Retrieve Latest
- **Grouped dropdown**:
  - "Current Graph" group (contextual)
  - "{Type} Registry" group
  - Sub-line for usage info
  - Badge indicators (local, planned, connected)
- **Inline creation**: "+ Create new {type}" button for non-existent IDs
- **Validation modes**: warning/strict/none (from `ValidationContext`)
- **Parameter type filtering**: `parameterType="probability|cost_gbp|cost_time"`

#### ✅ **`ColorSelector.tsx + .css`** - Color picker component
**Features:**
- 9 preset colors in 5-column grid
- Custom color button (HTML5 picker)
- Current color display with hex value
- Clean visual design

#### 🔄 **`PropertiesPanel.tsx`** - Integration started
**Completed:**
- Imported `EnhancedSelector` and `ColorSelector`
- Replaced node slug `ParameterSelector` with `EnhancedSelector`
  - Separated `onChange` (sets slug) from `onPullFromRegistry` (loads data)
  - Pull handler loads name, description, tags from registry
- Replaced edge probability `ParameterSelector` with `EnhancedSelector`
  - Separated `onChange` from `onPullFromRegistry`
  - Pull handler loads mean and stdev from parameter values

**Remaining:**
- Replace cost_gbp `ParameterSelector` (line ~1790)
- Replace cost_time `ParameterSelector` (line ~1970)
- Replace case node `ParameterSelector` (line ~927)
- Add `ColorSelector` for edge/node colors
- Reorganize sections with enhanced `CollapsibleSection`

## 🚧 Remaining Work

### Phase 4: Complete Integration (30% remaining)
1. **Finish ParameterSelector Replacements**
   - Cost GBP selector → EnhancedSelector
   - Cost Time selector → EnhancedSelector
   - Case parameter selector → EnhancedSelector

2. **Add ColorSelector Usage**
   - Node colors
   - Edge colors
   - Conditional probability colors

3. **Conditional Probabilities Editor** (Major component)
   - Chip-based node selection (AND logic within condition)
   - Parameter connection for each condition
   - Add/remove condition cards
   - Visual mockup from design doc Section 7.8
   - Inline editing (no modal)

4. **Reorganize Properties Panel Structure**
   - Wrap sections in enhanced `CollapsibleSection`
   - Per-tab persistence of accordion states
   - Follow design doc Section 7.5 field ordering

5. **Graph Properties Section**
   - Description textarea
   - Version input
   - Other metadata fields

### Phase 5: Polish & Bug Fixes
1. **Fix Known Issues**
   - Minimize button visibility/clarity
   - Floating panels not working (rc-dock wiring)
   - Tools menu needs View menu contents
   - Remove old sidebar entirely

2. **Keyboard Shortcuts** (Design doc Section 7.3)
   - `Ctrl/Cmd + B`: Toggle sidebar
   - `Ctrl/Cmd + Shift + W`: What-If panel
   - `Ctrl/Cmd + Shift + P`: Properties panel
   - `Ctrl/Cmd + Shift + T`: Tools panel

3. **Visual Polish**
   - Remove debug logging
   - Remove temporary styling
   - Consistent spacing/padding
   - Test all pastel border colors

4. **Testing**
   - Test all sync operations
   - Test per-tab state persistence
   - Test accordion animations
   - Test inline creation workflow
   - Test color selector

## 📁 New Files Created

### Hooks
- `/src/hooks/useSidebarState.ts` (175 lines)

### Components
- `/src/components/SidebarIconBar.tsx` (95 lines)
- `/src/components/SidebarIconBar.css` (93 lines)
- `/src/components/SidebarHoverPreview.tsx` (147 lines)
- `/src/components/SidebarHoverPreview.css` (148 lines)
- `/src/components/panels/WhatIfPanel.tsx`
- `/src/components/panels/WhatIfPanel.css`
- `/src/components/panels/PropertiesPanelWrapper.tsx`
- `/src/components/panels/PropertiesPanelWrapper.css`
- `/src/components/panels/ToolsPanel.tsx`
- `/src/components/panels/ToolsPanel.css`
- `/src/components/EnhancedSelector.tsx` (475 lines)
- `/src/components/EnhancedSelector.css` (323 lines)
- `/src/components/ColorSelector.tsx`
- `/src/components/ColorSelector.css`
- `/src/components/CollapsibleSection.css`

### Layouts
- `/src/layouts/graphSidebarLayout.ts`

### Modified Files
- `/src/components/editors/GraphEditor.tsx` (Major integration)
- `/src/components/CollapsibleSection.tsx` (Enhanced with animation)
- `/src/components/PropertiesPanel.tsx` (Partial integration)
- `/src/types/index.ts` (Added `sidebarState` to `TabState.editorState`)

## 🎯 Implementation Priorities

### Critical Path (To get functional)
1. **Conditional Probabilities Editor** - This is the most complex remaining piece
2. **Complete ParameterSelector replacements** - Quick wins
3. **Remove old sidebar** - Clean up technical debt

### Nice-to-Have (Can defer)
1. Keyboard shortcuts
2. Floating panel improvements
3. Visual polish
4. Advanced sync operations (Push to Registry, Retrieve Latest)

## 📊 Progress Metrics

- **Lines of Code Added**: ~1,500+
- **New Components**: 13
- **Design Doc Compliance**: ~70%
- **Estimated Time Remaining**: 2-3 days (Phase 4 completion + Phase 5 polish)

## 🔑 Key Technical Decisions

1. **EnhancedSelector replaces ParameterSelector entirely**
   - More features, better UX
   - Gradual migration approach
   - Old component can be deprecated after full migration

2. **Per-tab state persistence**
   - Sidebar state stored in `TabContext.editorState.sidebarState`
   - Each graph has independent sidebar configuration
   - Persists through page reloads

3. **rc-dock for panel management**
   - Native support for drag/float/dock
   - Minimal custom code needed
   - Familiar VS Code-like UX

4. **Pastel border visual language**
   - Type-specific colors improve scannability
   - Connection status (thick/thin border)
   - Consistent across all connection fields

5. **Sync menu integration**
   - No separate UI chrome
   - Discoverable via '[⋮]' icon
   - Extensible for future operations

## 🐛 Known Issues (Tracked)

1. Hover preview disappears when mouse enters (FIXED)
2. Blue debug border on icon bar (FIXED)
3. Minimize button not obvious enough
4. Floating panels don't return to icon bar on close
5. Tools panel needs View menu contents
6. Old sidebar conflicts with new (state sync added, full removal pending)

## 📖 Next Session Priorities

1. Build Conditional Probabilities chip editor
2. Replace remaining 3 ParameterSelectors
3. Add ColorSelector usage
4. Test end-to-end with actual graph

---

**Design Document**: `/GRAPH_EDITOR_SIDEBAR_REDESIGN.md` (2560 lines)  
**Implementation by**: Claude Sonnet 4.5  
**Last Updated**: 2025-10-30 15:45 UTC

