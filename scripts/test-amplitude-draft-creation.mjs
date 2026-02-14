#!/usr/bin/env node
/**
 * Test: Create an Amplitude funnel chart draft programmatically.
 *
 * Uses session cookies captured from the HAR spike to:
 * 1. POST the chart definition to /d/config/{orgId}/data/edit
 * 2. Register the draft via CreateOrUpdateChartDraft GraphQL mutation
 * 3. Print the draft URL
 *
 * Usage:
 *   node scripts/test-amplitude-draft-creation.mjs \
 *     --session /tmp/amp-session-state.json \
 *     --org $AMPLITUDE_ORG_ID \
 *     --app $AMPLITUDE_APP_ID \
 *     --org-slug $AMPLITUDE_ORG_SLUG
 *
 * Events are hardcoded for testing. A real implementation would
 * construct them from the DAS adapter dry-run.
 */

import fs from 'fs';
import https from 'https';
import crypto from 'crypto';

// ── Parse args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const sessionFile = getArg('session') || '/tmp/amp-session-state.json';
const orgId = getArg('org') || process.env.AMPLITUDE_ORG_ID;
const appId = getArg('app') || process.env.AMPLITUDE_APP_ID;
const orgSlug = getArg('org-slug') || process.env.AMPLITUDE_ORG_SLUG;
if (!orgId || !appId || !orgSlug) {
  console.error('Pass --org, --app, --org-slug or set AMPLITUDE_ORG_ID, AMPLITUDE_APP_ID, AMPLITUDE_ORG_SLUG (see connections.yaml defaults)');
  process.exit(1);
}

// ── Load session cookies ─────────────────────────────────────────────────────
if (!fs.existsSync(sessionFile)) {
  console.error(`Session file not found: ${sessionFile}`);
  console.error('Run scripts/spike-amplitude-funnel-api.sh first to capture cookies.');
  process.exit(1);
}

const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
const cookieString = session.cookies
  .map(c => `${c.name}=${c.value}`)
  .join('; ');

if (!cookieString) {
  console.error('No cookies in session file.');
  process.exit(1);
}

// ── Generate edit ID ─────────────────────────────────────────────────────────
// Amplitude uses 8-char alphanumeric IDs
function generateEditId() {
  return crypto.randomBytes(4).toString('hex');
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function request(options, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookieString,
        'Origin': 'https://app.amplitude.com',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...options.headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Test funnel events (hardcoded for spike) ─────────────────────────────────
// In production, these come from the DAS adapter dry-run.
const testEvents = [
  { event_type: 'Household Created', filters: [], group_by: [] },
  { event_type: 'Household DelegationStatusChanged', filters: [], group_by: [] },
];

// ── Chart definition ─────────────────────────────────────────────────────────
const editId = generateEditId();

const chartDefinition = {
  app: appId,
  type: 'funnels',
  vis: 'bar',
  version: 41,
  name: null,
  params: {
    mode: 'ordered',
    range: 'Last 30 Days',
    interval: 1,
    metric: 'CONVERSION',
    conversionSeconds: 86400,
    newOrActive: 'active',
    nthTimeLookbackWindow: 365,
    isFunnelPreciseComputationEnabled: false,
    countGroup: { name: 'User', is_computed: false },
    events: testEvents,
    segments: [{ name: 'All Users', label: '', conditions: [] }],
    groupBy: [],
    constantProps: [],
    excludedEvents: [],
  },
};

// ── Main ─────────────────────────────────────────────────────────────────────
console.log('');
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  Amplitude Funnel Draft Creation Test                       ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');
console.log(`  Org:     ${orgId}`);
console.log(`  App:     ${appId}`);
console.log(`  Edit ID: ${editId}`);
console.log(`  Events:  ${testEvents.map(e => e.event_type).join(' → ')}`);
console.log('');

// Step 1: Store chart definition
// The edit endpoint RETURNS the editId — we don't generate it.
console.log('Step 1: POST /d/config/{orgId}/data/edit ...');
const editResp = await request({
  hostname: 'app.amplitude.com',
  path: `/d/config/${orgId}/data/edit`,
  method: 'POST',
  headers: {
    'x-org': orgId,
    'x-version': 'dagnet',  // Amplitude tracks client version; any string works
  },
}, {
  chart_id: null,
  definition: chartDefinition,
});

console.log(`  Status: ${editResp.status}`);
if (editResp.status !== 200) {
  console.error('  FAILED:', JSON.stringify(editResp.data).substring(0, 500));
  process.exit(1);
}

// Extract editId from response
const returnedEditId = editResp.data?.editId;
if (!returnedEditId) {
  console.error('  No editId in response:', JSON.stringify(editResp.data).substring(0, 500));
  process.exit(1);
}
console.log(`  OK — editId: ${returnedEditId}`);

// Step 2: Register draft via GraphQL
console.log('');
console.log('Step 2: CreateOrUpdateChartDraft mutation ...');

const gqlBody = JSON.stringify({
  operationName: 'CreateOrUpdateChartDraft',
  variables: { editId: returnedEditId, prevEditId: null },
  query: `mutation CreateOrUpdateChartDraft($chartId: String, $prevEditId: String, $editId: ID!) {
  createOrUpdateChartDraft(chartId: $chartId, prevEditId: $prevEditId, editId: $editId) {
    editId
    chartId
    __typename
  }
}`,
});

const draftResp = await request({
  hostname: 'app.amplitude.com',
  path: `/t/graphql/org/${orgId}?q=CreateOrUpdateChartDraft`,
  method: 'POST',
  headers: { 'x-org': orgId },
}, gqlBody);

console.log(`  Status: ${draftResp.status}`);
if (draftResp.status !== 200 || draftResp.data?.errors) {
  console.error('  FAILED:', JSON.stringify(draftResp.data).substring(0, 500));
  process.exit(1);
}
console.log(`  Response: ${JSON.stringify(draftResp.data)}`);

// Step 3: Print the URL
const draftUrl = `https://app.amplitude.com/analytics/${orgSlug}/chart/new/${returnedEditId}`;
console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log('');
console.log(`  Draft URL: ${draftUrl}`);
console.log('');
console.log('  Open this URL in a browser where you are logged into');
console.log('  Amplitude to see the funnel chart.');
console.log('');
console.log('══════════════════════════════════════════════════════════════');
