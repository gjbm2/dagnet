#!/usr/bin/env node
/**
 * dagnet-cli analyse — entry point.
 */

const rawArgs = process.argv.slice(2);
const verbose = rawArgs.includes('--verbose') || rawArgs.includes('-v');
const showSessionLog = rawArgs.includes('--session-log');

if (!verbose) {
  const noop = () => {};
  console.log = noop;
  console.warn = noop;
  if (!showSessionLog) console.info = noop;
}

await import('fake-indexeddb/auto');

const { run } = await import('./commands/analyse.js');
await run();
