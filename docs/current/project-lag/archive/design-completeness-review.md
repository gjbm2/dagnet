# Design Completeness Review

Mapping `design.md` sections to `implementation.md` tasks.

## Section 1: Motivation & Scope
- [x] 1.1-1.3 Context: Informational. No code tasks.

## Section 2: Conceptual Model
- [x] 2.1 Windows: Implemented via DSL (Phase C2.1) and Adapter (Phase C2.4).
- [x] 2.3 Statistical Model: Implemented in `statisticalEnhancementService` (Phase C3.3).

## Section 3: Data Model Changes
- [x] 3.1 Probability Schema: `LatencyConfig` mapped in Phase C1.1, C1.4.
- [x] 3.2 Param File: Schema updates in Phase C1.3.
- [x] 3.3 Slice Labelling: Canonical DSL logic in Phase C3.4, C3.5.
- [x] 3.4 Date Format: Standardisation in Phase C1.3.

## Section 4: Query Architecture
- [x] 4.1-4.2 Cohort/Anchor: DSL Parsing in Phase C2.1.
- [x] 4.6 Dual-Slice: DSL Construction in Phase C2.2, Payload in Phase C2.3.
- [x] 4.7 Canonical DSL & Maturity: Phase C3.5 (extraction), C3.7 (Path DP).
- [x] 4.8 Query vs Retrieval: Logic split in Phase C3.1 (Ops) vs C3.6 (Query-Context).

## Section 5: Inference Engine
- [x] 5.3 Formula A: Phase C3.3.
- [x] 5.4 Lag Fitting: Phase C3.3.
- [x] 5.5 Completeness: Phase C3.2 (WindowAggregation), C3.3 (Forecast).
- [x] 5.6 p_infinity: Phase C3.2.
- [x] 5.8 Storage: Phase C3.6.
- [x] 5.9 Flows: Phase C3.9.
- [x] 5.10 Aggregation: Phase C3.2, C3.6.

## Section 6: Runner
- [x] 6. Runner: 'No change needed' confirmed by design. Uses p.mean scalar.

## Section 7: UI Rendering
- [x] 7.1 Edge Rendering: Phase C4.1.
- [x] 7.2 Edge Data: Phase C1.1 (Types).
- [x] 7.3 Scenarios: Phase C4.4, C4.7.
- [x] 7.4 Bead: Phase C4.2.
- [x] 7.5 Window Selector: Phase C4.6.
- [x] 7.6 Tooltips: Phase C4.5.
- [x] 7.7 Properties: Phase C4.3.

## Sections 8-12
- [x] 8. Analytics: Mapped to Post-Core Phase A.
- [x] 9. Impact: Sources for C1-C3 tasks.
- [x] 10. Implementation: The source of the plan itself.
- [x] 11. Testing: Mapped to Testing Phase.
- [x] 12. Open Questions: Stubbed pointing to implementation-open-issues.
