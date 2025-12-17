/**
 * PinnedQueryModal – live warnings
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { PinnedQueryModal } from '../PinnedQueryModal';

// Mock QueryExpressionEditor (it pulls in TabContext + Monaco; modal tests don't need that complexity)
vi.mock('../../QueryExpressionEditor', () => ({
  QueryExpressionEditor: ({ value }: { value: string }) => (
    <div data-testid="query-expression-editor-mock">{value}</div>
  ),
}));

// Mock DSL explosion to avoid contextRegistry/network dependencies in UI tests.
vi.mock('../../../lib/dslExplosion', () => ({
  explodeDSL: vi.fn(async (dsl: string) => [dsl]),
}));

// Mock validation service to keep this as a pure UI test (service behaviour is covered separately).
vi.mock('../../../services/slicePlanValidationService', () => ({
  validatePinnedDataInterestsDSL: vi.fn(async (dsl: string) => ({
    warnings: dsl.includes('cohort(') && !dsl.includes('window(')
      ? ['Pinned data interests include cohort() slices but no window() slices.']
      : [],
    diagnostics: {
      hasExplicitWindowUncontexted: false,
      hasExplicitCohortUncontexted: false,
      hasImplicitWindowMECE: false,
      hasImplicitCohortMECE: false,
    },
  })),
}));

describe('PinnedQueryModal live warnings', () => {
  it('surfaces cohort-without-window warning while editing (no Save required)', async () => {
    vi.useFakeTimers();
    try {
      render(
        <PinnedQueryModal
          isOpen={true}
          currentDSL="(cohort(-10d:)).context(channel)"
          onSave={() => {}}
          onClose={() => {}}
        />
      );

      // Validation is debounced.
      await vi.advanceTimersByTimeAsync(300);
      await vi.runOnlyPendingTimersAsync();
      // Allow the promise chain from validatePinnedDataInterestsDSL().then(...) to flush.
      await Promise.resolve();

      expect(
        screen.getByText(/cohort\(\) slices but no window\(\) slices/i)
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});


