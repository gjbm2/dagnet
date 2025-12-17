import { describe, it, expect } from 'vitest';
import { computeQuerySignature } from '../dataOperationsService';

describe('computeQuerySignature - context_filters', () => {
  it('changes when context_filters predicate changes even if context key/value stays the same', async () => {
    const basePayload: any = {
      from: 'a',
      to: 'b',
      context: [{ key: 'channel', value: 'other' }],
    };

    const sig1 = await computeQuerySignature(
      {
        ...basePayload,
        context_filters: [
          { field: 'utm_medium', op: 'is not', values: [], pattern: '^(cpc)$', patternFlags: 'i' },
        ],
      },
      'amplitude-prod'
    );

    const sig2 = await computeQuerySignature(
      {
        ...basePayload,
        context_filters: [
          { field: 'utm_medium', op: 'is not', values: [], pattern: '^(cpc|paid-social)$', patternFlags: 'i' },
        ],
      },
      'amplitude-prod'
    );

    expect(sig1).not.toEqual(sig2);
  });
});


