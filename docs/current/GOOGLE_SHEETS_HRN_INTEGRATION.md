# Google Sheets HRN Integration Specification

**Status**: 🚧 Not Yet Implemented  
**Priority**: High (blocks Google Sheets as practical parameter source)  
**Related**: SCENARIOS_MANAGER_SPEC.md (Appendix A.1 - HRN addressing)

---

## Problem Statement

Currently, the Google Sheets adapter expects **numeric values** in hardcoded cell positions (B1, B2, B3). This makes it unusable for:
- Human-readable parameter management
- Scenario-driven parameter updates
- Collaborative parameter editing

**Current limitation**:
```yaml
# connections.yaml (current)
transform:
  - name: p_mean
    jsonata: "$number(values[0][1])"  # ← Expects number in B1
  - name: n
    jsonata: "$number(values[1][1])"  # ← Expects number in B2
  - name: k
    jsonata: "$number(values[2][1])"  # ← Expects number in B3
```

If user pastes `e.edge-name.p.mean` into a cell, this tries to convert the string to a number → **fails**.

---

## Desired User Flow

### Scenario: User updates parameter via Google Sheet

1. **User opens scenario modal** in DagNet
2. **Sees reference**: `e.checkout-to-purchase.p.mean = 0.35`
3. **Copies HRN** to clipboard: `e.checkout-to-purchase.p.mean`
4. **Opens Google Sheet** linked to their graph
5. **Pastes HRN** into cell A1: `e.checkout-to-purchase.p.mean`
6. **Types new value** into cell B1: `0.45`
7. **Sets connection string**: `range = "Sheet1!A1:B1"`
8. **Clicks "Get from Source"** in DagNet
9. **Adapter**:
   - Fetches range
   - Parses HRN in A1 using `HRNParser`
   - Resolves to edge `checkout-to-purchase`, parameter `p.mean`
   - Extracts value `0.45` from B1
   - Applies update to graph

**Result**: Edge probability updated from 0.35 → 0.45, with provenance tracking.

---

## Design Specification

### A. Accepted Range Patterns (Keep It Simple)

The adapter supports **exactly three** classes of input from a Google Sheets range.  
Anything outside these patterns is treated as an error (or ignored) rather than a special case.

#### Pattern A: Single-Cell Scalar Value

```
| A1              |
|-----------------|
| 0.45            |
```

**Behavior**:
- Interprets the single cell value as the **primary parameter value** for the current context (typically `p.mean` of the selected edge or parameter). The cell content is usually numeric (e.g., a probability) but does **not** have to be numeric as long as the consumer can interpret it.
- No parameter name is required in the sheet; the **name comes from context** (e.g., which edge/param the user attached the connection to).

**Use case**:
- **Quick updates** from a spreadsheet calculation (e.g., a formula computing a new mean).

#### Pattern B: Single-Cell Param Pack (JSON / YAML Object)

```
| A1                                                                 |
|--------------------------------------------------------------------|
| {"p.mean": 0.5, "p.stdev": 0.1}                                    |
```

or (YAML-style):

```
| A1                                                                 |
|--------------------------------------------------------------------|
| mean: 0.5                                                          |
| stdev: 0.1                                                         |
```

**Behavior**:
- Treats the single cell as a **parameter pack** encoded as JSON or YAML.
- Parses the cell into an object of the form `{ VARNAME: VALUE, VARNAME2: VALUE2, ... }`.
- Supports both:
  - **Flat** structures (e.g., `"p.mean": 0.5`), and
  - **Nested** structures (e.g., `p: { mean: 0.5, stdev: 0.1 }`), which are normalized to dotted paths like `p.mean`, `p.stdev`.
- The normalization and interpretation rules are shared with the **same DSL reader used in the scenarios modal**, so there is a **single canonical specification and code path** for param packs coming from both Sheets and the scenarios system.
- Keys that refer to parameters **outside the scope of the current retrieval** are **silently skipped** (ignored, not treated as an error).

**Use cases**:
- **Compact param packs** in a single cell.
- Users who want to precompute a structured blob (e.g., via DagCalc or existing Apps Script helpers) and paste it directly.

#### Pattern C: Name / Value Pairs (Even Number of Cells)

```
| A                              | B      |
|--------------------------------|--------|
| e.checkout-to-purchase.p.mean  | 0.45   |
| e.checkout-to-purchase.p.stdev | 0.03   |
| n.homepage.entry.weight        | 100    |
```

or, linear range (row-wise):

```
| A                              | B      | C                              | D    |
|--------------------------------|--------|--------------------------------|------|
| p.mean                         | 0.45   | p.stdev                        | 0.03 |
```

The same alternating name/value pattern also works when names are laid out in the first row and values in the second row (for example, `A1 = p.mean`, `B1 = p.stdev`, `A2 = 0.45`, `B2 = 0.03`); since we simply enumerate cells in the selected range, any layout that results in **alternating param name / value cells** is supported.

**Requirements**:
- The selected range must contain an **even number of non-empty cells**.
- Cells are read in order and interpreted as **(name, value)** pairs:
  - First cell → DSL name
  - Second cell → value
  - Third cell → next DSL name
  - Fourth cell → next value
  - … and so on.

**Behavior**:
- Builds an in-memory object of the form `{ VARNAME: VALUE, VARNAME2: VALUE2, ... }`.
- Names are interpreted via the same **DSL / HRN reader** used by the scenarios system.
- Unknown or out-of-scope names are **ignored, not treated as hard errors**.

**Use cases**:
- **Bulk parameter updates** keyed by DSL/HRN names.
- Copy/paste from the scenarios modal into Sheets, adjust values, then pull them back.
- Maintain offline parameter tables (e.g., cost inputs or other parameter classes) that act as a source of truth and can be periodically pulled into DagNet.

#### Deliberate Non-Goals

- **No complex array lookups** from spreadsheet structures:
  - If the user wants to construct an array in Sheets, they should **pre-serialize it to JSON** in a cell and then pass that serialized string as the **value** in Pattern B or C. There is already an existing Apps Script helper that can do this JSON serialization directly in the sheet.
- **Scenario semantics are out of scope for this adapter**:
  - Users can still model multi-scenario data in the sheet, but from the adapter's perspective this is purely about **parameter data sourcing**: each invocation reads one set of values via the three simple patterns above, and higher layers (e.g., the scenarios system) decide how to interpret those values.

---

## Technical Implementation

### B. Adapter Logic (TypeScript Helper)

**Problem**: Cannot implement more-than-trivial parsing logic in `connections.yaml` (limited JavaScript sandbox).

**Solution**: Create a small, focused TypeScript helper that:
- Understands **only** the three simple patterns (A, B, C) above.
- Produces either a **single scalar value** (Pattern A) or a **normalized parameter pack** (Patterns B/C).
- Leaves **DSL/HRN interpretation to existing scenario/DSL logic**, instead of performing graph-aware resolution inside the Sheets adapter.

#### B.1. Create Sheets Range Parsing Helper

**File**: `/graph-editor/src/lib/das/sheetsHrnResolver.ts`

```typescript
export interface SheetsCellValue {
  row: number;
  col: number;
  value: any;
}

export type SheetsMode =
  | 'single-cell'      // Pattern A: single-cell → scalar value
  | 'param-pack';      // Patterns B/C: object of { varName: value }

export interface SheetsParseResult {
  mode: SheetsMode;
  cells: SheetsCellValue[];
  scalarValue?: any;                   // Only for Pattern A (often numeric)
  paramPack?: Record<string, any>;     // For Patterns B/C
  errors: Array<{
    row: number;
    col: number;
    message: string;
  }>;
}

/**
 * Parse Google Sheets range data into either:
 * - a single scalar value (Pattern A, often numeric), or
 * - a normalized param pack object (Patterns B/C).
 * 
 * The interpretation of keys (DSL / HRN → actual graph params) is delegated
 * to the existing scenarios / DSL layer.
 * 
 * @param values - Raw cell values from Sheets API (2D array)
 * @returns Parsed result, including any non-fatal parse errors
 */
export function parseSheetsRange(values: any[][]): SheetsParseResult {
  const cells: SheetsCellValue[] = [];
  const errors: SheetsParseResult['errors'] = [];

  if (!values || values.length === 0) {
    return {
      mode: 'single-cell',
      cells: [],
      scalarValue: undefined,
      paramPack: undefined,
      errors: [{ row: 0, col: 0, message: 'Empty range' }],
    };
  }
  
  // Populate cells list for diagnostics / debugging
  for (let r = 0; r < values.length; r++) {
    const row = values[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      cells.push({ row: r, col: c, value: row[c] });
    }
  }

  const isSingleCell = values.length === 1 && values[0].length === 1;

  // Pattern A: Single-cell scalar value
  if (isSingleCell) {
    const raw = values[0][0];

    // Pattern B: Single-cell object (JSON / YAML-like)
    const parsedObject = tryParseObject(raw);
    if (parsedObject && typeof parsedObject === 'object') {
      const paramPack = normalizeParamPack(parsedObject);
      return {
        mode: 'param-pack',
        cells,
        paramPack,
        errors,
      };
    }

    // Fallback: treat as scalar value, with best-effort numeric parsing
    const numeric = parseNumericValue(raw);
    const scalar = numeric !== null ? numeric : raw;

    return {
      mode: 'single-cell',
      cells,
      scalarValue: scalar,
      paramPack: undefined,
      errors,
    };
  }

  // Pattern C: Name/value pairs over an even number of cells
  const flatCells: SheetsCellValue[] = cells.filter(
    (c) => c.value !== null && c.value !== undefined && String(c.value).trim() !== ''
  );

  if (flatCells.length === 0) {
        errors.push({ 
      row: 0,
          col: 0, 
      message: 'Range has no non-empty cells',
    });
    return {
      mode: 'param-pack',
      cells,
      paramPack: {},
      errors,
    };
      }
      
  if (flatCells.length % 2 !== 0) {
        errors.push({ 
      row: 0,
          col: 0, 
      message:
        'Name/value pairs pattern requires an even number of non-empty cells (DSL name, value, DSL name, value, ...)',
    });
  }

  const paramPack: Record<string, any> = {};

  for (let i = 0; i + 1 < flatCells.length; i += 2) {
    const nameCell = flatCells[i];
    const valueCell = flatCells[i + 1];

    const name = String(nameCell.value).trim();
    if (!name) {
        errors.push({ 
        row: nameCell.row,
        col: nameCell.col,
        message: 'Empty DSL/HRN name cell in name/value pair',
        });
        continue;
      }
      
    const rawValue = valueCell.value;
    let value: any = rawValue;

    const numeric = parseNumericValue(rawValue);
    if (numeric !== null) {
      value = numeric;
    } else {
      const asObject = tryParseObject(rawValue);
      if (asObject && typeof asObject === 'object') {
        // Preserve nested objects as-is; they will be handled by DSL/param logic
        value = asObject;
        }
    }

    paramPack[name] = value;
  }
  
  return {
    mode: 'param-pack',
    cells,
    paramPack,
    errors,
  };
}

/**
 * Parse a cell value to number, handling various formats
 */
function parseNumericValue(value: any): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // Remove commas and trailing % sign
    const cleaned = trimmed.replace(/,/g, '').replace(/%$/, '');
    const parsed = parseFloat(cleaned);
    if (Number.isNaN(parsed)) return null;
    
    // Handle percentages
    if (trimmed.endsWith('%')) {
      return parsed / 100;
    }
    
    return parsed;
  }
  
  return null;
}

/**
 * Best-effort parse of JSON or YAML-ish content from a string cell.
 * Implementation detail: use JSON.parse and, if available, a YAML parser.
 * In practice we expect nested or flat YAML and flat JSON objects to be most common; nested JSON is allowed but likely less common.
 */
function tryParseObject(value: any): any | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  try {
    const json = JSON.parse(text);
    if (json && typeof json === 'object') return json;
  } catch {
    // fall through
  }

  // YAML / relaxed syntax parsing can be plugged in here if desired.
  // For the purposes of this spec, we assume an implementation that can
  // interpret simple "key: value" blocks into objects.
  return null;
}

/**
 * Normalize nested objects into a flat param pack using dotted paths.
 *
 * Example:
 *   { p: { mean: 0.5, stdev: 0.1 } } → { "p.mean": 0.5, "p.stdev": 0.1 }
 */
function normalizeParamPack(input: any): Record<string, any> {
  const result: Record<string, any> = {};

  function walk(prefix: string[], value: any) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) {
        walk([...prefix, k], v);
      }
      return;
    }

    const key = prefix.join('.');
    if (!key) return;
    result[key] = value;
  }

  walk([], input);
  return result;
}
```

#### B.2. Expose Helper to DAS Adapter

**File**: `/graph-editor/src/lib/das/DASRunner.ts`

```typescript
import { parseSheetsRange } from './sheetsHrnResolver';

// In executePreRequestScript():
const scriptEnv = {
  dsl: context.dsl,
  window: context.window,
  connection_string: context.connection_string,
  connection: context.connection,
  context: context.context,
  dasHelpers: {
    resolveVariantToBool,
    parseSheetsRange,  // ← ADD THIS (scalar or param-pack)
  },
  console: { ... }
};
```

#### B.3. Update Google Sheets Adapter

**File**: `/graph-editor/public/defaults/connections.yaml`

```yaml
  - name: sheets-readonly
    provider: google-sheets
    kind: http
    auth_type: google-service-account
    description: "Read-only access to Google Sheets for parameter data"
    enabled: true
    credsRef: google-sheets
    defaults:
      api_version: "v4"
    connection_string_schema:
      type: object
      required: [spreadsheet_id, range]
      properties:
        spreadsheet_id:
          type: string
          description: "Google Sheets spreadsheet ID from URL"
        range:
          type: string
          description: "A1 notation range (e.g., 'Sheet1!A1:B10')"
        mode:
          type: string
          enum: [auto, single, param-pack]
          default: auto
          description: >
            Parse mode: auto-detect, single-cell scalar value, or param pack (JSON/YAML or name/value pairs).
    adapter:
      pre_request:
        script: |
          // Nothing fancy here yet; we keep pre_request minimal.
          // Any edge/node context is handled by the caller (e.g., scenarios modal).
          return dsl;
      request:
        url_template: "https://sheets.googleapis.com/v4/spreadsheets/{{{connection_string.spreadsheet_id}}}/values/{{{connection_string.range}}}"
        method: GET
        headers:
          Authorization: "Bearer {{credentials.access_token}}"
      response:
        extract:
          - name: values
            jmes: "values"
      transform:
        - name: parsed_result
          jsonata: |
            (
              $dasHelpers := dasHelpers;
              
              $dasHelpers.parseSheetsRange ? 
                $dasHelpers.parseSheetsRange(values) :
                {
                  "mode": "error",
                  "scalarValue": null,
                  "paramPack": {},
                  "errors": [
                    {
                      "row": 0,
                      "col": 0,
                      "message": "dasHelpers.parseSheetsRange not available"
                    }
                  ]
                }
            )
        - name: scalar_value
          jsonata: "parsed_result.scalarValue"
        - name: param_pack
          jsonata: "parsed_result.paramPack"
        - name: errors
          jsonata: "parsed_result.errors"
      # NOTE: No direct upsert here. The caller (e.g., scenarios engine) consumes
      # scalar_value / param_pack and applies them to the graph using existing
      # DSL / HRN resolution and provenance tracking.
```

**Note**: By returning either a **scalar** or a **param pack** and letting the existing DSL/scenario machinery handle graph updates, this design **avoids needing dynamic upsert targets or graph context inside the adapter itself**.

---

## Implementation Plan

### Phase 1: Core Sheets Parsing (Prerequisite)
- [ ] Create `sheetsHrnResolver.ts` helper focused on patterns A/B/C
- [ ] Unit tests for `parseSheetsRange()`
  - Test single-cell scalar values (Pattern A), including numeric and non-numeric cases
  - Test single-cell JSON/YAML object (Pattern B)
  - Test name/value pairs with even/odd cell counts (Pattern C)
  - Test numeric parsing (%, commas, etc.)
  - Test nested param packs and flattening (e.g., `p: { mean, stdev }`)
- [ ] Expose helper to DAS adapter via `dasHelpers`

### Phase 2: Scenario / DSL Integration
- [ ] Ensure param pack keys are interpreted by the **existing DSL reader** used by the scenarios modal.
- [ ] Confirm that unknown or out-of-scope keys are **ignored** rather than treated as errors.
- [ ] Wire scalar mode (Pattern A) so that it updates the appropriate `p.mean` (or equivalent) based on **context**.

### Phase 3: Adapter Update
- [ ] Update Google Sheets adapter in `connections.yaml`
- [ ] Add `mode` to connection_string_schema
- [ ] Implement transform using `parseSheetsRange()`
- [ ] Ensure responses expose `scalar_value`, `param_pack`, and `errors` for the caller

### Phase 4: Error Handling & UX
- [ ] Display parsing errors in UI (e.g., toast notifications)
- [ ] Show which cells / names failed to parse
- [ ] Add "dry run" mode to preview updates before applying
- [ ] Log successful updates with provenance

### Phase 5: Documentation & Examples
- [ ] Add example Google Sheet template
- [ ] Document HRN syntax in user docs
- [ ] Add tutorial video/screenshots
- [ ] Create test graph with Sheet integration

---

## Example Google Sheet

### Setup
1. **Create Google Sheet**: "DagNet Parameters"
2. **Sheet: "Conversion Rates"**
   ```
   | A                                    | B (Current) | C (Optimistic) |
   |--------------------------------------|-------------|----------------|
   | e.homepage-to-product.p.mean         | 0.35        | 0.42           |
   | e.product-to-cart.p.mean             | 0.28        | 0.32           |
   | e.cart-to-checkout.p.mean            | 0.78        | 0.85           |
   | e.checkout-to-purchase.p.mean        | 0.45        | 0.52           |
   | e.checkout-to-purchase.p.stdev       | 0.03        | 0.02           |
   ```

3. **In DagNet**:
   - Select edge `checkout-to-purchase`
   - Open connection settings
   - Connection: `sheets-readonly`
   - Settings:
     - `spreadsheet_id`: `1abc...xyz`
     - `range`: `Conversion Rates!A4:B5`  (checkout-to-purchase rows)
     - `mode`: `hrn-pairs`
   - Click "Get from Source"

4. **Result**:
   - `p.mean` updated to 0.45
   - `p.stdev` updated to 0.03
   - Provenance: "sheets-readonly (Conversion Rates!A4:B5) at 2025-11-18T14:30:00Z"

---

## Benefits

### For Users
1. **Human-readable**: See parameter names, not UUIDs
2. **Copy-paste**: Copy HRN from scenario, paste to Sheet
3. **Collaborative**: Share Sheet with team, edit collaboratively
4. **Version control**: Use Google Sheets version history
5. **Formulas**: Use Sheet formulas to compute parameter values
6. **Multi-scenario**: Manage multiple scenarios in columns

### For System
1. **Consistency**: Same HRN parsing as scenarios
2. **Validation**: HRN resolution validates parameter exists
3. **Provenance**: Track which Sheet + range provided values
4. **Flexibility**: Support complex ranges (100s of parameters)

---

## Alternative Approaches Considered

### Alt 1: Require Sheet to Output JSON
**Rejected**: Too technical for non-developer users, defeats purpose of Sheet UI.

### Alt 2: Use Named Ranges
**Possible enhancement**: User creates named range "checkout_conversion" → adapter maps to HRN.
**Complexity**: Requires additional mapping layer, less transparent.

### Alt 3: Cell Comments with HRN
**Rejected**: Comments not returned by Sheets API without extra request, slows down fetches.

---

## Dependencies

### On DAS Runner
- Graph context availability in adapter scripts
- Dynamic upsert targets (array of writes)

### On HRN System
- `HRNParser` and `HRNResolver` (already implemented ✅)
- Normalization of HRN strings (already implemented ✅)

### On Google Sheets API
- OAuth token refresh (already implemented ✅)
- Range parsing (already implemented ✅)

---

## Testing Strategy

### Unit Tests
- `parseSheetsRange()` with various input patterns
- Numeric value parsing (%, commas, strings)
- HRN resolution (valid, invalid, ambiguous)

### Integration Tests
- End-to-end: Sheet → DagNet → graph update
- Error cases: invalid HRNs, missing cells
- Multi-row updates

### Manual Tests
- Create real Sheet, fetch data
- Verify provenance tracking
- Test with 100+ parameter rows (performance)

---

## Outstanding Work & Open Design Questions

This section tracks the remaining implementation work and open decisions for the Sheets HRN integration.  
It is written for **implementation review** and should be kept in sync with the actual code.

### 1. Canonical Param Pack Engine (HRN → Graph / Param Application)

**Design requirement**

There must be **one single, robust, high‑quality code path** for:
- (a) **Generating** parameter packs from a graph, and
- (b) **Parsing / interpreting** parameter packs into a structured, mergeable object,

used by **both**:
- The **scenarios system** (snapshotting, overlays, composition), and
- The **Sheets integration** (and any future external sources that speak “param packs”).

Sheets **must not** introduce a second, divergent DSL/HRN parsing implementation.  
**Important**: this shared engine is responsible for **DSL/HRN parsing and diff construction only** (pure data), **not** for how those diffs are ultimately applied to the live graph.

**Current state**
- For scenarios:
  - `GraphParamExtractor` turns a `Graph` into `ScenarioParams` (including `p`, `conditional_p`, node `case.variants`, etc.).
  - `ScenarioFormatConverter`:
    - Flattens `ScenarioParams` into HRN keys like:
      - `e.edge-id.p.mean`
      - `e.edge-id.conditional_p.visited(promo).mean`
      - `n.case-node.case(my-experiment:control).weight`
    - Unflattens those HRN key/value maps back into `ScenarioParams` (`unflattenParams()`).
  - `CompositionService.composeParams()` + `mergeEdgeParams()` implement the authoritative rules for overlaying param diffs (including `conditional_p` merge semantics).
- For Sheets:
  - The adapter returns:
    - `scalar_value` (Pattern A)
    - `param_pack` (Patterns B/C) as a flat map `{ key: value }`
    - `errors` (non-fatal parse issues)
  - A provisional helper (`extractSheetsUpdateData`) currently performs some ad‑hoc HRN/key parsing for direct edge updates; this MUST be refactored to use the canonical param‑pack engine described above.

**Outstanding work**

- [ ] **Extract and formalize the canonical param‑pack engine** from existing scenario code:
  - Centralize the “flat HRN map ↔ `ScenarioParams` ↔ graph diff” logic into a dedicated service (e.g. `ParamPackEngine`) built on:
    - `ScenarioFormatConverter.unflattenParams()` / `flattenParams()`
    - `CompositionService.composeParams()` / `mergeEdgeParams()` / `mergeNodeParams()`
    - Existing `GraphParamExtractor` / `UpdateManager` mappings.
  - Clearly document the supported key shapes:
    - Edge params: `e.edge-id.p.*`, `e.from(a).to(b).p.*`, etc.
    - Edge conditionals: `e.edge-id.conditional_p.<condition>.p.*` (using the same `condition` strings/DSL paths scenarios already use).
    - Node params: `n.node-id.entry.*`, `n.node-id.costs.*`, etc.
    - Case variants: `n.case-node-id.case(<caseId>:<variantName>).weight`.
- [ ] Extend this engine to accept an **optional “scope”** argument:
  - Scope can describe:
    - A specific **edge/param slot** (e.g. edge UUID + `p` or `cost_gbp`),
    - A specific **node/case** (e.g. case node UUID),
    - A specific **conditional entry** (edge UUID + `condition` string).
  - When a scope is provided:
    - Only params **within scope** are retained (others are *explicitly ignored* for this operation).
    - Out‑of‑scope but valid keys are reported as “skipped” (for logging / UX), not silently dropped.
  - When no scope is provided (e.g. scenario overlays), the engine behaves as it does today: scope is effectively the **entire graph**.
- [ ] Define **how structured diffs are consumed** in distinct application layers:
  - For **scenarios**:
    - Continue to treat `ScenarioParams` diffs as **overlays** composed via `composeParams()` for rendering and analysis only.
    - The live graph is **not** mutated by the param‑pack engine; it is only mutated when the user explicitly flattens scenarios.
  - For **data ingestion sources** (Sheets, Amplitude, Statsig, etc.):
    - Convert scoped `ScenarioParams` diffs into external payloads (`{ mean, stdev, n, k, variants, ... }`) and pass them through the existing ingestion pipeline:
      - `DataOperationsService` → `UpdateManager.handleExternalToGraph` / `handleExternalToFile` → graph/file mutation + rebalance + provenance.
- [ ] Ensure this engine is the **only** place that:
  - Parses HRN-style keys into structured params, and
  - Interprets conditional DSL / case variant selectors.

**Sheets-specific behavior (built on the canonical engine)**

- [ ] For Sheets `param_pack` ingestion:
  - Treat the pack as a **flat HRN map**, pass it through the canonical engine with an appropriate **scope**:
    - Direct edge pull (`getFromSourceDirect` on a specific edge/param slot):
      - Scope = “this edge UUID + this param slot (+ optional condition index)”.
    - Case update (Sheets driving case variants):
      - Scope = “this case node UUID”.
    - Future batch/multi-edge Sheets workflows:
      - Scope can be “entire graph” or a subset, as appropriate.
  - Convert the resulting scoped `ScenarioParams` diff into the external payload expected by `UpdateManager.handleExternalToGraph` / `handleExternalToFile` (schema terminology: `mean`, `stdev`, `n`, `k`, `variants`, etc.), so Sheets uses the **same graph/file mutation code paths** as scenarios, Amplitude, Statsig, etc.
- [ ] For `scalar_value` (Pattern A):
  - Treat it as a **degenerate param pack** for the scoped param:
    - E.g. in a direct edge pull for `p`, interpret `scalar_value` as `p.mean` *only if* the pack is otherwise empty for that scope.
  - Feed it through the same engine so that any future enhancements to param semantics (e.g. bounds, distributions) apply uniformly.

### 2. Scalar Mode Semantics (`scalar_value`)

**Current state**
- `scalar_value` is returned for Pattern A (single-cell scalar), but we do not yet define:
  - How it maps into graph fields (`p.mean` vs cost, etc.).
  - How it interacts with a simultaneous `param_pack` for the same call.

**Outstanding work**
- [ ] Define, per object type (`parameter` / `node` / `case`), what `scalar_value` means.
- [ ] Implement that mapping in `DataOperationsService.getFromSourceDirect` (and, if applicable, in the versioned/file path).

**Proposed approach**
- For **edge-level probability parameters** (objectType=`parameter`, paramSlot=`p`):
  - Treat `scalar_value` as **“primary numeric value”** for `p.mean` when no conflicting `param_pack` key is present for that edge.
  - Use `UpdateManager.handleExternalToGraph({ mean: scalar_value }, edge, 'UPDATE', 'parameter')` to leverage existing stats/provenance logic.
- For **other param slots** (e.g. `cost_gbp`, `cost_time`):
  - Treat `scalar_value` as `mean` for that slot.
- Precedence:
  - If a `param_pack` contains an explicit key for the current context (e.g. `p.mean`), that **wins** over `scalar_value`, and `scalar_value` is ignored for that specific param; this avoids silent conflicts.

### 3. Sheets in Versioned / File-Based Workflows

**Current state**
- The primary integration so far is via `getFromSourceDirect` (graph-only updates).
- Parameter files already support `connection: "sheets-readonly"` + `connection_string`, but:
  - There is no dedicated path yet that **pulls from Sheets and appends a new `values[]` entry** using the Sheets data.

**Outstanding work**
- [ ] Define how Sheets should be used in **file-based** workflows:
  - Append a new `values[]` entry using `scalar_value` / `param_pack`.
  - Set `data_source.type: 'sheets'` plus URL / range / timestamp for provenance, following the **same provenance pattern used for Amplitude and other external sources**.
- [ ] Implement this via the existing external→file path:
  - Use the current `getFromSource` / `getFromSourceDirect` machinery to fetch from Sheets.
  - Pass the resulting external payload through `UpdateManager.handleExternalToFile`, exactly as for other connectors, rather than introducing any Sheets-specific write logic.

**Proposed approach**
- For **probability parameters**:
  - When invoked in versioned mode, consume `scalar_value` / `param_pack` and construct a `values[]` entry with:
    - `mean`, `stdev`, `n`, `k` when available.
    - `data_source: { type: 'sheets', url, retrieved_at, range }`.
- For **cost/time parameters**:
  - Store `mean` (and optional `stdev`) under the appropriate slot (`cost_gbp`, `cost_time`), reusing the existing mappings from external data → file.

### 4. Error Surfacing & UX for Sheets

**Current state**
- `parseSheetsRange` returns structured `errors` (row, col, message).
- The adapter exposes these as `errors` in the transform output.
- The UI currently only surfaces **adapter-level errors** (e.g., HTTP failures, transform failure), not **per-cell parse errors**.

**Outstanding work**
- [ ] Decide how to surface Sheets parse errors to the user:
  - Toast with a summary (“3 cells could not be parsed; see details”), consistent with other external sources.
  - When **logging mode / batch mode** is active, also aggregate detailed errors and write them to the DAS log file for later inspection.
  - Optional “details” view listing row/col + message.
  - Potential highlighting of problematic cells (requires range + A1 conversion).
- [ ] Implement error propagation path:
  - Extend `DataOperationsService` to look at `result.raw.errors` for `sheets-readonly`.
  - Surface them via `toast.error` and/or a dedicated “Sheets errors” panel.

**Proposed approach**
- Treat `errors` as **non-fatal warnings** as long as at least one valid value was parsed:
  - Proceed with applying valid entries.
  - Show a toast like:  
    `“Sheets import applied (2 params updated). 1 cell could not be parsed: A3 (not a number).”`
- If **no usable values** are parsed:
  - Treat as a **hard error**: do not apply updates, show a clear error toast.

### 5. Connection `mode` (auto / single / param-pack)

**Current state**
- `mode` is defined in the connection string schema for `sheets-readonly` but not yet consumed by the adapter or helper.
- `parseSheetsRange` always **auto-detects** patterns based on shape and content.

**Outstanding work**
- [ ] Decide whether `mode` should:
  - Influence how `parseSheetsRange` behaves (e.g., force scalar vs param-pack).
  - Or simply be a hint at a **higher layer** (e.g., consumer decides what to expect).
- [ ] Implement that behavior and tests.

**Proposed approach**
- Keep `parseSheetsRange` **auto-only** for now (pure heuristic).
- Use `connection_string.mode` (when present) in the consumer:
  - `mode: 'single'`:
    - Require `scalar_value` to be present and ignore `param_pack` even if parseable.
  - `mode: 'param-pack'`:
    - Require non-empty `param_pack` and treat `scalar_value` as irrelevant.
  - `mode: 'auto'` (default when `mode` is omitted from the connection string):
    - Current behavior: use whichever the helper returns, with precedence rules as described in §2.

### 6. Additional Tests (Sheets + HRN + Graph Updates)

**Current state**
- Implemented tests:
  - Unit tests for `parseSheetsRange` Patterns A/B/C and edge cases.
  - DASRunner adapter tests for mocked Sheets responses → `scalar_value` / `param_pack`.
  - Basic integration test to ensure `sheets` `data_source.type` is recognized in daily flows.
- Missing tests:
  - End-to-end HRN resolution + graph updates driven by Sheets.
  - Negative tests for bad HRNs, out-of-scope keys, and conflicting data.

**Outstanding work**
- [ ] Add integration tests that:
  - Feed a mocked `param_pack` like `{ "e.checkout-to-purchase.p.mean": 0.45 }`.
  - Use `HRNResolver` + `UpdateManager` to assert that the correct edge is updated.
  - Verify that unknown HRNs are **ignored but logged**, not treated as hard errors.
- [ ] Add tests for mixed scalar + param-pack calls and `mode` variations (auto / single / param-pack).

**Proposed approach**
- Extend `dataOperations.integration.test.ts` with a **“Sheets HRN param pack”** suite:
  - Mock `createDASRunner().execute` to return a realistic `param_pack`.
  - Build a small in-memory graph with known edge IDs/UUIDs.
  - Assert that only the intended edges/params are mutated, provenance is set to `type: 'sheets'`, and unaffected edges remain unchanged.

---

## Timeline Estimate

- **Phase 1** (Core parsing): 2-3 days
- **Phase 2** (DAS enhancement): 3-4 days
- **Phase 3** (Adapter update): 1-2 days
- **Phase 4** (Error handling): 2-3 days
- **Phase 5** (Documentation): 1-2 days

**Total**: ~2 weeks (10-14 days)

---

## Blocking Issues

The simplified design (three patterns, param packs, and delegation to the DSL / scenarios layer) removes the need for several previously blocking requirements.

1. **Graph context in adapters**: No longer required for Sheets parsing itself. Adapters return scalar values or param packs; graph updates happen elsewhere.
2. **Dynamic upsert targets**: No longer required inside the Sheets adapter. The caller is responsible for mapping param packs onto specific graph paths.

---

## Status

🚧 **Blocked until**:
- Case Gate Integration complete (current priority)
- DAS Runner graph context enhancement
- Dynamic upsert design approved

**Next step**: Review this spec, approve design, prioritize implementation.

