# Staleness and Auto-Update

How DagNet detects stale data and applies auto-update policies for nudges, pulls, and retrieves.

## Staleness Nudges

**Location**: `stalenessNudgeService.ts`

Non-blocking UI nudges when data is out of date:

| Nudge type | Trigger |
|-----------|---------|
| Reload nudge | Git SHA mismatch (remote has newer commits) |
| Git-pull nudge | Stale git index (pending pull) |
| Retrieve-all-slices nudge | Data slices need refresh per pinned DSL |

## Nudge Jobs

**Location**: `stalenessNudgeJobs.ts`

Registered as `jobSchedulerService` jobs:

| Job | Interval | Purpose |
|-----|----------|---------|
| Version check | 10 min | Detect app version updates, trigger reload |
| Git remote check | 5 min | Fetch HEAD SHA to detect stale branches |
| Auto-pull | Conditional | Pull if nudged and auto-pull policy enabled |
| Retrieve nudge | Hourly | Mark slices as needing refresh |

## Auto-Update Policy

**Location**: `autoUpdatePolicyService.ts`

Three layers of precedence:
1. **Live share mode or dashboard URL**: always enabled (forced)
2. **`?auto-update=1` URL parameter**: enabled (not forced)
3. **Workspace preference** stored in IndexedDB: defaults to ON

## Key Files

| File | Role |
|------|------|
| `src/services/stalenessNudgeService.ts` | Nudge detection and state |
| `src/services/stalenessNudgeJobs.ts` | Scheduled nudge jobs |
| `src/services/autoUpdatePolicyService.ts` | Policy resolution |
