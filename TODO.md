# TODO

## Scenarios polishing & bugs
- check conversion graph...scenarios are fucked on it...
- confidence bands have gone over-wide...
- test conditional ps.
- "What if" not working with layers
- Reordering scenarios isn't working. are we maintaining a separte tab context state for the order of scenarios (which should be used when compositing on that tab)?
- we are also doing something weird with selected edges and highlighted now --
  - we used to be sharing the edges in a thoughtful way whe nthey were selected or highlighted, but that has broken compeltely.  we need to repair that properly. 
  - selected edge LABELS are showing black text on a black label background, which ain't great...
- colours are funky & not quite right... maybe just let user choose them?
-Let's simplify & move snapshot controls:
  - move so shown under 'Current' at all times
  - remove 'No scenarios yet' text -- it becomes obvious where the new snapshot appears now
  - Let's show inline controls:
	  + New Scenario [opens submenu...]
  		Snapshot everything
		  Snapshot differences
		  Blank
	  Flatten all
  - Sequence of buttons within a scenario:
      Left aligned:
        [Grab handle] [swatch] Scenario name["…" if doesn't fit]
      Right aligned: 
        [delete icon] [edit modal icon] [visibility toggle]
  - an empty placeholder for swatch should be shown if none (because layer not visible)
  - an empty area same size as grab handle should be shown if none (for current and base)
  - remove the pen icon (to edit name), instead allow user to click name to edit; while editing show a tick [commit change] and a cross [cancel change] icon on right hand side; hide all other icons.
  - Let's rename (for user purposes) 'Base' layer to 'Original' and 'Current' to 'Live'
- Let's add a right-click context menu to layers which shows three additional controls:
  - 'Use as current' -- copies the layer in question to current, overwriting current and resetting any whatifs in place
  - [if another layer is visible] 'Merge down'-- applies this layer to the next visible layer down in the stack
  - 'Show only' -- hides all other layers but this one
- Confidence interval rendering has been broken under scenarios

# TODO

## Critical Issues

### Form Field Duplicate ID Warnings

**Issue:** Multiple form editors (parameters, events, etc.) open in different tabs generate identical DOM element IDs, causing browser warnings about duplicate IDs. This is a violation of HTML spec where IDs must be unique across the entire document.

**Affected Components:** 
- Parameter editor forms
- Event editor forms  
- Any other forms using `react-jsonschema-form`

**Root Cause:** `react-jsonschema-form` generates field IDs based solely on the schema field names (e.g., `root_id`, `root_name`, etc.) without any instance-specific prefix. When multiple forms with the same schema are rendered simultaneously (in different tabs), they produce duplicate IDs.

**Severity:** HIGH - While functionally working currently, this could cause:
- Screen reader/accessibility issues
- Form validation problems
- JavaScript errors when trying to target elements by ID
- Potential data corruption if form libraries cache by ID

**Proposed Solution:** Add unique tab-specific prefixes to all form field IDs. Options:
1. Fork/extend `react-jsonschema-form` to accept an ID prefix prop
2. Use schema transformations to add prefixes dynamically
3. Ensure only one form instance per schema is mounted at a time (hide instead of unmount inactive tabs)

**Priority:** Should be fixed before production release




## Data project
**Case/Variant Filtering** (4-6 hrs)
 - Design case property mapping schema (Statsig case → Amplitude event property)
 - Extend event definitions with case_property_mappings
 - Implement case filter injection in pre_request script
 - Test variant filtering (treatment vs control)

## Major components
- Scenario viewer polishing
- Edge ids not updating/persisting
- Context support
- Latency/lag management
- Dashboarding views
- Bayesian modelling (...is expected?)
- Asynch / api updates

- download CSV built from selected funnel (or generate Google spreadsheet?)
- node renaming, file renaming -- need to handle globally
- systematically review that DELETE graph changes  go through UpdateManager


### Analytics / Model Fitting (Future)
- add moving arrow effect, speed of animation scale on log lag

### Medium Priority
- fix tools panel view options (Again)
- Graph integrity checker report
- Minus autocomplete not working in query/selector
- Let's add a bool 'Force retrieve' to 'Get all data' modal, which ignores current values check and gets a new slab of dailies anyway. 
  - Also add a 'Force updates' which ignores 'overridden' flags and 
- Let's add a rename on File menu, nav bar context menu which (a) renames the file (b) reviews registry and updates any ids in any graphs/files to match
- Polish "Get from Source" UX (success feedback, animations -- apply to graph elements as well as sidebar)
- docs to cover: MSMDC, connections
- **FormEditor UI Schemas (Class-Specific Layouts)**
  - Context: FormEditor auto-generates forms from JSON schemas, but layout isn't always optimal
  - Current: Have class-specific overrides for credentials
  - Need: UI schemas for other object classes (parameters, cases, graphs, connections)
  - UI schema specifies: field order, grouping, descriptions, widgets, conditional visibility
  - Example: Parameter FormEditor should group related fields, show better labels, use appropriate widgets
  - Pattern: `ui-schemas/parameter-ui-schema.json`, `ui-schemas/case-ui-schema.json`, etc.
  - Benefit: Better UX without changing underlying data schemas
- Edit > Undo broken; add Undo to right click context menus on graph (standardise context menu implmenetations)
- generalise props panel implementation
- Date windows in viewer
- Selected objects show query/selector string
- copy / paste param packs
- 'view param packs)
- GIT_BATCH_OPERATIONS_MD
- Turn 'Path analysis' into a proper rc floating dock at the bottom left, but movebale (and re-dockable)
- Allow snapshotted 'delta analysis' views within what if panel; show colour-coded overlayed edges
- **Per-Tab Data Overlays (WhatIf Extension)**
  - Context: Current design has window/context at GRAPH level (synced across all tabs)
  - This prevents viewing same graph with different contexts side-by-side
  - Future: Extend WhatIf overlay system to support per-tab data fetch contexts
  - Would allow: Tab 1 shows "Mobile users", Tab 2 shows "Desktop users" for same graph
  - Requires: Overlay state management separate from base graph
  - See: `PROJECT_CONNECT/CURRENT/EXTERNAL_DATA_SYSTEM_DESIGN.md` section 4.1
- **Drag & Drop from Navigator to Graph** - See [DRAG_DROP_PROPOSAL.md](./DRAG_DROP_PROPOSAL.md) for full spec
  - Drag nodes/cases/parameters from navigator and drop on canvas to create/connect
  - Estimated: 36-48 hours full implementation, 28-38 hours MVP
- Nodal levels in the editor (some nodes are 'tall') & Sankey L-R mode with dyanmic node sizes
- auto-re-route doesn't start automatically (needs kicking)
- Post-its (and sort object selection properly)
  - Let's add a new graph object type, 'post-it'
  - These should be rendered with a missing top right corner
  - They should be resizeable. 
  - They should render atop nodes, labels, etc.
  - Should be possible to edit text within them, ideally in-line
  - Create is right click > context > Add post-it
  OR
  - Object > Add post-in (under node)
  - both should have same code path for creation
  - Context menu on post-in should have 'delete' and colour picker (selection of 6x standard pastels)
  - Drag to move
  - We should extend graph schema to accommodate.
  - These are not data objects -- only displayed not used for calculation, of course

### Low Priority
- let's change the paramster keycolour to pink and nodes from blue to...something else that isn't orange or bright blue...cyan? That will help oragne and blue for dirty/open.
- flickering when moving nodes (chevrons render a frame later)
- 'show travel' chevrons along edges moving at log lag speed
- put outbound probs. left aligned in edge; arriving prob mix. right aligned in edge
- main app tabs are showing maximise button even when they're maximised, it seems
- maxmised tabs are appearing on top (zorder) of navigator button (incorrect)
- maximised tabs in main app are not reflecting padding
- somewhere along the line we lose animations on edge width changes, which is sad
