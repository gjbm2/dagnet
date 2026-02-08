import { describe, expect, it } from 'vitest';
import { generateSmartLabel, normaliseScenarioDateRangeDSL } from '../scenarioRegenerationService';

describe('normaliseScenarioDateRangeDSL', () => {
  it('converts window() to cohort() in cohort mode and drops window()', () => {
    const out = normaliseScenarioDateRangeDSL('window(-7d:-1d).context(channel:google)', 'cohort');
    expect(out).toBe('cohort(-7d:-1d).context(channel:google)');
  });

  it('converts cohort() to window() in window mode and drops cohort()', () => {
    const out = normaliseScenarioDateRangeDSL('cohort(1-Nov-25:7-Nov-25).context(channel:google)', 'window');
    expect(out).toBe('window(1-Nov-25:7-Nov-25).context(channel:google)');
  });

  it('preserves asat() while normalising date range mode', () => {
    const out = normaliseScenarioDateRangeDSL('window(-7d:-1d).context(channel:google).asat(5-Jan-26)', 'cohort');
    expect(out).toBe('cohort(-7d:-1d).context(channel:google).asat(5-Jan-26)');
  });
});

describe('generateSmartLabel (cohort)', () => {
  it('includes cohort date range in label', () => {
    const label = generateSmartLabel('cohort(1-Nov-25:7-Nov-25)');
    expect(label).toBe('Cohort: 1-Nov – 7-Nov');
  });

  it('includes cohort anchor in label when present', () => {
    const label = generateSmartLabel('cohort(A,-7d:-1d)');
    expect(label).toBe('Cohort(A): 7d ago – 1d ago');
  });

  it('includes asat() in label when present', () => {
    const label = generateSmartLabel('cohort(1-Nov-25:7-Nov-25).asat(5-Jan-26)');
    expect(label).toContain('Cohort: 1-Nov – 7-Nov');
    expect(label).toContain('As-at: 5-Jan');
  });
});


