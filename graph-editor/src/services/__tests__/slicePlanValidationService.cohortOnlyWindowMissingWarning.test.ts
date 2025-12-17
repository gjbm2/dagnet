/**
 * slicePlanValidationService – cohort-only pinned DSL warning
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { validatePinnedDataInterestsDSL } from '../slicePlanValidationService';

describe('validatePinnedDataInterestsDSL (cohort-only plan)', () => {
  it('warns when pinned DSL includes cohort() slices but no window() slices', async () => {
    const res = await validatePinnedDataInterestsDSL('or(cohort(-10d:)).context(channel)');
    expect(res.warnings.join('\n')).toContain('cohort() slices but no window() slices');
  });
});


