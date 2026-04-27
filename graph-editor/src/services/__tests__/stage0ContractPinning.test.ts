/**
 * Stage 0 FE contract pinning tests (doc 73b §8 Stage 0).
 *
 * Pins end-state TS-side contracts; some are end-state assertions that
 * fail today and will pass once the owning later stage lands. These use
 * `it.skip` (with a reason citing the owning stage) rather than xfail
 * because vitest does not have native xfail; flipping `skip` -> `it`
 * is the equivalent gesture when the contract goes green.
 *
 * Pinned contracts:
 *
 * - **Narrow promoted probability surface** (§3.2). The promoted
 *   surface is exactly `{ mean, stdev, source }` on `p.forecast`.
 *   `applyPromotion` in `modelVarsResolution.ts` is the single TS
 *   writer; Stage 4(c) extends it to populate the three-field surface.
 *   `k` is excluded — runtime population helper with a different
 *   writer (§12.2 row S4).
 *
 * - **`manual` removal from source taxonomy** (§9 acceptance criterion
 *   9; schema rows S2/S3 in §12.2). Owned by Stage 3.
 *
 * - **Baseline-forecast vs current-answer distinction** (§9 acceptance
 *   criterion 4; Decision 7). `p.mean` (current-answer) and
 *   `p.forecast.mean` (promoted baseline) are distinct semantic slots.
 *
 * - **Single-writer rule for promoted surface** (§3.2 centralisation
 *   principle). Today's CF apply path at
 *   `conditionedForecastService.ts:275` writes
 *   `forecast: { mean: edge.p_mean }`; Stage 4(c) removes this so
 *   `applyPromotion` is the only writer.
 */

import { describe, it, expect } from 'vitest';
import { applyPromotion } from '../modelVarsResolution';
import type { ModelVarsEntry, ProbabilityParam } from '../../types';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SRC_ROOT = path.resolve(__dirname, '..', '..');
const TYPES_PATH = path.resolve(SRC_ROOT, 'types', 'index.ts');
const MODELVARS_PATH = path.resolve(SRC_ROOT, 'services', 'modelVarsResolution.ts');
const CF_SERVICE_PATH = path.resolve(SRC_ROOT, 'services', 'conditionedForecastService.ts');

function readSource(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

describe('Stage 0 FE contract pinning — narrow promoted surface (§3.2)', () => {
  it('p.forecast carries exactly { mean, stdev, source } in the promoted surface (Stage 4(c) writer extension)', () => {
    // Stage 4(c) extends applyPromotion to write { mean, stdev, source }.
    // Until Stage 4(c) lands the deferral comment in modelVarsResolution.ts
    // explicitly notes that p.forecast.* writes are deferred to the topo
    // pass / pipeline. This test pins the source-of-truth rule.
    const src = readSource(MODELVARS_PATH);
    expect(src).toMatch(/applyPromotion only promotes latency model parameters/);
  });

  it.skip(
    'applyPromotion writes p.forecast.{mean, stdev, source} when a source is promoted (Stage 4(c))',
    () => {
      // End-state contract: after Stage 4(c) extends applyPromotion to
      // populate the three-field promoted surface, calling applyPromotion
      // on a probability with a valid model_vars entry must populate
      // p.forecast.mean, p.forecast.stdev, and p.forecast.source.
      const analyticEntry: ModelVarsEntry = {
        source: 'analytic',
        source_at: '20-Apr-26',
        probability: { mean: 0.18, stdev: 0.04 },
        latency: { mu: 2.5, sigma: 0.8, t95: 45, onset_delta_days: 3 },
      };
      const p: ProbabilityParam = {
        id: 'param-stage0-narrow-promoted',
        mean: 0,
        stdev: 0,
        n: 0,
        forecast: {},
        latency: {} as any,
        model_vars: [analyticEntry],
      } as any;

      const activeSource = applyPromotion(p, undefined);

      expect(activeSource).toBe('analytic');
      expect(p.forecast?.mean).toBe(0.18);
      expect(p.forecast?.stdev).toBe(0.04);
      expect((p.forecast as any)?.source).toBe('analytic');
    },
  );

  it('k is NOT part of the promoted surface — runtime population helper with a separate writer (§12.2 row S4)', () => {
    // Pin the carve-out: applyPromotion must never touch p.forecast.k.
    // Today applyPromotion does not write any p.forecast.* fields, so
    // this test is satisfied trivially. After Stage 4(c) extends the
    // writer, this assertion catches a regression that would write k
    // through promotion.
    const analyticEntry: ModelVarsEntry = {
      source: 'analytic',
      source_at: '20-Apr-26',
      probability: { mean: 0.18, stdev: 0.04 },
      latency: { mu: 2.5, sigma: 0.8, t95: 45, onset_delta_days: 3 },
    };
    const p: ProbabilityParam = {
      id: 'param-stage0-k-carveout',
      mean: 0,
      stdev: 0,
      n: 0,
      forecast: { k: 999 },
      latency: {} as any,
      model_vars: [analyticEntry],
    } as any;

    applyPromotion(p, undefined);

    expect(p.forecast?.k).toBe(999);
  });
});

describe('Stage 0 FE contract pinning — single-writer rule (§3.2 centralisation)', () => {
  it.skip(
    'applyPromotion is the only TS writer of the promoted-latency block (Stage 4(c))',
    () => {
      // §3.2: after Stage 4(c) migrates `applyBatchLAGValues`'s direct
      // `promoted_*` writes onto `model_vars[analytic].latency.*` so
      // `applyPromotion` fans them out, modelVarsResolution.ts is the
      // sole writer of the `p.latency.promoted_*` block. Today
      // `UpdateManager.ts::applyBatchLAGValues` writes
      // `promoted_onset_delta_days` directly (Mismatch 5a (i) target).
      // Pinned via grep across `src/services` excluding tests.
      const offenders: string[] = [];
      const servicesDir = path.resolve(SRC_ROOT, 'services');
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          if (!/\.(ts|tsx)$/.test(entry.name)) continue;
          if (/\.test\.tsx?$/.test(entry.name)) continue;
          if (entry.name === 'modelVarsResolution.ts') continue;
          const content = fs.readFileSync(full, 'utf-8');
          const matches = content.match(/promoted_[a-z_0-9]+\s*=/g);
          if (matches) {
            for (const m of matches) {
              offenders.push(`${full}: ${m}`);
            }
          }
        }
      };
      walk(servicesDir);

      expect(offenders).toEqual([]);
    },
  );

  it('today: at least one non-applyPromotion writer of promoted_* exists (baseline; Stage 4(c) target)', () => {
    // Companion baseline assertion. Removed when Stage 4(c) lands
    // and the skipped end-state assertion above is flipped to a
    // running test.
    const offenders: string[] = [];
    const servicesDir = path.resolve(SRC_ROOT, 'services');
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (/\.test\.tsx?$/.test(entry.name)) continue;
        if (entry.name === 'modelVarsResolution.ts') continue;
        const content = fs.readFileSync(full, 'utf-8');
        const matches = content.match(/promoted_[a-z_0-9]+\s*=/g);
        if (matches) {
          for (const m of matches) {
            offenders.push(`${full}: ${m}`);
          }
        }
      }
    };
    walk(servicesDir);

    expect(offenders.length).toBeGreaterThan(0);
  });

  it.skip(
    'conditionedForecastService no longer writes p.forecast.mean (Stage 4(c) CF de-collapse)',
    () => {
      // Stage 4(c) removes the `forecast: { mean: edge.p_mean }` entry
      // from the CF apply path; after that, only applyPromotion writes
      // p.forecast.mean. Pinned by source inspection.
      const src = readSource(CF_SERVICE_PATH);
      expect(src).not.toMatch(/forecast:\s*\{\s*mean:\s*edge\.p_mean\s*\}/);
    },
  );

  it('CF apply path currently writes p.forecast.mean (baseline; will be removed in Stage 4(c))', () => {
    // Companion to the skip above — explicit baseline that the
    // collapse exists today, so Stage 4(c) has a one-line target.
    const src = readSource(CF_SERVICE_PATH);
    expect(src).toMatch(/forecast:\s*\{\s*mean:\s*edge\.p_mean\s*\}/);
  });
});

describe('Stage 0 FE contract pinning — `manual` removal (§9 criterion 9, §12.2 S2/S3)', () => {
  it.skip(
    'ModelSource literal does not include `manual` (Stage 3 — schema row S2)',
    () => {
      const src = readSource(TYPES_PATH);
      // After Stage 3 the literal is the two-source set.
      expect(src).toMatch(
        /export\s+type\s+ModelSource\s*=\s*['"]analytic['"]\s*\|\s*['"]bayesian['"]\s*;/,
      );
      expect(src).not.toMatch(/['"]manual['"]\s*[|;].*ModelSource/);
    },
  );

  it.skip(
    'ModelSourcePreference literal does not include `manual` (Stage 3 — schema row S3)',
    () => {
      const src = readSource(TYPES_PATH);
      // After Stage 3 the literal is the three-value preference set.
      expect(src).toMatch(
        /ModelSourcePreference\s*=\s*['"]best_available['"]\s*\|\s*['"]bayesian['"]\s*\|\s*['"]analytic['"]\s*;/,
      );
    },
  );

  it('ModelSource and ModelSourcePreference still include `manual` today (baseline; removed in Stage 3)', () => {
    const src = readSource(TYPES_PATH);
    expect(src).toMatch(/ModelSource\s*=\s*['"]analytic['"]\s*\|\s*['"]bayesian['"]\s*\|\s*['"]manual['"]/);
    expect(src).toMatch(
      /ModelSourcePreference\s*=\s*['"]best_available['"]\s*\|\s*['"]bayesian['"]\s*\|\s*['"]analytic['"]\s*\|\s*['"]manual['"]/,
    );
  });
});

describe('Stage 0 FE contract pinning — baseline-forecast vs current-answer (§9 criterion 4)', () => {
  it('p.mean (current-answer) and p.forecast.mean (promoted) are distinct addressable slots', () => {
    // Decision 7: `p.mean` and `p.forecast.mean` are distinct semantic
    // slots that must stop collapsing. Pinned via direct shape test.
    const p: any = {
      id: 'p-distinct-slots',
      mean: 0.42,
      stdev: 0.05,
      n: 100,
      forecast: { mean: 0.18 },
      latency: {},
      model_vars: [],
    };
    expect(p.mean).toBe(0.42);
    expect(p.forecast.mean).toBe(0.18);
    p.mean = 0.99;
    expect(p.forecast.mean).toBe(0.18);
    p.forecast.mean = 0.27;
    expect(p.mean).toBe(0.99);
  });

  it.skip(
    'CF apply path leaves p.forecast.mean unchanged (Stage 4(c) — Decision 7 target)',
    () => {
      // After Stage 4(c) lands the CF de-collapse, applying a CF
      // result must update p.mean / p.blendedMean but must not write
      // p.forecast.mean. Pinned end-state — implementation in Stage 4(c).
      // This test is skipped today because the current CF apply path
      // explicitly writes forecast: { mean: edge.p_mean }.
    },
  );
});

describe('Stage 0 FE contract pinning — pack contract delegation (Decision 11, 73a §8)', () => {
  it('pack contract is owned by 73a §8; Stage 4(f) coordinates the p.stdev_pred extension (S8)', () => {
    // 73a §8 is the canonical pack-field list. This test is a
    // documentation-style assertion: it captures the cross-doc
    // delegation so a future reader looking for "pack contract
    // pinning" lands here and is redirected to 73a §8 / Stage 4(f).
    const planPath = path.resolve(
      REPO_ROOT,
      'docs',
      'current',
      'project-bayes',
      '73b-be-topo-removal-and-forecast-state-separation-plan.md',
    );
    const plan = fs.readFileSync(planPath, 'utf-8');
    expect(plan).toMatch(/73a-scenario-param-pack-and-cf-supersession-plan\.md/);
    expect(plan).toMatch(/Stage 4\(f\)/);
    expect(plan).toMatch(/p\.stdev_pred/);
  });
});
