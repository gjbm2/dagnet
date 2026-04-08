#!/usr/bin/env node
/**
 * dagnet-cli param-pack — entry point.
 *
 * Console suppression and polyfills run before any other imports
 * to silence module-level logging from dependencies.
 */

import { initCLI } from './cliEntry.js';
initCLI();

await import('fake-indexeddb/auto');

const { run } = await import('./commands/paramPack.js');
await run();
