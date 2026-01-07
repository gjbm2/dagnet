/**
 * LOCAL-ONLY Real Amplitude research test:
 * Validate the HTTP query shape + response parsing for Amplitude "event segmentation"
 * (single-event counts) before implementing window-mode n_query denominators in DAS.
 *
 * This is intentionally local-only and opt-in.
 *
 * Env file:
 * - Create repo-root `.env.amplitude.local` (gitignored)
 * - See `local-env/amplitude.env.example` for the required keys
 *
 * Run:
 *   cd graph-editor && DAGNET_RUN_REAL_AMPLITUDE_E2E=1 npm test -- --run src/services/__tests__/amplitudeSingleEvent.segmentation.local.research.test.ts
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fetch as undiciFetch } from 'undici';

type AmpCreds = { apiKey: string; secretKey: string };

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
  // Fallback: assume we're running from graph-editor/
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
  // IMPORTANT: local-only gate must require creds to be present in the env file itself.
  // We intentionally do NOT fall back to process.env here.
  const apiKey = env.AMPLITUDE_API_KEY;
  const secretKey = env.AMPLITUDE_SECRET_KEY;
  if (!apiKey || !secretKey) return null;
  return { apiKey, secretKey };
}

function b64(s: string): string {
  return Buffer.from(s).toString('base64');
}

function yyyymmddFromRelativeUtcDayOffset(offsetDays: number): string {
  const now = new Date();
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function loadAmplitudeExcludedCohortsFromConnectionsYaml(): Promise<string[]> {
  const connectionsPath = path.join(REPO_ROOT, 'graph-editor/public/defaults/connections.yaml');
  const parsed: any = yaml.load(fs.readFileSync(connectionsPath, 'utf8'));
  const conn = (parsed?.connections || []).find((c: any) => c?.name === 'amplitude-prod');
  const excluded = conn?.defaults?.excluded_cohorts;
  return Array.isArray(excluded) ? excluded.map(String) : [];
}

async function amplitudeSegmentationDailyUniques(args: {
  creds: AmpCreds;
  startYyyymmdd: string;
  endYyyymmdd: string;
  excludedCohorts: string[];
  event: any;
}): Promise<{ datesIso: string[]; uniquesDaily: number[]; raw: any }> {
  const { creds, startYyyymmdd, endYyyymmdd, excludedCohorts, event } = args;

  const baseUrl = 'https://amplitude.com/api/2/events/segmentation';
  const segments: any[] = [];
  for (const cohortId of excludedCohorts) {
    segments.push({ prop: 'userdata_cohort', op: 'is not', values: [cohortId] });
  }

  const qsParts: string[] = [];
  qsParts.push(`e=${encodeURIComponent(JSON.stringify(event))}`);
  qsParts.push(`start=${encodeURIComponent(startYyyymmdd)}`);
  qsParts.push(`end=${encodeURIComponent(endYyyymmdd)}`);
  qsParts.push('i=1'); // daily
  qsParts.push('m=uniques'); // unique users (arrival population)
  if (segments.length > 0) {
    qsParts.push(`s=${encodeURIComponent(JSON.stringify(segments))}`);
  }

  const url = `${baseUrl}?${qsParts.join('&')}`;
  const auth = `Basic ${b64(`${creds.apiKey}:${creds.secretKey}`)}`;
  const resp = await undiciFetch(url, { method: 'GET', headers: { Authorization: auth } });
  const rawText = await resp.text();
  if (!resp.ok) {
    throw new Error(`Amplitude segmentation HTTP ${resp.status}: ${rawText}`);
  }

  let body: any;
  try {
    body = JSON.parse(rawText);
  } catch {
    throw new Error(`Amplitude segmentation returned non-JSON: ${rawText}`);
  }

  const datesIso: string[] | undefined = body?.data?.xValues;
  const series: any[] | undefined = body?.data?.series;
  if (!Array.isArray(datesIso) || datesIso.length === 0) {
    throw new Error(`Unexpected segmentation response shape (missing data.xValues): ${rawText}`);
  }
  if (!Array.isArray(series) || series.length < 1) {
    throw new Error(`Unexpected segmentation response shape (missing data.series): ${rawText}`);
  }
  const first = series[0];
  if (!Array.isArray(first) || first.length !== datesIso.length) {
    throw new Error(`Unexpected segmentation series shape: series[0].length=${Array.isArray(first) ? first.length : 'non-array'} xValues.length=${datesIso.length}`);
  }

  const uniquesDaily: number[] = first.map((v: any, i: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      throw new Error(`Non-numeric uniques at i=${i}: ${JSON.stringify(v)}`);
    }
    return n;
  });

  return { datesIso, uniquesDaily, raw: body };
}

const creds = getAmplitudeCredsFromEnvFile();
const isCi = !!process.env.CI;
const RUN_REAL_AMPLITUDE_E2E = process.env.DAGNET_RUN_REAL_AMPLITUDE_E2E === '1';
const describeLocal = (!isCi && RUN_REAL_AMPLITUDE_E2E && creds) ? describe : describe.skip;

describeLocal('LOCAL research: Amplitude event segmentation (single-event daily uniques) query shape', () => {
  it('returns daily uniques for a filtered event over a short window', async () => {
    if (!creds) throw new Error('missing creds (should be gated)');

    const excludedCohorts = await loadAmplitudeExcludedCohortsFromConnectionsYaml();
    const start = yyyymmddFromRelativeUtcDayOffset(-20);
    const end = yyyymmddFromRelativeUtcDayOffset(-18);

    // Use the same event shape used in the live funnel E2E test (X = energy recommendation offered).
    const event = {
      event_type: 'Blueprint CheckpointReached',
      filters: [
        { subprop_type: 'event', subprop_key: 'checkpoint', subprop_op: 'is', subprop_value: ['RecommendationOffered'] },
        { subprop_type: 'event', subprop_key: 'category', subprop_op: 'is', subprop_value: ['Energy'] },
      ],
    };

    const res = await amplitudeSegmentationDailyUniques({
      creds,
      startYyyymmdd: start,
      endYyyymmdd: end,
      excludedCohorts,
      event,
    });

    // Shape assertions only (counts are environment-dependent).
    expect(res.datesIso.length).toBeGreaterThanOrEqual(1);
    expect(res.uniquesDaily).toHaveLength(res.datesIso.length);
    expect(res.uniquesDaily.every((n) => Number.isFinite(n) && n >= 0)).toBe(true);
  });
});


