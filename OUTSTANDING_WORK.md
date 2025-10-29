# Outstanding Work - Dagnet Project

## Status: October 29, 2025

This document tracks major incomplete workstreams and features that need implementation.

---

## 1. Nodes Registry System (Partially Complete)

**Status**: Foundation designed, implementation incomplete  
**Related Docs**: `NODES_REGISTRY_DESIGN.md`, `REGISTRY_SYNC.md`

### ✅ Completed
- Cost schema migration to flat `cost_gbp`/`cost_time` structure
- Parameter registry conceptual design
- Registry sync strategy defined

### ❌ Not Yet Started

#### 1.1 Registry Schemas & Files
- [ ] Create `public/param-schemas/node-schema.yaml`
- [ ] Create `public/param-schemas/nodes-index-schema.yaml`
- [ ] Add `param-registry/test/nodes-index.yaml` with examples
- [ ] Add example `param-registry/test/nodes/*.yaml` files

#### 1.2 Registry Service (Nodes)
- [ ] Implement `loadNodesIndex()` in `paramRegistryService`
- [ ] Implement `loadNode(id)` method
- [ ] Add generic `loadIndex(type)` method
- [ ] Add generic `loadItem(type, id)` method
- [ ] Add validation helpers: `isValidId`, `searchRegistry`
- [ ] Add usage tracking: `updateUsageCount('node', id, graphId)`
- [ ] Implement in-memory caching layer for indexes

#### 1.3 Navigator Integration (Nodes)
- [ ] Surface `state.registryIndexes.nodes` in navigator UI lists
- [ ] Show planned-without-file nodes with usage counts
- [ ] Add right-click: "Create file from registry ID" action

#### 1.4 NewFileModal Enhancements
- [ ] Implement two-mode UI (scratch vs. select-from-registry)
- [ ] Add search/sort functionality for registry entries
- [ ] Display usage counts and status badges
- [ ] Add validation warnings for similar IDs

#### 1.5 ParameterSelector Component
- [ ] Create generic `ParameterSelector.tsx` component
- [ ] Combobox/autocomplete with dropdown
- [ ] Visual indicators (has file, local, planned)
- [ ] Integration with enhanced `NewFileModal`

#### 1.6 PropertiesPanel Integration
- [ ] Replace text inputs with `ParameterSelector`:
  - `edge.p.parameter_id` → parameter selector
  - `edge.conditional_p[].p.parameter_id` → parameter selector
  - `node.case.id` → case selector
  - (Optional) `node.id` → node selector for validation

#### 1.7 Registry Sync on Save/Commit
- [ ] Auto-detect new IDs referenced in graphs
- [ ] Add to index as `planned` status
- [ ] Increment `usage_count` when saving graphs
- [ ] Prompt user to update index on commit

#### 1.8 Cross-Graph Features
- [ ] Query: "Which graphs use node X?"
- [ ] Usage dashboards for nodes
- [ ] Analytics surfaces for node usage and status

#### 1.9 Types & Documentation
- [ ] Add `NodesIndex` and `NodeDefinition` to `src/types`
- [ ] Document new service APIs
- [ ] Add registry data shapes to `src/docs`

#### 1.10 Testing
- [ ] Unit tests for registry service (nodes)
- [ ] Navigator integration tests
- [ ] Selector component tests

---

## 2. File Sync Issues

**Priority**: HIGH  
**Issue**: Locally opened files don't always sync properly into graph

### Investigation Needed
- [ ] Identify sync failure scenarios (when does it happen?)
- [ ] Review `toFlow`/`fromFlow` conversion logic
- [ ] Check `NavigatorContext` local items tracking
- [ ] Verify graph store update triggers

### Fix Tasks
- [ ] Add debug logging for file sync operations
- [ ] Ensure ReactFlow edges/nodes update when files change
- [ ] Fix timing issues in sync pipeline
- [ ] Add error handling for sync failures
- [ ] Add user feedback when sync fails

---

## 3. Conditional Probability Handling Enhancement

**Priority**: MEDIUM  
**Current State**: Basic conditional probability works, but incomplete parameter linking

### Required Enhancements
- [ ] **Tie node_id to conditional_p**: Each `conditional_p` entry needs `parameter_id` field
- [ ] Update schema: 
  ```yaml
  conditional_p:
    - condition:
        visited: [node-a, node-b]
      p:
        mean: 0.8
        parameter_id: "conversion-given-node-a-b"  # NEW
  ```
- [ ] Update UI: Add parameter selector for each conditional probability
- [ ] Update validation: Check parameter_id exists in registry
- [ ] Update analytics: Use parameter values when available
- [ ] Add tooltip showing parameter details on hover

---

## 4. Case Handling Enhancement

**Priority**: MEDIUM  
**Current State**: Case nodes work, but need registry + parameter integration

### Required Enhancements
- [ ] **Tie cases to nodes**: Link `node.case.id` to case registry
- [ ] **Tie cases to parameters**: Case variant weights could reference parameters
- [ ] Update schema:
  ```yaml
  case:
    id: homepage-variant-test
    variants:
      - name: control
        weight: 0.6
        weight_parameter_id: "homepage-control-weight"  # NEW
      - name: variant-a
        weight: 0.4
        weight_parameter_id: "homepage-variant-a-weight"  # NEW
  ```
- [ ] Add case registry integration to navigator
- [ ] Add case selector to node properties panel
- [ ] Update what-if analysis to respect parameter-driven weights
- [ ] Add validation for case registry entries

---

## 5. Parameter Updates - Data Menu Integration

**Priority**: HIGH  
**Feature**: Fetch latest real values from parameters and update graph

### New Data Menu Items
- [ ] **Data > Refresh Parameters**
  - Fetches latest values from all linked parameters
  - Updates `edge.p.mean`, `edge.cost_gbp.mean`, `edge.cost_time.mean`
  - Shows diff before applying
  - Batch update confirmation dialog

- [ ] **Data > Parameter Status**
  - Shows which edges have parameter links
  - Shows which parameters are stale (last_updated old)
  - Highlights parameters with no data source

- [ ] **Data > Validate Parameters**
  - Checks all parameter_ids exist in registry
  - Checks all parameters have valid values
  - Reports broken links

### Implementation Tasks
- [ ] Add `DataMenu` component (new top-level menu)
- [ ] Create `ParameterRefreshService`:
  - `fetchLatestValues(paramIds: string[]): Promise<ParamValues>`
  - `applyParameterUpdates(graph, updates): Graph`
  - `showDiffDialog(before, after): boolean`
- [ ] Add "Last refreshed" timestamp to graph metadata
- [ ] Add manual refresh button to parameter selector
- [ ] Show staleness indicator in properties panel

---

## 6. Google Sheets Connection Logic

**Priority**: HIGH  
**Feature**: Retrieve parameter values from Google Sheets

### Architecture
```
Graph → Parameter ID → Registry Entry → Data Source Config → Sheets Client
```

### Implementation Tasks

#### 6.1 Data Source Configuration
- [ ] Add `data_sources` to parameter schema:
  ```yaml
  data_sources:
    - type: google_sheets
      spreadsheet_id: "1abc123..."
      sheet_name: "Parameters"
      cell_range: "B2"
      value_column: "current_value"
      last_updated_column: "last_updated"
  ```

#### 6.2 Sheets Client Enhancement
- [ ] Extend `sheetsClient.ts` with:
  - `fetchParameterValue(source: DataSource): Promise<number>`
  - `fetchMultipleParameters(sources: DataSource[]): Promise<ParamValues>`
  - `validateSheetAccess(spreadsheetId): Promise<boolean>`
- [ ] Add batching for multiple parameter fetches
- [ ] Add caching with TTL
- [ ] Add error handling for missing sheets/cells

#### 6.3 UI Integration
- [ ] Add "Test Connection" button in parameter editor
- [ ] Show last fetch timestamp
- [ ] Add "Fetch Now" button for single parameter
- [ ] Bulk fetch via Data menu

#### 6.4 Future: Statsig Integration (Cases)
- [ ] Add `data_sources.type: statsig` for case weights
- [ ] Implement webhook receiver for experiment updates
- [ ] Auto-refresh case weights when webhook fires

---

## 7. Context Variables System

**Priority**: MEDIUM  
**Feature**: Add context dimensions and context-setting nodes

### 7.1 Context Variables in Graph

#### Schema Addition
```yaml
# In graph file
contexts:
  - id: user-segment
    type: categorical
    values: ["new", "returning", "power-user"]
    default: "new"
  
  - id: time-window
    type: temporal
    values: ["2024-Q1", "2024-Q2", "2024-Q3"]
    default: "2024-Q1"

# Nodes can reference context
nodes:
  - id: homepage
    # ... existing fields ...
    context_values:
      user-segment: "new"  # Override for this path
```

#### Implementation
- [ ] Add `contexts` array to graph schema
- [ ] Add `context_values` to node schema
- [ ] Update validation to check context references
- [ ] Add context selector to graph properties panel
- [ ] Integrate with parameter `values[]` array (window matching)

### 7.2 "Set Context" Node Type

#### New Node Type
```yaml
# Set-context node
type: set-context
context_assignments:
  - context_id: user-segment
    value: "returning"
  - context_id: time-window
    value_from_parameter: "current-quarter"
```

#### Implementation
- [ ] Add `set-context` node type to schema
- [ ] Create SetContextNode component
- [ ] Add context assignment UI in properties panel
- [ ] Update path analysis to track context changes
- [ ] Update runner to propagate context through graph

### 7.3 Context Trees (Sub-graphs)

#### Feature
- Sub-graph view showing all paths through different context values
- Example: "User Segment" tree shows 3 parallel graphs for new/returning/power-user

#### Implementation
- [ ] Design context tree visualization
- [ ] Add "View Context Tree" button to graph editor
- [ ] Implement sub-graph extraction logic
- [ ] Render multiple graph instances with context filtering
- [ ] Add comparison metrics across contexts

---

## 8. UI/UX Refactor - Sidebar Redesign

**Priority**: HIGH  
**Issue**: Current sidebar too confusing, takes up too much space  
**Reference**: Lightroom's right-hand palette (collapsible sections, compact)

### Current Problems
- What-If Analysis takes up permanent space
- Properties panel can get very long
- No clear visual hierarchy
- Hard to find specific controls
- Doesn't adapt to workflow

### Proposed Solution: Collapsible Panel System

```
┌─────────────────────────────────────┐
│ Graph Canvas                        │
│                                     │
│                                     │ ┌──────────────────┐
│                                     │ │ PROPERTIES    ▼ │
│                                     │ ├──────────────────┤
│                                     │ │ Node: Homepage   │
│                                     │ │ • Type: Entry    │
│                                     │ │ • Slug: ...      │
│                                     │ └──────────────────┘
│                                     │ ┌──────────────────┐
│                                     │ │ PARAMETERS    ▼ │
│                                     │ ├──────────────────┤
│                                     │ │ • Edge: 0.45     │
│                                     │ │   ⛓ linked       │
│                                     │ │ • Cost: £125     │
│                                     │ └──────────────────┘
│                                     │ ┌──────────────────┐
│                                     │ │ VALIDATION    ▶ │
│                                     │ └──────────────────┘
└─────────────────────────────────────┘
```

### Implementation Tasks

#### 8.1 Remove What-If from Sidebar
- [ ] Move What-If to **Data** menu (primary location)
- [ ] Add What-If dropdown in top-right of graph canvas (quick access)
- [ ] Remove `WhatIfAnalysisControl` from sidebar
- [ ] Free up 200-300px of vertical space

#### 8.2 Collapsible Panel System
- [ ] Create `CollapsiblePanel` component:
  ```tsx
  <CollapsiblePanel title="Properties" defaultOpen={true}>
    {/* content */}
  </CollapsiblePanel>
  ```
- [ ] Implement smooth expand/collapse animation
- [ ] Add chevron indicators (▼ open, ▶ closed)
- [ ] Persist panel states in localStorage
- [ ] Add "Collapse All" / "Expand All" buttons

#### 8.3 Reorganize Sidebar Content
- [ ] **Top Section**: Selected item properties (node/edge)
- [ ] **Middle Section**: Parameters & Values (collapsible)
- [ ] **Bottom Section**: Validation & Warnings (collapsible)
- [ ] Move analysis results to modal or separate tab

#### 8.4 Alternative: Floating rc-dock Sidebar
- [ ] Investigate `rc-dock` library
- [ ] Prototype floating/dockable sidebar
- [ ] Add drag-to-reposition
- [ ] Add minimize to edge
- [ ] User testing

---

## 9. What-If Analysis Reorganization

**Priority**: MEDIUM  
**Goal**: Move What-If out of sidebar, make more accessible

### 9.1 Data Menu Integration
- [ ] Add **Data > What-If Analysis** menu item
- [ ] Opens modal/panel with what-if controls
- [ ] Shows list of active scenarios
- [ ] Quick scenario switching

### 9.2 Top-Right Dropdown (Optional)
- [ ] Add dropdown next to user/settings icons:
  ```
  [Scenarios ▼]
    • Base Case (active)
    • Scenario 1: Optimistic
    • Scenario 2: Pessimistic
    • + New Scenario...
  ```
- [ ] Quick scenario switching without menu
- [ ] Shows current scenario name on graph
- [ ] Minimal space usage

### 9.3 Scenario Management
- [ ] Save named scenarios (in graph metadata)
- [ ] Export/import scenarios
- [ ] Scenario comparison view
- [ ] Highlight differences between scenarios

---

## 10. Additional Smaller Tasks

### Parameter Type Validation
- [ ] Add strict parameter type checking (probability vs cost_gbp vs cost_time)
- [ ] Show warning if wrong parameter type selected
- [ ] Filter parameter selector by compatible types

### Edge Label Improvements
- [ ] Show parameter name (not just ID) on hover
- [ ] Add "linked" indicator (⛓️) on edge labels
- [ ] Show staleness indicator if parameter outdated

### Keyboard Shortcuts
- [ ] Add shortcuts for common operations:
  - `P` - Open parameter selector
  - `W` - Toggle what-if panel
  - `R` - Refresh parameters
  - `Ctrl+/` - Show all shortcuts

### Error Boundaries
- [ ] Add error boundaries around major components
- [ ] Graceful degradation on registry load failure
- [ ] User-friendly error messages

---

## Implementation Priority Ranking

### P0 - Critical (Ship Blocker)
1. **File sync issues** - Core functionality broken
2. **Parameter refresh from Sheets** - Key workflow
3. **Sidebar redesign** - UX is confusing users

### P1 - Important (Next Sprint)
4. **What-If to Data menu** - Free up sidebar space
5. **ParameterSelector component** - Reduces errors
6. **Conditional_p parameter linking** - Complete feature

### P2 - Nice to Have (Future)
7. **Context variables** - Advanced feature
8. **Context trees** - Advanced visualization
9. **Case registry integration** - Polish
10. **Floating sidebar (rc-dock)** - Experimental

### P3 - Polish (When Time Permits)
11. **Cross-graph analytics** - Power user feature
12. **Statsig integration** - External dependency
13. **Keyboard shortcuts** - Quality of life

---

## Dependencies & Blockers

### Technical Dependencies
- **ParameterSelector** depends on **Registry Service (Nodes)** completion
- **Parameter refresh** depends on **Sheets connection logic**
- **Context system** depends on **Parameter values[] array** (already exists)

### Design Dependencies
- **Sidebar redesign** needs mockup approval before implementation
- **What-If reorganization** needs UX flow definition

### External Dependencies
- **Statsig integration** needs API access and webhook setup
- **Sheets connection** needs OAuth flow for production

---

## Next Actions

### This Week
1. Fix file sync issues (P0)
2. Create sidebar redesign mockup (P0)
3. Begin ParameterSelector component (P1)

### Next Week
1. Implement sidebar redesign (P0)
2. Add Data menu with What-If (P1)
3. Implement parameter refresh service (P0)

### This Month
1. Complete nodes registry system (P1)
2. Add context variables support (P2)
3. Implement conditional_p parameter linking (P1)

---

**Document Version**: 1.0  
**Last Updated**: October 29, 2025  
**Status**: Living document - update as priorities shift

