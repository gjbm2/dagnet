
import { describe, it, expect, vi } from 'vitest';
import { buildDslFromEdge } from '../buildDslFromEdge';
import { formatDateUK, parseUKDate } from '../../dateFormat';

// Mock graph and helpers
const mockGraph = {
  nodes: [
    { id: 'A', event_id: 'event_a' },
    { id: 'B', event_id: 'event_b' }
  ],
  edges: []
};

describe('resolveWindowDates Timezone/Boundary Issues', () => {
  
  it('window(-7d:) should result in clean date boundaries', async () => {
    // Mock "now" to a specific time: Dec 8, 2025, 14:30:00 Local
    // We'll use system time mocking
    const mockNow = new Date('2025-12-08T14:30:00');
    vi.useFakeTimers();
    vi.setSystemTime(mockNow);

    const edge = { 
      from: 'A', 
      to: 'B', 
      query: 'from(A).to(B)' 
    };
    
    // Pass window(-7d:) via constraints
    const constraints = {
      window: { start: '-7d', end: '' }, // "end: ''" implies 'now' / open-ended
      context: [],
      contextAny: [],
      cases: [],
      visited: [],
      visitedAny: [],
      exclude: []
    };

    const result = await buildDslFromEdge(edge, mockGraph, 'amplitude', undefined, constraints);
    
    const start = result.queryPayload.start;
    const end = result.queryPayload.end;
    
    console.log('Resolved Window:', { start, end });
    
    // Expect clean date boundaries (UTC Midnight)
    // Dec 8 Local -> 8-Dec-25 -> 2025-12-08T00:00:00.000Z (UTC)
    // Start: Dec 8 - 7 days = Dec 1
    expect(start).toBe('2025-12-01T00:00:00.000Z');
    expect(end).toBe('2025-12-08T00:00:00.000Z');
    
    // Ensure end date is populated (fixing the secondary bug)
    expect(end).toBeDefined();
    
    vi.useRealTimers();
  });

  it('should align to date boundaries to avoid timezone drifts near midnight', async () => {
    // Scenario: "Now" is near end of day UTC
    const mockNow = new Date('2025-12-08T23:59:59.999Z'); 
    vi.useFakeTimers();
    vi.setSystemTime(mockNow);
    
    const edge = { from: 'A', to: 'B', query: 'from(A).to(B)' };
    const constraints = { window: { start: '-1d', end: '' }, context: [], contextAny: [], cases: [], visited: [], visitedAny: [], exclude: [] };
    
    const result = await buildDslFromEdge(edge, mockGraph, 'amplitude', undefined, constraints);
    
    console.log('Near-midnight Window:', { start: result.queryPayload.start });
    
    // Expect clean boundaries, not T23:59:59
    expect(result.queryPayload.start).toBe('2025-12-07T00:00:00.000Z');
    expect(result.queryPayload.end).toBe('2025-12-08T00:00:00.000Z');
    
    vi.useRealTimers();
  });
});
