/**
 * Unit tests for the asat slice-family matcher in fileToGraphSync.
 *
 * Reviewer #6 (29-Apr-26 morning): pre-fix the asat reconstruction
 * loop overwrote every values[] entry with the queried slice's data,
 * clobbering unrelated slices. The matcher selects only entries
 * whose own slice family matches the asat query.
 *
 * Reviewer-M2 follow-up (29-Apr-26 evening): the matcher initially
 * reduced ALL cohorts to family `cohort()`, ignoring the cohort
 * anchor — but anchor != X means a genuinely different population
 * per 73h §"population identity". Cohort or window date BOUNDS,
 * however, are query filters over a single time series, not
 * population identity — including bounds in the family broke every
 * pre-existing asat-tier-2 fixture (synth files store bounds that
 * differ from query bounds). Final shape: family = context dims +
 * mode + cohort anchor (no bounds).
 */

import { describe, it, expect } from 'vitest';
import { __asatTesting } from '../dataOperations/fileToGraphSync';

const { selectAsatTargetValues, valueFamilyKey, familyKeyFromDSL } = __asatTesting;

describe('asat slice-family matcher', () => {
  describe('valueFamilyKey', () => {
    it('encodes cohort anchor in the family key', () => {
      expect(valueFamilyKey({ sliceDSL: 'cohort(simple-a, 1-Apr-26:30-Apr-26)' }))
        .toBe('cohort(simple-a)');
    });

    it('treats different cohort date bounds as the same family — bounds are query filters', () => {
      const k1 = valueFamilyKey({ sliceDSL: 'cohort(simple-a, 1-Mar-26:31-Mar-26)' });
      const k2 = valueFamilyKey({ sliceDSL: 'cohort(simple-a, 1-Apr-26:30-Apr-26)' });
      expect(k1).toBe(k2);
      expect(k1).toBe('cohort(simple-a)');
    });

    it('distinguishes cohorts with different anchors — anchor IS population identity', () => {
      const k1 = valueFamilyKey({ sliceDSL: 'cohort(simple-a, 1-Apr-26:30-Apr-26)' });
      const k2 = valueFamilyKey({ sliceDSL: 'cohort(simple-b, 1-Apr-26:30-Apr-26)' });
      expect(k1).not.toBe(k2);
    });

    it('treats different window date bounds as the same family', () => {
      const k1 = valueFamilyKey({ sliceDSL: 'window(-90d:)' });
      const k2 = valueFamilyKey({ sliceDSL: 'window(12-Dec-25:20-Mar-26)' });
      expect(k1).toBe('window()');
      expect(k2).toBe('window()');
    });

    it('preserves context dims + mode + cohort anchor', () => {
      const k = valueFamilyKey({
        sliceDSL: 'context(channel:google).cohort(simple-a, 1-Apr-26:30-Apr-26)',
      });
      expect(k).toContain('context(channel:google)');
      expect(k).toContain('cohort(simple-a)');
    });

    it('returns empty string for missing or empty sliceDSL', () => {
      expect(valueFamilyKey({})).toBe('');
      expect(valueFamilyKey({ sliceDSL: '' })).toBe('');
      expect(valueFamilyKey(null)).toBe('');
    });
  });

  describe('familyKeyFromDSL strips asat clause', () => {
    it('strips asat() — asat is a frontier on a population, not a population identity', () => {
      const withAsat = familyKeyFromDSL('cohort(simple-a, 1-Apr-26:30-Apr-26).asat(15-Apr-26)');
      const withoutAsat = familyKeyFromDSL('cohort(simple-a, 1-Apr-26:30-Apr-26)');
      expect(withAsat).toBe(withoutAsat);
    });
  });

  describe('selectAsatTargetValues', () => {
    it('returns the single bare value entry for legacy single-slice files (back-compat)', () => {
      const values = [{ n_daily: [1, 2, 3], k_daily: [0, 1, 1] }];
      expect(selectAsatTargetValues(values, 'cohort(simple-a)')).toEqual(values);
    });

    it('matches all stored cohorts for the same anchor regardless of bounds (bounds are filters)', () => {
      const v1 = { sliceDSL: 'cohort(simple-a, 1-Mar-26:31-Mar-26)', mark: 'mar' };
      const v2 = { sliceDSL: 'cohort(simple-a, 1-Apr-26:30-Apr-26)', mark: 'apr' };
      const v3 = { sliceDSL: 'cohort(simple-b, 1-Apr-26:30-Apr-26)', mark: 'b-apr' };

      const aKey = familyKeyFromDSL('cohort(simple-a, 1-Apr-26:30-Apr-26).asat(15-Apr-26)');
      // simple-a matches both v1 and v2; simple-b excluded.
      expect(selectAsatTargetValues([v1, v2, v3], aKey)).toEqual([v1, v2]);

      const bKey = familyKeyFromDSL('cohort(simple-b, 1-Apr-26:30-Apr-26).asat(15-Apr-26)');
      expect(selectAsatTargetValues([v1, v2, v3], bKey)).toEqual([v3]);
    });

    it('returns only the values matching the target family — leaves others untouched', () => {
      const a = { sliceDSL: 'context(channel:google).cohort(simple-a, 1-Apr-26:30-Apr-26)', mark: 'A' };
      const b = { sliceDSL: 'context(channel:facebook).cohort(simple-a, 1-Apr-26:30-Apr-26)', mark: 'B' };
      const c = { sliceDSL: 'cohort(simple-a, 1-Apr-26:30-Apr-26)', mark: 'C' };

      const googleKey = familyKeyFromDSL('context(channel:google).cohort(simple-a, 1-Apr-26:30-Apr-26)');
      expect(selectAsatTargetValues([a, b, c], googleKey)).toEqual([a]);

      const fbKey = familyKeyFromDSL('context(channel:facebook).cohort(simple-a, 1-Apr-26:30-Apr-26)');
      expect(selectAsatTargetValues([a, b, c], fbKey)).toEqual([b]);

      const bareKey = familyKeyFromDSL('cohort(simple-a, 1-Apr-26:30-Apr-26)');
      expect(selectAsatTargetValues([a, b, c], bareKey)).toEqual([c]);
    });

    it('returns an empty list when no family matches', () => {
      const values = [
        { sliceDSL: 'window(-90d:)' },
        { sliceDSL: 'context(channel:google).cohort(simple-a, 1-Apr-26:30-Apr-26)' },
      ];
      const fbKey = familyKeyFromDSL('context(channel:facebook).cohort(simple-a, 1-Apr-26:30-Apr-26)');
      expect(selectAsatTargetValues(values, fbKey)).toEqual([]);
    });

    it('does not match cohort to window (and vice versa)', () => {
      const cohortV = { sliceDSL: 'cohort(simple-a, 1-Apr-26:30-Apr-26)' };
      const windowV = { sliceDSL: 'window(-90d:)' };
      const values = [cohortV, windowV];

      const cohortKey = familyKeyFromDSL('cohort(simple-a, 1-Apr-26:30-Apr-26)');
      expect(selectAsatTargetValues(values, cohortKey)).toEqual([cohortV]);

      const windowKey = familyKeyFromDSL('window(-90d:)');
      expect(selectAsatTargetValues(values, windowKey)).toEqual([windowV]);
    });

    it('handles empty / missing values arrays defensively', () => {
      expect(selectAsatTargetValues([], 'cohort(simple-a)')).toEqual([]);
      expect(selectAsatTargetValues(null as unknown as any[], 'cohort(simple-a)')).toEqual([]);
    });
  });
});
