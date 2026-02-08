import { describe, expect, it } from 'vitest';
import { LIVE_EMPTY_DIFF_DSL, deriveBaseDSLForRebase, diffQueryDSLFromBase } from '../scenarioRegenerationService';

describe('deriveBaseDSLForRebase', () => {
  it('extracts cohort window from current DSL and drops context', () => {
    const dsl = deriveBaseDSLForRebase('context(channel:influencer).cohort(17-Nov-25:16-Dec-25)');
    expect(dsl).toBe('cohort(17-Nov-25:16-Dec-25)');
  });

  it('extracts window range from current DSL and drops context', () => {
    const dsl = deriveBaseDSLForRebase('window(17-Nov-25:16-Dec-25).context(channel:paid-search)');
    expect(dsl).toBe('window(17-Nov-25:16-Dec-25)');
  });

  it('preserves asat() when deriving base DSL', () => {
    const dsl = deriveBaseDSLForRebase('context(channel:influencer).cohort(17-Nov-25:16-Dec-25).asat(5-Jan-26)');
    expect(dsl).toBe('cohort(17-Nov-25:16-Dec-25).asat(5-Jan-26)');
  });

  it('returns empty when current DSL has no window/cohort', () => {
    const dsl = deriveBaseDSLForRebase('visited(foo).case(bar:baz)');
    expect(dsl).toBe('');
  });
});

describe('diffQueryDSLFromBase', () => {
  it('returns context-only diff when base has cohort window and current adds a context value', () => {
    const diff = diffQueryDSLFromBase(
      'cohort(17-Nov-25:16-Dec-25)',
      'cohort(17-Nov-25:16-Dec-25).context(channel:influencer)'
    );
    expect(diff).toBe('context(channel:influencer)');
  });

  it('includes asat() when current adds it relative to base', () => {
    const diff = diffQueryDSLFromBase(
      'cohort(17-Nov-25:16-Dec-25)',
      'cohort(17-Nov-25:16-Dec-25).asat(5-Jan-26)'
    );
    expect(diff).toBe('asat(5-Jan-26)');
  });

  it('returns empty diff when current equals base (for tracked parts)', () => {
    const diff = diffQueryDSLFromBase(
      'cohort(17-Nov-25:16-Dec-25)',
      'cohort(17-Nov-25:16-Dec-25)'
    );
    expect(diff).toBe(LIVE_EMPTY_DIFF_DSL);
  });
});


