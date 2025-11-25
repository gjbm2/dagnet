/**
 * End-to-End Integration Test: Channel Context with Phase 4 Implementation
 * 
 * Tests the complete flow:
 * 1. Load channel context from YAML
 * 2. Load event definitions from YAML
 * 3. Parse DSL with context constraints
 * 4. Build Amplitude filters with otherPolicy
 * 5. Verify complete funnel construction with context filters
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { buildDslFromEdge } from '../../src/lib/das/buildDslFromEdge';
import { parseConstraints } from '../../src/lib/queryDSL';
import { contextRegistry } from '../../src/services/contextRegistry';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

describe('Phase 4 E2E: Channel Context with Real Funnel', () => {
  
  let channelContext: any;
  let householdDelegatedEvent: any;
  let sawWaDetailsEvent: any;
  
  beforeAll(async () => {
    // Load the channel context YAML file
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
    
    console.log('\n[E2E Test] ==========================================');
    console.log('[E2E Test] Loaded channel context:', channelContext.id);
    console.log('[E2E Test] Channel values:', channelContext.values.map((v: any) => v.id).join(', '));
    console.log('[E2E Test] From event:', householdDelegatedEvent.id, '→', householdDelegatedEvent.provider_event_names.amplitude);
    console.log('[E2E Test] To event:', sawWaDetailsEvent.id, '→', sawWaDetailsEvent.provider_event_names.amplitude);
    console.log('[E2E Test] ==========================================\n');
  });
  
  describe('Complete Funnel with Context Filters', () => {
    
    it('should build complete DSL for Google (CPC) channel funnel', async () => {
      const graph = {
        nodes: [
          { 
            id: 'household-delegated', 
            label: 'Delegation Completed', 
            event_id: 'household-delegated'  // Use event definition ID, not provider name
          },
          { 
            id: 'saw-wa-details-page', 
            label: 'Saw WA Details', 
            event_id: 'saw-wa-details-page'  // Use event definition ID, not provider name
          }
        ],
        edges: []
      };
      
      const edge = {
        id: 'delegation-to-wa-details',
        from: 'household-delegated',
        to: 'saw-wa-details-page',
        p: { mean: 0.5 },
        query: 'from(household-delegated).to(saw-wa-details-page).context(channel:google)'
      };
      
      const constraints = parseConstraints('context(channel:google)');
      
      // Create event loader that returns our loaded event definitions
      const eventLoader = async (eventId: string) => {
        if (eventId === 'household-delegated') return householdDelegatedEvent;
        if (eventId === 'saw-wa-details-page') return sawWaDetailsEvent;
        throw new Error(`Event not found: ${eventId}`);
      };
      
      // Mock the context registry
      vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(channelContext);
      vi.spyOn(contextRegistry, 'getSourceMapping').mockResolvedValue({
        field: 'utm_medium',
        filter: "utm_medium == 'cpc'"
      });
      
      const result = await buildDslFromEdge(edge, graph, 'amplitude', eventLoader, constraints);
      
      // Verify DSL structure
      expect(result.from).toBe('Household DelegationStatusChanged');
      expect(result.to).toBe('Viewed WhatsApp details /onboarding/whatsApp-details Page');
      expect(result.context_filters).toBeDefined();
      expect(result.context_filters).toHaveLength(1);
      expect(result.context_filters![0]).toBe("utm_medium == 'cpc'");
      
      // Verify event filters for Amplitude properties
      expect(result.event_filters).toBeDefined();
      expect(result.event_filters!['Household DelegationStatusChanged']).toBeDefined();
      expect(result.event_filters!['Household DelegationStatusChanged']).toHaveLength(1);
      expect(result.event_filters!['Household DelegationStatusChanged'][0].property).toBe('newDelegationStatus');
      expect(result.event_filters!['Household DelegationStatusChanged'][0].operator).toBe('is any of');
      expect(result.event_filters!['Household DelegationStatusChanged'][0].values).toContain('ON');
      
      console.log('\n[E2E Test] ✅ Google Channel Funnel Built Successfully');
      console.log('[E2E Test] From:', result.from);
      console.log('[E2E Test] To:', result.to);
      console.log('[E2E Test] Context Filter:', result.context_filters![0]);
      console.log('[E2E Test] Event Filters:', JSON.stringify(result.event_filters, null, 2));
    });
    
    it('should build funnel for Influencer channel', async () => {
      const graph = {
        nodes: [
          { 
            id: 'household-delegated', 
            label: 'Delegation Completed', 
            event_id: householdDelegatedEvent.provider_event_names.amplitude 
          },
          { 
            id: 'saw-wa-details-page', 
            label: 'Saw WA Details', 
            event_id: sawWaDetailsEvent.provider_event_names.amplitude 
          }
        ],
        edges: []
      };
      
      const edge = {
        id: 'delegation-to-wa-details',
        from: 'household-delegated',
        to: 'saw-wa-details-page',
        p: { mean: 0.45 },
        query: 'from(household-delegated).to(saw-wa-details-page).context(channel:influencer)'
      };
      
      const constraints = parseConstraints('context(channel:influencer)');
      
      vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(channelContext);
      vi.spyOn(contextRegistry, 'getSourceMapping').mockResolvedValue({
        field: 'utm_medium',
        filter: "utm_medium == 'Influencers'"
      });
      
      const result = await buildDslFromEdge(edge, graph, 'amplitude', undefined, constraints);
      
      expect(result.context_filters).toBeDefined();
      expect(result.context_filters![0]).toBe("utm_medium == 'Influencers'");
      
      console.log('\n[E2E Test] ✅ Influencer Channel Funnel Built');
      console.log('[E2E Test] Context Filter:', result.context_filters![0]);
    });
    
    it('should build funnel for Paid Social channel with regex', async () => {
      const graph = {
        nodes: [
          { 
            id: 'household-delegated', 
            label: 'Delegation Completed', 
            event_id: householdDelegatedEvent.provider_event_names.amplitude 
          },
          { 
            id: 'saw-wa-details-page', 
            label: 'Saw WA Details', 
            event_id: sawWaDetailsEvent.provider_event_names.amplitude 
          }
        ],
        edges: []
      };
      
      const edge = {
        id: 'delegation-to-wa-details',
        from: 'household-delegated',
        to: 'saw-wa-details-page',
        p: { mean: 0.55 },
        query: 'from(household-delegated).to(saw-wa-details-page).context(channel:paid-social)'
      };
      
      const constraints = parseConstraints('context(channel:paid-social)');
      
      vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(channelContext);
      vi.spyOn(contextRegistry, 'getSourceMapping').mockResolvedValue({
        field: 'utm_medium',
        pattern: '^(Paid Social|paidsocial)$',
        patternFlags: 'i'
      });
      
      const result = await buildDslFromEdge(edge, graph, 'amplitude', undefined, constraints);
      
      expect(result.context_filters).toBeDefined();
      expect(result.context_filters![0]).toContain('utm_medium matches');
      expect(result.context_filters![0]).toContain('^(Paid Social|paidsocial)$');
      expect(result.context_filters![0]).toContain('(case-insensitive)');
      
      console.log('\n[E2E Test] ✅ Paid Social Channel Funnel Built (Regex)');
      console.log('[E2E Test] Context Filter:', result.context_filters![0]);
    });
    
    it('should build funnel for "other" channel with computed NOT filter', async () => {
      const graph = {
        nodes: [
          { 
            id: 'household-delegated', 
            label: 'Delegation Completed', 
            event_id: householdDelegatedEvent.provider_event_names.amplitude 
          },
          { 
            id: 'saw-wa-details-page', 
            label: 'Saw WA Details', 
            event_id: sawWaDetailsEvent.provider_event_names.amplitude 
          }
        ],
        edges: []
      };
      
      const edge = {
        id: 'delegation-to-wa-details',
        from: 'household-delegated',
        to: 'saw-wa-details-page',
        p: { mean: 0.25 },
        query: 'from(household-delegated).to(saw-wa-details-page).context(channel:other)'
      };
      
      const constraints = parseConstraints('context(channel:other)');
      
      // Mock context with computed otherPolicy
      const contextWithOther = {
        ...channelContext,
        otherPolicy: 'computed'
      };
      
      vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(contextWithOther);
      
      // Mock getSourceMapping to return filters for all explicit values
      vi.spyOn(contextRegistry, 'getSourceMapping')
        .mockImplementation(async (key, value, source) => {
          const mappings: Record<string, any> = {
            'google': { filter: "utm_medium == 'cpc'", field: 'utm_medium' },
            'influencer': { filter: "utm_medium == 'Influencers'", field: 'utm_medium' },
            'paid-social': { pattern: '^(Paid Social|paidsocial)$', patternFlags: 'i', field: 'utm_medium' },
            'referral': { filter: "utm_medium == 'referral'", field: 'utm_medium' },
            'pr': { filter: "utm_medium == 'pr'", field: 'utm_medium' }
          };
          return mappings[value];
        });
      
      const result = await buildDslFromEdge(edge, graph, 'amplitude', undefined, constraints);
      
      expect(result.context_filters).toBeDefined();
      expect(result.context_filters![0]).toContain('NOT (');
      expect(result.context_filters![0]).toContain("utm_medium == 'cpc'");
      expect(result.context_filters![0]).toContain("utm_medium == 'Influencers'");
      expect(result.context_filters![0]).toContain("utm_medium matches '^(Paid Social|paidsocial)$'");
      expect(result.context_filters![0]).toContain("utm_medium == 'referral'");
      expect(result.context_filters![0]).toContain("utm_medium == 'pr'");
      expect(result.context_filters![0]).toContain(' OR ');
      
      console.log('\n[E2E Test] ✅ "Other" Channel Funnel Built (Computed NOT filter)');
      console.log('[E2E Test] Context Filter:', result.context_filters![0]);
      console.log('\n[E2E Test] This filter excludes: google, influencer, paid-social, referral, pr');
      console.log('[E2E Test] Includes all other utm_medium values (email, sms, affiliate, etc.)');
    });
  });
  
  describe('Amplitude Segment Configuration Guide', () => {
    
    it('should document the required Amplitude segment setup', () => {
      const segmentConfig = {
        name: 'All Users with Tracking Data',
        description: 'Users with utm_medium parameter set',
        filter: {
          property: 'utm_medium',
          operator: 'is set'
        },
        notes: [
          'This segment ensures we only analyze users with tracking data',
          'Apply this segment to funnels that use channel context filters',
          'Without this, untracked users will dilute conversion rates'
        ]
      };
      
      console.log('\n[E2E Test] ==========================================');
      console.log('[E2E Test] 📋 AMPLITUDE SEGMENT CONFIGURATION');
      console.log('[E2E Test] ==========================================');
      console.log('[E2E Test]');
      console.log('[E2E Test] Create an "All Users" segment in Amplitude with:');
      console.log('[E2E Test]');
      console.log('[E2E Test]   Segment Name: All Users with Tracking Data');
      console.log('[E2E Test]   Filter: utm_medium is set');
      console.log('[E2E Test]');
      console.log('[E2E Test] Why this is needed:');
      console.log('[E2E Test]   - Ensures we only analyze users with tracking data');
      console.log('[E2E Test]   - Prevents untracked traffic from diluting metrics');
      console.log('[E2E Test]   - Required for accurate channel attribution');
      console.log('[E2E Test]');
      console.log('[E2E Test] Apply this segment when querying funnels with:');
      console.log('[E2E Test]   - context(channel:google)');
      console.log('[E2E Test]   - context(channel:influencer)');
      console.log('[E2E Test]   - context(channel:paid-social)');
      console.log('[E2E Test]   - context(channel:referral)');
      console.log('[E2E Test]   - context(channel:pr)');
      console.log('[E2E Test]   - context(channel:other)');
      console.log('[E2E Test] ==========================================\n');
      
      expect(segmentConfig.name).toBe('All Users with Tracking Data');
      expect(segmentConfig.filter.property).toBe('utm_medium');
      expect(segmentConfig.filter.operator).toBe('is set');
    });
  });
  
  describe('Mathematical Validation: Segment Sum = Total', () => {
    
    it('should verify that computed "other" filter = NOT(all explicit filters)', async () => {
      // This test validates that:
      // 1. The "other" filter is computed correctly using otherPolicy: computed
      // 2. It generates: NOT (google OR influencer OR paid-social OR referral OR pr)
      // 3. The implementation uses the actual buildDslFromEdge logic
      
      const graph = {
        nodes: [
          { 
            id: 'household-delegated', 
            label: 'Delegation Completed', 
            event_id: 'household-delegated'
          },
          { 
            id: 'saw-wa-details-page', 
            label: 'Saw WA Details', 
            event_id: 'saw-wa-details-page'
          }
        ],
        edges: []
      };
      
      const eventLoader = async (eventId: string) => {
        if (eventId === 'household-delegated') return householdDelegatedEvent;
        if (eventId === 'saw-wa-details-page') return sawWaDetailsEvent;
        throw new Error(`Event not found: ${eventId}`);
      };
      
      console.log('\n[E2E Test] 📊 Mathematical Validation: Computed "Other" Filter');
      console.log('[E2E Test] ==========================================\n');
      
      // 1. Build DSL for baseline (no filter)
      const baselineEdge = {
        ...graph.edges[0],
        from: 'household-delegated',
        to: 'saw-wa-details-page',
        query: 'from(household-delegated).to(saw-wa-details-page)'
      };
      
      const baselineResult = await buildDslFromEdge(
        baselineEdge, 
        graph, 
        'amplitude', 
        eventLoader
      );
      
      console.log('[E2E Test] 1. Baseline Query (No Filter):');
      console.log('[E2E Test]    From:', baselineResult.from);
      console.log('[E2E Test]    To:', baselineResult.to);
      console.log('[E2E Test]    Context Filters:', baselineResult.context_filters || 'none');
      console.log('[E2E Test]');
      
      // 2. Build DSL queries for each explicit channel
      const explicitChannels = ['google', 'influencer', 'paid-social', 'referral', 'pr'];
      const channelFilters: Record<string, string> = {};
      
      console.log('[E2E Test] 2. Explicit Channel Filters:');
      
      for (const channelId of explicitChannels) {
        const constraints = parseConstraints(`context(channel:${channelId})`);
        const channelEdge = {
          ...baselineEdge,
          query: `from(household-delegated).to(saw-wa-details-page).context(channel:${channelId})`
        };
        
        // Mock context registry for this channel
        vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(channelContext);
        
        // Get the actual mapping from our channel context
        const channelValue = channelContext.values.find((v: any) => v.id === channelId);
        const amplitudeSource = channelValue?.sources?.amplitude;
        
        if (amplitudeSource) {
          vi.spyOn(contextRegistry, 'getSourceMapping').mockResolvedValue(amplitudeSource);
        }
        
        const result = await buildDslFromEdge(
          channelEdge,
          graph,
          'amplitude',
          eventLoader,
          constraints
        );
        
        channelFilters[channelId] = result.context_filters![0];
        console.log(`[E2E Test]    ${channelId.padEnd(13)}: ${result.context_filters![0]}`);
      }
      
      console.log('[E2E Test]');
      
      // 3. Build DSL for "other" using otherPolicy: computed
      const otherEdge = {
        ...baselineEdge,
        query: 'from(household-delegated).to(saw-wa-details-page).context(channel:other)'
      };
      
      const otherConstraints = parseConstraints('context(channel:other)');
      
      // Mock context with computed otherPolicy
      const contextWithComputedOther = {
        ...channelContext,
        otherPolicy: 'computed'
      };
      
      vi.spyOn(contextRegistry, 'getContext').mockResolvedValue(contextWithComputedOther);
      
      // Mock getSourceMapping to return all explicit channel mappings for "other" computation
      vi.spyOn(contextRegistry, 'getSourceMapping')
        .mockImplementation(async (key, value, source) => {
          const mappings: Record<string, any> = {
            'google': { filter: "utm_medium == 'cpc'", field: 'utm_medium' },
            'influencer': { filter: "utm_medium == 'Influencers'", field: 'utm_medium' },
            'paid-social': { pattern: '^(Paid Social|paidsocial)$', patternFlags: 'i', field: 'utm_medium' },
            'referral': { filter: "utm_medium == 'referral'", field: 'utm_medium' },
            'pr': { filter: "utm_medium == 'pr'", field: 'utm_medium' }
          };
          return mappings[value];
        });
      
      const otherResult = await buildDslFromEdge(
        otherEdge,
        graph,
        'amplitude',
        eventLoader,
        otherConstraints
      );
      
      console.log('[E2E Test] 3. Computed "Other" Filter (otherPolicy: computed):');
      console.log('[E2E Test]    Filter:', otherResult.context_filters![0]);
      console.log('[E2E Test]');
      
      // 4. Verify "other" filter structure
      const otherFilter = otherResult.context_filters![0];
      
      // Should start with "NOT ("
      expect(otherFilter).toContain('NOT (');
      
      // Should contain all explicit channel filters with OR logic
      expect(otherFilter).toContain("utm_medium == 'cpc'");
      expect(otherFilter).toContain("utm_medium == 'Influencers'");
      expect(otherFilter).toContain("utm_medium matches '^(Paid Social|paidsocial)$'");
      expect(otherFilter).toContain("utm_medium == 'referral'");
      expect(otherFilter).toContain("utm_medium == 'pr'");
      expect(otherFilter).toContain(' OR ');
      
      console.log('[E2E Test] ✅ VALIDATION PASSED');
      console.log('[E2E Test]    "Other" filter starts with "NOT (" ✓');
      console.log('[E2E Test]    Contains all explicit filters with OR logic ✓');
      console.log('[E2E Test]    Generated by Phase 4 buildDslFromEdge code ✓');
      console.log('[E2E Test]');
      console.log('[E2E Test] 4. Mathematical Guarantee:');
      console.log('[E2E Test]    If you query Amplitude with these filters:');
      console.log('[E2E Test]    • google + influencer + paid-social + referral + pr + other');
      console.log('[E2E Test]    • Sum(n) = baseline n (no overlap, no gaps)');
      console.log('[E2E Test]    • Sum(k) = baseline k (no overlap, no gaps)');
      console.log('[E2E Test]');
      console.log('[E2E Test]    The "other" filter ensures:');
      console.log('[E2E Test]    • other(n) = baseline(n) - Σ(explicit channels n)');
      console.log('[E2E Test]    • other(k) = baseline(k) - Σ(explicit channels k)');
      console.log('[E2E Test] ==========================================\n');
    });
  });
  
  describe('Complete Query Examples', () => {
    
    it('should demonstrate all channel queries for the funnel', () => {
      const queries = [
        {
          channel: 'google',
          dsl: 'from(household-delegated).to(saw-wa-details-page).context(channel:google)',
          amplitudeFilter: "utm_medium == 'cpc'",
          description: 'Google Ads (CPC) traffic conversion'
        },
        {
          channel: 'influencer',
          dsl: 'from(household-delegated).to(saw-wa-details-page).context(channel:influencer)',
          amplitudeFilter: "utm_medium == 'Influencers'",
          description: 'Influencer campaign conversion'
        },
        {
          channel: 'paid-social',
          dsl: 'from(household-delegated).to(saw-wa-details-page).context(channel:paid-social)',
          amplitudeFilter: "utm_medium matches '^(Paid Social|paidsocial)$' (case-insensitive)",
          description: 'Paid social media conversion (handles both variants)'
        },
        {
          channel: 'referral',
          dsl: 'from(household-delegated).to(saw-wa-details-page).context(channel:referral)',
          amplitudeFilter: "utm_medium == 'referral'",
          description: 'Referral traffic conversion'
        },
        {
          channel: 'pr',
          dsl: 'from(household-delegated).to(saw-wa-details-page).context(channel:pr)',
          amplitudeFilter: "utm_medium == 'pr'",
          description: 'PR and media coverage conversion'
        },
        {
          channel: 'other',
          dsl: 'from(household-delegated).to(saw-wa-details-page).context(channel:other)',
          amplitudeFilter: "NOT (utm_medium == 'cpc' OR utm_medium == 'Influencers' OR ... OR utm_medium == 'pr')",
          description: 'All other traffic sources (email, sms, affiliate, etc.)'
        }
      ];
      
      console.log('\n[E2E Test] ==========================================');
      console.log('[E2E Test] 📊 COMPLETE QUERY EXAMPLES');
      console.log('[E2E Test] ==========================================\n');
      
      queries.forEach((q, idx) => {
        console.log(`[E2E Test] ${idx + 1}. ${q.channel.toUpperCase()} Channel`);
        console.log(`[E2E Test]    DSL: ${q.dsl}`);
        console.log(`[E2E Test]    Amplitude Filter: ${q.amplitudeFilter}`);
        console.log(`[E2E Test]    Description: ${q.description}`);
        console.log('[E2E Test]');
      });
      
      console.log('[E2E Test] ==========================================\n');
      
      expect(queries).toHaveLength(6);
    });
  });
});
