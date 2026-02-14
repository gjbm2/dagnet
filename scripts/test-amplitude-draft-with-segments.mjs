#!/usr/bin/env node
/**
 * Test: Create an Amplitude funnel draft with segment conditions,
 * including a behavioural "performed event" condition (visited/excludes pattern).
 */

import fs from 'fs';
import https from 'https';

const sessionFile = '/tmp/amp-session-state.json';
const orgId = process.env.AMPLITUDE_ORG_ID;
const appId = process.env.AMPLITUDE_APP_ID;
const orgSlug = process.env.AMPLITUDE_ORG_SLUG;
if (!orgId || !appId || !orgSlug) {
  console.error('Set AMPLITUDE_ORG_ID, AMPLITUDE_APP_ID, AMPLITUDE_ORG_SLUG (see connections.yaml defaults)');
  process.exit(1);
}

const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
const cookieString = session.cookies.map(c => `${c.name}=${c.value}`).join('; ');

function request(options, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookieString,
        'Origin': 'https://app.amplitude.com',
        'x-org': orgId,
        'Content-Length': Buffer.byteLength(bodyStr),
        ...options.headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// Chart definition with:
// - 2 funnel events (one with event property filter)
// - Segment conditions including:
//   - Cohort exclusion (userdata_cohort is not 9z057h6i)
//   - User property filter (country is United Kingdom)
//   - Behavioural: "performed Household Created at least 1 time" (visited pattern)
//   - Behavioural: "performed Household Cancelled exactly 0 times" (excludes pattern)
const definition = {
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
    events: [
      {
        event_type: 'Household Created',
        filters: [
          {
            subprop_type: 'event',
            subprop_key: 'flowId',
            subprop_op: 'is',
            subprop_value: ['energy-switch'],
            group_type: 'User',
            subfilters: [],
          },
        ],
        group_by: [],
      },
      {
        event_type: 'Household DelegationStatusChanged',
        filters: [],
        group_by: [],
      },
    ],
    segments: [
      {
        name: 'DagNet Test Segment',
        label: '',
        conditions: [
          // Cohort exclusion: exclude internal test users
          {
            type: 'property',
            prop_type: 'user',
            prop: 'userdata_cohort',
            op: 'is not',
            values: ['9z057h6i'],
            group_type: 'User',
          },
          // User property: UK only
          {
            type: 'property',
            prop_type: 'user',
            prop: 'country',
            op: 'is',
            values: ['United Kingdom'],
            group_type: 'User',
          },
          // Behavioural: visited pattern — "performed event at least 1 time"
          {
            type: 'event',
            event_type: 'Household Created',
            filters: [],
            op: '>=',
            value: 1,
            time_type: 'rolling',
            time_value: 366,
            group_type: 'User',
          },
          // Behavioural: excludes pattern — "did NOT perform event"
          {
            type: 'event',
            event_type: 'Household Cancelled',
            filters: [],
            op: '=',
            value: 0,
            time_type: 'rolling',
            time_value: 366,
            group_type: 'User',
          },
        ],
      },
    ],
    groupBy: [],
    constantProps: [],
    excludedEvents: [],
  },
};

console.log('Creating draft with segments...');
console.log('  Events:', definition.params.events.map(e => e.event_type).join(' → '));
console.log('  Segment conditions:');
for (const c of definition.params.segments[0].conditions) {
  if (c.type === 'property') {
    console.log(`    ${c.prop} ${c.op} ${JSON.stringify(c.values)}`);
  } else {
    console.log(`    performed "${c.event_type}" ${c.op} ${c.value} times (${c.time_type} ${c.time_value}d)`);
  }
}

const editResp = await request({
  hostname: 'app.amplitude.com',
  path: `/d/config/${orgId}/data/edit`,
  method: 'POST',
}, { chart_id: null, definition });

console.log(`\nEdit status: ${editResp.status}`);
if (editResp.status !== 200) {
  console.error('FAILED:', JSON.stringify(editResp.data).substring(0, 500));
  process.exit(1);
}

const editId = editResp.data?.editId;
console.log(`editId: ${editId}`);

const gqlResp = await request({
  hostname: 'app.amplitude.com',
  path: `/t/graphql/org/${orgId}?q=CreateOrUpdateChartDraft`,
  method: 'POST',
}, JSON.stringify({
  operationName: 'CreateOrUpdateChartDraft',
  variables: { editId, prevEditId: null },
  query: `mutation CreateOrUpdateChartDraft($chartId: String, $prevEditId: String, $editId: ID!) {
    createOrUpdateChartDraft(chartId: $chartId, prevEditId: $prevEditId, editId: $editId) {
      editId chartId __typename
    }
  }`,
}));

console.log(`GraphQL status: ${gqlResp.status}`);

const draftUrl = `https://app.amplitude.com/analytics/${orgSlug}/chart/new/${editId}`;
console.log(`\n══════════════════════════════════════════════════════════════`);
console.log(`  Draft URL: ${draftUrl}`);
console.log(`══════════════════════════════════════════════════════════════`);
console.log(`\nOpen this URL and verify:`);
console.log(`  1. Event "Household Created" has filter: flowId is energy-switch`);
console.log(`  2. Segment shows: cohort exclusion, country=UK`);
console.log(`  3. Segment shows: "performed Household Created >= 1 time"`);
console.log(`  4. Segment shows: "performed Household Cancelled = 0 times"`);
