/**
 * Golden parity test for computeShortCoreHash.
 *
 * Loads the shared fixture (core-hash-golden.json) and verifies the TypeScript
 * implementation produces identical core_hash values to the Python function.
 *
 * Both this test and the Python counterpart (test_core_hash_parity.py) consume
 * the same fixture — if both pass, the two languages are byte-for-byte identical.
 */
import { describe, it, expect } from 'vitest';
import { computeShortCoreHash } from '../coreHashService';
import { readFileSync } from 'fs';
import { resolve } from 'path';

interface GoldenCase {
  input: string;
  expected: string;
  description?: string;
}

// process.cwd() in vitest is the project root (graph-editor/)
const fixturePath = resolve(process.cwd(), 'lib', 'tests', 'fixtures', 'core-hash-golden.json');
const cases: GoldenCase[] = JSON.parse(readFileSync(fixturePath, 'utf-8'));

describe('computeShortCoreHash — golden parity', () => {
  it('fixture is non-empty', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c, i) => ({ ...c, _label: c.description || `case-${i}` })))(
    'golden: $_label',
    async ({ input, expected }) => {
      const result = await computeShortCoreHash(input);
      expect(result).toBe(expected);
    },
  );

  it('whitespace-padded inputs match trimmed equivalent', async () => {
    const trimmedHash = await computeShortCoreHash('{"c":"abc","x":{}}');
    for (const c of cases) {
      const desc = (c.description || '').toLowerCase();
      if (desc.includes('whitespace') || desc.includes('spaces')) {
        const result = await computeShortCoreHash(c.input);
        expect(result).toBe(trimmedHash);
      }
    }
  });

  it('throws on empty string', async () => {
    await expect(computeShortCoreHash('')).rejects.toThrow('non-empty');
  });

  it('throws on whitespace-only string', async () => {
    await expect(computeShortCoreHash('   ')).rejects.toThrow('non-empty');
  });

  it('throws on null/undefined', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(computeShortCoreHash(null as any)).rejects.toThrow('required');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(computeShortCoreHash(undefined as any)).rejects.toThrow('required');
  });
});
