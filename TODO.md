# TODO

## What-If Compositing Centralization (REFACTOR)

**Problem:** What-If DSL compositing logic is duplicated across multiple files:
- `GraphCanvas.tsx` - 7+ direct calls to `computeEffectiveEdgeProbability`
- `buildScenarioRenderEdges.ts` - inline case variant logic
- `AnalyticsPanel.tsx` - builds graphs with What-If
- `CompositionService.ts` - `applyWhatIfToGraph` (partial implementation)

**Solution:** All What-If compositing should be centralized in `CompositionService`:
1. Create `getEffectiveEdgeProbability(layerId, edgeId, graph, params, whatIfDSL)` that:
   - For 'current': calls `computeEffectiveEdgeProbability` with whatIfDSL
   - For scenarios: uses composed params + case variant weights
   - Replaces the 3-way pattern that appears 4+ times in the codebase

2. Consolidate case variant weight application
3. Single source of truth for layer probability resolution

**Docs:** See `docs/current/refactor/GRAPH_CANVAS_ARCHITECTURE.md` for full analysis

## Project-latency

- Use Amplitude time data properly
- Convolve time onto p params
- Re-name cost_time as cost_labour & use accordingly
- Upgrade runner
- Distinguish between eventwindow() and cohortwindow() [aka window()]

### Edge cases to consider
- upstream visited() calls to Amplitude need to query on the right cohort window for the edges we actually care about NOT the upstream start window


## Extra bugs

- We do not currently have a way to distinguish between paths from one node to various other nodes without manually building in conditionality e.g. from Viewed Dashboard to the three types of recs we've outlined

  Consider the same graph /test.json and note the three sibling edges:-

  viewed-dashboard-to-recommendation-with-BDOs
  viewed-dashboard-to-recommendation-calling-for-bds
  viewed-dashboard-to-not-sent-recommendation

  there is notionally a means of distinguishing between the three events for each of the nodes that terminate those edges, but we would need to add the right prop to the amplitude query, whereby we define an event which has a count=0 of a prior event. 

  (this is a big clunky, and I'm open to other suggestions)

- **INVESTIGATE**: `dailyMode: true` may not be propagating to DAS as `mode: 'daily'`. Test `flag-threading.test.ts` is skipped - verify in prod that daily data fetch actually works.

## Analytics phase 3
- let's think about tables....
- let's think about graphs...



## Other

- pre-commit modal is shit -- massively too long vertically. just make it X files changed; pull now?

## Current query DSL

- This query string is now a natural candidate for what to use to populate the name of newly created scenarios, poss. along with timestamp.
- If user creates a DIFF scenario rather than an ALL scenario, we can also subtract this query FROM what is otherwise shown (compositing layer 2 and below) to construct a helpful Human Readable name
- e.g. if we had (compositing from layer 2 and down) window(1-Jan-25:1-Jan-25) and user then added window(1-Jan-25:1-Jan-25).case(experiment:treament), then when they created a diff snapshot, it would calculate window(1-Jan-25:1-Jan-25).case(experiment:treament)-window(1-Jan-25:1-Jan-25)=case(experiment:treament) (noting we need a service for this query subtraction & addition logic, not to do it inline in the scenario editor) and write "case(experiment:treament) @ 9:24am, 13-Nov-25"  as the scenario name
- crucially, this would allow dynamic layers / scenarios (useful for saved charts/reports)
- (expand / contract scenario to show dsl string, and a 'generate' button on the right to 'run' that scenario)
- then we need to persist scenarios to graph

### Auto-scenarios (requires 'scenario from dsl query' feature)

- let's add a right click context menu to context chips in e.g. dsl query selector on graph in window component AND we can add same feature to contexts in side nav (they'll need to get current graph tab):
  "Create [x] scenarios by value"
  where x is the number of values for this context key
  then use existing 'snapshot all' codepath to create x new scenarios, one for each key=value


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

---

## Major components
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

### Medium 
- Hooks for every menu item...
- Session / tab state not reliably persisting on reload (annoying)
- let's add a 'Create [x] scenarios' on right click context menu on context chips in window component AND within context drop-down which: creates one scenario for each value in the key clicked  -- e.g. if I had browser-type, it would create one scenario [snapshot all mode] for each of the values in browser-type. As always, ensure the logic for this is NOT expressed in the menu file, but in a generalised location
- Orphaned rc windows at times
- Some of our files (UpdateManager, GraphEditor, etc.) are becoming very long; we need to re-factor them down to be more manageable
- **PMF Overflow/Underflow Policies** - Longer-term enhancement to rebalancing logic
  - Current: Edges with parameter references are excluded from auto-rebalancing (implemented)
  - Future: Add graph-level policy (overrideable at node level) to control PMF overflow/underflow behavior
  - Policy options: strict (error on imbalance), absorb (adjust free edges), ignore (allow imbalance)
  - Would provide fine-grained control over probability mass distribution
- need some 'check graph integrity' and 'check for orphansed image files', etc. admin features
- we need to be careful about overrides -- if user 'puts to file' I wonder whether we sohuld clear overrides so that file is now master as appropriate?
- confidence internals on Sankey view
- Events that can fire several times we may need to build Amplitude funnels further one step further upstream in order to ensure we know that it's this specific event we care about 
- Zap drop down menu:
  - 'Connection settings' on zap drop down menu isn't working
  - Sync status' on zap drop down should show last sync, source, etc. from files/graph
- Edit: copy & paste
- Graph integrity checker report
- Minus autocomplete not working in query/selector
- 'Clear overrides' at context & Data menu level  
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
- Keyboard short cuts, generally
- Clean up dead / misleading menu items
- add '?' icons to components, which link to relevant help docs 
- Image Undo/Redo Broken 
- bead labels aren't updating when values change e.g. on data retrieval, revbalances, etc. 
- make 'overridden' icons brighter
- add icons to collapsed beads?
- playing with edges resets edge_id! 
- clicking beads -- make hotspot larger
- whatif layer: prob needs is own layer in the palette really for clarity...
- auto-reroute still stubborn
- let's change the paramster keycolour to pink and nodes from blue to...something else that isn't orange or bright blue...cyan? That will help oragne and blue for dirty/open.
- put outbound probs. left aligned in edge; arriving prob mix. right aligned in edge
- main app tabs are showing maximise button even when they're maximised, it seems
- maxmised tabs are appearing on top (zorder) of navigator button (incorrect)
- maximised tabs in main app are not reflecting padding
- somewhere along the line we lose animations on edge width changes, which is sad
- Sankey mode and normal view use diff code paths for mass infernece; hence sankey requires start node to work -- weird glitch
- all tests in weird places in the codepath; centralise



Post Its:

Need some mild 'is selected' state visual treatment
let's have text inside the post-it in a script font 
but not the text inside the Text field on the Post It props panel (there is hould be normal sans serif)
Let's add font size for Post Its S M L XL; default to Medium which should be a bit smaller than what we currently have. We can expose that on Post It props
handle needs to be dragable
a light drop shadow prob. appropriate

