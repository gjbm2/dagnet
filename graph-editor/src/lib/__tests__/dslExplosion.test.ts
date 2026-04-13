/**
 * DSL Explosion — black-box specification tests.
 *
 * Tests the public contract of explodeDSL: given a compound DSL string,
 * produce the correct set of normalised atomic slices.
 *
 * Specification (from docstring):
 *   (a;b).c  =  c.(a;b)  =  or(a,b).c  =  or(a.c, b.c)  =  a.c;b.c
 *   a;b;c    =  or(a,b,c)
 *   or(a,or(b,c))  =  a;b;c
 *
 * Bare context keys: context(key) → one slice per value of that key.
 * Multiple bare keys on the SAME atomic clause → Cartesian product (simultaneous constraints).
 * Semicolon-separated bare keys → additive (alternative branches).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { explodeDSL } from '../dslExplosion';
import { contextRegistry } from '../../services/contextRegistry';

// ---------------------------------------------------------------------------
// Mock context registry — three contexts with distinct cardinalities
//   channel:  3 values  (ch-1, ch-2, ch-3)
//   geo:      2 values  (geo-1, geo-2)
//   device:   4 values  (dev-1, dev-2, dev-3, dev-4)
// ---------------------------------------------------------------------------
const CONTEXTS: Record<string, Array<{ id: string }>> = {
  channel: [{ id: 'ch-1' }, { id: 'ch-2' }, { id: 'ch-3' }],
  geo: [{ id: 'geo-1' }, { id: 'geo-2' }],
  device: [{ id: 'dev-1' }, { id: 'dev-2' }, { id: 'dev-3' }, { id: 'dev-4' }],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(contextRegistry, 'getValuesForContext').mockImplementation(
    async (key: string) => CONTEXTS[key] ?? [],
  );
});

/** Sort for order-agnostic comparison. */
const sorted = (arr: string[]) => [...arr].sort();

// ===========================================================================
// 1. Syntactic equivalences — different notation, identical slices
// ===========================================================================

describe('equivalences', () => {
  it('or(a,b) ≡ a;b', async () => {
    const withOr = await explodeDSL('or(context(channel:ch-1),context(geo:geo-1))');
    const withSemicolon = await explodeDSL('context(channel:ch-1);context(geo:geo-1)');
    expect(sorted(withOr)).toEqual(sorted(withSemicolon));
    expect(withOr).toHaveLength(2);
  });

  it('or(a,b,c) ≡ a;b;c', async () => {
    const withOr = await explodeDSL(
      'or(context(channel:ch-1),context(geo:geo-1),context(device:dev-1))',
    );
    const withSemicolon = await explodeDSL(
      'context(channel:ch-1);context(geo:geo-1);context(device:dev-1)',
    );
    expect(sorted(withOr)).toEqual(sorted(withSemicolon));
    expect(withOr).toHaveLength(3);
  });

  it('(a;b).c ≡ a.c;b.c', async () => {
    const grouped = await explodeDSL(
      '(context(channel:ch-1);context(channel:ch-2)).window(-30d:)',
    );
    const flat = await explodeDSL(
      'context(channel:ch-1).window(-30d:);context(channel:ch-2).window(-30d:)',
    );
    expect(sorted(grouped)).toEqual(sorted(flat));
    expect(grouped).toHaveLength(2);
  });

  it('c.(a;b) ≡ a.c;b.c', async () => {
    const prefixDot = await explodeDSL(
      'window(-30d:).(context(channel:ch-1);context(channel:ch-2))',
    );
    const flat = await explodeDSL(
      'context(channel:ch-1).window(-30d:);context(channel:ch-2).window(-30d:)',
    );
    expect(sorted(prefixDot)).toEqual(sorted(flat));
    expect(prefixDot).toHaveLength(2);
  });

  it('or(a,b).c ≡ (a;b).c', async () => {
    const orForm = await explodeDSL(
      'or(context(channel:ch-1),context(channel:ch-2)).window(-30d:)',
    );
    const parenForm = await explodeDSL(
      '(context(channel:ch-1);context(channel:ch-2)).window(-30d:)',
    );
    expect(sorted(orForm)).toEqual(sorted(parenForm));
  });

  it('c.or(a,b) ≡ c.(a;b)', async () => {
    const orForm = await explodeDSL(
      'window(-30d:).or(context(channel:ch-1),context(channel:ch-2))',
    );
    const parenForm = await explodeDSL(
      'window(-30d:).(context(channel:ch-1);context(channel:ch-2))',
    );
    expect(sorted(orForm)).toEqual(sorted(parenForm));
  });

  it('(a;b).(c;d) ≡ a.c;a.d;b.c;b.d', async () => {
    const grouped = await explodeDSL(
      '(window(-30d:);cohort(-30d:)).(context(channel:ch-1);context(geo:geo-1))',
    );
    const flat = await explodeDSL(
      'window(-30d:).context(channel:ch-1);window(-30d:).context(geo:geo-1);cohort(-30d:).context(channel:ch-1);cohort(-30d:).context(geo:geo-1)',
    );
    expect(sorted(grouped)).toEqual(sorted(flat));
    expect(grouped).toHaveLength(4);
  });

  it('or(a,b).or(c,d) ≡ (a;b).(c;d)', async () => {
    const orOr = await explodeDSL(
      'or(window(-30d:),cohort(-30d:)).or(context(channel:ch-1),context(geo:geo-1))',
    );
    const parenParen = await explodeDSL(
      '(window(-30d:);cohort(-30d:)).(context(channel:ch-1);context(geo:geo-1))',
    );
    expect(sorted(orOr)).toEqual(sorted(parenParen));
  });

  it('or(a,or(b,c)) ≡ a;b;c', async () => {
    const nested = await explodeDSL(
      'or(context(channel:ch-1),or(context(geo:geo-1),context(device:dev-1)))',
    );
    const flat = await explodeDSL(
      'context(channel:ch-1);context(geo:geo-1);context(device:dev-1)',
    );
    expect(sorted(nested)).toEqual(sorted(flat));
    expect(nested).toHaveLength(3);
  });

  it('((a;b);c) ≡ a;b;c — nested parens flatten', async () => {
    const nested = await explodeDSL(
      '((context(channel:ch-1);context(channel:ch-2));context(geo:geo-1))',
    );
    expect(nested).toHaveLength(3);
  });
});

// ===========================================================================
// 2. Distribution — prefix × suffix branching
// ===========================================================================

describe('distribution', () => {
  it('2 prefixes × 3 suffixes = 6 slices', async () => {
    const result = await explodeDSL(
      '(window(-30d:);cohort(-30d:)).(context(channel:ch-1);context(channel:ch-2);context(channel:ch-3))',
    );
    expect(result).toHaveLength(6);
    // Every prefix appears with every suffix
    for (const time of ['window(-30d:)', 'cohort(-30d:)']) {
      for (const ctx of ['context(channel:ch-1)', 'context(channel:ch-2)', 'context(channel:ch-3)']) {
        expect(result.some(s => s.includes(time) && s.includes(ctx))).toBe(true);
      }
    }
  });

  it('3 prefixes × 2 suffixes = 6 slices', async () => {
    const result = await explodeDSL(
      '(context(channel:ch-1);context(channel:ch-2);context(channel:ch-3)).(window(-7d:);window(-30d:))',
    );
    expect(result).toHaveLength(6);
  });

  it('distribution preserves all constraint parts on each slice', async () => {
    const result = await explodeDSL(
      '(window(-7d:);cohort(-30d:)).context(channel:ch-1)',
    );
    expect(result).toHaveLength(2);
    expect(result.some(s => s.includes('window(-7d:)') && s.includes('context(channel:ch-1)'))).toBe(true);
    expect(result.some(s => s.includes('cohort(-30d:)') && s.includes('context(channel:ch-1)'))).toBe(true);
  });
});

// ===========================================================================
// 3. Bare key expansion — additive vs multiplicative
// ===========================================================================

describe('bare key expansion', () => {
  it('single bare key expands to N slices', async () => {
    const result = await explodeDSL('context(channel)');
    expect(result).toHaveLength(3);
    expect(result).toContain('context(channel:ch-1)');
    expect(result).toContain('context(channel:ch-2)');
    expect(result).toContain('context(channel:ch-3)');
  });

  it('two bare keys on same clause → Cartesian product (N×M)', async () => {
    // context(channel).context(geo) = both constraints simultaneously
    const result = await explodeDSL('context(channel).context(geo)');
    expect(result).toHaveLength(3 * 2); // 6
    // Spot check: every channel paired with every geo
    expect(result.some(s => s.includes('channel:ch-1') && s.includes('geo:geo-2'))).toBe(true);
    expect(result.some(s => s.includes('channel:ch-3') && s.includes('geo:geo-1'))).toBe(true);
  });

  it('two bare keys semicolon-separated → additive (N+M)', async () => {
    const result = await explodeDSL('context(channel);context(geo)');
    expect(result).toHaveLength(3 + 2); // 5
    // No slice should contain both a channel and a geo value
    for (const s of result) {
      const hasChannel = s.includes('channel:');
      const hasGeo = s.includes('geo:');
      expect(hasChannel && hasGeo).toBe(false);
    }
  });

  it('three bare keys semicolon-separated → additive (N+M+P)', async () => {
    const result = await explodeDSL('context(channel);context(geo);context(device)');
    expect(result).toHaveLength(3 + 2 + 4); // 9
  });

  it('(time;time).(ctx;ctx;ctx) with bare keys → 2×(N+M+P) not 2×N×M×P', async () => {
    // THE BUG CASE: this is the pattern that produced 280 instead of 32
    const result = await explodeDSL(
      '(window(-30d:);cohort(-30d:)).(context(channel);context(geo);context(device))',
    );
    const additive = 2 * (3 + 2 + 4);     // 18
    const multiplicative = 2 * (3 * 2 * 4); // 48
    expect(result).toHaveLength(additive);
    expect(result).not.toHaveLength(multiplicative);
  });

  it('or() form of same pattern → same additive result', async () => {
    const parenForm = await explodeDSL(
      '(window(-30d:);cohort(-30d:)).(context(channel);context(geo);context(device))',
    );
    const orForm = await explodeDSL(
      'or(window(-30d:),cohort(-30d:)).or(context(channel),context(geo),context(device))',
    );
    expect(sorted(parenForm)).toEqual(sorted(orForm));
  });

  it('bare key with fixed prefix → prefix on every expanded slice', async () => {
    const result = await explodeDSL('window(-30d:).context(geo)');
    expect(result).toHaveLength(2);
    expect(result.every(s => s.includes('window(-30d:)'))).toBe(true);
    expect(result.some(s => s.includes('geo:geo-1'))).toBe(true);
    expect(result.some(s => s.includes('geo:geo-2'))).toBe(true);
  });

  it('mixed bare and pinned contexts are not confused', async () => {
    // context(channel) is bare (expand), context(geo:geo-1) is pinned (keep)
    const result = await explodeDSL('context(channel).context(geo:geo-1)');
    expect(result).toHaveLength(3); // one per channel value, each with geo:geo-1
    for (const s of result) {
      expect(s).toContain('context(geo:geo-1)');
    }
  });
});

// ===========================================================================
// 4. Nesting depth
// ===========================================================================

describe('nesting', () => {
  it('deeply nested or() flattens', async () => {
    const result = await explodeDSL(
      'or(context(channel:ch-1),or(context(channel:ch-2),or(context(channel:ch-3),context(geo:geo-1))))',
    );
    expect(result).toHaveLength(4);
  });

  it('nested parens with distribution', async () => {
    // ((a;b);c).d should produce 3 slices, each with d
    const result = await explodeDSL(
      '((context(channel:ch-1);context(channel:ch-2));context(geo:geo-1)).window(-7d:)',
    );
    expect(result).toHaveLength(3);
    expect(result.every(s => s.includes('window(-7d:)'))).toBe(true);
  });

  it('distribution on both sides with nested or()', async () => {
    const result = await explodeDSL(
      'or(window(-7d:),cohort(-30d:)).or(context(channel:ch-1),or(context(geo:geo-1),context(geo:geo-2)))',
    );
    expect(result).toHaveLength(2 * 3); // 6
  });
});

// ===========================================================================
// 5. Edge cases and passthrough
// ===========================================================================

describe('edge cases', () => {
  it('empty string → no slices', async () => {
    expect(await explodeDSL('')).toEqual([]);
    expect(await explodeDSL('   ')).toEqual([]);
  });

  it('single atomic slice passes through unchanged', async () => {
    const result = await explodeDSL('context(channel:ch-1).window(-30d:)');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('context(channel:ch-1)');
    expect(result[0]).toContain('window(-30d:)');
  });

  it('contextAny is not expanded (passthrough)', async () => {
    const result = await explodeDSL('contextAny(channel:ch-1,geo:geo-1)');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('contextAny(');
  });

  it('cohort anchor is preserved', async () => {
    const result = await explodeDSL('cohort(start-node,-14d:).context(channel:ch-1)');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('cohort(start-node,-14d:)');
  });

  it('whitespace tolerance in or()', async () => {
    const result = await explodeDSL('or( context(channel:ch-1) , context(channel:ch-2) )');
    expect(result).toHaveLength(2);
  });

  it('bare key for unknown context returns no slices for that branch', async () => {
    const result = await explodeDSL('context(nonexistent)');
    expect(result).toHaveLength(0);
  });

  it('bare key for unknown context alongside known → only known slices', async () => {
    const result = await explodeDSL('context(channel);context(nonexistent)');
    // channel expands to 3, nonexistent expands to 0
    expect(result).toHaveLength(3);
  });
});

// ===========================================================================
// 6. Real-world patterns
// ===========================================================================

describe('real-world patterns', () => {
  it('forecasting retrieval pattern: (window;cohort).(ctx;ctx;ctx) with bare keys', async () => {
    // Simulates the exact pattern that triggered the bug report
    const result = await explodeDSL(
      '(window(-30d:);cohort(-30d:)).(context(channel);context(geo);context(device))',
    );
    // 2 time branches × (3 + 2 + 4) context branches = 18
    expect(result).toHaveLength(18);

    // Each time branch paired with each individual context value
    const windowSlices = result.filter(s => s.includes('window(-30d:)'));
    const cohortSlices = result.filter(s => s.includes('cohort(-30d:)'));
    expect(windowSlices).toHaveLength(9);
    expect(cohortSlices).toHaveLength(9);

    // No slice should have values from two different context keys
    for (const s of result) {
      const keys = ['channel:', 'geo:', 'device:'].filter(k => s.includes(k));
      expect(keys).toHaveLength(1);
    }
  });

  it('pinned retrieval: (window;cohort).(pinned;pinned;pinned)', async () => {
    const result = await explodeDSL(
      '(window(-30d:);cohort(-30d:)).(context(channel:ch-1);context(geo:geo-1);context(device:dev-1))',
    );
    // 2 × 3 = 6 (no bare key expansion needed)
    expect(result).toHaveLength(6);
  });

  it('mixed bare and pinned in suffix group', async () => {
    const result = await explodeDSL(
      '(window(-30d:);cohort(-30d:)).(context(channel);context(geo:geo-1))',
    );
    // channel expands to 3, geo:geo-1 is 1 pinned slice → 2 × (3 + 1) = 8
    expect(result).toHaveLength(8);
  });

  it('single time with multiple context branches', async () => {
    const result = await explodeDSL(
      'window(-30d:).(context(channel);context(geo))',
    );
    // 1 × (3 + 2) = 5
    expect(result).toHaveLength(5);
  });

  it('or-style time with or-style contexts', async () => {
    const result = await explodeDSL(
      'or(window(-30d:),cohort(-30d:)).or(context(channel),context(geo))',
    );
    // 2 × (3 + 2) = 10
    expect(result).toHaveLength(10);
  });
});

// ===========================================================================
// 7. Reordering, commutativity, and mixed nesting
// ===========================================================================

describe('reordering and mixed nesting', () => {
  it('context;window;context — interleaved semicolons at top level → 3 additive branches', async () => {
    // Three top-level semicolon branches: two contexts and one window
    const result = await explodeDSL(
      'context(channel:ch-1);window(-30d:);context(geo:geo-1)',
    );
    expect(result).toHaveLength(3);
    expect(result.some(s => s.includes('context(channel:ch-1)'))).toBe(true);
    expect(result.some(s => s.includes('window(-30d:)'))).toBe(true);
    expect(result.some(s => s.includes('context(geo:geo-1)'))).toBe(true);
  });

  it('context(a).(window;context(b)) — dot-product with mixed group → 2 branches each with context(a)', async () => {
    // context(channel:ch-1) composed with (window(-30d:) OR context(geo:geo-1))
    // = context(channel:ch-1).window(-30d:) ; context(channel:ch-1).context(geo:geo-1)
    const result = await explodeDSL(
      'context(channel:ch-1).(window(-30d:);context(geo:geo-1))',
    );
    expect(result).toHaveLength(2);
    expect(result.every(s => s.includes('context(channel:ch-1)'))).toBe(true);
    expect(result.some(s => s.includes('window(-30d:)'))).toBe(true);
    expect(result.some(s => s.includes('context(geo:geo-1)'))).toBe(true);
  });

  it('(context(a);window).(context(b);cohort) — mixed types on both sides → 4 branches', async () => {
    // (context(channel:ch-1) OR window(-30d:)) × (context(geo:geo-1) OR cohort(-30d:))
    // = context(channel:ch-1).context(geo:geo-1)
    //   context(channel:ch-1).cohort(-30d:)
    //   window(-30d:).context(geo:geo-1)
    //   window(-30d:).cohort(-30d:)
    const result = await explodeDSL(
      '(context(channel:ch-1);window(-30d:)).(context(geo:geo-1);cohort(-30d:))',
    );
    expect(result).toHaveLength(4);
    // Check each expected combination exists
    expect(result.some(s => s.includes('channel:ch-1') && s.includes('geo:geo-1'))).toBe(true);
    expect(result.some(s => s.includes('channel:ch-1') && s.includes('cohort(-30d:)'))).toBe(true);
    expect(result.some(s => s.includes('window(-30d:)') && s.includes('geo:geo-1'))).toBe(true);
    expect(result.some(s => s.includes('window(-30d:)') && s.includes('cohort(-30d:)'))).toBe(true);
  });

  it('commutativity: A.B ≡ B.A for pinned terms', async () => {
    const ab = await explodeDSL('context(channel:ch-1).window(-30d:)');
    const ba = await explodeDSL('window(-30d:).context(channel:ch-1)');
    expect(ab).toHaveLength(1);
    expect(ba).toHaveLength(1);
    // Both should produce the same normalised slice (order may differ but both constraints present)
    expect(ab[0].includes('channel:ch-1') && ab[0].includes('window(-30d:)')).toBe(true);
    expect(ba[0].includes('channel:ch-1') && ba[0].includes('window(-30d:)')).toBe(true);
  });

  it('commutativity: (A;B).C ≡ C.(A;B) for mixed groups', async () => {
    const prefixed = await explodeDSL(
      '(context(channel:ch-1);context(geo:geo-1)).window(-30d:)',
    );
    const suffixed = await explodeDSL(
      'window(-30d:).(context(channel:ch-1);context(geo:geo-1))',
    );
    expect(sorted(prefixed)).toEqual(sorted(suffixed));
    expect(prefixed).toHaveLength(2);
  });

  it('bare key context(a).(window;context(b)) — bare a expands, b stays pinned', async () => {
    // context(channel) bare × (window OR context(geo:geo-1) pinned)
    // = 3 × 2 = 6 (each channel value paired with window, then with geo:geo-1)
    const result = await explodeDSL(
      'context(channel).(window(-30d:);context(geo:geo-1))',
    );
    expect(result).toHaveLength(3 * 2); // 6
    // Each channel value appears with window and with geo:geo-1
    for (const ch of ['ch-1', 'ch-2', 'ch-3']) {
      expect(result.some(s => s.includes(`channel:${ch}`) && s.includes('window(-30d:)'))).toBe(true);
      expect(result.some(s => s.includes(`channel:${ch}`) && s.includes('geo:geo-1'))).toBe(true);
    }
  });

  it('bare key in mixed position: (window;cohort).context(a).(context(b);context(c))', async () => {
    // 2 time modes × 3 channel values × (2 geo + 4 device) = 2 × 3 × 6 = 36?
    // NO — context(a) is bare (Cartesian with everything on its clause),
    // but (context(b);context(c)) is semicolon (additive in suffix group).
    // Parse: (window;cohort).context(channel).(context(geo);context(device))
    // Step 1: distribute (window;cohort) → 2 branches
    // Step 2: each branch gets .context(channel).(context(geo);context(device))
    // Step 3: (context(geo);context(device)) is additive → 2 + 4 = 6 branches
    // Step 4: .context(channel) is dot-product with each → 3 × 6 = 18 per time branch?
    // Actually: context(channel) is bare key on the SAME clause as context(geo:X) or context(device:X)
    //   so it's Cartesian: channel × geo = 3×2 = 6, channel × device = 3×4 = 12
    //   total per time branch: 6 + 12 = 18, times 2 = 36
    const result = await explodeDSL(
      '(window(-30d:);cohort(-30d:)).context(channel).(context(geo);context(device))',
    );
    // 2 × (3×2 + 3×4) = 2 × (6 + 12) = 36
    expect(result).toHaveLength(36);
    // Spot check: window + channel:ch-1 + geo:geo-1 should exist
    expect(result.some(s =>
      s.includes('window(-30d:)') && s.includes('channel:ch-1') && s.includes('geo:geo-1')
    )).toBe(true);
    // And window + channel:ch-2 + device:dev-3 should exist
    expect(result.some(s =>
      s.includes('window(-30d:)') && s.includes('channel:ch-2') && s.includes('device:dev-3')
    )).toBe(true);
  });

  it('triple dot-product with reordering: context(b).context(a).window ≡ window.context(a).context(b)', async () => {
    const order1 = await explodeDSL('context(geo).context(channel).window(-30d:)');
    const order2 = await explodeDSL('window(-30d:).context(channel).context(geo)');
    // Both should produce 3×2 = 6 slices (Cartesian of channel × geo, each with window)
    expect(order1).toHaveLength(6);
    expect(order2).toHaveLength(6);
    // Same set of slices regardless of term order
    expect(sorted(order1)).toEqual(sorted(order2));
  });
});

// ===========================================================================
// 8. Uncontexted slice via context() / trailing separator (doc 30 §10)
// ===========================================================================

describe('uncontexted slice inclusion', () => {
  it('context(channel);context() produces contexted + uncontexted slices', async () => {
    const slices = await explodeDSL('window(-90d:).(context(channel);context())');
    // 3 channel values + 1 uncontexted
    expect(slices).toHaveLength(4);
    // Should contain bare window (uncontexted)
    const bare = slices.filter(s => !s.includes('context('));
    expect(bare).toHaveLength(1);
    expect(bare[0]).toMatch(/window\(/);
    // Should contain 3 channel slices
    const contexted = slices.filter(s => s.includes('context(channel:'));
    expect(contexted).toHaveLength(3);
  });

  it('trailing semicolon produces uncontexted: context(channel);', async () => {
    const slices = await explodeDSL('window(-90d:).(context(channel);)');
    expect(slices).toHaveLength(4);
    const bare = slices.filter(s => !s.includes('context('));
    expect(bare).toHaveLength(1);
  });

  it('leading semicolon produces uncontexted: ;context(channel)', async () => {
    const slices = await explodeDSL('window(-90d:).(;context(channel))');
    expect(slices).toHaveLength(4);
    const bare = slices.filter(s => !s.includes('context('));
    expect(bare).toHaveLength(1);
  });

  it('or(context(channel),) produces contexted + uncontexted', async () => {
    const slices = await explodeDSL('window(-90d:).or(context(channel),)');
    expect(slices).toHaveLength(4);
    const bare = slices.filter(s => !s.includes('context('));
    expect(bare).toHaveLength(1);
  });

  it('or(,context(channel)) produces uncontexted + contexted', async () => {
    const slices = await explodeDSL('window(-90d:).or(,context(channel))');
    expect(slices).toHaveLength(4);
    const bare = slices.filter(s => !s.includes('context('));
    expect(bare).toHaveLength(1);
  });

  it('all forms are equivalent', async () => {
    const form1 = await explodeDSL('window(-90d:).(context(channel);context())');
    const form2 = await explodeDSL('window(-90d:).(context(channel);)');
    const form3 = await explodeDSL('window(-90d:).(;context(channel))');
    const form4 = await explodeDSL('window(-90d:).or(context(channel),)');
    const form5 = await explodeDSL('window(-90d:).or(,context(channel))');
    expect(sorted(form1)).toEqual(sorted(form2));
    expect(sorted(form1)).toEqual(sorted(form3));
    expect(sorted(form1)).toEqual(sorted(form4));
    expect(sorted(form1)).toEqual(sorted(form5));
  });

  it('multi-mode with uncontexted: (window;cohort).(context(channel);context())', async () => {
    const slices = await explodeDSL('(window(-90d:);cohort(-90d:)).(context(channel);context())');
    // 3 channel × 2 modes + 2 uncontexted (one per mode) = 8
    expect(slices).toHaveLength(8);
    const bare = slices.filter(s => !s.includes('context('));
    expect(bare).toHaveLength(2); // window + cohort uncontexted
  });

  it('context() alone with no other context is just the bare slice', async () => {
    const slices = await explodeDSL('window(-90d:).context()');
    // context() with no sibling = just the uncontexted slice
    expect(slices).toHaveLength(1);
    expect(slices[0]).not.toContain('context(');
    expect(slices[0]).toMatch(/window\(/);
  });
});
