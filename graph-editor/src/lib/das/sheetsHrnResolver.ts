export interface SheetsCellValue {
  row: number;
  col: number;
  value: unknown;
}

export type SheetsMode =
  | 'single-cell'      // Pattern A: single-cell → scalar value
  | 'param-pack';      // Patterns B/C: object of { varName: value }

export interface SheetsParseResult {
  mode: SheetsMode;
  cells: SheetsCellValue[];
  scalarValue?: unknown;              // Only for Pattern A (often numeric)
  paramPack?: Record<string, unknown>; // For Patterns B/C
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
export function parseSheetsRange(values: unknown[][]): SheetsParseResult {
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
    (c) => c.value !== null && c.value !== undefined && String(c.value).trim() !== '',
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

  const paramPack: Record<string, unknown> = {};

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
    let value: unknown = rawValue;

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
 * Parse a cell value to number, handling various formats.
 */
function parseNumericValue(value: unknown): number | null {
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
 * In practice we expect nested or flat YAML and flat JSON objects to be most common;
 * nested JSON is allowed but likely less common.
 */
function tryParseObject(value: unknown): unknown | null {
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
  // For the purposes of this helper, we assume an implementation that can
  // interpret simple "key: value" blocks into objects.

  return null;
}

/**
 * Normalize nested objects into a flat param pack using dotted paths.
 *
 * Example:
 *   { p: { mean: 0.5, stdev: 0.1 } } → { "p.mean": 0.5, "p.stdev": 0.1 }
 */
function normalizeParamPack(input: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  function walk(prefix: string[], value: unknown): void {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
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


