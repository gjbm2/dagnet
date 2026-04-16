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

// ---------------------------------------------------------------------------
// Hash-family separation (doc 43b)
//
// The structured signature is {"c":"<identityHash>","x":{<contextDefHashes>}}.
// Bare queries have x: {}, contexted queries have x: {"dim": "<hash>"}.
// These MUST produce different core_hash values — otherwise hash-family
// separation is broken and the snapshot DB cannot distinguish bare from
// contexted data by hash alone.
//
// What real bug would this test catch?
//   - serialiseSignature ignoring the x field
//   - computeShortCoreHash not being sensitive to x differences
//   - x: {} being serialised identically to x: {"dim": "..."}
//     (e.g. if both were normalised to the same string)
// ---------------------------------------------------------------------------

describe('hash-family separation (doc 43b)', () => {
  const sameIdentityHash = 'abc123def456';

  it('bare (x={}) and contexted (x={"dim":"hash"}) produce different core_hash', async () => {
    const bareSig = JSON.stringify({ c: sameIdentityHash, x: {} });
    const ctxSig = JSON.stringify({ c: sameIdentityHash, x: { 'synth-channel': 'def789' } });

    const bareHash = await computeShortCoreHash(bareSig);
    const ctxHash = await computeShortCoreHash(ctxSig);

    expect(bareHash).not.toBe(ctxHash);
  });

  it('two different context dimensions produce different core_hash', async () => {
    const sig1 = JSON.stringify({ c: sameIdentityHash, x: { channel: 'aaa' } });
    const sig2 = JSON.stringify({ c: sameIdentityHash, x: { device: 'bbb' } });

    const hash1 = await computeShortCoreHash(sig1);
    const hash2 = await computeShortCoreHash(sig2);

    expect(hash1).not.toBe(hash2);
  });

  it('same dimension, different def hash → different core_hash', async () => {
    const sig1 = JSON.stringify({ c: sameIdentityHash, x: { channel: 'version1' } });
    const sig2 = JSON.stringify({ c: sameIdentityHash, x: { channel: 'version2' } });

    const hash1 = await computeShortCoreHash(sig1);
    const hash2 = await computeShortCoreHash(sig2);

    expect(hash1).not.toBe(hash2);
  });

  it('multi-dimension contexted differs from single-dimension', async () => {
    const single = JSON.stringify({ c: sameIdentityHash, x: { channel: 'aaa' } });
    const multi = JSON.stringify({ c: sameIdentityHash, x: { channel: 'aaa', device: 'bbb' } });

    const singleHash = await computeShortCoreHash(single);
    const multiHash = await computeShortCoreHash(multi);

    expect(singleHash).not.toBe(multiHash);
  });
});
