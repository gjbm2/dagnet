#!/usr/bin/env node
/**
 * Sync Amplitude custom events from source project to target project.
 *
 * Fully programmatic: uses Playwright to log in, extract session cookies,
 * then calls the internal GraphQL API to list/create/update custom events.
 *
 * Usage:
 *   node scripts/amplitude-sync-custom-events.mjs \
 *     --email greg@nous.co \
 *     --password "YOUR_PASSWORD" \
 *     --org $AMPLITUDE_ORG_ID \
 *     --source $SOURCE_PROJECT_ID \
 *     --target $TARGET_PROJECT_ID \
 *     [--dry-run]
 *
 * Or with saved session (skips login):
 *   node scripts/amplitude-sync-custom-events.mjs \
 *     --session /tmp/amp-session-state.json \
 *     --org $AMPLITUDE_ORG_ID \
 *     --source $SOURCE_PROJECT_ID \
 *     --target $TARGET_PROJECT_ID
 */

import fs from 'fs';
import https from 'https';

// ── Parse args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
const hasFlag = (name) => args.includes(`--${name}`);

const email = getArg('email');
const password = getArg('password');
const sessionFile = getArg('session');
const orgId = getArg('org');
const sourceApp = getArg('source');
const targetApp = getArg('target');
const dryRun = hasFlag('dry-run');

if (!orgId || !sourceApp || !targetApp) {
  console.error('Required: --org, --source, --target');
  process.exit(1);
}
if (!sessionFile && (!email || !password)) {
  console.error('Required: --email + --password, or --session <file>');
  process.exit(1);
}

// ── Get session cookies ─────────────────────────────────────────────────────
let cookieString = '';

if (sessionFile && fs.existsSync(sessionFile)) {
  console.log(`Loading saved session from ${sessionFile}`);
  const state = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  cookieString = state.cookies
    .filter(c => c.domain.includes('amplitude.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
} else {
  // Interactive login: launch browser with HAR capture, user logs in manually
  console.log('Launching browser for login...');
  console.log('Log in to Amplitude, then close the browser to continue.');
  
  const { execSync } = await import('child_process');
  const harPath = '/tmp/amp-login.har';
  
  try {
    execSync(
      `cd "${process.cwd()}/graph-editor" && PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright" npx playwright open --save-har ${harPath} "https://app.amplitude.com/login"`,
      { stdio: 'inherit', timeout: 300000 }
    );
  } catch { /* browser closed */ }
  
  // Extract cookies from HAR
  if (fs.existsSync(harPath)) {
    const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
    for (const entry of har.log.entries) {
      const url = entry.request?.url || '';
      if (url.includes('app.amplitude.com') && url.includes('graphql')) {
        for (const h of entry.request.headers || []) {
          if (h.name.toLowerCase() === 'cookie') {
            cookieString = h.value;
            break;
          }
        }
        if (cookieString) break;
      }
    }
    
    // Save session for reuse
    if (cookieString) {
      const cookies = cookieString.split('; ').filter(p => p.includes('=')).map(p => {
        const [name, ...rest] = p.split('=');
        return { name: name.trim(), value: rest.join('=').trim(), domain: '.amplitude.com', path: '/' };
      });
      const savePath = '/tmp/amp-session-state.json';
      fs.writeFileSync(savePath, JSON.stringify({ cookies, origins: [] }, null, 2));
      console.log(`Session saved to ${savePath} (reuse with --session)`);
    }
  }
}

if (!cookieString) {
  console.error('ERROR: No amplitude.com cookies found. Login may have failed.');
  process.exit(1);
}

// ── GraphQL helpers ─────────────────────────────────────────────────────────
function gqlRequest(opName, query, variables) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ operationName: opName, variables, query });
    const req = https.request({
      hostname: 'app.amplitude.com',
      path: `/t/graphql/org-url/${orgSlug}?q=${opName}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookieString,
        'x-org': orgId,
        'Origin': 'https://app.amplitude.com',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Non-JSON response (${res.statusCode}): ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const LIST_QUERY = `query CustomEvents($appId: ID!) {
  customEvents(appId: $appId, allowedSuggestionStatuses: [NULL, ACCEPTED, SUGGESTED]) {
    id appId categoryName: category definition description
    display: displayName deleted: isDeleted hidden: isHidden
    autotrack: isAutotrack __typename
  }
}`;

const CREATE_MUTATION = `mutation CreateCustomEvent($appId: ID!, $name: String!, $definition: JSON!, $description: String!, $isAutotrack: Boolean, $category: String) {
  createCustomEvent(appId: $appId, name: $name, definition: $definition, description: $description, isAutotrack: $isAutotrack, category: $category) {
    customEvents { id display: displayName __typename } __typename
  }
}`;

const UPDATE_MUTATION = `mutation UpdateCustomEvent($appId: ID!, $customEventId: ID!, $name: String!, $definition: JSON!, $description: String!, $isAutotrack: Boolean, $category: String) {
  updateCustomEvent(appId: $appId, customEventId: $customEventId, name: $name, definition: $definition, description: $description, isAutotrack: $isAutotrack, category: $category) {
    customEvents { id display: displayName __typename } __typename
  }
}`;

// ── Main sync ───────────────────────────────────────────────────────────────
console.log('');
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log(`║  Amplitude Custom Event Sync                               ║`);
console.log(`║  Source: ${sourceApp} → Target: ${targetApp}${' '.repeat(Math.max(0, 25 - sourceApp.length - targetApp.length))}║`);
console.log(`║  Dry run: ${dryRun}${' '.repeat(dryRun ? 41 : 40)}║`);
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');

console.log(`Fetching source (${sourceApp}) custom events...`);
const sourceResp = await gqlRequest('CustomEvents', LIST_QUERY, { appId: sourceApp });
const sourceCEs = sourceResp?.data?.customEvents;
if (!Array.isArray(sourceCEs)) {
  console.error('ERROR listing source events:', JSON.stringify(sourceResp).substring(0, 500));
  process.exit(1);
}

console.log(`Fetching target (${targetApp}) custom events...`);
const targetResp = await gqlRequest('CustomEvents', LIST_QUERY, { appId: targetApp });
const targetCEs = targetResp?.data?.customEvents;
if (!Array.isArray(targetCEs)) {
  console.error('ERROR listing target events:', JSON.stringify(targetResp).substring(0, 500));
  process.exit(1);
}

const sourceActive = sourceCEs.filter(ce => !ce.deleted);
const targetActive = targetCEs.filter(ce => !ce.deleted);
console.log(`\nSource: ${sourceActive.length} active custom events`);
console.log(`Target: ${targetActive.length} active custom events\n`);

const targetByName = Object.fromEntries(targetActive.map(ce => [ce.display, ce]));

let created = 0, updated = 0, skipped = 0, errors = 0;

for (const ce of sourceActive) {
  let name = ce.display;
  const definition = ce.definition;
  const description = ce.description || '';
  const category = ce.categoryName || '';
  const isAutotrack = ce.autotrack || false;

  if (!name) { skipped++; continue; }

  // Amplitude auto-adds "[Custom] " prefix to display names. Strip it from the
  // source name so we don't get double-prefixed "[Custom] [Custom] ..." in the target.
  name = name.replace(/^\[Custom\]\s*/i, '');  // reassignment OK — was const, now let

  const existing = targetByName[name];

  if (existing) {
    if (JSON.stringify(definition) === JSON.stringify(existing.definition)) {
      console.log(`  OK: "${name}" — same definition`);
      skipped++;
      continue;
    }
    console.log(`  UPDATE: "${name}" (target id=${existing.id}) — definition differs`);
    if (!dryRun) {
      try {
        const resp = await gqlRequest('UpdateCustomEvent', UPDATE_MUTATION, {
          appId: targetApp, customEventId: existing.id,
          name, definition, description, isAutotrack, category,
        });
        if (resp.errors) { console.log(`    ERROR: ${JSON.stringify(resp.errors)}`); errors++; }
        else { console.log(`    ✓ updated`); updated++; }
      } catch (e) { console.log(`    ERROR: ${e.message}`); errors++; }
    }
  } else {
    const eventTypes = definition.map(d => d.event_type).join(' OR ');
    console.log(`  CREATE: "${name}" — ${eventTypes}`);
    if (!dryRun) {
      try {
        const resp = await gqlRequest('CreateCustomEvent', CREATE_MUTATION, {
          appId: targetApp, name, definition, description, isAutotrack, category,
        });
        if (resp.errors) { console.log(`    ERROR: ${JSON.stringify(resp.errors)}`); errors++; }
        else { console.log(`    ✓ created`); created++; }
      } catch (e) { console.log(`    ERROR: ${e.message}`); errors++; }
    }
  }
}

console.log(`\n${dryRun ? 'DRY RUN ' : ''}Summary: ${created} created, ${updated} updated, ${skipped} unchanged, ${errors} errors`);
