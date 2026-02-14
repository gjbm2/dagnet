/**
 * Amplitude Funnel Builder — Roundtrip E2E Tests
 *
 * Proves that the DAS adapter code path and the new funnel builder code path
 * produce semantically identical Amplitude queries by comparing live results.
 *
 *   Path A (DAS): buildDslFromEdge() → QueryPayload → format to REST API params
 *                 → GET /api/2/funnels → {n, k}
 *   Path B (Funnel builder): buildAmplitudeFunnelDefinition() → chart definition
 *                            → create chart in Amplitude → query via /api/3/chart/:id/csv
 *                            → {n, k}
 *   Assert: Path A {n, k} === Path B {n, k}
 *
 * NO MOCKS. Real fileRegistry, real contextRegistry, real buildDslFromEdge,
 * real buildAmplitudeFunnelDefinition. Only bypass: browser extension (session
 * cookies used directly for chart creation).
 *
 * Uses gm-rebuild-jan-26 from the data repo.
 *
 * Run:
 *   source ../.env.amplitude.local && npm test -- --run tests/phase4-e2e/amplitude-funnel-roundtrip.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import https from 'https';
import { buildDslFromEdge, type QueryPayload, type EventDefinition } from '../../src/lib/das/buildDslFromEdge';
import { buildAmplitudeFunnelDefinition, computeCohortConversionSeconds } from '../../src/services/amplitudeFunnelBuilderService';
import { fileRegistry } from '../../src/contexts/TabContext';
import { parseConstraints } from '../../src/lib/queryDSL';
import type { FileState } from '../../src/types';

// ---------------------------------------------------------------------------
// Skip guards
// ---------------------------------------------------------------------------

const SESSION_FILE = '/tmp/amp-session-state.json';
const hasSession = fs.existsSync(SESSION_FILE);
const DAGNET_SPACE_ID = process.env.AMPLITUDE_TEST_SPACE_ID || '';

// Credentials keyed by credsRef (from connections.yaml).
// Env var naming: AMPLITUDE_<CREDSREF>_API_KEY / _SECRET_KEY
// For the default "amplitude" credsRef: AMPLITUDE_API_KEY / AMPLITUDE_SECRET_KEY
const credentialsByRef: Record<string, { api_key: string; secret_key: string }> = {};

function loadCredRef(ref: string): boolean {
  const suffix = ref === 'amplitude' ? '' : `_${ref.replace('amplitude-', '').toUpperCase()}`;
  const apiKey = process.env[`AMPLITUDE${suffix}_API_KEY`];
  const secretKey = process.env[`AMPLITUDE${suffix}_SECRET_KEY`];
  if (apiKey && secretKey) {
    credentialsByRef[ref] = { api_key: apiKey, secret_key: secretKey };
    return true;
  }
  return false;
}

// Load prod creds (credsRef: "amplitude")
const hasProdCreds = loadCredRef('amplitude');
// Load staging creds (credsRef: "amplitude-staging")
const hasStagingCreds = loadCredRef('amplitude-staging');

const canRun = hasProdCreds && hasSession && !!DAGNET_SPACE_ID;
const testMode = canRun ? describe : describe.skip;

if (!canRun) {
  console.log('\n⚠️  Skipping Amplitude roundtrip tests.');
  if (!hasProdCreds) console.log('   Missing: AMPLITUDE_API_KEY / AMPLITUDE_SECRET_KEY');
  if (!DAGNET_SPACE_ID) console.log('   Missing: AMPLITUDE_TEST_SPACE_ID');
  if (!hasSession) console.log('   Missing: /tmp/amp-session-state.json');
  console.log('');
}

// ---------------------------------------------------------------------------
// Config — resolved at runtime from data repo connections.yaml
// ---------------------------------------------------------------------------

// Per-connection project config (populated in seedFileRegistry)
interface AmplitudeProjectConfig {
  appId: string;
  orgId: string;
  orgSlug: string;
  excludedCohorts: string[];
  credsRef: string;
}
const connectionConfigs: Record<string, AmplitudeProjectConfig> = {};

// ---------------------------------------------------------------------------
// Resolve data repo
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(__dirname, '../../..');
const privateConf = fs.readFileSync(path.join(repoRoot, '.private-repos.conf'), 'utf8');
const dataRepoDir = privateConf.match(/^DATA_REPO_DIR=(.+)$/m)?.[1]?.trim() || '';
const dataRepoPath = path.join(repoRoot, dataRepoDir);

// ---------------------------------------------------------------------------
// Seed REAL fileRegistry with real data from the data repo
// ---------------------------------------------------------------------------

let graphData: any;

async function seedFileRegistry() {
  // Load and register graph
  graphData = JSON.parse(fs.readFileSync(path.join(dataRepoPath, 'graphs', 'gm-rebuild-jan-26.json'), 'utf8'));

  // Load and register event definitions (real files → real fileRegistry)
  const eventIds = ['household-created', 'household-delegated', 'switch-registered', 'switch-success', 'landing-page-all'];
  for (const eid of eventIds) {
    const p = path.join(dataRepoPath, 'events', `${eid}.yaml`);
    if (fs.existsSync(p)) {
      const data = yaml.parse(fs.readFileSync(p, 'utf8'));
      await fileRegistry.registerFile(`event-${eid}`, {
        fileId: `event-${eid}`,
        type: 'event',
        data,
        path: `events/${eid}.yaml`,
      } as FileState);
    }
  }

  // Load and register context definitions (real files → real fileRegistry)
  const contextIds = ['channel'];
  for (const cid of contextIds) {
    const p = path.join(dataRepoPath, 'contexts', `${cid}.yaml`);
    if (fs.existsSync(p)) {
      const data = yaml.parse(fs.readFileSync(p, 'utf8'));
      await fileRegistry.registerFile(`context-${cid}`, {
        fileId: `context-${cid}`,
        type: 'context',
        data,
        path: `contexts/${cid}.yaml`,
      } as FileState);
    }
  }

  // Resolve Amplitude project identifiers from connections.yaml.
  // Try data repo first (workspace-specific), fall back to public defaults (shipped with app).
  let connectionsPath = path.join(dataRepoPath, 'connections.yaml');
  if (!fs.existsSync(connectionsPath)) {
    connectionsPath = path.join(repoRoot, 'graph-editor', 'public', 'defaults', 'connections.yaml');
  }
  if (!fs.existsSync(connectionsPath)) throw new Error(`No connections.yaml found`);

  const connFile = yaml.parse(fs.readFileSync(connectionsPath, 'utf8'));
  const connections: any[] = connFile.connections || [];

  // Resolve each amplitude connection
  for (const connName of ['amplitude-prod', 'amplitude-staging']) {
    let conn = connections.find((c: any) => c.name === connName);
    if (!conn) continue;
    if (conn.extends) {
      const parent = connections.find((c: any) => c.name === conn.extends);
      conn = { ...parent, ...conn, defaults: { ...parent?.defaults, ...conn.defaults } };
    }
    const defaults = conn.defaults || {};
    const credsRef = conn.credsRef || 'amplitude';
    if (defaults.app_id && defaults.org_id && defaults.org_slug) {
      connectionConfigs[connName] = {
        appId: defaults.app_id,
        orgId: defaults.org_id,
        orgSlug: defaults.org_slug,
        excludedCohorts: Array.isArray(defaults.excluded_cohorts) ? defaults.excluded_cohorts : [],
        credsRef,
      };
      console.log(`  ${connName}: app=${defaults.app_id}, org=${defaults.org_id}, creds=${credsRef}`);
    } else {
      console.log(`  ${connName}: SKIPPED (missing app_id/org_id/org_slug in defaults)`);
    }
  }

  if (!connectionConfigs['amplitude-prod']) {
    throw new Error('amplitude-prod connection missing app_id/org_id/org_slug in connections.yaml');
  }
}

// ---------------------------------------------------------------------------
// Event loader for buildDslFromEdge (loads from real fileRegistry)
// ---------------------------------------------------------------------------

async function eventLoader(eventId: string): Promise<EventDefinition> {
  const file = fileRegistry.getFile(`event-${eventId}`);
  if (!file?.data) throw new Error(`Event ${eventId} not found in fileRegistry`);
  return file.data as EventDefinition;
}

// ---------------------------------------------------------------------------
// Path A: QueryPayload → REST API params (mirrors connections.yaml pre_request)
// ---------------------------------------------------------------------------

function queryPayloadToRestParams(
  qp: QueryPayload,
  eventDefs: Record<string, EventDefinition>,
  excludedCohorts: string[] = [],
): string {
  const parts: string[] = [];

  // Build funnel steps: [from, ...visited_between, to]
  const stepEventIds = [qp.from, ...(qp.visited || []), qp.to];
  for (const eid of stepEventIds) {
    const def = eventDefs[eid];
    const ampName = def?.provider_event_names?.amplitude || eid;
    const obj: any = { event_type: ampName };
    const filters = (def?.amplitude_filters || []).map((f: any) => ({
      subprop_type: 'event',
      subprop_key: f.property,
      subprop_op: f.operator === 'is any of' ? 'is' : (f.operator || 'is'),
      subprop_value: f.values,
    }));
    if (filters.length > 0) obj.filters = filters;
    parts.push('e=' + encodeURIComponent(JSON.stringify(obj)));
  }

  // Dates
  if (qp.cohort?.start) {
    parts.push('start=' + isoToYYYYMMDD(qp.cohort.start));
    if (qp.cohort.end) parts.push('end=' + isoToYYYYMMDD(qp.cohort.end));
    // Conversion window from cohort
    const csDays = qp.cohort.conversion_window_days || 30;
    parts.push('cs=' + (csDays * 86400));
  } else if (qp.start) {
    parts.push('start=' + isoToYYYYMMDD(qp.start));
    if (qp.end) parts.push('end=' + isoToYYYYMMDD(qp.end));
    parts.push('cs=' + (30 * 86400)); // window default
  }

  parts.push('mode=ordered');

  // Segment conditions
  const segments: any[] = [];

  // Cohort exclusions (from connection defaults — same as DAS pre_request script)
  for (const cohortId of excludedCohorts) {
    segments.push({ prop: 'userdata_cohort', op: 'is not', values: [cohortId] });
  }

  // Visited upstream → behavioural segment ≥ 1
  for (const eid of (qp.visited_upstream || [])) {
    const def = eventDefs[eid];
    const ampName = def?.provider_event_names?.amplitude || eid;
    const filters = (def?.amplitude_filters || []).map((f: any) => ({
      subprop_type: 'event', subprop_key: f.property,
      subprop_op: f.operator === 'is any of' ? 'is' : (f.operator || 'is'),
      subprop_value: f.values,
    }));
    segments.push({
      type: 'event', event_type: ampName, filters,
      op: '>=', value: 1, time_type: 'rolling', time_value: 366,
    });
  }

  // Exclude → behavioural segment = 0
  for (const eid of (qp.exclude || [])) {
    const def = eventDefs[eid];
    const ampName = def?.provider_event_names?.amplitude || eid;
    segments.push({
      type: 'event', event_type: ampName, filters: [],
      op: '=', value: 0, time_type: 'rolling', time_value: 366,
    });
  }

  // Context filters
  for (const cf of (qp.context_filters || [])) {
    const prop = cf.field?.startsWith('gp:') ? cf.field
      : ['version','country','city','region','DMA','language','platform','os','device','device_type','device_family','start_version','paying','userdata_cohort'].includes(cf.field)
        ? cf.field : `gp:${cf.field}`;
    const values = cf.pattern
      ? extractLiterals(cf.pattern)
      : [...(cf.values || [])];
    if (values.length > 0) {
      segments.push({ prop, op: cf.op || 'is', values });
    }
  }

  if (segments.length > 0) {
    parts.push('s=' + encodeURIComponent(JSON.stringify(segments)));
  }

  return parts.join('&');
}

function isoToYYYYMMDD(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

function extractLiterals(pattern: string): string[] {
  let s = pattern.replace(/^\^/, '').replace(/\$$/, '');
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  return s.split('|').map(p => p.trim()).filter(p => !/[\\[\]().*+?^${}]/.test(p));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function loadCookies(): string {
  const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  return s.cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
}

function amplitudePost(urlPath: string, body: any, orgId: string): Promise<{ status: number; data: any }> {
  const cookies = loadCookies();
  const bodyStr = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'app.amplitude.com', path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Cookie': cookies,
        'Origin': 'https://app.amplitude.com', 'x-org': orgId,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = '';
      res.on('data', (d: string) => { data += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 0, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode || 0, data }); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function amplitudeRestGet(queryString: string, credsRef = 'amplitude'): Promise<any> {
  const creds = credentialsByRef[credsRef];
  if (!creds) throw new Error(`No credentials for credsRef "${credsRef}"`);
  const auth = Buffer.from(`${creds.api_key}:${creds.secret_key}`).toString('base64');
  return new Promise((resolve, reject) => {
    https.get(`https://amplitude.com/api/2/funnels?${queryString}`, {
      headers: { Authorization: `Basic ${auth}` },
    }, (res) => {
      let body = '';
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`REST API ${res.statusCode}: ${body.substring(0, 300)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function getChartResults(chartId: string, credsRef = 'amplitude'): Promise<{ n: number; k: number }> {
  const creds = credentialsByRef[credsRef];
  if (!creds) throw new Error(`No credentials for credsRef "${credsRef}"`);
  const auth = Buffer.from(`${creds.api_key}:${creds.secret_key}`).toString('base64');
  return new Promise((resolve, reject) => {
    https.get(`https://amplitude.com/api/3/chart/${chartId}/csv`, {
      headers: { Authorization: `Basic ${auth}` },
    }, (res) => {
      let body = '';
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Chart API ${res.statusCode}: ${body.substring(0, 300)}`));
        try {
          const csv = JSON.parse(body).data as string;
          const lines = csv.split('\r\n').map(l =>
            l.split(',').map(c => c.trim().replace(/^\t/, '').replace(/^"/, '').replace(/"$/, '').trim())
          );
          const totalRow = lines.find(row => row.some(c => c === 'Total'));
          if (!totalRow) return reject(new Error('No Total row in chart CSV'));
          const stepCounts: number[] = [];
          let idx = 3;
          stepCounts.push(parseInt(totalRow[idx], 10));
          idx++;
          while (idx < totalRow.length) {
            idx += 2;
            if (idx < totalRow.length && /^\d+$/.test(totalRow[idx])) {
              stepCounts.push(parseInt(totalRow[idx], 10));
              idx++;
            } else break;
          }
          resolve({ n: stepCounts[0], k: stepCounts[stepCounts.length - 1] });
        } catch (e) { reject(new Error(`CSV parse: ${(e as Error).message}`)); }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Chart lifecycle
// ---------------------------------------------------------------------------

const createdChartIds: Array<{ chartId: string; orgId: string }> = [];

async function createAndSaveChart(definition: any, name: string, config: AmplitudeProjectConfig): Promise<string> {
  const editResp = await amplitudePost(`/d/config/${config.orgId}/data/edit`, { chart_id: null, definition }, config.orgId);
  if (editResp.status !== 200) throw new Error(`Edit API ${editResp.status}: ${JSON.stringify(editResp.data).substring(0, 300)}`);
  const editId = editResp.data?.editId;

  const gqlResp = await amplitudePost(`/t/graphql/org/${config.orgId}?q=CreateChart`, {
    operationName: 'CreateChart',
    variables: {
      definition: { ...definition, name },
      isPublished: false, locationId: DAGNET_SPACE_ID,
      dashboardIds: [], notebookIds: [],
      createNewDashboard: false, createNewNotebook: false,
      shouldSendSpaceNotifications: false,
    },
    query: `mutation CreateChart($definition: JSON!, $isPublished: Boolean!, $locationId: ID!, $dashboardIds: [ID!]!, $notebookIds: [ID!]!, $createNewDashboard: Boolean!, $createNewNotebook: Boolean!, $shouldSendSpaceNotifications: Boolean!) {
  createChart(definition: $definition, locationId: $locationId, isPublished: $isPublished, dashboardIds: $dashboardIds, notebookIds: $notebookIds, createNewDashboard: $createNewDashboard, createNewNotebook: $createNewNotebook, shouldSendSpaceNotifications: $shouldSendSpaceNotifications) {
    chart { id __typename } __typename
  }
}`,
  }, config.orgId);

  const chartId = gqlResp.data?.data?.createChart?.chart?.id;
  if (!chartId) throw new Error(`CreateChart failed: ${JSON.stringify(gqlResp.data).substring(0, 500)}`);

  await amplitudePost(`/t/graphql/org/${config.orgId}?q=DeleteChartDraft`, {
    operationName: 'DeleteChartDraft',
    variables: { editId },
    query: `mutation DeleteChartDraft($editId: ID!) { deleteChartDraft(editId: $editId) { editId __typename } }`,
  }, config.orgId);

  createdChartIds.push({ chartId, orgId: config.orgId });
  return chartId;
}

async function deleteChart(chartId: string, orgId: string): Promise<void> {
  await amplitudePost(`/t/graphql/org/${orgId}?q=DeleteChart`, {
    operationName: 'DeleteChart',
    variables: { chartId },
    query: `mutation DeleteChart($chartId: ID!) { deleteChart(chartId: $chartId) { id __typename } }`,
  }, orgId);
}

// ---------------------------------------------------------------------------
// Test matrix
// ---------------------------------------------------------------------------

interface TestCase {
  id: string;
  label: string;
  /** Graph node IDs for funnel builder (Path B) */
  selectedNodeIds: string[];
  /** Edge query string for DAS (Path A): from(X).to(Y)[.visited(Z)] */
  dasQuery: string;
  /** DSL constraints appended to both paths */
  dslConstraints: string;
  adjacency: 'adjacent' | 'non-adjacent';
  /** Connection name (default: amplitude-prod) */
  connection?: string;
}

const WINDOW_DATES = '15-Jan-26:13-Feb-26';
const COHORT_DATES = '15-Jan-26:13-Feb-26';

const TEST_CASES: TestCase[] = [
  // ── 2-node adjacent ──
  { id: 'W2A', label: '2-node adjacent, window, no context',
    selectedNodeIds: ['household-created', 'household-delegated'],
    dasQuery: 'from(household-created).to(household-delegated)',
    dslConstraints: `window(${WINDOW_DATES})`,
    adjacency: 'adjacent' },
  { id: 'W2A-ctx', label: '2-node adjacent, window, context',
    selectedNodeIds: ['household-created', 'household-delegated'],
    dasQuery: 'from(household-created).to(household-delegated)',
    dslConstraints: `context(channel:influencer).window(${WINDOW_DATES})`,
    adjacency: 'adjacent' },
  // ── 2-node non-adjacent ──
  { id: 'W2N', label: '2-node non-adjacent, window, no context',
    selectedNodeIds: ['household-created', 'switch-registered'],
    dasQuery: 'from(household-created).to(switch-registered)',
    dslConstraints: `window(${WINDOW_DATES})`,
    adjacency: 'non-adjacent' },
  // ── 2-node cohort ──
  { id: 'C2A', label: '2-node adjacent, cohort, no context',
    selectedNodeIds: ['household-delegated', 'switch-registered'],
    dasQuery: 'from(household-delegated).to(switch-registered)',
    dslConstraints: `cohort(${COHORT_DATES})`,
    adjacency: 'adjacent' },
  { id: 'C2N-ctx', label: '2-node non-adjacent, cohort, context',
    selectedNodeIds: ['household-created', 'switch-success'],
    dasQuery: 'from(household-created).to(switch-success)',
    dslConstraints: `context(channel:influencer).cohort(${COHORT_DATES})`,
    adjacency: 'non-adjacent' },
  // ── 3-node adjacent (DAS uses visited() for middle node) ──
  { id: 'W3A', label: '3-node adjacent, window, no context',
    selectedNodeIds: ['household-created', 'household-delegated', 'switch-registered'],
    dasQuery: 'from(household-created).to(switch-registered).visited(household-delegated)',
    dslConstraints: `window(${WINDOW_DATES})`,
    adjacency: 'adjacent' },
  { id: 'W3N-ctx', label: '3-node non-adjacent, window, context',
    selectedNodeIds: ['Landing-page', 'household-delegated', 'switch-success'],
    dasQuery: 'from(Landing-page).to(switch-success).visited(household-delegated)',
    dslConstraints: `context(channel:influencer).window(${WINDOW_DATES})`,
    adjacency: 'non-adjacent' },
  // ── 3-node cohort ──
  { id: 'C3A', label: '3-node adjacent, cohort, no context',
    selectedNodeIds: ['household-delegated', 'switch-registered', 'switch-success'],
    dasQuery: 'from(household-delegated).to(switch-success).visited(switch-registered)',
    dslConstraints: `cohort(${COHORT_DATES})`,
    adjacency: 'adjacent' },
  { id: 'C3N', label: '3-node non-adjacent, cohort, no context',
    selectedNodeIds: ['Landing-page', 'switch-registered', 'switch-success'],
    dasQuery: 'from(Landing-page).to(switch-success).visited(switch-registered)',
    dslConstraints: `cohort(${COHORT_DATES})`,
    adjacency: 'non-adjacent' },
  { id: 'C3A-ctx', label: '3-node adjacent, cohort, context',
    selectedNodeIds: ['household-created', 'household-delegated', 'switch-registered'],
    dasQuery: 'from(household-created).to(switch-registered).visited(household-delegated)',
    dslConstraints: `context(channel:influencer).cohort(${COHORT_DATES})`,
    adjacency: 'adjacent' },
  // ── Staging ── (uses amplitude-staging connection + credentials)
  { id: 'STG-W2A', label: 'STAGING: 2-node adjacent, window, no context',
    selectedNodeIds: ['household-created', 'household-delegated'],
    dasQuery: 'from(household-created).to(household-delegated)',
    dslConstraints: `window(12-Feb-26:14-Feb-26)`,
    adjacency: 'adjacent',
    connection: 'amplitude-staging' },
  { id: 'STG-W2A-ctx', label: 'STAGING: 2-node adjacent, window, context',
    selectedNodeIds: ['household-created', 'household-delegated'],
    dasQuery: 'from(household-created).to(household-delegated)',
    dslConstraints: `context(channel:influencer).window(12-Feb-26:14-Feb-26)`,
    adjacency: 'adjacent',
    connection: 'amplitude-staging' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

testMode('Amplitude Funnel Roundtrip E2E (gm-rebuild-jan-26)', () => {
  beforeAll(async () => {
    await seedFileRegistry();
  });

  afterAll(async () => {
    for (const { chartId, orgId } of createdChartIds) {
      try { await deleteChart(chartId, orgId); console.log(`  Cleaned up chart ${chartId}`); }
      catch (e) { console.warn(`  Failed to clean up chart ${chartId}:`, e); }
    }
  });

  for (const tc of TEST_CASES) {
    it(`${tc.id}: ${tc.label}`, async () => {
      const connName = tc.connection || 'amplitude-prod';
      const config = connectionConfigs[connName];
      if (!config) throw new Error(`Connection "${connName}" not configured in connections.yaml (missing app_id/org_id/org_slug)`);
      const credsRef = config.credsRef;
      if (!credentialsByRef[credsRef]) throw new Error(`No credentials for credsRef "${credsRef}" — set env vars`);

      // ── Path A: DAS adapter (real buildDslFromEdge) ──────────────────
      const fullDasQuery = `${tc.dasQuery}.${tc.dslConstraints}`;
      const constraints = parseConstraints(tc.dslConstraints);

      // Find a real edge for the from→to pair (for latency data), or construct synthetic
      const fromNode = graphData.nodes.find((n: any) => n.id === tc.selectedNodeIds[0]);
      const toNode = graphData.nodes.find((n: any) => n.id === tc.selectedNodeIds[tc.selectedNodeIds.length - 1]);
      const realEdge = graphData.edges.find((e: any) => {
        const fromId = graphData.nodes.find((n: any) => n.uuid === e.from)?.id || e.from;
        const toId = graphData.nodes.find((n: any) => n.uuid === e.to)?.id || e.to;
        return fromId === tc.selectedNodeIds[0] && toId === tc.selectedNodeIds[tc.selectedNodeIds.length - 1];
      });

      const edge = realEdge
        ? { ...realEdge, query: fullDasQuery, from: fromNode?.uuid || tc.selectedNodeIds[0], to: toNode?.uuid || tc.selectedNodeIds[tc.selectedNodeIds.length - 1] }
        : { query: fullDasQuery, from: fromNode?.uuid || tc.selectedNodeIds[0], to: toNode?.uuid || tc.selectedNodeIds[tc.selectedNodeIds.length - 1], p: {} };

      const { queryPayload, eventDefinitions } = await buildDslFromEdge(
        edge, graphData, 'amplitude', eventLoader, constraints,
      );

      const dasParams = queryPayloadToRestParams(queryPayload, eventDefinitions, config!.excludedCohorts);
      const dasData = await amplitudeRestGet(dasParams, credsRef);
      if (!dasData.data?.[0]?.cumulativeRaw) {
        console.log(`  ${tc.id} [${connName}] SKIPPED: no data from Amplitude (empty result set)`);
        return; // No data in this project for this query — skip comparison
      }
      const dasResult = { n: dasData.data[0].cumulativeRaw[0], k: dasData.data[0].cumulativeRaw[dasData.data[0].cumulativeRaw.length - 1] };

      // ── Path B: Funnel builder (real buildAmplitudeFunnelDefinition) ─
      const buildResult = await buildAmplitudeFunnelDefinition({
        selectedNodeIds: tc.selectedNodeIds,
        graphNodes: graphData.nodes,
        graphEdges: graphData.edges,
        effectiveDsl: tc.dslConstraints,
        appId: config!.appId,
        connectionDefaults: { excluded_cohorts: config!.excludedCohorts },
      });

      const chartId = await createAndSaveChart(buildResult.definition, `RT-${tc.id}`, config!);
      const chartResult = await getChartResults(chartId, credsRef);

      // ── Compare ──────────────────────────────────────────────────────
      console.log(`  ${tc.id} [${connName}] DAS:   n=${dasResult.n}, k=${dasResult.k}`);
      console.log(`  ${tc.id} [${connName}] Chart: n=${chartResult.n}, k=${chartResult.k}`);

      expect(chartResult.n).toBe(dasResult.n);
      expect(chartResult.k).toBe(dasResult.k);
    }, 60000);
  }

  it('structural: cohort cs from graph latency', () => {
    const cs = computeCohortConversionSeconds(graphData.edges);
    expect(cs).toBe(50 * 86400);
    expect(cs).toBeGreaterThan(30 * 86400);
  });
});
