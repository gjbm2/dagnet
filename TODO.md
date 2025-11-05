# DagNet TODO

## Recently Completed

### Phase 0 (Data Connections Foundation) - Nov 5, 2025 ✅
- **Phase 0.0:** ID/Slug Standardization - All `slug` → `id`, all `id` (UUID) → `uuid`
- **Phase 0.1:** Schema Updates - 7 schemas updated, override patterns implemented
- **Phase 0.2:** Field Mapping Validation (Gate 2) - 8 critical mismatches fixed
- **Fixed:** Variant weight context menu slider (UUID/ID lookup issue resolved)
- **Fixed:** Edge weight display issues (UUID/ID systematic fixes)
- **Fixed:** Node PMF validation ("missing 100%" issue)
- **Fixed:** Hide selected functionality (human-readable ID handling)
- **Next:** Phase 0.3 - UpdateManager Implementation

See `PROJECT_CONNECT/PHASE_0.0_COMPLETE.md` and `PROJECT_CONNECT/PHASE_0.1_COMPLETE.md` for details.

---

## In Progress

### High Priority
- Amplitude, Google sheets pull through params
- Context support
- Scenario viewer (snapshotting)
- Latency/lag management
- Dashboarding views
- Bayesian modelling (...is expected?)

### Analytics / Model Fitting (Future)
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
- Edit > Undo broken; add Undo to right click context menus on graph (standardise context menu implmenetations)
- generalise props panel implementation
- Date windows in viewer
- Selected objects show query/selector string
- copy / paste param packs
- 'view param packs)
- GIT_BATCH_OPERATIONS_MD
- Turn 'Path analysis' into a proper rc floating dock at the bottom left, but movebale (and re-dockable)
- Allow snapshotted 'delta analysis' views within what if panel; show colour-coded overlayed edges
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
- main app tabs are showing maximise button even when they're maximised, it seems
- maxmised tabs are appearing on top (zorder) of navigator button (incorrect)
- maximised tabs in main app are not reflecting padding
