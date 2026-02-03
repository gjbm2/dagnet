/**
 * LOCAL-ONLY: Fetch fresh Amplitude window() lag histograms for Nov-25.
 *
 * Purpose:
 * - Retrieve a thicker, uncontexted Amplitude response (1-Nov-25 → 30-Nov-25)
 *   for two funnels:
 *   1) switch-registered → switch-success
 *   2) energy-rec → switch-registered
 * - Persist the RAW Amplitude response JSON before any transformation.
 * - Emit a wide CSV with 10 day-bins of:
 *   - actual histogram mass (counts)
 *   - estimated mass (no shift)
 *   - estimated mass (with shift)
 *
 * Local env:
 * - Create repo-root `.env.amplitude.local` (gitignored)
 * - See `local-env/amplitude.env.example` for keys
 *
 * Run:
 *   cd graph-editor && DAGNET_RUN_REAL_AMPLITUDE_E2E=1 npm test -- --run src/services/__tests__/amplitudeNov25.windowLag.uncontexted.local.e2e.test.ts
 *
 * Output:
 * - `param-registry/test/amplitude/window-1-Nov-25_to_30-Nov-25.<funnel>.amplitude-response.json`
 * - `param-registry/test/amplitude/window-1-Nov-25_to_30-Nov-25.<funnel>.daybins10.wide.csv`
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fetch as undiciFetch } from 'undici';

import { ONSET_MASS_FRACTION_ALPHA } from '../../constants/latency';
import { deriveOnsetDeltaDaysFromLagHistogram } from '../onsetDerivationService';
import { fitLagDistribution, logNormalCDF, toModelSpaceLagDays } from '../statisticalEnhancementService';

type AmpCreds = { apiKey: string; secretKey: string };

const MS_PER_DAY = 86_400_000;
const CONVERSION_WINDOW_DAYS = 30; // match connection default csParam behaviour

function findRepoRootFromCwd(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const hasParamRegistry = fs.existsSync(path.join(dir, 'param-registry'));
    const hasGraphEditor = fs.existsSync(path.join(dir, 'graph-editor'));
    if (hasParamRegistry && hasGraphEditor) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), '..');
}

const REPO_ROOT = findRepoRootFromCwd();
const ENV_PATH = path.join(REPO_ROOT, '.env.amplitude.local');

function loadLocalEnvFile(envPath: string): Record<string, string> {
  const raw = fs.readFileSync(envPath, 'utf8');
  const out: Record<string, string> = {};
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function getAmplitudeCredsFromEnvFile(): AmpCreds | null {
  if (!fs.existsSync(ENV_PATH)) return null;
  const env = loadLocalEnvFile(ENV_PATH);
  const apiKey = env.AMPLITUDE_API_KEY;
  const secretKey = env.AMPLITUDE_SECRET_KEY;
  if (!apiKey || !secretKey) return null;
  return { apiKey, secretKey };
}

function b64(s: string): string {
  return Buffer.from(s).toString('base64');
}

function loadYamlFixture(relFromRepoRoot: string): any {
  const abs = path.join(REPO_ROOT, relFromRepoRoot);
  return yaml.load(fs.readFileSync(abs, 'utf8'));
}

async function loadAmplitudeExcludedCohortsFromConnectionsYaml(): Promise<string[]> {
  const connectionsPath = path.join(REPO_ROOT, 'graph-editor/public/defaults/connections.yaml');
  const parsed: any = yaml.load(fs.readFileSync(connectionsPath, 'utf8'));
  const conn = (parsed?.connections || []).find((c: any) => c?.name === 'amplitude-prod');
  const excluded = conn?.defaults?.excluded_cohorts;
  return Array.isArray(excluded) ? excluded.map(String) : [];
}

function yyyymmddFromUk(dateUk: string): string {
  // dateUk is like "1-Nov-25"
  const [dRaw, monRaw, yyRaw] = dateUk.split('-');
  const d = Number(dRaw);
  const yy = Number(yyRaw);
  const mon = monRaw.toLowerCase();
  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  const m = months[mon];
  if (!Number.isFinite(d) || !Number.isFinite(yy) || !Number.isFinite(m)) throw new Error(`Bad UK date: ${dateUk}`);
  const yyyy = 2000 + yy;
  const dd = String(d).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function amplitudeEventFromYaml(eventYaml: any): any {
  const eventType = eventYaml?.provider_event_names?.amplitude;
  if (!eventType) throw new Error(`Missing provider_event_names.amplitude in event yaml: ${eventYaml?.id}`);
  const filters = Array.isArray(eventYaml?.amplitude_filters) ? eventYaml.amplitude_filters : [];
  const ampFilters = filters.map((f: any) => ({
    subprop_type: 'event',
    subprop_key: f.property,
    subprop_op: f.operator,
    subprop_value: Array.isArray(f.values) ? f.values : [f.values],
  }));
  return ampFilters.length > 0 ? { event_type: eventType, filters: ampFilters } : { event_type: eventType };
}

async function fetchAmplitudeFunnelRaw(args: {
  creds: AmpCreds;
  startYyyymmdd: string;
  endYyyymmdd: string;
  excludedCohorts: string[];
  steps: any[];
}): Promise<any> {
  const { creds, startYyyymmdd, endYyyymmdd, excludedCohorts, steps } = args;
  const baseUrl = 'https://amplitude.com/api/2/funnels';

  const segments: any[] = [];
  for (const cohortId of excludedCohorts) {
    segments.push({ prop: 'userdata_cohort', op: 'is not', values: [cohortId] });
  }

  const qsParts: string[] = [];
  for (const s of steps) qsParts.push(`e=${encodeURIComponent(JSON.stringify(s))}`);
  qsParts.push(`start=${encodeURIComponent(startYyyymmdd)}`);
  qsParts.push(`end=${encodeURIComponent(endYyyymmdd)}`);
  qsParts.push('i=1'); // daily
  if (segments.length > 0) qsParts.push(`s=${encodeURIComponent(JSON.stringify(segments))}`);
  qsParts.push(`cs=${encodeURIComponent(String(CONVERSION_WINDOW_DAYS * 24 * 60 * 60))}`);

  const url = `${baseUrl}?${qsParts.join('&')}`;
  const auth = `Basic ${b64(`${creds.apiKey}:${creds.secretKey}`)}`;
  const resp = await undiciFetch(url, { method: 'GET', headers: { Authorization: auth } });
  const rawText = await resp.text();
  if (!resp.ok) throw new Error(`Amplitude funnels HTTP ${resp.status}: ${rawText}`);
  try {
    return JSON.parse(rawText);
  } catch {
    throw new Error(`Amplitude funnels returned non-JSON: ${rawText}`);
  }
}

function getStep2Histogram(payload: any): { bins: any[] } {
  const bins = payload?.data?.[0]?.stepTransTimeDistribution?.step_bins?.[1]?.bins;
  return { bins: Array.isArray(bins) ? bins : [] };
}

function massOfBin(b: any): number {
  const totals = b?.bin_dist?.totals;
  if (typeof totals === 'number' && Number.isFinite(totals)) return Math.max(0, totals);
  const uniques = b?.bin_dist?.uniques;
  if (typeof uniques === 'number' && Number.isFinite(uniques)) return Math.max(0, uniques);
  return 0;
}

function buildDayBins10(hist: { bins: any[] }): number[] {
  // 10 bins:
  // - day 0..8 represent [d, d+1)
  // - day 9 represents [9, +∞)
  const bins = [...hist.bins].sort((a, b) => (a?.start ?? 0) - (b?.start ?? 0));
  const masses = new Array(10).fill(0);

  for (const b of bins) {
    const m = massOfBin(b);
    if (!(m > 0)) continue;

    const startMs = (typeof b?.start === 'number' && Number.isFinite(b.start)) ? b.start : 0;
    const endMs = (typeof b?.end === 'number' && Number.isFinite(b.end)) ? b.end : startMs;
    const startDays = Math.max(0, startMs / MS_PER_DAY);
    const endDays = Math.max(0, endMs / MS_PER_DAY);

    if (!(endDays > startDays)) {
      const idx = startDays >= 9 ? 9 : Math.floor(startDays);
      masses[idx] += m;
      continue;
    }

    const span = endDays - startDays;
    for (let day = 0; day < 9; day++) {
      const lo = day;
      const hi = day + 1;
      const overlap = Math.max(0, Math.min(endDays, hi) - Math.max(startDays, lo));
      if (overlap > 0) masses[day] += m * (overlap / span);
    }
    const overlap9p = Math.max(0, endDays - Math.max(startDays, 9));
    if (overlap9p > 0) masses[9] += m * (overlap9p / span);
  }

  return masses;
}

function wideCsvRow(args: {
  dateStartUk: string;
  dateEndUk: string;
  funnelId: string;
  onsetDays: number | null;
  medianLagDays: number | null;
  meanLagDays: number | null;
  totalMass: number;
  actualBins: number[];
  estNoShiftBins: number[];
  estShiftBins: number[];
}): string {
  const {
    dateStartUk,
    dateEndUk,
    funnelId,
    onsetDays,
    medianLagDays,
    meanLagDays,
    totalMass,
    actualBins,
    estNoShiftBins,
    estShiftBins,
  } = args;

  const cols: string[] = [];
  cols.push('window_start_uk', 'window_end_uk', 'funnel_id');
  for (let d = 0; d < 10; d++) cols.push(`actual_bin_day_${d}`);
  cols.push('onset_days', 'median_lag_days', 'mean_lag_days', 'total_mass');
  for (let d = 0; d < 10; d++) cols.push(`est_bin_no_shift_day_${d}`);
  for (let d = 0; d < 10; d++) cols.push(`est_bin_with_shift_day_${d}`);

  const vals: (string | number)[] = [];
  vals.push(dateStartUk, dateEndUk, funnelId);
  for (let d = 0; d < 10; d++) vals.push(actualBins[d] ?? 0);
  vals.push(onsetDays ?? '', medianLagDays ?? '', meanLagDays ?? '', totalMass);
  for (let d = 0; d < 10; d++) vals.push(estNoShiftBins[d] ?? 0);
  for (let d = 0; d < 10; d++) vals.push(estShiftBins[d] ?? 0);

  const header = cols.join(',');
  const row = vals.map((v) => (typeof v === 'number' ? String(v) : JSON.stringify(v))).join(',');
  return `${header}\n${row}\n`;
}

const creds = getAmplitudeCredsFromEnvFile();
const isCi = !!process.env.CI;
const RUN_REAL_AMPLITUDE_E2E = process.env.DAGNET_RUN_REAL_AMPLITUDE_E2E === '1';
const describeLocal = (!isCi && RUN_REAL_AMPLITUDE_E2E && creds) ? describe : describe.skip;

describeLocal('LOCAL: Fetch Nov-25 window() lag histograms (uncontexted)', () => {
  it('fetches and persists raw Amplitude + wide CSV for both funnels', async () => {
    if (!creds) throw new Error('missing creds (should be gated)');

    const excludedCohorts = await loadAmplitudeExcludedCohortsFromConnectionsYaml();

    const dateStartUk = '1-Nov-25';
    const dateEndUk = '30-Nov-25';
    const start = yyyymmddFromUk(dateStartUk);
    const end = yyyymmddFromUk(dateEndUk);

    const energyRec = loadYamlFixture('param-registry/test/events/energy-rec.yaml');
    const switchRegistered = loadYamlFixture('param-registry/test/events/switch-registered.yaml');
    const switchSuccess = loadYamlFixture('param-registry/test/events/switch-success.yaml');

    const funnels: Array<{ id: string; from: any; to: any }> = [
      { id: 'switch-registered_to_switch-success', from: switchRegistered, to: switchSuccess },
      { id: 'energy-rec_to_switch-registered', from: energyRec, to: switchRegistered },
    ];

    const outDir = path.join(REPO_ROOT, 'param-registry/test/amplitude');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    for (const f of funnels) {
      const steps = [amplitudeEventFromYaml(f.from), amplitudeEventFromYaml(f.to)];
      const raw = await fetchAmplitudeFunnelRaw({
        creds,
        startYyyymmdd: start,
        endYyyymmdd: end,
        excludedCohorts,
        steps,
      });

      // (a) Store raw response before transforming.
      const rawName = `window-${dateStartUk}_to_${dateEndUk}.${f.id}.amplitude-response.json`;
      const rawPath = path.join(outDir, rawName);
      fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');

      // Transform into 10 day bins from step2 histogram.
      const hist = getStep2Histogram(raw);
      expect(hist.bins.length).toBeGreaterThan(0);

      const actualBins = buildDayBins10(hist);
      const totalMass = actualBins.reduce((s, x) => s + x, 0);
      expect(totalMass).toBeGreaterThan(0);

      const d0 = raw?.data?.[0];
      const medianMs = d0?.medianTransTimes?.[1];
      const meanMs = d0?.avgTransTimes?.[1];
      const medianLagDays = (typeof medianMs === 'number' && Number.isFinite(medianMs)) ? (medianMs / MS_PER_DAY) : null;
      const meanLagDays = (typeof meanMs === 'number' && Number.isFinite(meanMs)) ? (meanMs / MS_PER_DAY) : null;

      const onsetDays = deriveOnsetDeltaDaysFromLagHistogram(hist as any, ONSET_MASS_FRACTION_ALPHA);

      // Fit (unshifted) + predict per-day-bin mass.
      const fitU = fitLagDistribution(medianLagDays ?? 0, meanLagDays ?? undefined, totalMass);
      const predProbU: number[] = [];
      for (let d = 0; d < 10; d++) {
        const lo = d;
        const hi = d === 9 ? Infinity : d + 1;
        const cLo = lo <= 0 ? 0 : logNormalCDF(lo, fitU.mu, fitU.sigma);
        const cHi = hi === Infinity ? 1 : logNormalCDF(hi, fitU.mu, fitU.sigma);
        predProbU.push(Math.max(0, cHi - cLo));
      }
      const estNoShiftBins = predProbU.map((p) => p * totalMass);

      // Fit (shifted) + predict per-day-bin mass.
      const delta = onsetDays ?? 0;
      const fitS = fitLagDistribution(
        toModelSpaceLagDays(delta, medianLagDays ?? 0),
        meanLagDays === null ? undefined : toModelSpaceLagDays(delta, meanLagDays),
        totalMass
      );
      const predProbS: number[] = [];
      for (let d = 0; d < 10; d++) {
        const loT = d;
        const hiT = d === 9 ? Infinity : d + 1;
        const cLo = loT <= delta ? 0 : logNormalCDF(loT - delta, fitS.mu, fitS.sigma);
        const cHi = hiT === Infinity ? 1 : (hiT <= delta ? 0 : logNormalCDF(hiT - delta, fitS.mu, fitS.sigma));
        predProbS.push(Math.max(0, cHi - cLo));
      }
      const estShiftBins = predProbS.map((p) => p * totalMass);

      // (b) Emit wide CSV with 10 unshifted cols THEN 10 shifted cols (no interleaving).
      const csvName = `window-${dateStartUk}_to_${dateEndUk}.${f.id}.daybins10.wide.csv`;
      const csvPath = path.join(outDir, csvName);
      fs.writeFileSync(csvPath, wideCsvRow({
        dateStartUk,
        dateEndUk,
        funnelId: f.id,
        onsetDays,
        medianLagDays,
        meanLagDays,
        totalMass,
        actualBins,
        estNoShiftBins,
        estShiftBins,
      }), 'utf8');

      // Small sanity: columns are consistent.
      expect(estNoShiftBins).toHaveLength(10);
      expect(estShiftBins).toHaveLength(10);
    }
  }, 120_000);
});

