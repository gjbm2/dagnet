/**
 * TS/Py promotion-parity contract — doc 73b §3.2.
 *
 * `applyPromotion` (TS) and `resolve_model_params` (Py) are the only
 * computers of the promoted scalars. They MUST agree on which source
 * promotes and on the promoted latency parameters for the same input.
 *
 * Fixture: graph-editor/lib/tests/fixtures/promotion-parity/cases.json.
 * Python sibling: graph-editor/lib/tests/test_model_resolver.py
 * (TestPromotionParityWithTS). Both sides load the same JSON.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyPromotion } from '../modelVarsResolution';
import type { GraphModelSourcePreference, ProbabilityParam } from '../../types';

interface ParityCase {
  name: string;
  edge: { p: ProbabilityParam };
  graph_preference: GraphModelSourcePreference | null;
  expected: {
    source?: string;
    prob_mean?: number;
    prob_stdev?: number;
    lat_mu?: number;
    lat_sigma?: number;
    lat_t95?: number;
    lat_onset_delta_days?: number;
    lat_mu_sd?: number;
    lat_sigma_sd?: number;
    lat_onset_sd?: number;
    lat_onset_mu_corr?: number;
  };
}

function loadCases(): ParityCase[] {
  const fixturePath = resolve(
    __dirname,
    '../../../lib/tests/fixtures/promotion-parity/cases.json',
  );
  const json = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  return json.cases as ParityCase[];
}

describe('Promotion parity (doc 73b §3.2) — shared fixture with Py resolver', () => {
  const cases = loadCases();

  it('loads the shared fixture matrix', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(`case: ${c.name}`, () => {
      const p = JSON.parse(JSON.stringify(c.edge.p)) as ProbabilityParam;
      const graphPref = (c.graph_preference ?? undefined) as
        | GraphModelSourcePreference
        | undefined;
      const active = applyPromotion(p, graphPref);

      const exp = c.expected;
      const expectedSource = exp.source;

      if (!expectedSource) {
        expect(active).toBeUndefined();
        return;
      }

      expect(active).toBe(expectedSource);
      expect(p.forecast?.source).toBe(expectedSource);

      if (exp.prob_mean !== undefined) {
        expect(p.forecast?.mean).toBeCloseTo(exp.prob_mean, 9);
      }
      if (exp.prob_stdev !== undefined) {
        expect(p.forecast?.stdev).toBeCloseTo(exp.prob_stdev, 9);
      }

      const lat = p.latency ?? {};
      if (exp.lat_mu !== undefined) expect(lat.mu).toBeCloseTo(exp.lat_mu, 9);
      if (exp.lat_sigma !== undefined) expect(lat.sigma).toBeCloseTo(exp.lat_sigma, 9);
      // Doc 19: t95 promotes to `promoted_t95` to avoid the input-vs-derived
      // circular dependency.
      if (exp.lat_t95 !== undefined) expect(lat.promoted_t95).toBeCloseTo(exp.lat_t95, 9);
      if (exp.lat_onset_delta_days !== undefined) {
        expect(lat.onset_delta_days).toBeCloseTo(exp.lat_onset_delta_days, 9);
        expect(lat.promoted_onset_delta_days).toBeCloseTo(exp.lat_onset_delta_days, 9);
      }
      if (exp.lat_mu_sd !== undefined) {
        expect(lat.promoted_mu_sd).toBeCloseTo(exp.lat_mu_sd, 9);
      }
      if (exp.lat_sigma_sd !== undefined) {
        expect(lat.promoted_sigma_sd).toBeCloseTo(exp.lat_sigma_sd, 9);
      }
      if (exp.lat_onset_sd !== undefined) {
        expect(lat.promoted_onset_sd).toBeCloseTo(exp.lat_onset_sd, 9);
      }
      if (exp.lat_onset_mu_corr !== undefined) {
        expect(lat.promoted_onset_mu_corr).toBeCloseTo(exp.lat_onset_mu_corr, 9);
      }
    });
  }
});
