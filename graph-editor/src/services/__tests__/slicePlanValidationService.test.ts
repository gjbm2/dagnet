/**
 * slicePlanValidationService – pinned DSL warnings
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validatePinnedDataInterestsDSL } from '../slicePlanValidationService';
import { contextRegistry } from '../contextRegistry';

describe('validatePinnedDataInterestsDSL', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('warns when neither explicit nor implicit uncontexted support is present for window/cohort', async () => {
    vi.spyOn(contextRegistry, 'detectMECEPartition').mockResolvedValue({
      isMECE: true,
      isComplete: false,
      canAggregate: false,
      missingValues: ['x'],
      policy: 'null',
    });

    const res = await validatePinnedDataInterestsDSL('context(channel:google).window(1-Dec-25:3-Dec-25)');
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('does not warn when explicit uncontexted window and cohort slices exist', async () => {
    const res = await validatePinnedDataInterestsDSL('window(1-Dec-25:3-Dec-25);cohort(A,1-Dec-25:3-Dec-25)');
    expect(res.warnings).toEqual([]);
  });
});


