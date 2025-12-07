# Implementation Pre-Flight Check

## Phase P0: Rename `cost_time` → `labour_cost`
- [x] Design Reference: Self-contained refactor.
- [x] Files: Types, Pydantic models, Schema, Services/UI/Contexts (search/replace).
- [x] Clarity: Unambiguous.

## Phase C1: Schema Changes & Core Types
- [x] 1.1 TypeScript Types: References `design.md §3.1`, `§7.2`. Files: `graph-editor/src/types/index.ts`, `scenarios.ts`, `GraphParamExtractor.ts`. Clarity: Clear.
- [x] 1.2 Python Models: References `design.md §3.1`, `§9.I`. File: `graph-editor/lib/graph_types.py`. Clarity: Clear.
- [x] 1.3 Param Schema: References `design.md §3.2`, `§3.3`, `§3.4`. File: `graph-editor/public/param-schemas/parameter-schema.yaml`. Clarity: Clear.
- [x] 1.4 Update Manager: References `design.md §9.H`, `§9.K`. File: `graph-editor/src/services/UpdateManager.ts`. Clarity: Clear.
- [x] 1.5 MSMDC Extension: References `design.md §3.1`, `§9.K`. File: `graph-editor/lib/msmdc.py`. Clarity: Clear.

## Phase C2: DSL & Query Architecture
- [x] 2.1 DSL Parsing: References `design.md §4.1`, `§4.2`. Files: `graph-editor/src/lib/queryDSL.ts`, `compositeQueryParser.ts`, `query-dsl-1.1.0.json`. Clarity: Clear.
- [x] 2.2 DSL Construction: References `design.md §9.A`, `§4.6`. Files: `dslConstruction.ts`, `dslExplosion.ts`, `QueryExpressionEditor.tsx`. Clarity: Clear.
- [x] 2.3 Query Payload: References `design.md §9.A`, `§4.6`. File: `buildDslFromEdge.ts`. Clarity: Clear.
- [x] 2.4 Amplitude Adapter: References `design.md §4.4`, `§9.E`. Files: `amplitudeHelpers.ts`, `connections.yaml`. Clarity: Clear.

## Phase C3: Data Storage, Aggregation & Inference
- [x] 3.1 Data Ops: References `design.md §9.C`, `§4.8`. File: `dataOperationsService.ts`. Clarity: Clear.
- [x] 3.2 Window Aggregation: References `design.md §5.5`, `§5.6`. File: `windowAggregationService.ts`. Clarity: Clear.
- [x] 3.3 Lag Distribution: References `design.md §5.3`, `§5.4`. File: `statisticalEnhancementService.ts`. Clarity: Clear.
- [x] 3.4 Param Registry: References `design.md §9.F`, `§3.3`. File: `paramRegistryService.ts`. Clarity: Clear.
- [x] 3.5 Slice Dimension: References `design.md §3.3`, `§4.7`. Files: `dataOperationsService.ts`, `lib/das/`. Clarity: Clear.
- [x] 3.6 Query-Context Latency: References `design.md §3.1`, `§5.8`. File: `statisticalEnhancementService.ts`, `constants/latency.ts`. Clarity: Clear.
- [x] 3.7 Total Maturity (DP): References `design.md §4.7.2`. File: `statisticalEnhancementService.ts`. Clarity: Clear.
- [x] 3.8 Topo Sort: References `design.md §4.7.2`. File: `fetchDataService.ts`. Clarity: Clear.

## Phase C4: UI & Rendering
- [x] 4.1 Edge Rendering: References `design.md §7.1`. File: `ConversionEdge.tsx`, `nodeEdgeConstants.ts`. Clarity: Clear.
- [x] 4.2 Edge Beads: References `design.md §7.4`. Files: `EdgeBeads.tsx`, `edgeBeadHelpers.tsx`. Clarity: Clear.
- [x] 4.3 Properties Panel: References `design.md §7.7`. File: `ParameterSection.tsx`. Clarity: Clear.
- [x] 4.4 Scenarios: References `design.md §7.3`. Files: `ScenariosContext.tsx`, `ScenarioEditorModal.tsx`. Clarity: Clear.
- [!] 4.5 Tooltips: Plan lists `Tooltip.tsx`, but edge tooltips are custom-built in `ConversionEdge.tsx`. Logic should go in `ConversionEdge.tsx`. Ambiguity resolved by inspection.
- [x] 4.6 Window Selector: References `design.md §7.5`. File: `WindowSelector.tsx`. Clarity: Clear.
- [x] 4.7 Scenario Chip: References `design.md §7.3`. Files: `ScenariosPanel.tsx`, `ScenarioLegend.tsx`. Clarity: Clear.
- [x] 4.8 Sibling Constraints: References `design.md §5.10`. Files: `integrityCheckService.ts`, `graphIssuesService.ts`. Clarity: Clear.

## Phase Testing
- [x] Testing: References `design.md §11`. Files: `queryDSL.test.ts`, `dslConstruction.test.ts`, `dataOperationsService.test.ts`, `windowAggregationService.test.ts`, `statisticalEnhancementService.test.ts`. Clarity: Clear.

# Conclusion
The Implementation Plan is robust and fully incorporates impacted code files. Minor ambiguity in Phase C4.5 (Tooltips) resolved by inspection (logic goes in `ConversionEdge.tsx`).
