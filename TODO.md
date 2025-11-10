# DagNet TODO

### High Priority
- **P-Slider Auto-Balance NOT WORKING**
  - STATUS: Sibling edges don't auto-adjust when dragging probability slider
  - Issue: `handleEdgeProbSlide` in PropertiesPanel.tsx (line ~650-700) should auto-adjust sibling probabilities
  - Sibling finding logic exists and works for rebalance button
  - But slider onChange doesn't trigger sibling updates
  - Related: Rebalance indicator now works (fixed: added `isEdgeProbabilityUnbalanced` memo, line ~586-602)
  - Next: Wire up slider onChange to call same sibling adjustment logic as rebalance button uses
  
- **Auto-Reroute Node Position Revert - STILL BROKEN**
  - PROBLEM: When moving a node and triggering auto-reroute, node position reverts to prior state
  - Log evidence: tmp.log lines 265-411 show node drag stop → force reroute → full rebuild → positions revert
  - ATTEMPTED FIX (FAILED): Added node position preservation in performAutoReroute (GraphCanvas.tsx line ~1039-1047)
    - Tried: Update nextGraph.nodes[].layout.{x,y} from ReactFlow positions before setGraph()
    - Theory: cloned graph had old positions, triggered full rebuild pulling old positions back
    - Result: DID NOT WORK - positions still revert
  - ROOT ISSUE: Line 411 in log shows "Slow path: Topology changed, doing full rebuild" even though nothing changed
    - Edge count same, node count same, edge IDs same
    - But still triggers full rebuild at GraphCanvas.tsx ~line 1558
    - Full rebuild pulls positions from graph store which has old positions
  - NEXT: Need to either (a) prevent full rebuild when only handles change, OR (b) ensure ReactFlow positions are authoritative during rebuild

- global/local weights whacked (why???)
- fix tools panel view options (Again)
- Amplitude, Google sheets pull through params
- Context support
- Scenario viewer (snapshotting)
- Latency/lag management
- Dashboarding views
- Bayesian modelling (...is expected?)

### Analytics / Model Fitting (Future)
- add moving arrow effect, speed of animation scale on log lag
- **Standard Deviation Calculation Strategy**
  - Currently: `stdev` defaults to 0 or simple estimates
  - Need proper calculation based on:
    - Distribution type (beta for probabilities, lognormal for costs, etc.)
    - Sample size (n) and confidence
    - Historical variance if available
    - Bayesian priors vs. frequentist estimates
  - Decision: Defer to model fitting analytics phase
  - Context: Different data sources provide different levels of detail:
    - Amplitude funnels: Can calculate from n/k using beta distribution
    - Google Sheets: No statistical context, might need historical variance
    - Manual entry: User may provide or leave as 0
  - Should be smart about deriving when possible, but not too opinionated
  - See: Phase 0.3 discussion on flexible data handling

### Medium Priority
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
- flickering when moving nodes (chevrons render a frame later)
- 'show travel' chevrons along edges moving at log lag speed
- put outbound probs. left aligned in edge; arriving prob mix. right aligned in edge
- main app tabs are showing maximise button even when they're maximised, it seems
- maxmised tabs are appearing on top (zorder) of navigator button (incorrect)
- maximised tabs in main app are not reflecting padding
- somewhere along the line we lose animations on edge width changes, which is sad
