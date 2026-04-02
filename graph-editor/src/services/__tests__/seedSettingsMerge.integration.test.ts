/**
 * Integration tests for seedSettings merge logic.
 *
 * Invariants protected:
 *   1. Missing default keys are added to IDB without overwriting user values
 *   2. FileRegistry stays in sync with IDB after merge
 *   3. originalData is also merged (prevents false dirty detection on pull)
 *   4. Post-pull mergeSettingsDefaults restores missing keys
 *   5. Seed from scratch creates file with all defaults
 *   6. No-op when all keys are already present
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

// ── IDB mock ──
// We track the last value written via db.files.put so we can assert on it.
let idbStore: Record<string, any> = {};

vi.mock('../../db/appDatabase', () => ({
  db: {
    files: {
      put: vi.fn(async (file: any) => {
        idbStore[file.fileId] = file;
      }),
      get: vi.fn(async (fileId: string) => {
        return idbStore[fileId] ?? null;
      }),
      add: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      where: vi.fn(() => ({
        equals: vi.fn(() => ({
          and: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
          toArray: vi.fn().mockResolvedValue([]),
        })),
      })),
      toArray: vi.fn().mockResolvedValue([]),
    },
    workspaces: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
    tabs: { toArray: vi.fn().mockResolvedValue([]) },
    getSettings: vi.fn().mockResolvedValue(null),
    getAppState: vi.fn().mockResolvedValue(null),
  },
}));

// ── Fetch mock (for loadDefaultSettings) ──
const FULL_DEFAULTS = {
  version: '1.0.0',
  forecasting: {
    RECENCY_HALF_LIFE_DAYS: 30,
    LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE: 150,
    DEFAULT_T95_DAYS: 30,
    FORECAST_BLEND_LAMBDA: 0.15,
    LATENCY_BLEND_COMPLETENESS_POWER: 2.25,
    ANCHOR_DELAY_BLEND_K_CONVERSIONS: 50,
    ONSET_MASS_FRACTION_ALPHA: 0.01,
    ONSET_AGGREGATION_BETA: 0.5,
    LATENCY_MAX_MEAN_MEDIAN_RATIO: 999999,
    BAYES_LOG_KAPPA_MU: 3.4012,
    BAYES_LOG_KAPPA_SIGMA: 1.5,
    BAYES_FALLBACK_PRIOR_ESS: 20,
    BAYES_DIRICHLET_CONC_FLOOR: 0.5,
    BAYES_SIGMA_FLOOR: 0.01,
    BAYES_MU_PRIOR_SIGMA_FLOOR: 0.5,
    BAYES_MATURITY_FLOOR: 0.9,
    BAYES_SOFTPLUS_SHARPNESS: 8.0,
    BAYES_RHAT_THRESHOLD: 1.05,
    BAYES_ESS_THRESHOLD: 400,
    BAYES_WARM_START_RHAT_MAX: 1.10,
    BAYES_WARM_START_ESS_MIN: 100,
    BAYES_HDI_PROB: 0.90,
    BAYES_DRAWS: 2000,
    BAYES_TUNE: 1000,
    BAYES_CHAINS: 4,
    BAYES_TARGET_ACCEPT: 0.90,
  },
  development: {
    debugGitOperations: false,
  },
};

// The repo-committed version (missing Bayes + onset + max_mean_median keys)
const REPO_SETTINGS_DATA = {
  version: '1.0.0',
  forecasting: {
    RECENCY_HALF_LIFE_DAYS: 80, // user-edited: differs from default 30
    LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE: 150,
    DEFAULT_T95_DAYS: 30,
    FORECAST_BLEND_LAMBDA: 0.15,
    LATENCY_BLEND_COMPLETENESS_POWER: 2.25,
    ANCHOR_DELAY_BLEND_K_CONVERSIONS: 50,
  },
  development: {
    debugGitOperations: false,
  },
};

// Mock fetch to return defaults YAML (we mock yaml.load indirectly via the
// parsed result — fetch returns text, yaml.load parses it; we mock at the
// fetch level to keep the integration path real).
// Actually, seedSettings uses yaml.load so we need to return valid YAML text.
// Easier to mock at the js-yaml level for test simplicity.
vi.mock('js-yaml', () => ({
  default: {
    load: vi.fn(() => structuredClone(FULL_DEFAULTS)),
  },
}));

// Mock global fetch for /defaults/settings.yaml
const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  text: vi.fn().mockResolvedValue('mocked-yaml-text'),
});
vi.stubGlobal('fetch', mockFetch);

// ── Import after mocks ──
import { seedSettingsFile, mergeSettingsDefaults, _mergeDefaults } from '../../init/seedSettings';
import { fileRegistry } from '../../contexts/TabContext';
import { db } from '../../db/appDatabase';

// ── Helpers ──

/** Access the internal files Map of the FileRegistry singleton */
function getRegistryFile(fileId: string): any {
  return (fileRegistry as any).files?.get?.(fileId) ?? null;
}

function clearRegistryFile(fileId: string): void {
  (fileRegistry as any).files?.delete?.(fileId);
}

// ── Tests ──

describe('seedSettings merge integration', () => {
  beforeEach(() => {
    // Reset IDB store
    idbStore = {};
    // Clear FileRegistry
    clearRegistryFile('settings-settings');
    // Reset mock call counts
    vi.clearAllMocks();
    // Re-stub fetch (clearAllMocks clears stubs)
    mockFetch.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue('mocked-yaml-text'),
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Merge adds missing keys without overwriting user values
  // ──────────────────────────────────────────────────────────────────────────

  it('should add missing Bayes keys to existing settings without overwriting user-edited values', async () => {
    // Pre-populate IDB with repo version (6 forecasting keys, user-edited RECENCY)
    idbStore['settings-settings'] = {
      fileId: 'settings-settings',
      type: 'settings',
      path: 'settings/settings.yaml',
      data: structuredClone(REPO_SETTINGS_DATA),
      originalData: structuredClone(REPO_SETTINGS_DATA),
      isDirty: false,
      viewTabs: [],
      lastModified: 1000,
      sha: 'abc123',
      source: { repository: 'test-repo', path: 'settings/settings.yaml', branch: 'main' },
    };

    await seedSettingsFile();

    // Verify IDB was updated
    const idbFile = idbStore['settings-settings'];
    expect(idbFile).toBeTruthy();
    const forecasting = idbFile.data.forecasting;

    // User-edited value MUST be preserved (80, not the default 30)
    expect(forecasting.RECENCY_HALF_LIFE_DAYS).toBe(80);

    // All Bayes keys should now be present
    expect(forecasting.BAYES_LOG_KAPPA_MU).toBe(3.4012);
    expect(forecasting.BAYES_LOG_KAPPA_SIGMA).toBe(1.5);
    expect(forecasting.BAYES_FALLBACK_PRIOR_ESS).toBe(20);
    expect(forecasting.BAYES_DIRICHLET_CONC_FLOOR).toBe(0.5);
    expect(forecasting.BAYES_SIGMA_FLOOR).toBe(0.01);
    expect(forecasting.BAYES_MU_PRIOR_SIGMA_FLOOR).toBe(0.5);
    expect(forecasting.BAYES_MATURITY_FLOOR).toBe(0.9);
    expect(forecasting.BAYES_SOFTPLUS_SHARPNESS).toBe(8.0);
    expect(forecasting.BAYES_RHAT_THRESHOLD).toBe(1.05);
    expect(forecasting.BAYES_ESS_THRESHOLD).toBe(400);
    expect(forecasting.BAYES_WARM_START_RHAT_MAX).toBe(1.10);
    expect(forecasting.BAYES_WARM_START_ESS_MIN).toBe(100);
    expect(forecasting.BAYES_HDI_PROB).toBe(0.90);
    expect(forecasting.BAYES_DRAWS).toBe(2000);
    expect(forecasting.BAYES_TUNE).toBe(1000);
    expect(forecasting.BAYES_CHAINS).toBe(4);
    expect(forecasting.BAYES_TARGET_ACCEPT).toBe(0.90);

    // Onset keys should also be present
    expect(forecasting.ONSET_MASS_FRACTION_ALPHA).toBe(0.01);
    expect(forecasting.ONSET_AGGREGATION_BETA).toBe(0.5);
    expect(forecasting.LATENCY_MAX_MEAN_MEDIAN_RATIO).toBe(999999);

    // SHA and source should be preserved from the existing file
    expect(idbFile.sha).toBe('abc123');
    expect(idbFile.source.repository).toBe('test-repo');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. FileRegistry stays in sync with IDB after merge
  // ──────────────────────────────────────────────────────────────────────────

  it('should update FileRegistry in sync with IDB after merging new keys', async () => {
    idbStore['settings-settings'] = {
      fileId: 'settings-settings',
      type: 'settings',
      data: structuredClone(REPO_SETTINGS_DATA),
      originalData: structuredClone(REPO_SETTINGS_DATA),
      isDirty: false,
      viewTabs: [],
      lastModified: 1000,
    };

    await seedSettingsFile();

    const regFile = getRegistryFile('settings-settings');
    expect(regFile).toBeTruthy();

    // FileRegistry data should have the merged Bayes keys
    expect(regFile.data.forecasting.BAYES_LOG_KAPPA_MU).toBe(3.4012);
    expect(regFile.data.forecasting.BAYES_DRAWS).toBe(2000);

    // User-edited value preserved in FileRegistry too
    expect(regFile.data.forecasting.RECENCY_HALF_LIFE_DAYS).toBe(80);

    // FileRegistry and IDB should reference the same data structure
    const idbFile = idbStore['settings-settings'];
    expect(regFile.data).toEqual(idbFile.data);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. originalData is also merged (prevents false dirty detection)
  // ──────────────────────────────────────────────────────────────────────────

  it('should merge defaults into originalData so added keys do not trigger hasActualChanges', async () => {
    idbStore['settings-settings'] = {
      fileId: 'settings-settings',
      type: 'settings',
      data: structuredClone(REPO_SETTINGS_DATA),
      originalData: structuredClone(REPO_SETTINGS_DATA),
      isDirty: false,
      viewTabs: [],
      lastModified: 1000,
    };

    await seedSettingsFile();

    const idbFile = idbStore['settings-settings'];

    // originalData should also have the Bayes keys
    expect(idbFile.originalData.forecasting.BAYES_LOG_KAPPA_MU).toBe(3.4012);
    expect(idbFile.originalData.forecasting.BAYES_DRAWS).toBe(2000);

    // data and originalData should be identical (no false dirty detection)
    expect(JSON.stringify(idbFile.data)).toBe(JSON.stringify(idbFile.originalData));
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Post-pull mergeSettingsDefaults restores missing keys
  // ──────────────────────────────────────────────────────────────────────────

  it('should restore missing Bayes keys after a pull overwrites the settings file', async () => {
    // Simulate: pull just wrote the git version (6 keys) to IDB
    idbStore['settings-settings'] = {
      fileId: 'settings-settings',
      type: 'settings',
      data: structuredClone(REPO_SETTINGS_DATA),
      originalData: structuredClone(REPO_SETTINGS_DATA),
      isDirty: false,
      viewTabs: [],
      lastModified: 2000,
      sha: 'post-pull-sha',
      source: { repository: 'test-repo', path: 'settings/settings.yaml', branch: 'main' },
    };

    await mergeSettingsDefaults();

    const idbFile = idbStore['settings-settings'];
    expect(idbFile.data.forecasting.BAYES_LOG_KAPPA_MU).toBe(3.4012);
    expect(idbFile.data.forecasting.BAYES_DRAWS).toBe(2000);

    // User-edited value preserved
    expect(idbFile.data.forecasting.RECENCY_HALF_LIFE_DAYS).toBe(80);

    // originalData also merged
    expect(idbFile.originalData.forecasting.BAYES_LOG_KAPPA_MU).toBe(3.4012);

    // SHA preserved from pull
    expect(idbFile.sha).toBe('post-pull-sha');

    // FileRegistry also updated
    const regFile = getRegistryFile('settings-settings');
    expect(regFile).toBeTruthy();
    expect(regFile.data.forecasting.BAYES_LOG_KAPPA_MU).toBe(3.4012);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Seed from scratch creates file with all defaults
  // ──────────────────────────────────────────────────────────────────────────

  it('should create settings.yaml from defaults when no file exists in IDB', async () => {
    // IDB is empty — no settings-settings file
    await seedSettingsFile();

    const idbFile = idbStore['settings-settings'];
    expect(idbFile).toBeTruthy();
    expect(idbFile.type).toBe('settings');
    expect(idbFile.path).toBe('settings/settings.yaml');

    // All defaults present including Bayes
    expect(idbFile.data.forecasting.RECENCY_HALF_LIFE_DAYS).toBe(30); // default, not user-edited
    expect(idbFile.data.forecasting.BAYES_LOG_KAPPA_MU).toBe(3.4012);
    expect(idbFile.data.forecasting.BAYES_DRAWS).toBe(2000);
    expect(idbFile.data.version).toBe('1.0.0');
    expect(idbFile.data.development.debugGitOperations).toBe(false);

    // originalData should match data
    expect(JSON.stringify(idbFile.data)).toBe(JSON.stringify(idbFile.originalData));

    // FileRegistry also populated
    const regFile = getRegistryFile('settings-settings');
    expect(regFile).toBeTruthy();
    expect(regFile.data.forecasting.BAYES_LOG_KAPPA_MU).toBe(3.4012);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. No-op when all keys are already present
  // ──────────────────────────────────────────────────────────────────────────

  it('should not write to IDB when settings already have all default keys', async () => {
    // Pre-populate with full defaults (all keys present)
    idbStore['settings-settings'] = {
      fileId: 'settings-settings',
      type: 'settings',
      data: structuredClone(FULL_DEFAULTS),
      originalData: structuredClone(FULL_DEFAULTS),
      isDirty: false,
      viewTabs: [],
      lastModified: 1000,
    };

    await seedSettingsFile();

    // db.files.put should NOT have been called (no changes needed)
    // It was called once in beforeEach to set up the store, but seedSettingsFile
    // shouldn't have called it
    expect(db.files.put).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 7. mergeDefaults unit: deep merge preserves nested structure
  // ──────────────────────────────────────────────────────────────────────────

  it('should deep-merge nested keys without flattening', () => {
    const existing = {
      forecasting: { A: 1 },
      development: { X: true },
    };
    const defaults = {
      forecasting: { A: 99, B: 2 },
      development: { X: false, Y: 'new' },
      newSection: { Z: 42 },
    };

    const changed = _mergeDefaults(existing, defaults);

    expect(changed).toBe(true);
    // A is preserved (not overwritten)
    expect(existing.forecasting.A).toBe(1);
    // B is added
    expect((existing.forecasting as any).B).toBe(2);
    // X is preserved
    expect(existing.development.X).toBe(true);
    // Y is added
    expect((existing.development as any).Y).toBe('new');
    // newSection added wholesale
    expect((existing as any).newSection).toEqual({ Z: 42 });
  });

  it('should return false when no keys need adding', () => {
    const existing = { a: 1, b: { c: 2 } };
    const defaults = { a: 99, b: { c: 99 } };

    const changed = _mergeDefaults(existing, defaults);
    expect(changed).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 8. Guard: arrays and non-objects in defaults are not deep-merged
  // ──────────────────────────────────────────────────────────────────────────

  it('should not deep-merge arrays — treat them as atomic values', () => {
    const existing = { tags: ['old'] };
    const defaults = { tags: ['new'], added: true };

    const changed = _mergeDefaults(existing, defaults);

    expect(changed).toBe(true);
    // tags should NOT be merged — existing array preserved
    expect(existing.tags).toEqual(['old']);
    // added key should be added
    expect((existing as any).added).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 9. Post-pull no-op when nothing is missing
  // ──────────────────────────────────────────────────────────────────────────

  it('mergeSettingsDefaults should be a no-op when all keys are present', async () => {
    idbStore['settings-settings'] = {
      fileId: 'settings-settings',
      type: 'settings',
      data: structuredClone(FULL_DEFAULTS),
      originalData: structuredClone(FULL_DEFAULTS),
      isDirty: false,
      viewTabs: [],
      lastModified: 2000,
    };

    await mergeSettingsDefaults();

    // Should not have written to IDB
    expect(db.files.put).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Schema alignment: every default key must be renderable in the FormEditor
// ══════════════════════════════════════════════════════════════════════════════

describe('settings schema ↔ defaults alignment', () => {
  // Read the REAL files from disk — no mocks.
  // This is the test that would have caught the actual bug:
  // defaults had Bayes keys but the schema didn't, so the form
  // never rendered them.

  let schema: any;
  let uiSchema: any;
  let defaults: any;

  beforeEach(async () => {
    const fs = await import('fs');
    const path = await import('path');
    const yamlMod = await import('js-yaml');

    const root = path.resolve(__dirname, '../../..');

    schema = JSON.parse(
      fs.readFileSync(path.join(root, 'public/schemas/settings-schema.json'), 'utf8')
    );
    uiSchema = JSON.parse(
      fs.readFileSync(path.join(root, 'public/ui-schemas/settings-ui-schema.json'), 'utf8')
    );
    // Use real yaml module (not the mock) for defaults
    const yamlText = fs.readFileSync(path.join(root, 'public/defaults/settings.yaml'), 'utf8');
    defaults = (yamlMod as any).default?.load?.(yamlText) ?? yamlMod.load(yamlText);
  });

  it('every forecasting key in defaults.yaml must have a property in the JSON schema', () => {
    const defaultKeys = Object.keys(defaults.forecasting);
    const schemaKeys = Object.keys(schema.properties.forecasting.properties);

    const missingInSchema = defaultKeys.filter(k => !schemaKeys.includes(k));
    expect(missingInSchema).toEqual([]);
  });

  it('every forecasting key in the JSON schema must have a default in defaults.yaml', () => {
    const defaultKeys = Object.keys(defaults.forecasting);
    const schemaKeys = Object.keys(schema.properties.forecasting.properties);

    const missingInDefaults = schemaKeys.filter(k => !defaultKeys.includes(k));
    expect(missingInDefaults).toEqual([]);
  });

  it('every forecasting key in the JSON schema must appear in a UI schema group', () => {
    const schemaKeys = Object.keys(schema.properties.forecasting.properties);
    const groups: Array<{ fields: string[] }> = uiSchema.forecasting['ui:options']?.groups || [];
    const groupedFields = new Set(groups.flatMap(g => g.fields));

    const missingInGroups = schemaKeys.filter(k => !groupedFields.has(k));
    expect(missingInGroups).toEqual([]);
  });

  it('every forecasting key in ForecastingModelSettings type must be in defaults.yaml', async () => {
    // Read the forecastingSettingsService source and extract field names
    const fs = await import('fs');
    const path = await import('path');
    const root = path.resolve(__dirname, '../../..');
    const svcSource = fs.readFileSync(
      path.join(root, 'src/services/forecastingSettingsService.ts'), 'utf8'
    );

    // Extract the type definition field names (lines like "  BAYES_LOG_KAPPA_MU: number;")
    const typeFieldRegex = /^\s+([A-Z_]+)\s*:\s*number\s*;/gm;
    const serviceFields: string[] = [];
    let match;
    while ((match = typeFieldRegex.exec(svcSource)) !== null) {
      serviceFields.push(match[1]);
    }

    const defaultKeys = Object.keys(defaults.forecasting);
    const missingInDefaults = serviceFields.filter(k => !defaultKeys.includes(k));
    expect(missingInDefaults).toEqual([]);
  });
});
