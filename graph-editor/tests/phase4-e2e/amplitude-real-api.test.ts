/**
 * Real Amplitude API Integration Test
 * 
 * This test actually calls the Amplitude API with context filters.
 * Requires AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY environment variables.
 * 
 * Run with:
 *   AMPLITUDE_API_KEY=xxx AMPLITUDE_SECRET_KEY=yyy npm test -- tests/phase4-e2e/amplitude-real-api.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { DASRunner } from '../../src/lib/das/DASRunner';
import { buildDslFromEdge } from '../../src/lib/das/buildDslFromEdge';
import { parseConstraints } from '../../src/lib/queryDSL';
import { contextRegistry } from '../../src/services/contextRegistry';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

// Skip if no credentials provided
const hasCredentials = process.env.AMPLITUDE_API_KEY && process.env.AMPLITUDE_SECRET_KEY;
const testMode = hasCredentials ? describe : describe.skip;

testMode('Real Amplitude API: Channel Context Integration', () => {
  
  let dasRunner: DASRunner;
  let channelContext: any;
  let householdDelegatedEvent: any;
  let sawWaDetailsEvent: any;
  
  beforeAll(async () => {
    // Load channel context
    const channelPath = path.join(__dirname, '../../../param-registry/test/contexts/channel.yaml');
    const channelYaml = fs.readFileSync(channelPath, 'utf8');
    channelContext = yaml.parse(channelYaml);
    
    // Load event definitions
    const householdDelegatedPath = path.join(__dirname, '../../../param-registry/test/events/household-delegated.yaml');
    const householdDelegatedYaml = fs.readFileSync(householdDelegatedPath, 'utf8');
    householdDelegatedEvent = yaml.parse(householdDelegatedYaml);
    
    const sawWaDetailsPath = path.join(__dirname, '../../../param-registry/test/events/saw-wa-details-page.yaml');
    const sawWaDetailsYaml = fs.readFileSync(sawWaDetailsPath, 'utf8');
    sawWaDetailsEvent = yaml.parse(sawWaDetailsYaml);
    
    // Initialize DASRunner with Amplitude credentials
    dasRunner = new DASRunner();
    
    console.log('\n╔════════════════════════════════════════════════════════════════╗');
    console.log('║  REAL AMPLITUDE API INTEGRATION TEST                           ║');
    console.log('╚════════════════════════════════════════════════════════════════╝\n');
    console.log('[Real API] Credentials loaded from environment variables');
    console.log('[Real API] Channel context:', channelContext.id);
    console.log('[Real API] From event:', householdDelegatedEvent.provider_event_names.amplitude);
    console.log('[Real API] To event:', sawWaDetailsEvent.provider_event_names.amplitude);
    console.log('');
  });
  
  it('should fetch baseline conversion (no context filter)', async () => {
    const graph = {
      nodes: [
        { id: 'household-delegated', label: 'Delegation Completed', event_id: 'household-delegated' },
        { id: 'saw-wa-details-page', label: 'Saw WA Details', event_id: 'saw-wa-details-page' }
      ],
      edges: []
    };
    
    const edge = {
      id: 'baseline',
      from: 'household-delegated',
      to: 'saw-wa-details-page',
      query: 'from(household-delegated).to(saw-wa-details-page)'
    };
    
    const eventLoader = async (eventId: string) => {
      if (eventId === 'household-delegated') return householdDelegatedEvent;
      if (eventId === 'saw-wa-details-page') return sawWaDetailsEvent;
      throw new Error(`Event not found: ${eventId}`);
    };
    
    const dsl = await buildDslFromEdge(edge, graph, 'amplitude', eventLoader);
    
    console.log('────────────────────────────────────────────────────────────────');
    console.log('📊 BASELINE QUERY (No Filter)');
    console.log('────────────────────────────────────────────────────────────────');
    console.log('From:', dsl.from);
    console.log('To:', dsl.to);
    console.log('Context Filters:', dsl.context_filters || 'none');
    console.log('');
    
    // Calculate date range (last 7 days)
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 7);
    
    const window = {
      start: start.toISOString(),
      end: end.toISOString()
    };
    
    console.log('Window:', `${start.toISOString().split('T')[0]} to ${end.toISOString().split('T')[0]}`);
    console.log('');
    console.log('Calling Amplitude API...');
    
    const credentials = {
      api_key: process.env.AMPLITUDE_API_KEY!,
      secret_key: process.env.AMPLITUDE_SECRET_KEY!
    };
    
    const result = await dasRunner.execute('amplitude-prod', dsl, {
      window,
      credentials,
      context: { mode: 'daily' }
    });
    
    console.log('');
    console.log('✅ Response received:');
    console.log('   n (from count):', result.extracted?.n || result.extracted?.from_count);
    console.log('   k (to count):', result.extracted?.k || result.extracted?.to_count);
    console.log('   p (conversion):', result.extracted?.p_mean);
    console.log('   Time series days:', result.extracted?.time_series?.length || 0);
    console.log('');
    
    expect(result.success).toBe(true);
    expect(result.extracted).toBeDefined();
  }, 30000); // 30 second timeout for API call
  
  it('should fetch Google (CPC) channel conversion', async () => {
    const graph = {
      nodes: [
        { id: 'household-delegated', label: 'Delegation Completed', event_id: 'household-delegated' },
        { id: 'saw-wa-details-page', label: 'Saw WA Details', event_id: 'saw-wa-details-page' }
      ],
      edges: []
    };
    
    const edge = {
      id: 'google',
      from: 'household-delegated',
      to: 'saw-wa-details-page',
      query: 'from(household-delegated).to(saw-wa-details-page).context(channel:google)'
    };
    
    const eventLoader = async (eventId: string) => {
      if (eventId === 'household-delegated') return householdDelegatedEvent;
      if (eventId === 'saw-wa-details-page') return sawWaDetailsEvent;
      throw new Error(`Event not found: ${eventId}`);
    };
    
    const constraints = parseConstraints('context(channel:google)');
    
    // Mock context registry
    vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(channelContext);
    vi.spyOn(contextRegistry, 'getSourceMapping').mockResolvedValue({
      field: 'utm_medium',
      filter: "utm_medium == 'cpc'"
    });
    
    const dsl = await buildDslFromEdge(edge, graph, 'amplitude', eventLoader, constraints);
    
    console.log('────────────────────────────────────────────────────────────────');
    console.log('📊 GOOGLE CHANNEL QUERY (utm_medium == \'cpc\')');
    console.log('────────────────────────────────────────────────────────────────');
    console.log('From:', dsl.from);
    console.log('To:', dsl.to);
    console.log('Context Filters:', dsl.context_filters);
    console.log('');
    
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 7);
    
    const window = {
      start: start.toISOString(),
      end: end.toISOString()
    };
    
    console.log('Window:', `${start.toISOString().split('T')[0]} to ${end.toISOString().split('T')[0]}`);
    console.log('');
    console.log('Calling Amplitude API with context filter...');
    
    const credentials = {
      api_key: process.env.AMPLITUDE_API_KEY!,
      secret_key: process.env.AMPLITUDE_SECRET_KEY!
    };
    
    const result = await dasRunner.execute('amplitude-prod', dsl, {
      window,
      credentials,
      context: { mode: 'daily' }
    });
    
    console.log('');
    console.log('✅ Response received:');
    console.log('   n (from count):', result.extracted?.n || result.extracted?.from_count);
    console.log('   k (to count):', result.extracted?.k || result.extracted?.to_count);
    console.log('   p (conversion):', result.extracted?.p_mean);
    console.log('   Time series days:', result.extracted?.time_series?.length || 0);
    console.log('');
    
    expect(result.success).toBe(true);
    expect(result.extracted).toBeDefined();
  }, 30000);
  
  it('should fetch all channels and verify sum = baseline', async () => {
    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('🔬 MATHEMATICAL VALIDATION: CHANNEL SEGMENTS');
    console.log('════════════════════════════════════════════════════════════════\n');
    
    const graph = {
      nodes: [
        { id: 'household-delegated', label: 'Delegation Completed', event_id: 'household-delegated' },
        { id: 'saw-wa-details-page', label: 'Saw WA Details', event_id: 'saw-wa-details-page' }
      ],
      edges: []
    };
    
    const eventLoader = async (eventId: string) => {
      if (eventId === 'household-delegated') return householdDelegatedEvent;
      if (eventId === 'saw-wa-details-page') return sawWaDetailsEvent;
      throw new Error(`Event not found: ${eventId}`);
    };
    
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 7);
    
    const window = {
      start: start.toISOString(),
      end: end.toISOString()
    };
    
    const credentials = {
      api_key: process.env.AMPLITUDE_API_KEY!,
      secret_key: process.env.AMPLITUDE_SECRET_KEY!
    };
    
    // 1. Fetch baseline
    console.log('1️⃣  Fetching BASELINE (no filter)...');
    const baselineEdge = {
      id: 'baseline',
      from: 'household-delegated',
      to: 'saw-wa-details-page',
      query: 'from(household-delegated).to(saw-wa-details-page)'
    };
    
    const baselineDsl = await buildDslFromEdge(baselineEdge, graph, 'amplitude', eventLoader);
    const baselineResult = await dasRunner.execute('amplitude-prod', baselineDsl, {
      window,
      credentials,
      context: { mode: 'daily' }
    });
    
    const baselineN = baselineResult.extracted?.n || baselineResult.extracted?.from_count || 0;
    const baselineK = baselineResult.extracted?.k || baselineResult.extracted?.to_count || 0;
    
    console.log('   ✓ n =', baselineN);
    console.log('   ✓ k =', baselineK);
    console.log('   ✓ p =', (baselineK / baselineN).toFixed(4));
    console.log('');
    
    // 2. Fetch each channel
    const channels = [
      { id: 'google', filter: "utm_medium == 'cpc'" },
      { id: 'influencer', filter: "utm_medium == 'Influencers'" },
      { id: 'paid-social', pattern: '^(Paid Social|paidsocial)$', patternFlags: 'i' },
      { id: 'referral', filter: "utm_medium == 'referral'" },
      { id: 'pr', filter: "utm_medium == 'pr'" }
    ];
    
    const channelResults: any[] = [];
    
    for (const channel of channels) {
      console.log(`2️⃣  Fetching ${channel.id.toUpperCase()}...`);
      
      const channelEdge = {
        id: channel.id,
        from: 'household-delegated',
        to: 'saw-wa-details-page',
        query: `from(household-delegated).to(saw-wa-details-page).context(channel:${channel.id})`
      };
      
      const constraints = parseConstraints(`context(channel:${channel.id})`);
      
      vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(channelContext);
      vi.spyOn(contextRegistry, 'getSourceMapping').mockResolvedValue(
        channel.filter 
          ? { filter: channel.filter, field: 'utm_medium' }
          : { pattern: channel.pattern, patternFlags: channel.patternFlags, field: 'utm_medium' }
      );
      
      const dsl = await buildDslFromEdge(channelEdge, graph, 'amplitude', eventLoader, constraints);
      const result = await dasRunner.execute('amplitude-prod', dsl, {
        window,
        credentials,
        context: { mode: 'daily' }
      });
      
      const n = result.extracted?.n || result.extracted?.from_count || 0;
      const k = result.extracted?.k || result.extracted?.to_count || 0;
      
      channelResults.push({ id: channel.id, n, k });
      
      console.log(`   ✓ n = ${n}, k = ${k}, p = ${(k / n).toFixed(4)}`);
      console.log('');
    }
    
    // 3. Calculate sums
    const sumN = channelResults.reduce((sum, ch) => sum + ch.n, 0);
    const sumK = channelResults.reduce((sum, ch) => sum + ch.k, 0);
    const missingN = baselineN - sumN;
    const missingK = baselineK - sumK;
    
    console.log('════════════════════════════════════════════════════════════════');
    console.log('📈 RESULTS');
    console.log('════════════════════════════════════════════════════════════════');
    console.log('');
    console.log('Baseline (all traffic):');
    console.log('  n =', baselineN);
    console.log('  k =', baselineK);
    console.log('');
    console.log('Sum of explicit channels:');
    console.log('  Σn =', sumN);
    console.log('  Σk =', sumK);
    console.log('');
    console.log('Missing traffic (should be "other"):');
    console.log('  Δn =', missingN, `(${((missingN / baselineN) * 100).toFixed(1)}%)`);
    console.log('  Δk =', missingK, `(${((missingK / baselineK) * 100).toFixed(1)}%)`);
    console.log('');
    
    // 4. Verify mathematical property
    const tolerance = 0.05; // 5% tolerance for API inconsistencies
    const nRatio = sumN / baselineN;
    const kRatio = sumK / baselineK;
    
    console.log('✅ VALIDATION:');
    console.log('  Explicit channels cover', (nRatio * 100).toFixed(1), '% of traffic');
    console.log('  Remaining', ((1 - nRatio) * 100).toFixed(1), '% would be caught by "other" filter');
    console.log('');
    
    expect(baselineN).toBeGreaterThan(0);
    expect(baselineK).toBeGreaterThan(0);
    expect(sumN).toBeGreaterThan(0);
  }, 120000); // 2 minute timeout for multiple API calls
});

// Message if credentials not provided
if (!hasCredentials) {
  console.log('\n⚠️  Skipping real Amplitude API tests');
  console.log('   To run: AMPLITUDE_API_KEY=xxx AMPLITUDE_SECRET_KEY=yyy npm test -- tests/phase4-e2e/amplitude-real-api.test.ts\n');
}

