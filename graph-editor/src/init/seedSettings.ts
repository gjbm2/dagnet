import { db } from '../db/appDatabase';
import { gitConfig } from '../config/gitConfig';
import yaml from 'js-yaml';
import { sessionLogService } from '../services/sessionLogService';

/**
 * Loads default settings.yaml from public/defaults/
 */
async function loadDefaultSettings(): Promise<any> {
  try {
    const response = await fetch('/defaults/settings.yaml');
    if (!response.ok) {
      throw new Error(`Failed to fetch default settings: ${response.status}`);
    }
    const text = await response.text();
    return yaml.load(text);
  } catch (error) {
    console.error('[seedSettings] Failed to load default settings.yaml:', error);
    // Fallback to minimal structure with safe defaults (schema also provides defaults)
    return {
      version: '1.0.0',
      forecasting: {},
    };
  }
}

/**
 * Seeds settings/settings.yaml - priority: git > local > defaults
 *
 * Rationale:
 * - This file is intended to be shared and versioned (like connections.yaml).
 * - It must be present in IndexedDB so it can be opened/edited in the UI and committed back.
 */
export async function seedSettingsFile(): Promise<void> {
  try {
    const fileId = 'settings-settings';
    const existing = await db.files.get(fileId);

    // Try git first (mirrors seedConnections)
    try {
      console.log('[seedSettings] Attempting to load settings.yaml from git...');

      const { credentialsManager } = await import('../lib/credentials');
      const credResult = await credentialsManager.loadCredentials();

      if (credResult.success && credResult.credentials?.git && credResult.credentials.git.length > 0) {
        const gitCred = credResult.credentials.git[0];
        const basePath = gitCred.basePath || '';
        const fullPath = basePath ? `${basePath}/settings/settings.yaml` : 'settings/settings.yaml';
        const notFoundKey = `dagnet:seed:git404:${gitCred.owner}/${gitCred.repo || gitCred.name}@${gitCred.branch || 'main'}:${fullPath}`;
        const notFoundAt = window.localStorage.getItem(notFoundKey);
        if (notFoundAt) {
          console.log('[seedSettings] Skipping git fetch (previous 404 cached):', notFoundKey);
        } else {

        const apiUrl = `${gitConfig.githubApiBase}/repos/${gitCred.owner}/${gitCred.repo || gitCred.name}/contents/${fullPath}?ref=${gitCred.branch || 'main'}`;

        const headers: HeadersInit = {
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        };
        if (gitCred.token) headers.Authorization = `token ${gitCred.token}`;

        console.log(`[seedSettings] Fetching from: ${gitCred.owner}/${gitCred.repo || gitCred.name} - ${fullPath}`);
        const response = await fetch(apiUrl, { headers });

        if (response.ok) {
          const data = await response.json();
          const content = atob(data.content.replace(/\n/g, ''));
          const parsedData = yaml.load(content);
          window.localStorage.removeItem(notFoundKey);

          if (!existing || JSON.stringify(existing.data) !== JSON.stringify(parsedData)) {
            console.log('[seedSettings] Syncing settings.yaml from git');
            await db.files.put({
              fileId,
              type: 'settings',
              data: parsedData as any,
              lastModified: Date.now(),
              viewTabs: existing?.viewTabs || [],
              sha: data.sha,
              source: {
                repository: gitCred.name,
                branch: gitCred.branch || 'main',
                path: fullPath,
              },
            });
            console.log('[seedSettings] settings.yaml synced successfully from git');
          } else {
            console.log('[seedSettings] settings.yaml already up-to-date');
          }
          return;
        } else {
          if (response.status === 404) {
            window.localStorage.setItem(notFoundKey, String(Date.now()));
            sessionLogService.warning(
              'workspace',
              'SEED_SETTINGS_GIT_NOT_FOUND',
              'settings.yaml not found in repo; using defaults',
              `${gitCred.owner}/${gitCred.repo || gitCred.name}@${gitCred.branch || 'main'}:${fullPath} returned 404`,
              { owner: gitCred.owner, repo: gitCred.repo || gitCred.name, branch: gitCred.branch || 'main', path: fullPath }
            );
          } else {
            sessionLogService.warning(
              'workspace',
              'SEED_SETTINGS_GIT_FAILED',
              'Could not load settings.yaml from repo; using defaults',
              `${gitCred.owner}/${gitCred.repo || gitCred.name}@${gitCred.branch || 'main'}:${fullPath} returned ${response.status}`,
              { owner: gitCred.owner, repo: gitCred.repo || gitCred.name, branch: gitCred.branch || 'main', path: fullPath, status: response.status }
            );
          }
          console.log(`[seedSettings] File not loaded from git (${response.status}), will seed from defaults`);
        }
        } // end notFound cached guard
      } else {
        console.log('[seedSettings] No git credentials configured, skipping git sync');
      }
    } catch (gitError) {
      console.log('[seedSettings] Could not load from git (expected if using local mode or file does not exist):', gitError);
    }

    // Fallback: defaults (if missing, or present-but-empty and not dirty)
    const defaultData = await loadDefaultSettings();
    const shouldSeedFromDefaults = !existing || (!existing.isDirty && !existing.data);

    if (shouldSeedFromDefaults) {
      console.log('[seedSettings] Creating settings.yaml from defaults');

      const { credentialsManager } = await import('../lib/credentials');
      const credResult = await credentialsManager.loadCredentials();
      const gitCred = credResult.success && credResult.credentials?.git?.[0];

      await db.files.put({
        fileId,
        type: 'settings',
        data: defaultData,
        lastModified: Date.now(),
        viewTabs: existing?.viewTabs || [],
        isDirty: false,
        originalData: defaultData,
        source: gitCred
          ? {
              repository: gitCred.name,
              branch: gitCred.branch || 'main',
              path: 'settings/settings.yaml',
            }
          : undefined,
      });

      console.log('[seedSettings] ✅ settings.yaml created from defaults');
    } else {
      console.log('[seedSettings] settings.yaml already exists, skipping seed');
    }
  } catch (error) {
    console.error('[seedSettings] Failed to seed settings.yaml:', error);
  }
}


