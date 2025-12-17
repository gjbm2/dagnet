/**
 * DSL explosion: tolerate whitespace in suffix `.or (...)`.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { explodeDSL } from '../dslExplosion';
import { contextRegistry } from '../../services/contextRegistry';

describe('explodeDSL tolerates whitespace in .or(...) suffix', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(contextRegistry, 'getValuesForContext').mockResolvedValue([{ id: 'google' }, { id: 'meta' }]);
  });

  it('handles `.or ( ... )` with a space', async () => {
    const dsl = 'or(cohort(-60d:),window(-60d:)).or (context(channel))';
    const slices = await explodeDSL(dsl);
    expect(slices).toHaveLength(4); // 2 time × 2 channel values
  });
});


