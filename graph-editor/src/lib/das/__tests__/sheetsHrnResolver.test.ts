import { describe, it, expect } from 'vitest';
import { parseSheetsRange } from '../sheetsHrnResolver';

describe('parseSheetsRange - core patterns and edge cases', () => {
  it('handles empty range', () => {
    const result = parseSheetsRange([]);
    expect(result.mode).toBe('single-cell');
    expect(result.scalarValue).toBeUndefined();
    expect(result.paramPack).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain('Empty range');
  });

  it('parses single-cell numeric scalar (Pattern A)', () => {
    const result = parseSheetsRange([[0.45]]);
    expect(result.mode).toBe('single-cell');
    expect(result.scalarValue).toBeCloseTo(0.45);
    expect(result.paramPack).toBeUndefined();
    expect(result.errors).toHaveLength(0);
  });

  it('parses single-cell percentage string as numeric scalar (Pattern A)', () => {
    const result = parseSheetsRange([['45%']]);
    expect(result.mode).toBe('single-cell');
    expect(result.scalarValue).toBeCloseTo(0.45);
    expect(result.errors).toHaveLength(0);
  });

  it('parses single-cell non-numeric scalar (Pattern A)', () => {
    const result = parseSheetsRange([['foo']]);
    expect(result.mode).toBe('single-cell');
    expect(result.scalarValue).toBe('foo');
    expect(result.paramPack).toBeUndefined();
    expect(result.errors).toHaveLength(0);
  });

  it('parses single-cell JSON object to param pack (Pattern B)', () => {
    const result = parseSheetsRange([[`{"p.mean": 0.5, "p.stdev": 0.1}`]]);
    expect(result.mode).toBe('param-pack');
    expect(result.scalarValue).toBeUndefined();
    expect(result.paramPack).toEqual({
      'p.mean': 0.5,
      'p.stdev': 0.1,
    });
    expect(result.errors).toHaveLength(0);
  });

  it('normalizes nested JSON objects to dotted keys in param pack (Pattern B)', () => {
    const result = parseSheetsRange([[`{"p": {"mean": 0.5, "stdev": 0.1}}`]]);
    expect(result.mode).toBe('param-pack');
    expect(result.paramPack).toEqual({
      'p.mean': 0.5,
      'p.stdev': 0.1,
    });
  });

  it('filters out empty cells and requires even number for name/value pairs (Pattern C)', () => {
    const result = parseSheetsRange([
      ['p.mean', '0.45', '   '],
      [null, undefined, 'p.stdev', '0.03'],
    ]);

    expect(result.mode).toBe('param-pack');
    expect(result.paramPack).toEqual({
      'p.mean': 0.45,
      'p.stdev': 0.03,
    });
    // No "even number" error because after filtering we have exactly 4 non-empty cells
    expect(result.errors.filter((e) => e.message.includes('even number'))).toHaveLength(0);
  });

  it('records error when name/value pairs have odd number of non-empty cells', () => {
    const result = parseSheetsRange([
      ['p.mean', '0.45', 'p.stdev'],
    ]);

    expect(result.mode).toBe('param-pack');
    expect(result.paramPack).toEqual({
      'p.mean': 0.45,
    });
    expect(result.errors.some((e) => e.message.includes('even number'))).toBe(true);
  });

  it('records error for empty name cell in name/value pairs', () => {
    const result = parseSheetsRange([
      ['', 0.45],
      ['p.mean', 0.5],
    ]);

    expect(result.mode).toBe('param-pack');
    expect(result.paramPack).toEqual({
      'p.mean': 0.5,
    });
    expect(result.errors.some((e) => e.message.includes('Empty DSL/HRN name cell'))).toBe(true);
  });
});

