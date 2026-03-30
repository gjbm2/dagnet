#!/usr/bin/env node
/**
 * Spike: Validate behavioural segment filters in Amplitude REST API v2.
 *
 * Tests whether "user has done event X where property = Y" segment filters
 * work correctly on the /api/2/funnels endpoint. This is the foundation
 * for variant contexts in DagNet.
 *
 * Requires:
 *   AMPLITUDE_API_KEY    — Amplitude API key
 *   AMPLITUDE_SECRET_KEY — Amplitude secret key
 *
 * Usage:
 *   node scripts/spikes/spike-behavioral-segment-filters.mjs
 *
 * What it tests:
 *   1. Funnel with NO segment filter (baseline total)
 *   2. Funnel with behavioural "performed event" filter (variant:II equivalent)
 *   3. Funnel with behavioural "did NOT perform event" filter (variant:other equivalent)
 *   4. Funnel with mixed property + behavioural filters (channel AND variant)
 *   5. Validates: variant + other ~ total (MECE check)
 *
 * @see docs/current/project-contexts/VARIANT_CONTEXTS_DESIGN.md
 */

import https from 'https';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const apiKey = process.env.AMPLITUDE_API_KEY;
const secretKey = process.env.AMPLITUDE_SECRET_KEY;

if (!apiKey || !secretKey) {
  console.error('Set AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY');
  process.exit(1);
}

const basicAuth = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');
const BASE_URL = 'amplitude.com';
const BASE_PATH = '/api/2/funnels';

// Date range: last 30 days
const now = new Date();
const end = new Date(now);
const start = new Date(now);
start.setDate(start.getDate() - 30);
const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const startDate = fmt(start);
const endDate = fmt(end);

// ─────────────────────────────────────────────────────────────────────────────
// Funnel events: Household Created -> ServiceLineManagement Confirmed (Energy)
//
// These are real production events from the data repo.
// "Household Created" = account creation (funnel entry)
// "ServiceLineManagement Confirmed" with categoriesOn contains "Energy" = conversion
// ─────────────────────────────────────────────────────────────────────────────

const funnelEvents = [
  {
    event_type: 'Household Created',
    filters: [],
  },
  {
    event_type: 'ServiceLineManagement Confirmed',
    filters: [
      {
        subprop_type: 'event',
        subprop_key: 'categoriesOn',
        subprop_op: 'contains',
        subprop_value: ['Energy'],
      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Behavioural segment filter: "user has done Flow Started where flowId = X"
//
// This simulates a variant context. The discriminating event is "Flow Started"
// with the flowId property identifying which variant the user entered.
// ─────────────────────────────────────────────────────────────────────────────

const variantFilter = {
  type: 'event',
  event_type: 'Flow Started',
  filters: [
    {
      subprop_type: 'event',
      subprop_key: 'flowId',
      subprop_op: 'is',
      subprop_value: ['tell_us_about_your_energy'],
    },
  ],
  op: '>=',
  value: 1,
  time_type: 'rolling',
  time_value: 366,
};

// Complement: "user has NOT done Flow Started" (variant:other)
const complementFilter = {
  type: 'event',
  event_type: 'Flow Started',
  filters: [
    {
      subprop_type: 'event',
      subprop_key: 'flowId',
      subprop_op: 'is',
      subprop_value: ['tell_us_about_your_energy'],
    },
  ],
  op: '=',
  value: 0,
  time_type: 'rolling',
  time_value: 366,
};

// Property-based filter for mixed test: utm_medium = cpc
const channelFilter = {
  prop: 'gp:utm_medium',
  op: 'is',
  values: ['cpc'],
};

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────────────────────────────────────

function amplitudeFunnelQuery(segments = []) {
  return new Promise((resolve, reject) => {
    const eventParams = funnelEvents
      .map(e => 'e=' + encodeURIComponent(JSON.stringify(e)))
      .join('&');

    const segParam = segments.length > 0
      ? 's=' + encodeURIComponent(JSON.stringify(segments))
      : '';

    const params = [
      eventParams,
      `start=${startDate}`,
      `end=${endDate}`,
      'i=1',
      segParam,
      'cs=2592000', // 30-day conversion window
    ].filter(Boolean).join('&');

    const path = `${BASE_PATH}?${params}`;

    const req = https.request({
      hostname: BASE_URL,
      path,
      method: 'GET',
      headers: {
        Authorization: `Basic ${basicAuth}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Run tests
// ─────────────────────────────────────────────────────────────────────────────

function extractCounts(resp) {
  if (resp.status !== 200) {
    return { error: `HTTP ${resp.status}`, raw: JSON.stringify(resp.data).substring(0, 200) };
  }
  const cumulative = resp.data?.data?.[0]?.cumulativeRaw;
  if (!cumulative) {
    return { error: 'No cumulativeRaw in response', raw: JSON.stringify(resp.data).substring(0, 200) };
  }
  return {
    from: cumulative[0],
    to: cumulative[cumulative.length - 1],
    rate: cumulative[0] > 0 ? (cumulative[cumulative.length - 1] / cumulative[0] * 100).toFixed(2) + '%' : 'N/A',
  };
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Spike: Behavioural Segment Filters on Amplitude REST API v2');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  Funnel: Household Created -> ServiceLineManagement Confirmed (Energy)`);
console.log(`  Date range: ${startDate} - ${endDate}`);
console.log(`  Variant event: Flow Started (flowId = tell_us_about_your_energy)`);
console.log('');

// Test 1: Baseline (no segment filter)
console.log('Test 1: Baseline (no segment filter)...');
const baselineResp = await amplitudeFunnelQuery([]);
const baseline = extractCounts(baselineResp);
console.log('  Result:', baseline);
console.log('');

// Test 2: Behavioural "performed event" filter (variant)
console.log('Test 2: Behavioural filter — "user has done Flow Started(flowId=tell_us_about_your_energy) >= 1 time"...');
const variantResp = await amplitudeFunnelQuery([variantFilter]);
const variant = extractCounts(variantResp);
console.log('  Result:', variant);
console.log('');

// Test 3: Behavioural "did NOT perform event" filter (complement)
console.log('Test 3: Complement — "user has done Flow Started(flowId=tell_us_about_your_energy) = 0 times"...');
const complementResp = await amplitudeFunnelQuery([complementFilter]);
const complement = extractCounts(complementResp);
console.log('  Result:', complement);
console.log('');

// Test 4: Mixed property + behavioural filter
console.log('Test 4: Mixed — channel(utm_medium=cpc) AND variant(Flow Started >= 1)...');
const mixedResp = await amplitudeFunnelQuery([channelFilter, variantFilter]);
const mixed = extractCounts(mixedResp);
console.log('  Result:', mixed);
console.log('');

// ─────────────────────────────────────────────────────────────────────────────
// Analysis
// ─────────────────────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Analysis');
console.log('═══════════════════════════════════════════════════════════════');

if (baseline.error || variant.error || complement.error || mixed.error) {
  console.log('  ERRORS detected — check results above.');
  if (baseline.error) console.log('  Baseline error:', baseline.error);
  if (variant.error) console.log('  Variant error:', variant.error);
  if (complement.error) console.log('  Complement error:', complement.error);
  if (mixed.error) console.log('  Mixed error:', mixed.error);
  process.exit(1);
}

console.log('');
console.log('  MECE check (variant + complement ~ baseline):');
console.log(`    Baseline from:    ${baseline.from}`);
console.log(`    Variant from:     ${variant.from}`);
console.log(`    Complement from:  ${complement.from}`);
console.log(`    Sum:              ${variant.from + complement.from}`);
const drift = Math.abs(baseline.from - (variant.from + complement.from));
const driftPct = baseline.from > 0 ? (drift / baseline.from * 100).toFixed(2) : 'N/A';
console.log(`    Drift:            ${drift} (${driftPct}%)`);
console.log('');

if (drift === 0) {
  console.log('  MECE: EXACT MATCH. variant + complement = baseline.');
} else if (baseline.from > 0 && drift / baseline.from < 0.05) {
  console.log('  MECE: WITHIN TOLERANCE (<5%). Likely sampling variance.');
} else {
  console.log('  MECE: SIGNIFICANT DRIFT. Investigate — behavioural filters may not partition cleanly.');
}

console.log('');
console.log('  Mixed filter check:');
console.log(`    Variant-only from:  ${variant.from}`);
console.log(`    Mixed (cpc+var):    ${mixed.from}`);
if (mixed.from <= variant.from) {
  console.log('  PASS: Mixed <= variant (channel further restricts population, as expected).');
} else {
  console.log('  FAIL: Mixed > variant — channel filter is not restricting. Investigate.');
}

console.log('');
console.log('  Conversion rates:');
console.log(`    Baseline:   ${baseline.rate}`);
console.log(`    Variant:    ${variant.rate}`);
console.log(`    Complement: ${complement.rate}`);
console.log(`    Mixed:      ${mixed.rate}`);

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  Spike complete. Review results above.');
console.log('═══════════════════════════════════════════════════════════════');
