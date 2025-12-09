/**
 * Auto-Fetch Coverage Tests
 *
 * Verifies that hasFullSliceCoverageByHeader implements the contract in
 * docs/current/project-lag/auto-fetch-behaviour.md:
 *
 * - Coverage is determined by slice header ranges (window_from/window_to or
 *   cohort_from/cohort_to) within the correct slice family.
 * - Context and MECE semantics control which slices participate.
 * - Maturity, sparsity, and daily gaps do NOT affect coverage.
 */

import { describe, it, expect } from 'vitest';
import type { DateRange } from '../../types';
import type { ParameterValue } from '../paramRegistryService';
import { hasFullSliceCoverageByHeader } from '../windowAggregationService';

function makeWindowSlice(
  sliceDSL: string,
  from: string,
  to: string,
  extra?: Partial<ParameterValue>,
): ParameterValue {
  return {
    sliceDSL,
    window_from: from,
    window_to: to,
    ...extra,
  } as any as ParameterValue;
}

function makeCohortSlice(
  sliceDSL: string,
  from: string,
  to: string,
  extra?: Partial<ParameterValue>,
): ParameterValue {
  return {
    sliceDSL,
    cohort_from: from,
    cohort_to: to,
    ...extra,
  } as any as ParameterValue;
}

describe('hasFullSliceCoverageByHeader - window mode', () => {
  const requestedWindow: DateRange = { start: '1-Nov-25', end: '7-Nov-25' };

  it('returns true when a window slice header fully contains the requested window', () => {
    const paramFileData = {
      values: [
        makeWindowSlice('window(1-Nov-25:7-Nov-25)', '1-Nov-25', '7-Nov-25'),
      ],
    };

    const result = hasFullSliceCoverageByHeader(
      paramFileData,
      requestedWindow,
      'window(1-Nov-25:7-Nov-25)',
    );

    expect(result).toBe(true);
  });

  it('returns false when requested window extends beyond the slice header', () => {
    const paramFileData = {
      values: [
        makeWindowSlice('window(1-Nov-25:3-Nov-25)', '1-Nov-25', '3-Nov-25'),
      ],
    };

    const result = hasFullSliceCoverageByHeader(
      paramFileData,
      { start: '1-Nov-25', end: '7-Nov-25' },
      'window(1-Nov-25:7-Nov-25)',
    );

    expect(result).toBe(false);
  });
});

describe('hasFullSliceCoverageByHeader - context isolation', () => {
  const requestedWindow: DateRange = { start: '1-Nov-25', end: '7-Nov-25' };

  const paramFileData = {
    values: [
      makeWindowSlice(
        'window(1-Nov-25:7-Nov-25).context(channel:google)',
        '1-Nov-25',
        '7-Nov-25',
      ),
      makeWindowSlice(
        'window(1-Nov-25:7-Nov-25).context(channel:organic)',
        '1-Nov-25',
        '7-Nov-25',
      ),
    ],
  };

  it('returns true only for the matching context slice family', () => {
    const googleCovered = hasFullSliceCoverageByHeader(
      paramFileData,
      requestedWindow,
      'window(1-Nov-25:7-Nov-25).context(channel:google)',
    );
    const organicCovered = hasFullSliceCoverageByHeader(
      paramFileData,
      requestedWindow,
      'window(1-Nov-25:7-Nov-25).context(channel:organic)',
    );
    const facebookCovered = hasFullSliceCoverageByHeader(
      paramFileData,
      requestedWindow,
      'window(1-Nov-25:7-Nov-25).context(channel:facebook)',
    );

    expect(googleCovered).toBe(true);
    expect(organicCovered).toBe(true);
    expect(facebookCovered).toBe(false);
  });
});

describe('hasFullSliceCoverageByHeader - MECE uncontexted over contexted-only file', () => {
  const requestedWindow: DateRange = { start: '1-Nov-25', end: '7-Nov-25' };

  it('returns true only when all MECE component slices cover the window', () => {
    const fullCoverageData = {
      values: [
        makeWindowSlice(
          'window(1-Nov-25:7-Nov-25).context(channel:google)',
          '1-Nov-25',
          '7-Nov-25',
        ),
        makeWindowSlice(
          'window(1-Nov-25:7-Nov-25).context(channel:organic)',
          '1-Nov-25',
          '7-Nov-25',
        ),
      ],
    };

    const partialCoverageData = {
      values: [
        makeWindowSlice(
          'window(1-Nov-25:7-Nov-25).context(channel:google)',
          '1-Nov-25',
          '7-Nov-25',
        ),
        makeWindowSlice(
          'window(1-Nov-25:3-Nov-25).context(channel:organic)',
          '1-Nov-25',
          '3-Nov-25',
        ),
      ],
    };

    const fullResult = hasFullSliceCoverageByHeader(
      fullCoverageData,
      requestedWindow,
      'window(1-Nov-25:7-Nov-25)', // uncontexted query → MECE over both channels
    );
    const partialResult = hasFullSliceCoverageByHeader(
      partialCoverageData,
      requestedWindow,
      'window(1-Nov-25:7-Nov-25)',
    );

    expect(fullResult).toBe(true);
    expect(partialResult).toBe(false);
  });
});

describe('hasFullSliceCoverageByHeader - cohort mode', () => {
  const insideWindow: DateRange = { start: '1-Oct-25', end: '31-Oct-25' };
  const outsideWindow: DateRange = { start: '1-Dec-25', end: '31-Dec-25' };

  const paramFileData = {
    values: [
      makeCohortSlice(
        'cohort(landing-page,1-Sep-25:30-Nov-25)',
        '1-Sep-25',
        '30-Nov-25',
      ),
    ],
  };

  it('returns true when cohort header fully contains the requested cohort window', () => {
    const result = hasFullSliceCoverageByHeader(
      paramFileData,
      insideWindow,
      'cohort(landing-page,1-Oct-25:31-Oct-25)',
    );

    expect(result).toBe(true);
  });

  it('returns false when cohort request lies completely outside header range', () => {
    const result = hasFullSliceCoverageByHeader(
      paramFileData,
      outsideWindow,
      'cohort(landing-page,1-Dec-25:31-Dec-25)',
    );

    expect(result).toBe(false);
  });
});