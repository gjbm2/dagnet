# TODO

## Nasty glitches
- what-if funky and fussy (render path...)

## Current query DSL
- whatifdsl is becoming (gradually) a more powerful general statement of the current query applied to the graph.
  - in current: some of this (e.g. window, contexts in due course) determins what data is retrieved in the first place; other parts (whatifs) determine what overlay is applied to that data before render
- ideally we would build a single dsl string to express all of this, such that the top control set (context/window/whatif) interact with that dsl string, but it is the string that controls the graph.
- is our dsl expessive enough already? we need:
    case(<case_id>:<variant).visited(noda).excludes(nodeb).visitedAny(nodec,noded).context(<context_id>:<context_value>).window(<fromdate>:<todate>)
- once we have ensured it is adequately expressive, we can expose the 'current query string' to the user inside the window control [we may later hide, but is useful for debugging purposes]
- This query string is then also a natural candidate for what to use to populate the name of newly created scenarios, poss. along with timestamp.
- If user creates a DIFF scenario rather than an ALL scenario, we can also subtract this query FROM what is otherwise shown (compositing layer 2 and below) to construct a helpful Human Readable name
- e.g. if we had (compositing from layer 2 and down) window(1-Jan-25:1-Jan-25) and user then added window(1-Jan-25:1-Jan-25).case(experiment:treament), then when they created a diff snapshot, it would calculate window(1-Jan-25:1-Jan-25).case(experiment:treament)-window(1-Jan-25:1-Jan-25)=case(experiment:treament) (noting we need a service for this query subtraction & addition logic, not to do it inline in the scenario editor) and write "case(experiment:treament) @ 9:24am, 13-Nov-25"  as the scenario name
- crucially, this would allow dynamic layers / scenarios (useful for saved charts/reports)

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

## Major components
- Context support
- Declarartive Analytics Module
- Latency/lag management
- Dashboarding views
- Bayesian modelling (...is expected?)
- Asynch / api updates
- Cyclic graphs

- download CSV built from selected funnel (or generate Google spreadsheet?)
- node renaming, file renaming -- need to handle globally
- systematically review that DELETE graph changes  go through UpdateManager


### Analytics / Model Fitting (Future)
- add moving arrow effect, speed of animation scale on log lag

### Medium Priority
- Events that can fire several times we may need to build Amplitude funnels further one step further upstream in order to ensure we know that it's this specific event we care about 
- Add UI schemas for common forms (params, cases, etc.)
- Zap drop down menu:
  - 'Connection settings' on zap drop down menu isn't working
  - Sync status' on zap drop down should show last sync, source, etc. from files/graph
- Edit: copy & paste
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
- bead labels aren't updating when values change e.g. on data retrieval, revbalances, etc. 
- make 'overridden' icons brighter
- add icons to collapsed beads?
- playing with edges resets edge_id! 
- clicking beads -- make hotspot larger
- whatif layer: prob needs is own layer in the palette really for clarity...
- auto-reroute still stubborn
- let's change the paramster keycolour to pink and nodes from blue to...something else that isn't orange or bright blue...cyan? That will help oragne and blue for dirty/open.
- flickering when moving nodes (chevrons render a frame later)
- 'show travel' chevrons along edges moving at log lag speed
- put outbound probs. left aligned in edge; arriving prob mix. right aligned in edge
- main app tabs are showing maximise button even when they're maximised, it seems
- maxmised tabs are appearing on top (zorder) of navigator button (incorrect)
- maximised tabs in main app are not reflecting padding
- somewhere along the line we lose animations on edge width changes, which is sad
- Sankey mode and normal view use diff code paths for mass infernece; hence sankey requires start node to work -- weird glitch