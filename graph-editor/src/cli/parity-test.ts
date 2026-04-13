#!/usr/bin/env node
/**
 * dagnet-cli parity-test — entry point.
 *
 * Proves old-path (snapshot_subjects) and new-path (analytics_dsl)
 * produce identical BE responses for snapshot analysis types.
 */

import { initCLI } from './cliEntry.js';
initCLI();

await import('fake-indexeddb/auto');

const { run } = await import('./commands/parity-test.js');
await run();
