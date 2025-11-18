*** I THINK WE NEED TO KEEP THIS SIMPLE: THERE ARE THREE CLASSES OF ACCEPTABLE INPUT FROM A GOOGLE RANGE CONNECTION AND IDEALLY WE WOULD HANDLE ALL OF THEM:
A. RANGE RESOLVES TO ONE CELL ONLY & CELL CONTAINS A NUMERIC VALUE
    TAKE AS P.MEAN
B. RANGE RESOLVES TO ONE CELL ONLY & CELL CONTAINS A YAML OR JSON OBJECT WHICH CAN REASONABLY TAKE THE JSON FORM: { VARNAME: VALUE, VARNAME2: VALUE2, ... }
    ACCEPT JSON OBJECT AS A PARAM PACK AND PROCESS AS BELOW
C. RANGE CONTAINS AN EVEN NUMBER OF CELLS
    ITERATE THROUGH EACH CELL:
        IN FIRST CELL, RETRIEVE DSL-NAME OF A VAR
        IN SECOND CELL, RETRIEVE VALUE OF THAT VAR
    REPEAT UNTIL DONE, BUILDING A JSON OBJECT OF THE FORM { VARNAME: VALUE, VARNAME2: VALUE2, ... }

NOW IF WE HAVE JSON FROM EITHER B OR C PATH, THEN PROCESS VARNAMES USING OUR DSL READER [PER SCENARIOS MODAL]. SUPPORT BOTH 'FLAT' AND 'NESTED' YAML STRUCTURES PER OUR SCENARIOS MODAL. E.G. IF USER ONLY GIVES "{ 'MEAN': 0.5, 'STDEV': 0.1 }" THEN THIS SHOULD PASS AS THE EXPLICIT NAME FOR THE PARAM ETC. IS AVAIABLLE FROM CONTEXT. IF USER DOES GIVE SOME EXPLICIT NAMES WHICH ARE OUTSDIDE THE SCOPE OF THIS QUERY RETRIEVAL (E.G. REFER TO ANOTHER PARAM ELSEHWERE ON THE GRPAH) THEN SKIP OVER THEM GRACEFULLY; WE SHOULD _NOT_ USE THEM BUT IT IS NOT AN INVALID SUBMISSION.

I THINK THIS APPROACH PERMITS A GOOD DEAL OF PRACTICAL FLEXIBILTIY AND SENSIBLE ERGONOMICS.

WE DO NOT NEED TO IMPLEMENT MORE COMPLEX ARRAY LOOK UPS; IF USER WANTS TO BUILD AN ARRAY IN THE SPREADSHEET THEY CAN PRE-PARSE THAT INTO A JSON STRING BEFORE PASSING THAT IN A RANGE REF TO US ***


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

### A. Cell Layout Patterns

#### Pattern 1: Single Cell (Simple)
```
| A1              |
|-----------------|
| 0.45            |
```

**Behavior**: Apply value to `p.mean` of the target edge (specified in connection context).

**Use case**: Quick update of a single parameter from external calculation.

#### Pattern 2: HRN + Value Pairs (Power User)
```
| A                              | B      |
|--------------------------------|--------|
| e.checkout-to-purchase.p.mean  | 0.45   |
| e.checkout-to-purchase.p.stdev | 0.03   |
| n.homepage.entry.weight        | 100    |
| e.from(A).to(B).visited(C).p.mean | 0.67 |
```

**Behavior**: For each row, parse HRN in column A, apply value from column B.

**Use case**: 
- Bulk parameter updates
- Scenario management via spreadsheet
- Collaborative parameter tuning

#### Pattern 3: HRN + Multiple Columns (Advanced)
```
| A                              | B (Base) | C (Promo) | D (Holiday) |
|--------------------------------|----------|-----------|-------------|
| e.checkout-to-purchase.p.mean  | 0.35     | 0.45      | 0.52        |
| e.cart-to-checkout.p.mean      | 0.78     | 0.82      | 0.85        |
```

**Behavior**: Column A = HRN, columns B+ = scenario values. User specifies which column to read via `connection_string.column`.

**Use case**: Multi-scenario parameter management in single sheet.

---

## Technical Implementation

### B. Adapter Logic (TypeScript Helper)

**Problem**: Cannot implement complex parsing logic in `connections.yaml` (limited JavaScript sandbox).

**Solution**: Create TypeScript helper function, expose to adapter via `dasHelpers`.

#### B.1. Create HRN Resolution Helper

**File**: `/graph-editor/src/lib/das/sheetsHrnResolver.ts`

```typescript
import { parseHRN } from '../../services/HRNParser';
import { resolveEdgeHRN, resolveNodeHRN } from '../../services/HRNResolver';

export interface SheetsCellValue {
  row: number;
  col: number;
  value: any;
  parsed?: {
    hrn: string;
    entityType: 'edge' | 'node';
    paramPath: string[];
    resolvedUuid?: string;
  };
}

export interface SheetsParseResult {
  mode: 'single' | 'hrn-value-pairs';
  cells: SheetsCellValue[];
  updates: Array<{
    targetType: 'edge' | 'node';
    targetUuid: string;
    paramPath: string;  // e.g., "p.mean"
    value: any;
  }>;
  errors: Array<{
    row: number;
    col: number;
    message: string;
  }>;
}

/**
 * Parse Google Sheets range data with HRN support.
 * 
 * Patterns:
 * 1. Single cell: value only → apply to p.mean
 * 2. HRN + value pairs: A=HRN, B=value → resolve and apply
 * 
 * @param values - Raw cell values from Sheets API (2D array)
 * @param graph - Current graph (for HRN resolution)
 * @param edgeId - Target edge ID (for single-cell mode)
 * @returns Parsed updates and errors
 */
export function parseSheetsRange(
  values: any[][],
  graph: any,
  edgeId?: string
): SheetsParseResult {
  if (!values || values.length === 0) {
    return {
      mode: 'single',
      cells: [],
      updates: [],
      errors: [{ row: 0, col: 0, message: 'Empty range' }]
    };
  }
  
  const cells: SheetsCellValue[] = [];
  const updates: SheetsParseResult['updates'] = [];
  const errors: SheetsParseResult['errors'] = [];
  
  // Detect mode
  const isSingleCell = values.length === 1 && values[0].length === 1;
  const mode: 'single' | 'hrn-value-pairs' = isSingleCell ? 'single' : 'hrn-value-pairs';
  
  if (mode === 'single') {
    // Pattern 1: Single cell → apply to p.mean
    const value = parseNumericValue(values[0][0]);
    
    if (value === null) {
      errors.push({ row: 0, col: 0, message: `Invalid numeric value: ${values[0][0]}` });
    } else if (!edgeId) {
      errors.push({ row: 0, col: 0, message: 'Single-cell mode requires edgeId in context' });
    } else {
      updates.push({
        targetType: 'edge',
        targetUuid: edgeId,
        paramPath: 'p.mean',
        value
      });
    }
    
  } else {
    // Pattern 2: HRN + value pairs (each row is: HRN | value)
    for (let rowIdx = 0; rowIdx < values.length; rowIdx++) {
      const row = values[rowIdx];
      
      if (row.length < 2) {
        errors.push({ 
          row: rowIdx, 
          col: 0, 
          message: 'Row must have at least 2 columns (HRN | value)' 
        });
        continue;
      }
      
      const hrnString = row[0];
      const valueRaw = row[1];
      
      // Skip empty rows
      if (!hrnString || hrnString === '') {
        continue;
      }
      
      // Parse HRN
      const parsed = parseHRN(hrnString);
      if (!parsed) {
        errors.push({ 
          row: rowIdx, 
          col: 0, 
          message: `Invalid HRN: ${hrnString}` 
        });
        continue;
      }
      
      // Resolve HRN to UUID
      let resolvedUuid: string | null = null;
      if (parsed.entityType === 'edge') {
        resolvedUuid = resolveEdgeHRN(hrnString, graph);
      } else if (parsed.entityType === 'node') {
        resolvedUuid = resolveNodeHRN(hrnString, graph);
      }
      
      if (!resolvedUuid) {
        errors.push({ 
          row: rowIdx, 
          col: 0, 
          message: `Could not resolve HRN to ${parsed.entityType}: ${hrnString}` 
        });
        continue;
      }
      
      // Parse value
      const value = parseNumericValue(valueRaw);
      if (value === null) {
        errors.push({ 
          row: rowIdx, 
          col: 1, 
          message: `Invalid numeric value: ${valueRaw}` 
        });
        continue;
      }
      
      // Build param path (e.g., "p.mean" → "p.mean")
      const paramPath = parsed.paramPath ? parsed.paramPath.join('.') : 'p.mean';
      
      // Add update
      updates.push({
        targetType: parsed.entityType,
        targetUuid: resolvedUuid,
        paramPath,
        value
      });
      
      cells.push({
        row: rowIdx,
        col: 0,
        value: hrnString,
        parsed: {
          hrn: hrnString,
          entityType: parsed.entityType,
          paramPath: parsed.paramPath || ['p', 'mean'],
          resolvedUuid
        }
      });
      
      cells.push({
        row: rowIdx,
        col: 1,
        value: valueRaw
      });
    }
  }
  
  return {
    mode,
    cells,
    updates,
    errors
  };
}

/**
 * Parse a cell value to number, handling various formats
 */
function parseNumericValue(value: any): number | null {
  if (typeof value === 'number') {
    return value;
  }
  
  if (typeof value === 'string') {
    // Remove whitespace, commas, % signs
    const cleaned = value.trim().replace(/,/g, '').replace(/%$/, '');
    const parsed = parseFloat(cleaned);
    
    // Handle percentage (divide by 100)
    if (value.trim().endsWith('%')) {
      return parsed / 100;
    }
    
    return isNaN(parsed) ? null : parsed;
  }
  
  return null;
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
    parseSheetsRange,  // ← ADD THIS
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
          enum: [auto, single, hrn-pairs]
          default: auto
          description: "Parse mode: auto-detect, single cell, or HRN+value pairs"
    adapter:
      pre_request:
        script: |
          // Pass graph context to helper (needs to be available)
          // Note: This requires DASRunner to pass graph to pre_request environment
          dsl.edgeId = edgeId;  // From execution context
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
              $graph := graph;
              $edgeId := $dsl.edgeId;
              
              $dasHelpers.parseSheetsRange ? 
                $dasHelpers.parseSheetsRange(values, $graph, $edgeId) :
                { "mode": "error", "updates": [], "errors": [{"row": 0, "col": 0, "message": "dasHelpers.parseSheetsRange not available"}] }
            )
        - name: updates
          jsonata: "parsed_result.updates"
        - name: errors
          jsonata: "parsed_result.errors"
      upsert:
        mode: replace
        writes:
          # Dynamic writes based on parsed updates
          # This requires DAS Runner to support dynamic write targets
          - target: "{{updates[]}}"  # ← Needs enhancement in DAS Runner
            value: "{{updates[].value}}"
```

**Challenge**: Current DAS adapter `upsert` logic doesn't support dynamic write targets from parsed data. Need to enhance this.

---

## Implementation Plan

### Phase 1: Core HRN Parsing (Prerequisite)
- [ ] Create `sheetsHrnResolver.ts` helper
- [ ] Unit tests for `parseSheetsRange()`
  - Test single-cell mode
  - Test HRN+value pairs
  - Test resolution failures
  - Test numeric parsing (%, commas, etc.)
- [ ] Expose helper to DAS adapter via `dasHelpers`

### Phase 2: DAS Runner Enhancement
- [ ] Pass `graph` context to `pre_request` script environment
- [ ] Pass `edgeId`/`nodeId` context from execution
- [ ] Support dynamic `upsert.writes` targets
  - Currently: `target: "/edges/{{edgeId}}/p/mean"` (static template)
  - Need: `target` derived from parsed updates array

### Phase 3: Adapter Update
- [ ] Update Google Sheets adapter in `connections.yaml`
- [ ] Add `mode` to connection_string_schema
- [ ] Implement transform using `parseSheetsRange()`
- [ ] Handle multiple updates from single fetch

### Phase 4: Error Handling & UX
- [ ] Display parsing errors in UI (e.g., toast notifications)
- [ ] Show which HRNs failed to resolve
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

## Timeline Estimate

- **Phase 1** (Core parsing): 2-3 days
- **Phase 2** (DAS enhancement): 3-4 days
- **Phase 3** (Adapter update): 1-2 days
- **Phase 4** (Error handling): 2-3 days
- **Phase 5** (Documentation): 1-2 days

**Total**: ~2 weeks (10-14 days)

---

## Blocking Issues

1. **Graph context in adapters**: Currently adapters don't have access to graph. Need to pass through DASRunner execution context.
2. **Dynamic upsert targets**: Current upsert system expects static templates, need to support array of dynamic writes.

---

## Status

🚧 **Blocked until**:
- Case Gate Integration complete (current priority)
- DAS Runner graph context enhancement
- Dynamic upsert design approved

**Next step**: Review this spec, approve design, prioritize implementation.

