/**
 * export-graph-bundle – dependency detection
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectGraphDependencies } from '../export-graph-bundle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('export-graph-bundle dependency detection', () => {
  it('extracts parameters/events/cases/contexts/nodes from a fixture graph', async () => {
    // This test lives at graph-editor/scripts/__tests__.
    // Repo root (dagnet) is 3 levels up: __tests__ → scripts → graph-editor → dagnet
    const repoRoot = path.resolve(__dirname, '../../..');
    const fixtureGraphPath = path.join(repoRoot, 'param-registry/test/graphs/ecommerce-checkout-flow.json');

    const text = await fs.readFile(fixtureGraphPath, 'utf8');
    const graph = JSON.parse(text);

    const deps = collectGraphDependencies(graph);

    // Parameters (edge-backed)
    expect(deps.parameterIds.has('landing-to-product')).toBe(true);
    expect(deps.parameterIds.has('checkout-to-payment-latency')).toBe(true);

    // Events (node.event_id)
    expect(deps.eventIds.has('page-view-landing')).toBe(true);
    expect(deps.eventIds.has('payment-submitted')).toBe(true);

    // Cases (case node)
    expect(deps.caseIds.has('cart-experience-test')).toBe(true);

    // Context keys (from graph.dataInterestsDSL)
    expect(deps.contextKeys.has('channel')).toBe(true);

    // Nodes (from node.id)
    expect(deps.nodeIds.has('landing-page')).toBe(true);
    expect(deps.nodeIds.has('checkout')).toBe(true);
  });
});


